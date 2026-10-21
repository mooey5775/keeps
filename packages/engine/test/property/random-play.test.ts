import { describe, expect, it } from 'vitest';
import {
  apply,
  buildPosition,
  checkInvariants,
  checkRestInvariants,
  legalCommands,
  pick,
  playerSeats,
  seedRng,
  shuffle,
  type CardId,
  type GameState,
  type PerSeat,
  type SeatKind,
} from '../../src/index.ts';

// Random legal play over the cards implemented so far. Grows into the full
// property suite (docs/ENGINE.md) once every card is implemented.

const IMPLEMENTED: CardId[] = [
  'count-token', 'chalice', 'dagger', 'medallion', 'scepter', 'timepiece', 'faberge-egg',
  'fool-token', 'friar-token', 'hocus-pocus', 'juggling', 'sanction', 'acquisition',
  'blunder', 'shackles', 'purity', 'tithes', 'requisition', 'epiphany', 'prayer',
  'resurrection', 'providence', 'pandemonium', 'revelation', 'royal-favor', 'interest',
  'retribution', 'joker', 'legerdemain', 'pickpocket', 'pluck', 'offering', 'invocation',
  'fiat', 'last-laugh',
];

const SEATINGS: PerSeat<SeatKind>[] = [
  ['player', 'player', 'player', 'player'],
  ['player', 'ghost', 'player', 'player'],
  ['player', 'ghost', 'player', 'ghost'],
];

function randomRound(seed: number): { state: GameState; commands: number } {
  const rng = seedRng(`random-play-${seed}`);
  const cards = shuffle(rng, [...IMPLEMENTED]);
  const seats = pick(rng, SEATINGS);
  const piles: Record<number, CardId[]> = { 0: [], 1: [], 2: [], 3: [] };
  cards.forEach((card, i) => piles[i % 4]!.push(card));
  let state = buildPosition({ seats, piles, turn: pick(rng, [0, 2] as const), seed });

  let commands = 0;
  while (state.phase === 'playing' || state.phase === 'post-round') {
    const options = playerSeats(state).flatMap((seat) => legalCommands(state, seat).map((c) => ({ seat, c })));
    expect(options.length, 'deadlock: nobody has a legal command').toBeGreaterThan(0);
    const { seat, c } = pick(rng, options);
    const result = apply(state, seat, c);
    if (!result.ok) expect.fail(`seed ${seed}: ${result.error.code}: ${result.error.message}`);
    state = result.state;
    expect(checkInvariants(state)).toEqual([]);
    expect(checkRestInvariants(state)).toEqual([]);
    expect(++commands).toBeLessThan(500);
  }
  return { state, commands };
}

describe('random play (implemented cards only)', () => {
  it('always finishes the round with valid states and a single winner', () => {
    for (let seed = 0; seed < 300; seed++) {
      const { state } = randomRound(seed);
      expect(['round-over', 'game-over']).toContain(state.phase);
      expect(state.marks.reduce((a, b) => a + b)).toBe(1);
    }
  });

  it('replays identically from the same seed', () => {
    expect(randomRound(7)).toEqual(randomRound(7));
  });
});
