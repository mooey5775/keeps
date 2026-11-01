import { describe, expect, it } from 'vitest';
import { apply, buildPosition, legalCommands, newGame, replay, type Command, type GameState, type ReplayLog, type Seat } from '../../src/index.ts';

// Leaving (docs/ENGINE.md, "Leaving"): a player leaves the game, giving it up, at any time until it's over. Their seat is a
// ghost from then on, holding nothing; with one player left, they win the game; otherwise a round in play ends with no
// winner, and the next is dealt without them.

const LEAVE: Command = { type: 'leave' };
const TWO = ['player', 'ghost', 'player', 'ghost'] as const;

function applied(state: GameState, seat: Seat, command: Command) {
  const result = apply(state, seat, command);
  if (!result.ok) throw new Error(`${JSON.stringify(command)} by ${seat} refused: ${result.error.message}`);
  return result;
}

/** `state` played on by any legal moves (seeded), `steps` of them or until the round or game is over. */
function playOn(state: GameState, steps: number, seed = 7): GameState {
  let x = seed;
  for (let i = 0; i < steps && state.phase === 'playing'; i++) {
    const seat = state.prompts[0]!.seat;
    const legal = legalCommands(state, seat).filter((c) => c.type !== 'reveal-duplicity');
    x = (Math.imul(x, 48271) + 11) >>> 0;
    state = applied(state, seat, legal[x % legal.length]!).state;
  }
  return state;
}

describe('leaving', () => {
  it('in a game of two ends the game: the other player wins it, and the one who left holds nothing', () => {
    const start = buildPosition({ seats: [...TWO], hands: { 2: ['chalice'] }, keeps: { 2: ['dagger'] }, piles: { 0: ['?'], 2: ['?'] }, turn: 0 });
    // (Not on their turn: leaving is open at any time.)
    const { state, events } = applied(start, 2, LEAVE);
    expect(events.map((e) => e.payload.type)).toEqual(['left', 'discard', 'discard', 'game-over']);
    expect(state.phase).toBe('game-over');
    expect(state.lastRoundWinner).toBe(0);
    expect(state.roundEnd).toEqual({ kind: 'left', seat: 2 });
    expect(state.config.seats[2]).toBe('ghost');
    expect([state.hands[2], state.keeps[2]]).toEqual([[], []]);
    expect(state.discard.slice(-2)).toEqual(['chalice', 'dagger']);
    expect([state.prompts, state.stack, state.turn]).toEqual([[], [], null]);
    // Over: nothing more, leaving included.
    expect(apply(state, 0, LEAVE).ok).toBe(false);
    expect(legalCommands(state, 0)).toEqual([]);
  });

  it('in a game of four ends the round in play with no winner, and the next is dealt without them', () => {
    const start = buildPosition({ hands: { 1: ['chalice'] }, keeps: { 1: ['dagger'] }, piles: { 0: ['?'], 1: ['?'], 2: ['?'], 3: ['?'] }, turn: 0, marks: [1, 0, 0, 0] });
    const { state, events } = applied(start, 1, LEAVE);
    expect(events.map((e) => e.payload.type)).toEqual(['left', 'discard', 'discard', 'round-end']);
    expect(state.phase).toBe('round-over');
    expect(state.lastRoundWinner).toBeNull();
    expect(state.roundEnd).toEqual({ kind: 'left', seat: 1 });
    expect(state.marks).toEqual([1, 0, 0, 0]);
    expect(state.config.seats).toEqual(['player', 'ghost', 'player', 'player']);
    // The next round: dealt without them; they never have a turn or a decision (invariants checked at every move).
    let next = applied(state, 0, { type: 'next-round' }).state;
    expect(next.startingSeat).not.toBe(1);
    expect(next.hands[1]).toEqual([]);
    next = playOn(next, 100);
    expect(next.round).toBe(start.round + 1);
  });

  it('leaves the last player the winner of the game', () => {
    const start = buildPosition({ seats: ['player', 'player', 'player', 'ghost'], piles: { 0: ['?'], 1: ['?'], 2: ['?'] }, turn: 0 });
    const once = applied(start, 0, LEAVE).state;
    expect(once.phase).toBe('round-over');
    const dealt = applied(once, 1, { type: 'next-round' }).state;
    const { state, events } = applied(dealt, 1, LEAVE);
    expect(events.map((e) => e.payload.type).at(-1)).toBe('game-over');
    expect(state.phase).toBe('game-over');
    expect(state.lastRoundWinner).toBe(2);
  });

  it('between rounds: the round goes on being over, and a winner of it who leaves does not start the next', () => {
    const over = { ...buildPosition({ piles: { 0: ['?'] } }), phase: 'round-over' as const, lastRoundWinner: 2 as Seat };
    const { state, events } = applied(over, 2, LEAVE);
    expect(events.map((e) => e.payload.type)).toEqual(['left']);
    expect(state.phase).toBe('round-over');
    expect(state.lastRoundWinner).toBeNull();
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const next = applied({ ...state, rng: buildPosition({ seed }).rng }, 0, { type: 'next-round' }).state;
      expect(next.startingSeat).not.toBe(2);
    }
  });

  it("discards the face-down cards the one who left placed in others' keeps (a ghost places nothing)", () => {
    const start = buildPosition({ seats: [...TWO], keeps: { 0: ['dagger', { id: 'fiat', faceDown: { placedBy: 2 } }] }, piles: { 0: ['?'], 2: ['?'] }, turn: 0 });
    const { state } = applied(start, 2, LEAVE);
    expect(state.keeps[0]).toEqual([{ id: 'dagger' }]);
    expect(state.discard).toContain('fiat');
  });

  it("isn't open to a ghost", () => {
    const start = buildPosition({ seats: [...TWO], piles: { 0: ['?'] }, turn: 0 });
    const result = apply(start, 1, LEAVE);
    expect(result.ok ? null : result.error.code).toBe('not-a-player');
  });

  it('replays: a game someone left is the same game replayed from its log', () => {
    let { state } = newGame({ players: 4, seed: 'leaving' });
    const log: ReplayLog = { options: { players: 4, seed: 'leaving' }, commands: [] };
    const play = (seat: Seat, command: Command) => {
      state = applied(state, seat, command).state;
      log.commands.push({ seat, command });
    };
    for (let i = 0; i < 12; i++) {
      const seat = state.prompts[0]!.seat;
      play(seat, legalCommands(state, seat).find((c) => c.type !== 'reveal-duplicity')!);
    }
    play(3, LEAVE);
    play(0, { type: 'next-round' });
    play(2, LEAVE);
    expect(replay(log).state).toEqual(state);
  });
});
