import { describe, expect, it } from 'vitest';
import {
  apply,
  CARDS,
  leftOf,
  legalCommands,
  newGame,
  pick,
  playerSeats,
  seedRng,
  type GameState,
  type Seat,
  type TraceEvent,
  type TracePayload,
} from '../../src/index.ts';

// Rule-level invariants, checked over the full trace of many random games.
// Structural invariants (every card in one place, no held HOT cards) are
// checked elsewhere; these check that the game followed the rules.

interface Game {
  seats: GameState['config']['seats'];
  events: TraceEvent[];
  /** State right after each command, for checks that need it. */
  states: GameState[];
}

function playGame(seed: number): Game {
  const players = (2 + (seed % 3)) as 2 | 3 | 4;
  const rng = seedRng(`rule-invariants-${seed}`);
  const start = newGame({ players, seed: `rule-invariants-${seed}`, marksToWin: 3 });
  let state = start.state;
  const events = [...start.events];
  const states = [state];
  while (state.phase !== 'game-over') {
    const options = playerSeats(state).flatMap((s) => legalCommands(state, s).map((command) => ({ seat: s, command })));
    const choice = pick(rng, options);
    const result = apply(state, choice.seat, choice.command);
    if (!result.ok) throw new Error(result.error.message);
    state = result.state;
    events.push(...result.events);
    states.push(state);
  }
  return { seats: state.config.seats, events, states };
}

const GAMES = Array.from({ length: 45 }, (_, i) => playGame(i));

function each(check: (game: Game, bySeq: Map<number, TraceEvent>) => void) {
  for (const game of GAMES) check(game, new Map(game.events.map((e) => [e.seq, e])));
}

const is = <T extends TracePayload['type']>(e: TraceEvent | undefined, type: T): e is TraceEvent & { payload: Extract<TracePayload, { type: T }> } =>
  e?.payload.type === type;

