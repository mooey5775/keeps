// Round reviews for games against the bot: how each round went, move by move, for the person playing.
//
// After every move the server queues the work to judge it, so a round's review is nearly done when the
// round ends. What the live game already searched is reused, not worked out again: a decision that
// training mode advised on, or that the bot searched for itself, takes that search (the same worlds,
// the same ranking, the bot's own pick first, as the hint showed it).
//
//   - the position after the move: played out from the real position (every card known), and from what
//     each player knows (worlds drawn from their information): three chances of winning, after every move;
//   - the decision the move made, if there was a choice: every option played out in worlds drawn from what
//     the decider knew (the same worlds for every option) and on the real position.
// The work runs in separate processes at the lowest CPU priority (nice 19): the bot's own search, and
// training mode's, always come first. It's cut into small jobs, and a game's jobs are dropped the moment
// the review can't be wanted any more (its room closes, or a new game starts there).
// Nothing of a round is sent before it's over: the numbers show what was hidden.
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { eventsFor, legalCommands, scores, viewFor, type Command, type GameState, type Seat, type TraceEvent } from '../../engine/src/index.ts';
import type { RoundReview } from '../../protocol/src/index.ts';
import { describeOptions, makeNames } from '../../web/src/game/options.ts';
import type { ReviewJob, ReviewResult } from './review-worker.ts';
import type { SearchReport } from './search-bot.ts';

/** Sample sizes (REVIEW_SCALE scales them all, for tests). */
const SCALE = Number(process.env.REVIEW_SCALE ?? 1);
const at = (n: number) => Math.max(1, Math.round(n * SCALE));
export const SIZES = {
  /** Playouts of the real position after each move. */
  truth: at(200),
  /** Worlds per player after each move. */
  worlds: at(128),
  /** Worlds per decision, every option played out in each. */
  optionWorlds: at(128),
  /** Playouts of the real position per option. */
  optionTruth: at(64),
  /** More worlds for the best option and the one played, when a mistake isn't clear yet. */
  recheck: at(384),
};
/** Playouts per job: small, so dropped work stops soon. */
const CHUNK = 24;

// -- The pool -----------------------------------------------------------------

interface Task {
  id: number;
  group: string;
  /** The round it's for (work for one round can be set aside). */
  tag: number;
  job: ReviewJob;
  done: (result: ReviewResult | null) => void;
  cancelled: boolean;
}

/** Worker processes at nice 19, started when first needed. Jobs are queued by group (a game) and taken in turn across groups. */
export class ReviewPool {
  private workers: { child: ChildProcess; task: Task | null }[] = [];
  private queues = new Map<string, Task[]>();
  private turn: string[] = [];
  private next = 0;
  private errors = 0;

  private readonly size: number;
  private readonly weights: string;

  constructor(size: number, weights: string) {
    this.size = size;
    this.weights = weights;
  }

  submit(group: string, tag: number, job: ReviewJob, done: (result: ReviewResult | null) => void): void {
    const task: Task = { id: this.next++, group, tag, job, done, cancelled: false };
    if (!this.queues.has(group)) {
      this.queues.set(group, []);
      this.turn.push(group);
    }
    this.queues.get(group)!.push(task);
    this.start();
    this.pump();
  }

  /** Drops the group's queued jobs; its running ones finish, unheard. */
  cancel(group: string): number {
    const dropped = this.queues.get(group)?.length ?? 0;
    this.queues.delete(group);
    this.turn = this.turn.filter((g) => g !== group);
    for (const w of this.workers) if (w.task?.group === group) w.task.cancelled = true;
    return dropped;
  }

  /** Takes the group's queued jobs for one round out of the queue (to submit again later); running ones finish. */
  setAside(group: string, tag: number): { job: ReviewJob; done: (result: ReviewResult | null) => void }[] {
    const queue = this.queues.get(group);
    if (!queue) return [];
    const out = queue.filter((t) => t.tag === tag);
    this.queues.set(group, queue.filter((t) => t.tag !== tag));
    return out.map((t) => ({ job: t.job, done: t.done }));
  }

