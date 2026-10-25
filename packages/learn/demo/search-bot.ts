// Search bot for the demo server: Ataraxos-style update-equivalent search on top of the policy.
//
// At each of the bot's decisions with a real choice: sample WORLDS hidden states exactly from
// the chance-only posterior given what the bot knows (packages/learn/src/worlds.ts), play every
// legal command out to the end of the round in each world (the policy on both sides, in worker
// threads), and take one damped policy-improvement step from the network's policy (see `mode`).
import { Worker } from 'node:worker_threads';
import {
  eventsFor,
  legalCommands,
  viewFor,
  type Command,
  type GameState,
  type Seat,
  type TraceEvent,
} from '../../engine/src/index.ts';
import { actionName, Decision, NUM_ACTIONS } from '../src/actions.ts';
import { Belief } from '../src/belief.ts';
import { sampleWorld, worldModel } from '../src/worlds.ts';
import { encodeObservation2 } from '../src/observation2.ts';
import type { BotPlayer } from '../src/bot.ts';
import type { Policy } from '../src/policy.ts';

export let WORLDS = Number(process.env.SEARCH_WORLDS ?? 256);
export function setWorlds(n: number): void {
  WORLDS = n;
}
/**
 * How the bot picks from the search.
 * 'damped' (the default): one damped policy-improvement step, as Ataraxos's Stratego search takes (its
 * Table S12): a tabular step of magnetic mirror descent,
 *   pi'(c) ∝ [exp(Q(c)) · rho(c)^ALPHA · pi(c)^BETA]^(1 / (ALPHA + BETA)),
 * where Q is the command's average result (±1), pi the network's probability of the whole command, and
 * rho the magnet: uniform at each step of a decision, as VRPO's training regularizes towards. The step
 * stays close to the (near-equilibrium) policy, moving only where the values clearly say so. The bot's
 * move is sampled from pi'; training mode's advice shows pi''s most likely move.
 * 'best-q': the move with the best rollout value, the policy breaking near-ties (within TIE).
 */
export const ALPHA = Number(process.env.SEARCH_ALPHA ?? 0.002);
export const BETA = Number(process.env.SEARCH_BETA ?? 0.02);
let mode: 'damped' | 'best-q' = process.env.SEARCH_MODE === 'best-q' ? 'best-q' : 'damped';
export function setSearchMode(m: 'damped' | 'best-q'): void {
  mode = m;
}
const TIE = 0.05;

/** What the bot thought at one decision, for the demo's insight page. Evaluations are its chance to win (0..1). */
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
  mode: 'damped' | 'best-q';
  overrode: boolean;
  /** Every candidate (reveals the bot's hand): its move, policy probability, rollout win chance, chosen. */
  moves: { move: string; policy: number; win: number; chosen: boolean; command: Command }[];
  /** Every playout's result for the searching seat (+1 won, -1 not), by world, in the order of `commands` (the round review reuses them). */
  outcomes?: { commands: Command[]; rows: number[][] };
}
const toWin = (v: number) => Math.min(1, Math.max(0, (v + 1) / 2));
let x = 7654321;
const random = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;
/** Where each search's summary goes (its candidates reveal the bot's hand: keep it from a human opponent's screen). */
let log: (line: string) => void = (line) => console.log(line);
export function setSearchLog(sink: (line: string) => void): void {
  log = sink;
}

/** Worker threads that play out commands in sampled worlds. */
export class RolloutPool {
  private readonly workers: Worker[];
  private next = 0;
  private readonly waiting = new Map<number, { resolve: (out: number[]) => void; reject: (e: Error) => void }>();
  private id = 0;

  /** `sampled`: rollouts sample the policy (as the bot plays it) instead of taking its most likely id. */
  constructor(size: number, weights: string, sampled = process.env.SEARCH_ROLLOUTS === 'sampled') {
    this.workers = Array.from({ length: size }, () => {
      const w = new Worker(new URL('./rollout-worker.ts', import.meta.url), { workerData: { weights, sampled } });
      w.on('message', (m: { id: number; out?: number[]; error?: string }) => {
        const job = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        if (m.error) job?.reject(new Error(m.error));
        else job?.resolve(m.out!);
      });
      return w;
    });
  }

  run(job: { world: GameState; events: TraceEvent[]; myLog: TraceEvent[]; me: Seat; commands: Command[] }): Promise<number[]> {
    const id = this.id++;
    const worker = this.workers[this.next++ % this.workers.length]!;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      worker.postMessage({ id, ...job });
    });
  }
}

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
function pick(prior: number[], rho: number[], q: number[], by: 'sample' | 'mode'): { k: number; searched: number[] } {
  const total = prior.reduce((a, c) => a + c, 0);
  const logits = prior.map((p, k) => (q[k]! + ALPHA * Math.log(rho[k]!) + BETA * Math.log(p / total)) / (ALPHA + BETA));
  const m = Math.max(...logits);
  const weights = logits.map((l) => Math.exp(l - m));
  const z = weights.reduce((a, c) => a + c, 0);
  const searched = weights.map((w) => w / z);
  let k = 0;
  if (mode === 'best-q') {
    const top = Math.max(...q);
    for (let i = 0; i < q.length; i++) if (q[i]! >= top - TIE && (q[k]! < top - TIE || prior[i]! > prior[k]!)) k = i;
  } else if (by === 'mode') {
    for (let i = 0; i < searched.length; i++) if (searched[i]! > searched[k]!) k = i;
  } else {
    let u = random();
    for (; k < searched.length - 1 && u >= searched[k]!; k++) u -= searched[k]!;
  }
  return { k, searched };
}