describe('rule invariants over random games', () => {
  it('a HOT play is never caused directly by an action; a normal play always is', () => {
    let hot = 0;
    each((game, bySeq) => {
      for (const e of game.events) {
        if (!is(e, 'play')) continue;
        const cause = e.cause === null ? undefined : bySeq.get(e.cause);
        if (e.payload.hot) {
          hot++;
          expect(cause?.payload.type, `#${e.seq}`).not.toBe('action');
        } else {
          expect(is(cause, 'action'), `#${e.seq} ${e.payload.card}`).toBe(true);
          if (is(cause, 'action')) {
            expect(cause.payload.choice).toMatchObject({ action: 'play', card: e.payload.card });
            expect(cause.payload.seat).toBe(e.payload.seat);
          }
        }
      }
    });
    expect(hot).toBeGreaterThan(100);
  });

  it('only Keep cards go into keeps; everything else is discarded', () => {
    each((game) => {
      for (const e of game.events) {
        if (!is(e, 'play')) continue;
        const def = CARDS[e.payload.card];
        if (def.keep) expect(e.payload.target).not.toBeNull();
        else expect(e.payload.target).toBeNull();
        if (e.payload.card === 'blunder') expect(e.payload.target).toBe(e.payload.seat);
        if (e.payload.target !== null) expect(game.seats[e.payload.target]).toBe('player');
      }
    });
  });

  it('a draw from an empty pile during play always ends the round, with the drawer as ender', () => {
    each((game) => {
      game.events.forEach((e, i) => {
        if (!is(e, 'empty-draw') || e.payload.afterRoundEnd) return;
        const next = game.events[i + 1];
        expect(next?.payload).toEqual({ type: 'round-end', reason: 'empty-pile', ender: e.payload.seat });
      });
    });
  });

  it('every round produces exactly one mark, and the game ends at the target', () => {
    each((game) => {
      const rounds = game.events.filter((e) => is(e, 'round-start')).length;
      const marks = game.events.filter((e) => is(e, 'mark'));
      expect(marks).toHaveLength(rounds);
      const final = game.states.at(-1)!;
      expect(Math.max(...final.marks)).toBe(3);
      expect(game.events.filter((e) => is(e, 'game-over'))).toHaveLength(1);
    });
  });

  it('a scored round goes to the player with the most coins, ties left of the ender', () => {
    each((game) => {
      game.events.forEach((e, i) => {
        if (!is(e, 'score')) return;
        const end = game.events.slice(0, i).findLast((x) => is(x, 'round-end'));
        if (!is(end, 'round-end') || end.payload.reason !== 'empty-pile') throw new Error('score without an empty-pile end');
        const scores = e.payload.scores;
        const best = Math.max(...scores.filter((s): s is number => s !== null));
        const order: Seat[] = [];
        for (let s = leftOf(end.payload.ender); order.length < 4; s = leftOf(s)) order.push(s);
        expect(e.payload.winner).toBe(order.find((s) => scores[s] === best));
      });
    });
  });

  it('Retribution never fires for the player who made the play', () => {
    let fired = 0;
    each((game, bySeq) => {
      for (const e of game.events) {
        if (!is(e, 'triggers')) continue;
        const play = e.cause === null ? undefined : bySeq.get(e.cause);
        if (!is(play, 'play')) throw new Error(`triggers #${e.seq} not caused by a play`);
        for (const t of e.payload.triggers) {
          if (t.kind !== 'retribution') continue;
          fired++;
          expect(t.seat).not.toBe(play.payload.seat);
        }
      }
    });
    expect(fired).toBeGreaterThan(5);
  });

  it('triggers are always listed Retribution, then Interest, then Royal Favor', () => {
    const rank = { retribution: 0, interest: 1, 'royal-favor': 2 } as const;
    each((game) => {
      for (const e of game.events) {
        if (!is(e, 'triggers')) continue;
        const ranks = e.payload.triggers.map((t) => rank[t.kind]);
        expect(ranks).toEqual([...ranks].sort());
      }
    });
  });

  it('turns go left, skipping ghosts; each round starts with the previous round’s winner', () => {
    each((game) => {
      let previous: Seat | null = null;
      let lastWinner: Seat | null = null;
      for (const e of game.events) {
        if (is(e, 'round-start')) {
          if (lastWinner !== null) expect(e.payload.startingSeat).toBe(lastWinner);
          previous = null;
        } else if (is(e, 'mark')) {
          lastWinner = e.payload.seat;
        } else if (is(e, 'turn-start')) {
          expect(game.seats[e.payload.seat]).toBe('player');
          if (previous !== null) {
            let expected = leftOf(previous);
            while (game.seats[expected] !== 'player') expected = leftOf(expected);
            expect(e.payload.seat).toBe(expected);
          }
          previous = e.payload.seat;
        }
      }
    });
  });

  it('a turn starts with one action exactly when Shackles is face up in that player’s keep', () => {
    const seen = { shackled: 0, free: 0 };
    each((game) => {
      for (let i = 0; i < game.states.length; i++) {
        const state = game.states[i]!;
        // Look at states sitting on a fresh turn: the turn frame is untouched.
        const frame = state.stack[0];
        if (state.phase !== 'playing' || !state.turn || state.turn.actionsTaken !== 0 || frame?.op !== 'action-frame') continue;
        if (frame.kind !== 'turn' || state.stack.length !== 1) continue;
        // (A Shackles revealed before the first action is face up too, so it counts the same.)
        const shackled = state.keeps[state.turn.seat].some((c) => c.id === 'shackles' && !c.faceDown);
        expect(frame.remaining).toBe(shackled ? 1 : 2);
        seen[shackled ? 'shackled' : 'free']++;
      }
    });
    expect(seen.shackled).toBeGreaterThan(5);
    expect(seen.free).toBeGreaterThan(500);
  });

  it('Last Laugh acts only after an empty-pile round end, never after a token victory', () => {
    each((game) => {
      game.events.forEach((e, i) => {
        if (!is(e, 'last-laugh')) return;
        const end = game.events.slice(0, i).findLast((x) => is(x, 'round-end') || is(x, 'round-start'));
        expect(is(end, 'round-end') && end.payload.reason === 'empty-pile').toBe(true);
      });
    });
  });
});