  /** Jobs queued or running, for the status page and tests. */
  load(): { queued: number; running: number; workers: number } {
    return {
      queued: [...this.queues.values()].reduce((a, q) => a + q.length, 0),
      running: this.workers.filter((w) => w.task).length,
      workers: this.workers.length,
    };
  }

  /** Worker process ids (to check their priority). */
  pids(): number[] {
    return this.workers.flatMap((w) => (w.child.pid ? [w.child.pid] : []));
  }

  close(): void {
    for (const w of this.workers) w.child.kill();
    this.workers = [];
  }

  private start(): void {
    while (this.workers.length < this.size) this.spawn();
  }

  private spawn(): void {
    // `nice` sets the priority before node starts, so every thread of the worker has it.
    const child = spawn('nice', ['-n', '19', process.execPath, join(import.meta.dirname, 'review-worker.ts'), this.weights], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const worker = { child, task: null as Task | null };
    this.workers.push(worker);
    child.on('message', (m: { id: number; result?: ReviewResult; error?: string }) => {
      const task = worker.task;
      worker.task = null;
      if (task && task.id === m.id && !task.cancelled) {
        if (m.error && this.errors++ < 20) console.error(`review: a job failed: ${m.error}`);
        task.done(m.result ?? null);
      }
      this.pump();
    });
    child.on('exit', () => {
      // A worker that dies (out of memory, killed) is replaced; its job counts as failed.
      this.workers = this.workers.filter((w) => w !== worker);
      if (worker.task && !worker.task.cancelled) worker.task.done(null);
      if (this.queues.size) this.start();
      this.pump();
    });
  }

  private pump(): void {
    for (const worker of this.workers) {
      if (worker.task || !worker.child.connected) continue;
      const task = this.take();
      if (!task) return;
      worker.task = task;
      worker.child.send({ id: task.id, job: task.job });
    }
  }

  /** The next job, taking groups in turn. */
  private take(): Task | null {
    for (let i = 0; i < this.turn.length; i++) {
      const group = this.turn.shift()!;
      this.turn.push(group);
      const queue = this.queues.get(group)!;
      const task = queue.shift();
      if (!queue.length) {
        this.queues.delete(group);
        this.turn = this.turn.filter((g) => g !== group);
      }
      if (task) return task;
    }
    return null;
  }
}

// -- A game's reviews ---------------------------------------------------------------

interface Tally {
  wins: number;
  n: number;
}
interface MoveData {
  turn: number;
  seat: Seat;
  /** What happened, as the person's log showed it. */
  events: TraceEvent[];
  /** Win tallies of the person's seat: on the real position, and per player from their own information (their own wins). */
  truth: Tally;
  info: Map<Seat, Tally>;
}
interface DecisionData {
  move: number;
  seat: Seat;
  commands: Command[];
  labels: string[];
  played: number;
  /** From the decider's information: per world, 1/0 per option (null: not played out in that world). */
  rows: (number | null)[][];
  /** The option the bot's search picked (the live search's), or null: ranked by the worlds alone. */
  chosen: number | null;
  /** On the real position: the decider's wins per option. */
  truth: Tally[];
  rechecked: boolean;
}
interface RoundData {
  round: number;
  over: boolean;
  winner: Seat | null;
  scores: (number | null)[];
  moves: MoveData[];
  decisions: DecisionData[];
  pending: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Work set aside while the person is away (the round isn't over: nobody to show it to). */
  parked: { job: ReviewJob; done: (result: ReviewResult | null) => void }[];
}
interface GameData {
  id: string;
  /** The game itself (a WeakMap value may point back to its key). */
  game: ReviewedGame;
  /** The person the reviews are for, and the bot. */
  person: Seat;
  bot: Seat;
  names: (string | null)[];
  rounds: Map<number, RoundData>;
}

/** What a game looks like to the reviewer. */
export interface ReviewedGame {
  state: GameState;
  events: TraceEvent[];
  startedAt: number;
}

export class Reviewer {
  private games = new WeakMap<ReviewedGame, GameData>();

