import { describe, expect, it } from 'vitest';
import {
  apply,
  buildPosition,
  checkInvariants,
  checkRestInvariants,
  legalCommands,
  newGame,
  pick,
  playerSeats,
  seedRng,
  type GameState,
} from '../../src/index.ts';
import { act, draw, ok, payloads, types } from '../helpers.ts';

// Across rounds: what carries over (marks, seating, who starts), what resets
// (every zone, the turn counter, half-finished plays), and how the game ends.

const nextRound = (state: GameState) => ok(apply(state, state.lastRoundWinner ?? 0, { type: 'next-round' }));

/** Plays random legal commands until the round is scored. */
function finishRound(state: GameState, seed: string): GameState {
  const rng = seedRng(seed);
  for (let i = 0; state.phase === 'playing' || state.phase === 'post-round'; i++) {
    if (i > 2000) throw new Error('round did not end');
    const options = playerSeats(state).flatMap((seat) => legalCommands(state, seat).map((command) => ({ seat, command })));
    const choice = pick(rng, options);
    state = ok(apply(state, choice.seat, choice.command)).state;
  }
  return state;
}

describe('between rounds', () => {
  it('a new round resets every zone and redeals all 36 cards, keeping marks and seats', () => {
    const start = buildPosition({
      seats: ['player', 'ghost', 'player', 'player'],
      keeps: { 0: ['chalice', 'retribution'], 2: ['dagger'] },
      hands: { 3: ['joker'] },
      discard: ['pluck'],
      marks: [1, 0, 0, 1],
      round: 3,
      turn: 0,
    });
    const ended = draw(start, 0).state;
    const next = nextRound(ended).state;
    expect(next.round).toBe(4);
    expect(next.config.seats).toEqual(['player', 'ghost', 'player', 'player']);
    expect(next.marks).toEqual([1, 0, 0, 1].map((m, s) => m + (s === ended.lastRoundWinner ? 1 : 0)));
    expect(next.keeps.flat()).toEqual([]);
    expect(next.hands.flat()).toEqual([]);
    expect(next.discard).toEqual([]);
    expect(next.box).toEqual([]);
    expect(next.openPlays).toEqual([]);
    expect(next.roundEnd).toBeNull();
    expect(next.turnNumber).toBe(1);
    expect(Object.values(next.piles).map((p) => p.cards.length)).toEqual([9, 9, 9, 9]);
    expect(checkInvariants(next)).toEqual([]);
    expect(checkRestInvariants(next)).toEqual([]);
  });

  it('each round deals a different layout', () => {
    let state = newGame({ players: 4, seed: 'layouts', marksToWin: 5 }).state;
    const layouts = new Set<string>();
    for (let round = 0; round < 4; round++) {
      layouts.add(Object.values(state.piles).map((p) => p.cards.map((c) => c.id).join()).join('|'));
      state = nextRound(finishRound(state, `layouts-${round}`)).state;
    }
    expect(layouts.size).toBe(4);
  });

  it("the round's winner starts the next round, even a winner by Tokens", () => {
    const start = buildPosition({ keeps: { 2: ['count-token', 'fool-token'] }, hands: { 0: ['friar-token'] }, turn: 0 });
    const won = act(start, 0, { action: 'play', card: 'friar-token', target: 2 }).state;
    expect(nextRound(won).state.turn?.seat).toBe(2);
  });

  it('the turn number restarts each round', () => {
    const start = buildPosition({ piles: { 0: ['chalice', 'medallion'], 1: ['dagger', 'scepter'] }, turn: 0 });
    let state = draw(draw(start, 0).state, 0).state;
    expect(state.turnNumber).toBe(2);
    state = draw(state, 1).state;
    state = draw(state, 1).state;
    expect(state.turnNumber).toBe(3);
    state = draw(state, 2).state; // empty: round ends
    expect(nextRound(state).state.turnNumber).toBe(1);
  });

  it('any player may start the next round, but only once', () => {
    const start = buildPosition({ turn: 0 });
    const ended = draw(start, 0).state;
    const by2 = ok(apply(ended, 2, { type: 'next-round' })).state;
    expect(by2.round).toBe(2);
    expect(apply(by2, 3, { type: 'next-round' }).ok).toBe(false);
  });

  it('a next-round started during the post-round phase is rejected', () => {
    const start = buildPosition({ keeps: { 0: ['last-laugh'] }, hands: { 0: ['chalice'] }, turn: 0 });
    const ended = draw(start, 0).state;
    expect(ended.phase).toBe('post-round');
    expect(apply(ended, 1, { type: 'next-round' }).ok).toBe(false);
  });
});

