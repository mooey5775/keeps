import { describe, expect, it } from 'vitest';
import {
  apply,
  buildPosition,
  CARD_IDS,
  CARDS,
  legalCommands,
  newGame,
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

// Two more whole-engine properties:
// - Relabeling: cards with identical rules (Chalice and Dagger; Scepter,
//   Medallion and Timepiece; the three Tokens) are interchangeable. Swapping
//   them everywhere, commands included, must change nothing but the names.
// - Bounds: the resolution stack, open plays, and simultaneous prompts stay
//   small, so nothing leaks over long games.

const SIGMA: Partial<Record<CardId, CardId>> = {
  chalice: 'dagger',
  dagger: 'chalice',
  scepter: 'medallion',
  medallion: 'timepiece',
  timepiece: 'scepter',
  'count-token': 'fool-token',
  'fool-token': 'friar-token',
  'friar-token': 'count-token',
};
const CARD_SET = new Set<string>(CARD_IDS);
const sigma = <T,>(value: T): T =>
  JSON.parse(JSON.stringify(value), (_k, v: unknown) => (typeof v === 'string' && CARD_SET.has(v) ? (SIGMA[v as CardId] ?? v) : v)) as T;

function randomSpec(seed: number): PositionSpec {
  const rng = seedRng(`relabel-${seed}`);
  const cards = shuffle(rng, [...CARD_IDS]);
  const piles: Record<number, CardId[]> = { 0: [], 1: [], 2: [], 3: [] };
  const hands: Record<number, CardId[]> = { 0: [], 1: [], 2: [], 3: [] };
  const keeps: Record<number, (CardId | KeepCard)[]> = { 0: [], 1: [], 2: [], 3: [] };
  const discard: CardId[] = [];
  for (const card of cards) {
    const roll = randomInt(rng, 10);
    const seat = randomInt(rng, 4);
    if (roll < 4) piles[randomInt(rng, 4)]!.push(card);
    else if (roll < 6 && !CARDS[card].hot) hands[seat]!.push(card);
    else if (roll < 8 && CARDS[card].keep && card !== 'duplicity') keeps[seat]!.push(card);
    else discard.push(card);
  }
  return { piles, hands, keeps, discard, turn: randomInt(rng, 4) as Seat, seed };
}

describe('relabeling identical cards', () => {
  it('swapping cards with identical rules everywhere changes nothing but their names', () => {
    let steps = 0;
    for (let seed = 0; seed < 90; seed++) {
      const spec = randomSpec(seed);
      let a = buildPosition(spec);
      let b = buildPosition(sigma(spec));
      const rng = seedRng(`relabel-play-${seed}`);
      for (let n = 0; n < 80 && (a.phase === 'playing' || a.phase === 'post-round'); n++) {
        for (const seat of playerSeats(a)) {
          // Hands may list the swapped cards in a different order; compare them as sets.
          const norm = (v: ReturnType<typeof viewFor>) => ({ ...v, hands: v.hands.map((h) => ({ ...h, cards: h.cards?.slice().sort() })) });
          expect(norm(viewFor(b, seat)), `seed ${seed} step ${n}`).toEqual(norm(sigma(viewFor(a, seat))));
        }
        const options = playerSeats(a).flatMap((seat) => legalCommands(a, seat).map((command) => ({ seat, command })));
        const { seat, command } = pick(rng, options);
        const ra = apply(a, seat, command);
        const rb = apply(b, seat, sigma(command) as Command);
        if (!ra.ok) throw new Error(ra.error.message);
        if (!rb.ok) expect.fail(`seed ${seed} step ${n}: relabeled command rejected: ${rb.error.message}`);
        expect(rb.events.map((e) => e.payload)).toEqual(sigma(ra.events.map((e) => e.payload)));
        a = ra.state;
        b = rb.state;
        steps++;
      }
    }
    expect(steps).toBeGreaterThan(1500);
  });
});

describe('bounded internal state', () => {
  it('the stack, open plays, and simultaneous prompts stay small over long games', () => {
    const max = { stack: 0, plays: 0, prompts: 0 };
    for (let game = 0; game < 30; game++) {
      const rng = seedRng(`bounds-${game}`);
      let state: GameState = newGame({ players: (2 + (game % 3)) as 2 | 3 | 4, seed: `bounds-${game}`, marksToWin: 4 }).state;
      while (state.phase !== 'game-over') {
        const options = playerSeats(state).flatMap((s) => legalCommands(state, s).map((command) => ({ seat: s, command })));
        const choice = pick(rng, options);
        const result = apply(state, choice.seat, choice.command);
        if (!result.ok) throw new Error(result.error.message);
        state = result.state;
        max.stack = Math.max(max.stack, state.stack.length);
        max.plays = Math.max(max.plays, state.openPlays.length);
        max.prompts = Math.max(max.prompts, state.prompts.length);
        // Simultaneous prompts only come from Offering: at most one per other player.
        expect(state.prompts.length).toBeLessThanOrEqual(playerSeats(state).length - 1 || 1);
      }
    }
    expect(max.stack).toBeLessThan(30);
    expect(max.plays).toBeLessThan(12);
    expect(max.prompts).toBeLessThanOrEqual(3);
  });
});
