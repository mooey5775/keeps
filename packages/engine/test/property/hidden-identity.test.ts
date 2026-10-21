import { describe, expect, it } from 'vitest';
import {
  apply,
  buildPosition,
  CARD_IDS,
  CARDS,
  legalCommands,
  pick,
  playerSeats,
  randomInt,
  seedRng,
  shuffle,
  viewFor,
  type CardId,
  type Command,
  type GameState,
  type KeepCard,
  type PositionSpec,
  type Seat,
} from '../../src/index.ts';

// "It does not take effect until then": while a card is face down, which card
// it is must make no public difference. Two positions that differ only in the
// identity of the hidden card (it trades places with a card buried in a pile)
// must look the same to a spectator, step by step, under the same commands:
// same prompts, same reveal windows, same scores, same everything, until one
// of the two swapped cards could become visible.

/** Two specs: the face-down card is `a` in one and `b` in the other; the other card sits in a pile. */
function pair(seed: number, a: CardId, b: CardId): [PositionSpec, PositionSpec] {
  const rng = seedRng(`identity-${seed}`);
  const rest = shuffle(rng, CARD_IDS.filter((c) => c !== a && c !== b && c !== 'duplicity'));
  const piles: Record<number, CardId[]> = { 0: [], 1: [], 2: [], 3: [] };
  const hands: Record<number, CardId[]> = { 0: [], 1: [], 2: [], 3: [] };
  const keeps: Record<number, (CardId | KeepCard)[]> = { 0: [], 1: [], 2: [], 3: [] };
  const discard: CardId[] = [];
  for (const card of rest) {
    const r = randomInt(rng, 10);
    const seat = randomInt(rng, 4);
    if (r < 3) piles[seat]!.push(card);
    else if (r < 6 && !CARDS[card].hot) hands[seat]!.push(card);
    else if (r < 8 && CARDS[card].keep) keeps[seat]!.push(card);
    else discard.push(card);
  }
  const holder = randomInt(rng, 4) as Seat;
  const hiddenSeat = randomInt(rng, 4);
  const buriedPile = randomInt(rng, 4);
  const turn = randomInt(rng, 4) as Seat;
  keeps[holder]!.push('duplicity');
  const build = (faceDown: CardId, buried: CardId): PositionSpec => ({
    piles: { ...piles, [buriedPile]: [...piles[buriedPile]!, buried] },
    hands,
    keeps: { ...keeps, [hiddenSeat]: [...keeps[hiddenSeat]!, { id: faceDown, faceDown: { placedBy: holder } }] },
    discard,
    turn,
    seed,
    fill: 'quiet',
  });
  return [build(a, b), build(b, a)];
}

/** The public picture, with the seq-based prompt ids left out (they match anyway). */
function publicView(state: GameState) {
  const { legal: _legal, ...view } = viewFor(state, 'spectator');
  return view;
}

/** Could either swapped card be visible to anyone now (revealed, drawn, played, discarded, looked at)? */
function exposed(state: GameState, a: CardId, b: CardId): boolean {
  if (!state.keeps.flat().some((c) => c.faceDown)) return true;
  for (const id of [a, b]) {
    const inPile = Object.values(state.piles).some((p) => p.cards.some((c, i) => c.id === id && !(i === 0 && c.faceUp)));
    const faceDown = state.keeps.flat().some((c) => c.id === id && c.faceDown);
    if (!inPile && !faceDown) return true;
  }
  // Someone looking through a pile (Requisition, Tithes, Epiphany, Prayer) may see the buried one.
  return state.prompts.some((p) => ['choose-pile-card', 'order-pile', 'choose-top-card', 'take-or-discard'].includes(p.kind));
}

const PAIRS: [CardId, CardId][] = [
  ['retribution', 'chalice'],
  ['interest', 'shackles'],
  ['last-laugh', 'purity'],
  ['count-token', 'faberge-egg'],
  ['tithes', 'medallion'],
];

describe('a face-down card makes no public difference until revealed', () => {
  for (const [a, b] of PAIRS) {
    it(`${a} or ${b} hidden: identical public play`, () => {
      let steps = 0;
      for (let seed = 0; seed < 60; seed++) {
        const [specA, specB] = pair(seed, a, b);
        let stateA = buildPosition(specA);
        let stateB = buildPosition(specB);
        const rng = seedRng(`identity-play-${seed}`);
        for (let n = 0; n < 60; n++) {
          if (exposed(stateA, a, b) || exposed(stateB, a, b)) break;
          expect(publicView(stateB), `seed ${seed} step ${n}`).toEqual(publicView(stateA));
          if (stateA.phase !== 'playing' && stateA.phase !== 'post-round') break;
          // Commands legal in both (they differ only for a player holding the buried card).
          const options = playerSeats(stateA).flatMap((seat) =>
            legalCommands(stateA, seat)
              .filter((c) => c.type !== 'reveal-duplicity')
              .filter((c) => legalCommands(stateB, seat).some((d) => JSON.stringify(d) === JSON.stringify(c)))
              .map((command) => ({ seat, command })),
          );
          if (options.length === 0) break;
          const { seat, command } = pick(rng, options) as { seat: Seat; command: Command };
          const resultA = apply(stateA, seat, command);
          const resultB = apply(stateB, seat, command);
          if (!resultA.ok || !resultB.ok) throw new Error('a command legal in both was rejected');
          stateA = resultA.state;
          stateB = resultB.state;
          steps++;
        }
      }
      expect(steps).toBeGreaterThan(300);
    });
  }
});
