import { apply, legalCommands, newGame, viewFor, type Command, type GameState, type Seat, type TraceEvent } from '@keeps/engine';
import { BotPlayer } from './bot.ts';
import { heuristic, type HeuristicKind } from './heuristics.ts';
import type { Policy } from './policy.ts';

// Duplicate-deal matches between players of any kind (a bot policy, a
// heuristic, a random player), in TypeScript: each deal is played twice with
// the seats swapped, so the luck of the deal and of going first cancels out.

/** A player for one round at one seat. */
export interface SeatPlayer {
  choose(state: GameState, events: readonly TraceEvent[]): Command;
}

/** Makes a fresh player for a round at `seat`. */
export type Player = (seat: Seat, random: () => number) => SeatPlayer;

export const botPlayer =
  (policy: Policy): Player =>
  (seat, random) => {
    const bot = new BotPlayer(policy, seat, random);
    return { choose: (state, events) => bot.choose(state, events) };
  };

export const heuristicPlayer =
  (kind: HeuristicKind): Player =>
  (seat, random) => {
    const choose = heuristic(kind, random);
    return { choose: (state) => choose(viewFor(state, seat), legalCommands(state, seat).filter((c) => c.type !== 'next-round')) };
  };

/** Uniformly random among whole commands (not among action ids, like the Python evaluator's random player). */
export const randomPlayer: Player = (seat, random) => ({
  choose: (state) => {
    const legal = legalCommands(state, seat).filter((c) => c.type !== 'next-round');
    return legal[Math.floor(random() * legal.length)]!;
  },
});

export interface MatchResult {
  /** A's win rate over all rounds. */
  score: number;
  /** 95% interval half-width, from the per-deal scores. */
  ci95: number;
  asSeat0: number;
  asSeat2: number;
  deals: number;
  /** A's score on each deal (0, 0.5 or 1), for combining shards. */
  perDeal: number[];
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** The round's winner seat, A at `seatA`. */
function playRound(seed: string, a: Player, b: Player, seatA: Seat, random: () => number): Seat {
  let { state, events } = newGame({ players: 2, seed, marksToWin: 1 }) as { state: GameState; events: TraceEvent[] };
  const seatB = (seatA === 0 ? 2 : 0) as Seat;
  const players = new Map<Seat, SeatPlayer>([
    [seatA, a(seatA, random)],
    [seatB, b(seatB, random)],
  ]);
  for (let step = 0; state.phase === 'playing' || state.phase === 'post-round'; step++) {
    if (step > 5000) throw new Error(`round ${seed} did not end`);
    const seat = state.prompts[0]!.seat;
    const result = apply(state, seat, players.get(seat)!.choose(state, events), { trusted: true });
    if (!result.ok) throw new Error(`${seed}: ${result.error.message}`);
    state = result.state;
    events = [...events, ...result.events];
  }
  if (state.lastRoundWinner === null) throw new Error(`round ${seed} ended without a winner`);
  return state.lastRoundWinner;
}

/** A against B on `deals` deals (numbered from `first`, so shards can split a match), each played from both seats. */
export function match(a: Player, b: Player, deals: number, seed = 'match', first = 0): MatchResult {
  const random = rng(deals * 7919 + seed.length + first);
  const perDeal: number[] = [];
  let seat0 = 0;
  let seat2 = 0;
  for (let i = first; i < first + deals; i++) {
    const deal = `${seed}-${i}`;
    const w0 = playRound(deal, a, b, 0, random) === 0 ? 1 : 0;
    const w2 = playRound(deal, a, b, 2, random) === 2 ? 1 : 0;
    seat0 += w0;
    seat2 += w2;
    perDeal.push((w0 + w2) / 2);
  }
  const mean = perDeal.reduce((x, y) => x + y, 0) / deals;
  const variance = perDeal.reduce((x, y) => x + (y - mean) ** 2, 0) / Math.max(1, deals - 1);
  return { score: mean, ci95: 1.96 * Math.sqrt(variance / deals), asSeat0: seat0 / deals, asSeat2: seat2 / deals, deals, perDeal };
}