  private readonly pool: ReviewPool;
  /** Sends a review to the person. */
  private readonly send: (game: ReviewedGame, review: RoundReview) => void;

  constructor(pool: ReviewPool, send: (game: ReviewedGame, review: RoundReview) => void) {
    this.pool = pool;
    this.send = send;
  }

  /** Whether the game is being reviewed. */
  has(game: ReviewedGame): boolean {
    return this.games.has(game);
  }

  /** Starts reviewing a game against the bot (one person, one bot). */
  start(code: string, game: ReviewedGame, person: Seat, bot: Seat, names: (string | null)[]): void {
    this.games.set(game, { id: `${code}-${game.startedAt}`, game, person, bot, names: [...names], rounds: new Map() });
  }

  /** Drops everything left to do for a game (its room closed, or another game started there). */
  stop(game: ReviewedGame): void {
    const g = this.games.get(game);
    if (!g) return;
    const dropped = this.pool.cancel(g.id);
    for (const r of g.rounds.values()) if (r.timer) clearTimeout(r.timer);
    this.games.delete(game);
    if (dropped) console.log(`review ${g.id}: stopped, ${dropped} jobs dropped`);
  }

  /**
   * The person went away (disconnected, or left the table): the round being played can't be shown to
   * anyone unless they come back, so its queued work is set aside. Finished rounds go on.
   */
  pause(game: ReviewedGame): void {
    const g = this.games.get(game);
    if (!g) return;
    let parked = 0;
    for (const r of g.rounds.values()) {
      if (r.over) continue;
      const aside = this.pool.setAside(g.id, r.round);
      r.parked.push(...aside);
      parked += aside.length;
    }
    if (parked) console.log(`review ${g.id}: the player went away; ${parked} jobs set aside`);
  }

  /** The person is back: the work set aside is queued again. */
  resume(game: ReviewedGame): void {
    const g = this.games.get(game);
    if (!g) return;
    for (const r of g.rounds.values()) {
      for (const { job, done } of r.parked.splice(0)) this.pool.submit(g.id, r.round, job, done);
    }
  }

  /** The finished rounds' reviews, to send again (a reconnecting player). */
  finished(game: ReviewedGame): RoundReview[] {
    const g = this.games.get(game);
    return g ? [...g.rounds.values()].filter((r) => r.over).map((r) => this.review(g, r)) : [];
  }