describe('ending the game', () => {
  it('marks accumulate across rounds until someone reaches the target', () => {
    let state = newGame({ players: 3, seed: 'to-the-end', marksToWin: 3 }).state;
    let rounds = 0;
    while (state.phase !== 'game-over') {
      state = finishRound(state, `end-${rounds}`);
      rounds++;
      const total = state.marks.reduce((a, b) => a + b, 0);
      expect(total).toBe(rounds);
      if (state.phase === 'round-over') state = nextRound(state).state;
      expect(rounds).toBeLessThan(20);
    }
    expect(Math.max(...state.marks)).toBe(3);
    expect(rounds).toBeGreaterThanOrEqual(3);
    for (const seat of [0, 1, 2, 3] as const) expect(legalCommands(state, seat)).toEqual([]);
  });

  it('ghost seats never earn marks', () => {
    let state = newGame({ players: 2, seed: 'ghost-marks', marksToWin: 4 }).state;
    for (let round = 0; state.phase !== 'game-over' && round < 12; round++) {
      state = finishRound(state, `ghost-${round}`);
      for (const seat of [0, 1, 2, 3] as const) {
        if (state.config.seats[seat] === 'ghost') expect(state.marks[seat]).toBe(0);
      }
      if (state.phase === 'round-over') state = nextRound(state).state;
    }
  });

  it('the game-over event names the winner once, in the round that decides it', () => {
    const start = buildPosition({ keeps: { 1: ['chalice'] }, marks: [2, 2, 0, 0], marksToWin: 3, turn: 0 });
    const { events } = draw(start, 0);
    expect(payloads(events, 'game-over')).toEqual([{ type: 'game-over', winner: 1 }]);
    expect(types(events).filter((t) => t === 'mark')).toHaveLength(1);
  });
});

describe('turn order', () => {
  it('play passes left around four players and keeps going around', () => {
    let state = buildPosition({
      piles: { 0: ['chalice', 'dagger', 'scepter', 'medallion'], 1: ['timepiece', 'faberge-egg', 'joker', 'pluck'], 2: ['prayer', 'requisition', 'epiphany', 'offering'], 3: ['providence', 'resurrection', 'purity', 'interest'] },
      turn: 2,
    });
    const order: number[] = [];
    for (let i = 0; i < 6; i++) {
      const seat = state.turn!.seat;
      order.push(seat);
      state = draw(draw(state, seat).state, seat).state;
    }
    expect(order).toEqual([2, 3, 0, 1, 2, 3]);
  });

  it("three players with the ghost at seat 0 skip seat 0", () => {
    let state = buildPosition({
      seats: ['ghost', 'player', 'player', 'player'],
      piles: { 1: ['chalice', 'dagger'], 2: ['timepiece', 'faberge-egg'], 3: ['joker', 'pluck', 'prayer', 'epiphany'] },
      turn: 3,
    });
    const order: number[] = [];
    for (let i = 0; i < 4; i++) {
      const seat = state.turn!.seat;
      order.push(seat);
      state = draw(draw(state, seat).state, seat).state;
    }
    expect(order).toEqual([3, 1, 2, 3]);
  });

  it('a tie with a ghost seat between: the ghost is skipped when looking left of the ender', () => {
    const start = buildPosition({
      seats: ['player', 'ghost', 'player', 'player'],
      keeps: { 0: ['chalice'], 2: ['dagger'], 3: ['scepter'] },
      turn: 0,
    });
    // Left of S0: S1 (ghost, skipped), S2. S2 wins over S3 and S0.
    expect(payloads(draw(start, 0).events, 'score')[0]).toMatchObject({ winner: 2, tiedWith: [3, 0] });
  });

  it('a half-coin settles what would otherwise be a tie', () => {
    const start = buildPosition({ keeps: { 1: ['chalice'], 2: ['dagger', 'royal-favor'] }, turn: 0 });
    expect(payloads(draw(start, 0).events, 'score')[0]).toMatchObject({ scores: [0, 4, 5, 0], winner: 2, tiedWith: [] });
  });
});