/** The bot's move, chosen by search. Updates the bot's belief exactly as BotPlayer.choose does. */
export async function searchChoose(
  bot: BotPlayer,
  state: GameState,
  events: readonly TraceEvent[],
  pool: RolloutPool,
  report?: (r: SearchReport) => void,
  /** Called once the policy's view is known, before the rollouts: each candidate with its probability. */
  early?: (e: { before: number | null; moves: { move: string; policy: number; command: Command }[] }) => void,
  /** Sample the move from the search policy (the bot's own play), or take its most likely (training mode's advice). */
  by: 'sample' | 'mode' = 'sample',
): Promise<Command> {
  const b = bot as unknown as { log: TraceEvent[]; read: number; belief: Belief; policy: Policy; seat: Seat };
  const seat = b.seat;
  b.log.push(...eventsFor(events.slice(b.read), seat));
  b.read = events.length;
  const view = viewFor(state, seat);
  b.belief.update(b.log).observe(view);
  const decision = new Decision(view, legalCommands(state, seat));
  const first = decision.next([]);
  // Tithes' reorder lists no commands (any order of up to 12 cards is legal). The network orders the
  // pile one card at a time, each step a decision of its own: search each step in turn, the candidates
  // "this card next, then the policy's order for the rest", all scored in the same sampled worlds.
  if (decision.encodings().length === 0) {
    const model = worldModel(state, seat, b.belief, view);
    const worlds = Array.from({ length: WORLDS }, () => sampleWorld(model, state, b.belief, random));
    const fixed: number[] = [];
    while (!decision.complete(fixed)) {
      const ids = decision.next(fixed);
      if (ids.length === 1) {
        fixed.push(ids[0]!);
        continue;
      }
      const mask = new Uint8Array(NUM_ACTIONS);
      for (const id of ids) mask[id] = 1;
      const p = b.policy.raw(encodeObservation2(view, b.belief, fixed, ids), mask);
      const prior = ids.map((id) => Math.max(p[id]!, 1e-9));
      const candidates = ids.map((id) => decision.complete(completeGreedily(decision, view, b.belief, b.policy, [...fixed, id]))!);
      const results = await Promise.all(worlds.map((world) => pool.run({ world, events: [...events], myLog: [...b.log], me: seat, commands: candidates })));
      const q = candidates.map((_, k) => results.reduce((sum, r) => sum + r[k]!, 0) / results.length);
      fixed.push(ids[pick(prior, ids.map(() => 1 / ids.length), q, by).k]!);
    }
    log(`[search] seat ${seat} turn ${state.turnNumber}: reorder searched card by card → ${fixed.map(actionName).join(' ')}`);
    return decision.complete(fixed)!;
  }
  const encodings = decision.encodings();
  const commands = encodings.map((ids) => decision.complete(ids)!);
  const before = b.policy.value(encodeObservation2(view, b.belief, [], first));
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
      p *= b.policy.raw(encodeObservation2(view, b.belief, ids.slice(0, i), next), mask)[ids[i]!]!;
    }
    return Math.max(p, 1e-9);
  });
  const total = prior.reduce((a, c) => a + c, 0);
  early?.({ before: base.before, moves: encodings.map((ids, i) => ({ move: ids.map(actionName).join(' '), policy: prior[i]! / total, command: commands[i]! })) });
  const started = Date.now();
  const model = worldModel(state, seat, b.belief, view);
  const worlds = Array.from({ length: WORLDS }, () => sampleWorld(model, state, b.belief, random));
  const myLog = [...b.log];
  const plainEvents = [...events];
  const results = await Promise.all(worlds.map((world) => pool.run({ world, events: plainEvents, myLog, me: seat, commands })));
  const q = commands.map((_, k) => results.reduce((s, r) => s + r[k]!, 0) / results.length);
  const { k, searched } = pick(prior, magnet, q, by);
  const rows = encodings
    .map((ids, i) => ({ move: ids.map(actionName).join(' '), prior: prior[i]! / total, q: q[i]!, search: searched[i]!, chosen: i === k }))
    .sort((a, c) => c.search - a.search)
    .slice(0, 8);
  const favourite = prior.indexOf(Math.max(...prior));
  report?.({
    ...base,
    after: toWin(q[k]!),
    worlds: worlds.length,
    ms: Date.now() - started,
    overrode: k !== favourite,
    moves: encodings
      .map((ids, i) => ({ move: ids.map(actionName).join(' '), policy: prior[i]! / total, win: toWin(q[i]!), chosen: i === k, command: commands[i]! }))
      .sort((a, c) => c.win - a.win),
    outcomes: { commands, rows: results },
  });
  log(`[search${mode === 'best-q' ? ' best-q' : ''}] seat ${seat} turn ${state.turnNumber}: ${worlds.length} worlds × ${commands.length} moves in ${((Date.now() - started) / 1000).toFixed(1)} s`);
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
  pool: RolloutPool,
  /** The search's full report (training mode's advice is also the round review's). */
  onReport?: (r: SearchReport) => void,
): Promise<{ command: Command; probability: number; win?: number }[]> {
  let moves: SearchReport['moves'] = [];
  const command = await searchChoose(
    advisor,
    state,
    events,
    pool,
    (r) => {
      moves = r.moves;
      onReport?.(r);
    },
    undefined,
    'mode',
  );
  if (moves.length === 0) return [{ command, probability: 1 }];
  const ranked = [...moves].sort((a, b) => Number(b.chosen) - Number(a.chosen) || b.win - a.win);
  return ranked.map((m) => ({ command: m.command, probability: m.policy, win: m.win }));
}