  /**
   * A move was made: `seat` played `command` in `before`, which led to `after`; `events` is the game's
   * whole log through the move, the last `newEvents` of it the move's own.
   */
  moved(
    game: ReviewedGame,
    before: GameState,
    seat: Seat,
    command: Command,
    after: GameState,
    events: TraceEvent[],
    newEvents: TraceEvent[],
    /** The live game's search of this decision, if it ran one (training mode's advice, or the bot's own move). */
    searched?: Promise<SearchReport | null>,
  ): void {
    const g = this.games.get(game);
    if (!g || !(before.phase === 'playing' || before.phase === 'post-round')) return;
    const round = g.rounds.get(before.round) ?? this.newRound(g, before.round);
    const live = after.phase === 'playing' || after.phase === 'post-round';
    // The round so far, for the players' logs (each player's knowledge starts at the round's start).
    const start = events.findLastIndex((e) => e.payload.type === 'round-start' && e.round === before.round);
    const roundEvents = events.slice(Math.max(0, start));
    const eventsBefore = roundEvents.slice(0, roundEvents.length - newEvents.length);
    const move: MoveData = {
      turn: before.turnNumber,
      seat,
      events: eventsFor(newEvents, g.person),
      truth: { wins: 0, n: 0 },
      info: new Map([
        [g.person, { wins: 0, n: 0 }],
        [g.bot, { wins: 0, n: 0 }],
      ]),
    };
    round.moves.push(move);
    const index = round.moves.length - 1;

    // The decision this move made.
    const legal = legalCommands(before, seat);
    if (legal.length > 1) {
      const played = legal.findIndex((c) => same(c, command));
      const decision: DecisionData = {
        move: index,
        seat,
        commands: legal,
        labels: legal.map((c) => this.label(g, before, seat, c)),
        played,
        rows: [],
        chosen: null,
        truth: legal.map(() => ({ wins: 0, n: 0 })),
        rechecked: false,
      };
      round.decisions.push(decision);
      const logs: [Seat, TraceEvent[]][] = [g.person, g.bot].map((s) => [s, eventsFor(eventsBefore, s)]);
      const search = () =>
        this.worlds(g, round, before, seat, eventsBefore, legal, SIZES.optionWorlds, (rows) => {
          decision.rows.push(...rows);
          this.judge(g, round, decision, before, eventsBefore);
        });
      if (searched) {
        // The live search's worlds, as they were: no need to play them again.
        round.pending++;
        searched
          .catch(() => null)
          .then((report) => {
            round.pending--;
            if (this.games.get(game) !== g) return;
            const out = report?.outcomes;
            if (!out) return search();
            const at = legal.map((c) => out.commands.findIndex((o) => same(o, c)));
            decision.rows = out.rows.map((row) => at.map((j) => (j < 0 ? null : row[j]! > 0 ? 1 : 0)));
            const pick = report.moves.find((m) => m.chosen);
            decision.chosen = pick ? legal.findIndex((c) => same(c, pick.command)) : null;
            if (decision.chosen === -1) decision.chosen = null;
            this.judge(g, round, decision, before, eventsBefore);
            this.updated(g, round);
          });
      } else search();
      legal.forEach((c, k) =>
        this.chunks(g, round, SIZES.optionTruth, (n) => ({ kind: 'truth', state: before, logs, first: { seat, command: c }, n }), (r) => {
          if ('wins' in r) {
            decision.truth[k]!.wins += r.wins[seat] ?? 0;
            decision.truth[k]!.n += r.n;
          }
          this.judge(g, round, decision, before, eventsBefore);
        }),
      );
    }

    // The position after it.
    if (live) {
      const logs: [Seat, TraceEvent[]][] = [g.person, g.bot].map((s) => [s, eventsFor(roundEvents, s)]);
      this.chunks(g, round, SIZES.truth, (n) => ({ kind: 'truth', state: after, logs, first: null, n }), (r) => {
        if ('wins' in r) {
          move.truth.wins += r.wins[g.person] ?? 0;
          move.truth.n += r.n;
        }
      });
      for (const s of [g.person, g.bot]) {
        this.worlds(g, round, after, s, roundEvents, null, SIZES.worlds, (rows) => {
          const t = move.info.get(s)!;
          t.wins += rows.reduce((a, r) => a + r[0]!, 0);
          t.n += rows.length;
        });
      }
    } else {
      // The round is over: nothing left to estimate.
      const won = after.lastRoundWinner === g.person ? 1 : 0;
      move.truth = { wins: won, n: 1 };
      move.info.set(g.person, { wins: won, n: 1 });
      move.info.set(g.bot, { wins: after.lastRoundWinner === g.bot ? 1 : 0, n: 1 });
      round.over = true;
      round.winner = after.lastRoundWinner;
      round.scores = scores(after);
      this.publish(g, round, true);
    }
  }

  private newRound(g: GameData, n: number): RoundData {
    const round: RoundData = { round: n, over: false, winner: null, scores: [], moves: [], decisions: [], pending: 0, timer: null, parked: [] };
    g.rounds.set(n, round);
    return round;
  }

  /** Queues `total` playouts in jobs of CHUNK; `add` takes each result. */
  private chunks(g: GameData, round: RoundData, total: number, job: (n: number) => ReviewJob, add: (r: ReviewResult) => void): void {
    for (let left = total; left > 0; left -= CHUNK) {
      round.pending++;
      this.pool.submit(g.id, round.round, job(Math.min(CHUNK, left)), (result) => {
        round.pending--;
        if (result) add(result);
        this.updated(g, round);
      });
    }
  }

