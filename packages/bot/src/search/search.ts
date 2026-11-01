// Midstrike's search: Ataraxos-style update-equivalent search on top of the policy.
//
// At each of the bot's decisions with a real choice: sample hidden states exactly from the
// chance-only posterior given what the bot knows (worlds.ts), as many as the Evaluator was made
// for, play every legal command out to the end of the round in each world (the policy on both
// sides, in worker threads or on another machine), and choose by the rollouts (see SearchMode).
import { legalCommands, viewFor, type Command, type GameState, type Seat, type TraceEvent } from '@keeps/engine';
import { actionName, Decision, NUM_ACTIONS } from '../actions.ts';
import type { Belief } from '../belief.ts';
import { encodeObservation2 } from '../observation2.ts';
import type { BotPlayer } from '../bot.ts';
import type { Policy } from '../policy.ts';

/** A setting from the environment, where there is one (not in a browser). */
const env = (name: string): string | undefined => (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env[name];

/**
 * How the bot picks from the search.
 * 'best-q' (Midstrike's): the move with the best rollout value, the policy breaking near-ties (within tie(worlds)).
 * 'damped': one damped policy-improvement step, as Ataraxos's Stratego search takes (its
 * Table S12): a tabular step of magnetic mirror descent,
 *   pi'(c) ∝ [exp(Q(c)) · rho(c)^ALPHA · pi(c)^BETA]^(1 / (ALPHA + BETA)),
 * where Q is the command's average result (±1), pi the network's probability of the whole command, and
 * rho the magnet: uniform at each step of a decision, as VRPO's training regularizes towards. The step
 * stays close to the (near-equilibrium) policy, moving only where the values clearly say so. The bot's
 * move is sampled from pi'; training mode's advice shows pi''s most likely move.
 */
export type SearchMode = 'best-q' | 'damped';
export const ALPHA = Number(env('SEARCH_ALPHA') ?? 0.002);
export const BETA = Number(env('SEARCH_BETA') ?? 0.02);
/**
 * best-Q's near-tie margin for a search of `worlds` worlds: it shrinks as Q's noise does, as 1/√worlds, from 0.05 at
 * 512 (0.025 at 2,048, 0.14 at 64). Judged on held-out worlds (30 decisions of 8,192 worlds each, split), it loses
 * the least, or within 0.05 points of it, at every size from 16 to 2,048 worlds.
 */
const tie = (worlds: number) => 0.05 * Math.sqrt(512 / worlds);

/** What the bot thought at one decision, for the admin's insight page. Evaluations are its chance to win (0..1). */
export interface SearchReport {
  seat: Seat;
  turn: number;
  kind: string;
  /** The network's own estimate (value head) as the decision begins. */
  before: number | null;
  /** The rollouts' estimate for the move it played (null: only one legal move, no search). */
  after: number | null;
  worlds: number;
  ms: number;
  mode: SearchMode;
  overrode: boolean;
  /** Every candidate (reveals the bot's hand): its move, policy probability, rollout win chance, chosen. */
  moves: { move: string; policy: number; win: number; chosen: boolean; command: Command }[];
  /** Every playout's result for the searching seat (+1 won, -1 not), by world, in the order of `commands` (the round review reuses them). */
  outcomes?: { commands: Command[]; rows: number[][] };
}
const toWin = (v: number) => Math.min(1, Math.max(0, (v + 1) / 2));
let x = 7654321;
/** The search's own random stream (its damped choices, and RolloutPool's worlds). */
export const random = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;
/** Where each search's summary goes (its candidates reveal the bot's hand: keep it from a human opponent's screen). */
let log: (line: string) => void = (line) => console.log(line);
export function setSearchLog(sink: (line: string) => void): void {
  log = sink;
}

/** A search's expensive part: worlds sampled for `me` from its log, every command played out in each. */
export interface EvaluateJob {
  state: GameState;
  me: Seat;
  myLog: TraceEvent[];
  commands: Command[];
  /** Whether its result is still wanted (the game hasn't moved on): a pool may drop the rest of it, with Superseded. */
  wanted?: () => boolean;
}

/** A search dropped because the position it was for has passed. */
export class Superseded extends Error {
  constructor() {
    super('the position searched has passed');
    this.name = 'Superseded';
  }
}

/**
 * What runs it, with as many worlds as it was made for: a pool at a number of worlds (atWorlds), or another machine
 * (remote.ts). One row per world: ±1 per command, `me`'s result.
 */
export interface Evaluator {
  evaluate(job: EvaluateJob): Promise<number[][]>;
}

/** What plays out any number of worlds, `n` (rollout-pool.ts, batch-search.ts, the app's workers). */
export interface WorldsPool {
  evaluate(job: EvaluateJob & { n: number }): Promise<number[][]>;
}

/** `pool`, `worlds` worlds a search. */
export const atWorlds = (pool: WorldsPool, worlds: number): Evaluator => ({ evaluate: (job) => pool.evaluate({ ...job, n: worlds }) });

/** `prefix` completed with the policy's most likely id at each remaining step. */
function completeGreedily(decision: Decision, view: ReturnType<typeof viewFor>, belief: Belief, policy: Policy, prefix: number[]): number[] {
  const out = [...prefix];
  while (!decision.complete(out)) {
    const ids = decision.next(out);
    const mask = new Uint8Array(NUM_ACTIONS);
    for (const id of ids) mask[id] = 1;
    const p = policy.raw(encodeObservation2(view, belief, out, ids), mask);
    out.push(ids.reduce((best, id) => (p[id]! > p[best]! ? id : best), ids[0]!));
  }
  return out;
}

/**
 * The searched move's index, from the policy's prior, the magnet and the rollouts' Q (by `mode`), and the
 * search policy pi'. `by`: sample the move from pi' (the bot's play), or take its most likely (advice).
 */
function pick(mode: SearchMode, prior: number[], rho: number[], q: number[], worlds: number, by: 'sample' | 'mode'): { k: number; searched: number[] } {
  const total = prior.reduce((a, c) => a + c, 0);
  const logits = prior.map((p, k) => (q[k]! + ALPHA * Math.log(rho[k]!) + BETA * Math.log(p / total)) / (ALPHA + BETA));
  const m = Math.max(...logits);
  const weights = logits.map((l) => Math.exp(l - m));
  const z = weights.reduce((a, c) => a + c, 0);
  const searched = weights.map((w) => w / z);
  let k = 0;
  if (mode === 'best-q') {
    const top = Math.max(...q);
    const margin = tie(worlds);
    for (let i = 0; i < q.length; i++) if (q[i]! >= top - margin && (q[k]! < top - margin || prior[i]! > prior[k]!)) k = i;
  } else if (by === 'mode') {
    for (let i = 0; i < searched.length; i++) if (searched[i]! > searched[k]!) k = i;
  } else {
    let u = random();
    for (; k < searched.length - 1 && u >= searched[k]!; k++) u -= searched[k]!;
  }
  return { k, searched };
}

export interface SearchOptions {
  /** How it chooses (Midstrike's: best-q). */
  mode?: SearchMode;
  /** The search's report, once it's made. */
  report?: (r: SearchReport) => void;
  /** Called once the policy's view is known, before the rollouts: each candidate with its probability. */
  early?: (e: { before: number | null; moves: { move: string; policy: number; command: Command }[] }) => void;
  /** Sample the move from the search policy (the bot's own play), or take its most likely (training mode's advice). */
  by?: 'sample' | 'mode';
}

/** The bot's move, chosen by search. Updates the bot's belief exactly as BotPlayer.choose does. */
export async function searchChoose(
  bot: BotPlayer,
  state: GameState,
  events: readonly TraceEvent[],
  pool: Evaluator,
  { mode = 'best-q', report, early, by = 'sample' }: SearchOptions = {},
): Promise<Command> {
  const seat = bot.seat;
  const policy = bot.policy;
  const { view, log: myLog, belief } = bot.knowledge(state, events);
  const legal = legalCommands(state, seat);
  // (A decision with no moves would never complete below: a caller's mistake, said plainly.)
  if (!legal.length) throw new Error(`searchChoose: seat ${seat} has no move to make`);
  const decision = new Decision(view, legal);
  const first = decision.next([]);
  // Tithes' reorder lists no commands (any order of up to 12 cards is legal). The network orders the
  // pile one card at a time, each step a decision of its own: search each step in turn, the candidates
  // "this card next, then the policy's order for the rest", each step's candidates scored in the same sampled worlds.
  if (decision.encodings().length === 0) {
    const fixed: number[] = [];
    while (!decision.complete(fixed)) {
      const ids = decision.next(fixed);
      if (ids.length === 1) {
        fixed.push(ids[0]!);
        continue;
      }
      const mask = new Uint8Array(NUM_ACTIONS);
      for (const id of ids) mask[id] = 1;
      const p = policy.raw(encodeObservation2(view, belief, fixed, ids), mask);
      const prior = ids.map((id) => Math.max(p[id]!, 1e-9));
      const candidates = ids.map((id) => decision.complete(completeGreedily(decision, view, belief, policy, [...fixed, id]))!);
      const results = await pool.evaluate({ state, me: seat, myLog, commands: candidates });
      const q = candidates.map((_, k) => results.reduce((sum, r) => sum + r[k]!, 0) / results.length);
      fixed.push(ids[pick(mode, prior, ids.map(() => 1 / ids.length), q, results.length, by).k]!);
    }
    log(`[search] seat ${seat} turn ${state.turnNumber}: reorder searched card by card → ${fixed.map(actionName).join(' ')}`);
    return decision.complete(fixed)!;
  }
  const encodings = decision.encodings();
  const commands = encodings.map((ids) => decision.complete(ids)!);
  const before = policy.value(encodeObservation2(view, belief, [], first));
  const kind = state.prompts.find((p) => p.seat === seat)?.kind ?? '?';
  const base = { seat, turn: state.turnNumber, kind, before: before === null ? null : toWin(before), mode };
  if (encodings.length === 1) {
    report?.({ ...base, after: null, worlds: 0, ms: 0, overrode: false, moves: [] });
    return commands[0]!;
  }
  // The policy's probability of each whole command, and the magnet's (uniform at each step): products along its ids.
  const magnet = encodings.map((ids) => ids.reduce((r, _, i) => r / decision.next(ids.slice(0, i)).length, 1));
  const prior = encodings.map((ids) => {
    let p = 1;
    for (let i = 0; i < ids.length; i++) {
      const next = decision.next(ids.slice(0, i));
      const mask = new Uint8Array(NUM_ACTIONS);
      for (const id of next) mask[id] = 1;
      p *= policy.raw(encodeObservation2(view, belief, ids.slice(0, i), next), mask)[ids[i]!]!;
    }
    return Math.max(p, 1e-9);
  });
  const total = prior.reduce((a, c) => a + c, 0);
  early?.({ before: base.before, moves: encodings.map((ids, i) => ({ move: ids.map(actionName).join(' '), policy: prior[i]! / total, command: commands[i]! })) });
  const started = Date.now();
  const results = await pool.evaluate({ state, me: seat, myLog, commands });
  const q = commands.map((_, k) => results.reduce((s, r) => s + r[k]!, 0) / results.length);
  const { k, searched } = pick(mode, prior, magnet, q, results.length, by);
  const rows = encodings
    .map((ids, i) => ({ move: ids.map(actionName).join(' '), prior: prior[i]! / total, q: q[i]!, search: searched[i]!, chosen: i === k }))
    .sort((a, c) => c.search - a.search)
    .slice(0, 8);
  const favourite = prior.indexOf(Math.max(...prior));
  report?.({
    ...base,
    after: toWin(q[k]!),
    worlds: results.length,
    ms: Date.now() - started,
    overrode: k !== favourite,
    moves: encodings
      .map((ids, i) => ({ move: ids.map(actionName).join(' '), policy: prior[i]! / total, win: toWin(q[i]!), chosen: i === k, command: commands[i]! }))
      .sort((a, c) => c.win - a.win),
    outcomes: { commands, rows: results },
  });
  log(`[search${mode === 'best-q' ? ' best-q' : ''}] seat ${seat} turn ${state.turnNumber}: ${results.length} worlds × ${commands.length} moves in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  for (const r of rows)
    log(`  ${r.chosen ? '→' : ' '} ${r.move.padEnd(36)} policy ${(100 * r.prior).toFixed(0).padStart(3)}%  Q ${r.q >= 0 ? '+' : ''}${r.q.toFixed(2)}  search ${(100 * r.search).toFixed(0).padStart(3)}%`);
  return commands[k]!;
}

/**
 * Training mode's advice for the seat `advisor` follows, from the same search: the move the bot would
 * play there first, then the rest by their chance of winning the round. A move with nothing to compare
 * (one legal move, or a pile reorder, searched card by card) comes alone.
 */
export async function searchAdvise(
  advisor: BotPlayer,
  state: GameState,
  events: readonly TraceEvent[],
  pool: Evaluator,
  /** `report`: the search's full report (training mode's advice is also the round review's). */
  { mode, report }: Pick<SearchOptions, 'mode' | 'report'> = {},
): Promise<{ command: Command; probability: number; win?: number }[]> {
  let moves: SearchReport['moves'] = [];
  const command = await searchChoose(advisor, state, events, pool, {
    ...(mode ? { mode } : {}),
    report: (r) => {
      moves = r.moves;
      report?.(r);
    },
    by: 'mode',
  });
  if (moves.length === 0) return [{ command, probability: 1 }];
  const ranked = [...moves].sort((a, b) => Number(b.chosen) - Number(a.chosen) || b.win - a.win);
  return ranked.map((m) => ({ command: m.command, probability: m.policy, win: m.win }));
}
