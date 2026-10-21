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
  type PositionSpec,
  type Seat,
  type TraceEvent,
} from '../../src/index.ts';

// "JOKER takes the effect of that card." Playing Joker as X must do exactly
// what playing X does. The only difference afterward is which of the two is
// in the discard and which stays in hand, so with the names Joker and X
// swapped, the two games must match through the whole resolution: every
// prompt, trigger, and view, until someone is back to choosing an action.

const COPYABLE = CARD_IDS.filter((c) => !CARDS[c].keep && !CARDS[c].hot && c !== 'joker');

/** Swaps the card names Joker and X wherever a card is meant (not prompt purposes or frame kinds). */
function swapNames<T>(value: T, x: CardId): T {
  return JSON.parse(JSON.stringify(value), (key, v: unknown) =>
    key === 'kind' || key === 'purpose' ? v : v === 'joker' ? x : v === x ? 'joker' : v,
  ) as T;
}

/** A view without prompt ids and legal commands (ids differ by one event: Joker's reveal). */
function comparable(state: GameState, seat: Seat) {
  const { legal: _legal, ...view } = viewFor(state, seat);
  return {
    ...view,
    prompts: view.prompts.map(({ id: _id, ...p }) => p),
    hands: view.hands,
  };
}

function sortHands<T extends { hands: { cards?: CardId[] }[] }>(view: T): T {
  return { ...view, hands: view.hands.map((h) => (h.cards ? { ...h, cards: [...h.cards].sort() } : h)) };
}

/**
 * Joker's own events, minus the reveal and the copy markers, to line up with
 * X's. Extra actions and no-effect notes name the card whose rule applied (X in
 * both games), which the name swap would garble, so they're compared unlabeled.
 */
function normalize(events: TraceEvent[]) {
  return events
    .filter((e) => e.payload.type !== 'reveal-card' && e.payload.type !== 'prompt')
    .map((e) => {
      const p = e.payload;
      if (p.type === 'play' && p.copy) {
        const { copy: _copy, ...play } = p;
        return play;
      }
      if (p.type === 'action' && p.choice.action === 'play' && p.choice.copy) {
        const { copy: _copy, ...choice } = p.choice;
        return { ...p, choice };
      }
      if (p.type === 'extra-actions') return { ...p, source: null };
      if (p.type === 'no-effect') return { ...p, card: null };
      return p;
    });
}

function randomSpec(seed: number, x: CardId): PositionSpec {
  const rng = seedRng(`joker-${x}-${seed}`);
  const cards = shuffle(rng, CARD_IDS.filter((c) => c !== 'joker' && c !== x));
  const piles: Record<number, CardId[]> = { 0: [], 1: [], 2: [], 3: [] };
  const hands: Record<number, CardId[]> = { 0: ['joker', x], 1: [], 2: [], 3: [] };
  const keeps: Record<number, CardId[]> = { 0: [], 1: [], 2: [], 3: [] };
  const discard: CardId[] = [];
  for (const card of cards) {
    const roll = randomInt(rng, 10);
    const seat = randomInt(rng, 4);
    if (roll < 4) piles[randomInt(rng, 4)]!.push(card);
    else if (roll < 6 && !CARDS[card].hot) hands[seat]!.push(card);
    else if (roll < 8 && CARDS[card].keep && card !== 'duplicity') keeps[seat]!.push(card);
    else discard.push(card);
  }
  return { piles, hands, keeps, discard, turn: 0, seed };
}

function answerAt(state: GameState, seat: Seat, command: Command): Command | null {
  if (command.type !== 'answer') return command;
  const prompt = state.prompts.find((p) => p.seat === seat && p.kind === command.answer.kind);
  return prompt ? { ...command, promptId: prompt.id } : null;
}

describe('Joker takes the effect of the card it reveals', () => {
  for (const x of COPYABLE) {
    it(`Joker as ${CARDS[x].name} matches ${CARDS[x].name}`, () => {
      let compared = 0;
      for (let seed = 0; seed < 15; seed++) {
        const spec = randomSpec(seed, x);
        const startA = buildPosition(spec);
        const startB = buildPosition(spec);
        // Skip positions that are already over (e.g. all three Tokens dealt into one keep).
        if (startA.prompts[0]?.kind !== 'action' || startA.prompts[0].seat !== 0) continue;
        const playA = apply(startA, 0, { type: 'answer', promptId: startA.prompts[0]!.id, answer: { kind: 'action', choice: { action: 'play', card: 'joker', copy: x } } });
        const playB = apply(startB, 0, { type: 'answer', promptId: startB.prompts[0]!.id, answer: { kind: 'action', choice: { action: 'play', card: x } } });
        if (!playA.ok || !playB.ok) throw new Error('setup');
        let a = playA.state;
        let b = playB.state;
        expect(normalize(playA.events)).toEqual(swapNames(normalize(playB.events), x));
        const rng = seedRng(`joker-play-${x}-${seed}`);
        // Follow the effect until someone is choosing an action again (or the round is over).
        for (let n = 0; n < 40 && a.prompts.length > 0 && !a.prompts.some((p) => p.kind === 'action'); n++) {
          for (const seat of playerSeats(a)) expect(sortHands(comparable(a, seat))).toEqual(sortHands(swapNames(comparable(b, seat), x)));
          // Targeting yourself would steal from the hand where the two games differ (X versus Joker).
          const selfTarget = (c: Command) => c.type === 'answer' && c.answer.kind === 'choose-player' && c.answer.seat === 0;
          const options = playerSeats(a).flatMap((seat) =>
            legalCommands(a, seat)
              .filter((c) => c.type === 'answer' && !selfTarget(c))
              .map((command) => ({ seat, command })),
          );
          if (options.length === 0) break;
          const { seat, command } = pick(rng, options);
          const forB = answerAt(b, seat, swapNames(command, x));
          if (!forB) expect.fail(`${x} seed ${seed}: no matching prompt in the plain game`);
          const ra = apply(a, seat, command);
          const rb = apply(b, seat, forB);
          if (!ra.ok || !rb.ok) expect.fail(`${x} seed ${seed}: a matching answer was rejected`);
          expect(normalize(ra.events)).toEqual(swapNames(normalize(rb.events), x));
          a = ra.state;
          b = rb.state;
          compared++;
        }
        for (const seat of playerSeats(a)) expect(sortHands(comparable(a, seat))).toEqual(sortHands(swapNames(comparable(b, seat), x)));
        compared++;
      }
      expect(compared).toBeGreaterThanOrEqual(10);
    });
  }
});