  /** Worlds from `seat`'s information in `state`: each played on (commands null), or once per command. */
  private worlds(g: GameData, round: RoundData, state: GameState, seat: Seat, events: TraceEvent[], commands: Command[] | null, total: number, add: (rows: number[][]) => void): void {
    const job = (n: number): ReviewJob => ({ kind: 'worlds', state, me: seat, myLog: eventsFor(events, seat), publicLog: eventsFor(events, 'spectator'), commands, n });
    // Each world plays every command: fewer worlds per job when there are many.
    const per = Math.max(2, Math.floor(CHUNK / Math.max(1, (commands?.length ?? 1) / 2)));
    for (let left = total; left > 0; left -= per) {
      round.pending++;
      this.pool.submit(g.id, round.round, job(Math.min(per, left)), (result) => {
        round.pending--;
        if (result && 'rows' in result) add(result.rows);
        this.updated(g, round);
      });
    }
  }

  /** The person's decisions: when one looks like a mistake that isn't clear yet, more worlds for the best option and the one played. */
  private judge(g: GameData, round: RoundData, d: DecisionData, before: GameState, events: TraceEvent[]): void {
    if (d.seat !== g.person || d.rechecked) return;
    if (d.chosen === null && d.rows.length < SIZES.optionWorlds) return;
    const v = verdictOf(d);
    if (v.unclear) {
      d.rechecked = true;
      const pair = [v.best, d.played];
      this.worlds(g, round, before, d.seat, events, pair.map((k) => d.commands[k]!), SIZES.recheck, (rows) => {
        d.rows.push(...rows.map((r) => d.commands.map((_, k) => (k === pair[0] ? r[0]! : k === pair[1] ? r[1]! : null))));
      });
    }
  }

  private updated(g: GameData, round: RoundData): void {
    if (round.over) this.publish(g, round, round.pending === 0);
  }

  /** Sends the round's review now (`now`), or within a moment (several results arrive together). */
  private publish(g: GameData, round: RoundData, now: boolean): void {
    const game = g.game;
    if (round.timer && !now) return;
    if (round.timer) clearTimeout(round.timer);
    round.timer = null;
    const send = () => {
      round.timer = null;
      if (this.games.get(game) === g) this.send(game, this.review(g, round));
    };
    if (now) send();
    else round.timer = setTimeout(send, 1500);
  }

  private review(g: GameData, round: RoundData): RoundReview {
    const share = (t: Tally | undefined) => (t && t.n > 0 ? t.wins / t.n : null);
    return {
      game: g.id,
      round: round.round,
      seat: g.person,
      pending: round.pending,
      winner: round.winner,
      scores: round.scores,
      moves: round.moves.map((m) => {
        const theirs = share(m.info.get(g.bot));
        return { turn: m.turn, seat: m.seat, events: m.events, truth: share(m.truth), mine: share(m.info.get(g.person)), theirs: theirs === null ? null : 1 - theirs };
      }),
      decisions: round.decisions.map((d) => {
        const known = means(d);
        const options = d.commands
          .map((_, k) => ({ label: d.labels[k]!, known: known[k] ?? null, truth: share(d.truth[k]), played: k === d.played }))
          .map((o, k) => ({ ...o, pick: k === d.chosen }))
          .sort((a, b) => Number(b.pick) - Number(a.pick) || (b.known ?? -1) - (a.known ?? -1))
          .map(({ pick: _, ...o }) => o);
        return { move: d.move, seat: d.seat, options, verdict: d.seat === g.person ? verdictOf(d).verdict : null };
      }),
    };
  }

  /** An option as the decider saw it, named from the person's side. */
  private label(g: GameData, state: GameState, seat: Seat, command: Command): string {
    const options = describeOptions(viewFor(state, seat), makeNames(g.names, g.person));
    const option = options.find((o) => same(o.command, command));
    let label = option?.label ?? (command.type === 'answer' && command.answer.kind === 'order-pile' ? `Put the pile in this order: ${command.answer.order.join(', ')}` : 'A move');
    if (seat !== g.person) {
      // A few labels say "your" for the decider's own things; for the bot that's "its".
      label = label
        .replace(/^Draw from your pile$/, 'Draw from its pile')
        .replace(/^Discard Shackles from your keep$/, 'Discard Shackles from its keep')
        .replace(/^Tithes: discard your Coin cards and reorder your pile$/, 'Tithes: discard its Coin cards and reorder its pile')
        .replace(/ into your hand$/, ' into its hand')
        .replace(/^(Pass every pile \w+): you get (.*), yours goes to /, '$1: it gets $2, its pile goes to ');
    }
    return label;
  }
}

/** Each option's share of wins over the worlds it was played out in. */
function means(d: DecisionData): (number | null)[] {
  return d.commands.map((_, k) => {
    let sum = 0;
    let n = 0;
    for (const row of d.rows) {
      if (row[k] === null || row[k] === undefined) continue;
      sum += row[k]!;
      n++;
    }
    return n ? sum / n : null;
  });
}

/**
 * How the move played compares with the best option from what the decider knew. A gap counts only
 * when it's clear: at least 10 points, and three standard errors of the paired difference (the same
 * worlds for both), so picking the biggest of a round's many noisy gaps doesn't make mistakes out of
 * noise. `unclear`: a gap that big, but not yet clear (more worlds would settle it).
 */
export function verdictOf(d: Pick<DecisionData, 'rows' | 'truth' | 'played' | 'commands' | 'rechecked' | 'chosen'>): {
  verdict: RoundReview['decisions'][number]['verdict'];
  best: number;
  unclear: boolean;
} {
  const known = means(d as DecisionData);
  // The bot's pick when its search made one (the hint's first move), otherwise the best by the worlds.
  let best = d.chosen ?? 0;
  if (d.chosen === null)
    known.forEach((m, k) => {
      if ((m ?? -1) > (known[best] ?? -1)) best = k;
    });
  const p = d.played;
  if (known[p] === null || known[best] === null) return { verdict: null, best, unclear: false };
  // Unlucky: with every card known, another option was clearly better (at least 15 points, three standard errors).
  const unlucky = () => {
    const truth = d.truth.map((t) => (t.n ? t.wins / t.n : null));
    const top = truth.reduce<number>((a, t, k) => ((t ?? -1) > (truth[a] ?? -1) ? k : a), 0);
    const tp = truth[p] ?? null;
    const tb = truth[top] ?? null;
    if (tp === null || tb === null || top === p) return false;
    const se = Math.sqrt((tb * (1 - tb)) / d.truth[top]!.n + (tp * (1 - tp)) / d.truth[p]!.n);
    return tb - tp >= 0.15 && tb - tp >= 3 * se;
  };
  // The bot's own pick: right from what they knew.
  if (best === p) return { verdict: unlucky() ? 'unlucky' : 'best', best, unclear: false };
  const gap = known[best]! - known[p]!;
  const diffs = d.rows.filter((r) => r[best] !== null && r[best] !== undefined && r[p] !== null && r[p] !== undefined).map((r) => r[best]! - r[p]!);
  const mean = diffs.reduce((a, x) => a + x, 0) / diffs.length;
  const variance = diffs.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, diffs.length - 1);
  const se = Math.sqrt(variance / diffs.length) || 1e-9;
  const clear = gap >= 0.1 && gap >= 3 * se;
  // As good as the pick from what they knew (within 10 points): only the hidden cards can make it look bad.
  if (gap < 0.1) return { verdict: unlucky() ? 'unlucky' : null, best, unclear: false };
  if (!clear) return { verdict: null, best, unclear: !d.rechecked };
  const tb = d.truth[best]!.n ? d.truth[best]!.wins / d.truth[best]!.n : null;
  const tp = d.truth[p]!.n ? d.truth[p]!.wins / d.truth[p]!.n : null;
  if (gap >= 0.2) return { verdict: 'blunder', best, unclear: false };
  return { verdict: tb !== null && tp !== null && tp >= tb - 0.05 ? 'mistake-worked-out' : 'mistake', best, unclear: false };
}

/** Commands compared by content, whatever the order of their keys. */
function same(a: Command, b: Command): boolean {
  return canonical(a) === canonical(b);
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  );
}
