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
import { eventsFor, legalCommands, scores, viewFor, type Command, type GameState, type Seat, type TraceEvent } from '@keeps/engine';
import type { RoundReview } from '@keeps/protocol';
import { describeOptions, makeNames } from '@keeps/table';
import type { ReviewJob, ReviewResult } from './jobs.ts';
import type { SearchReport } from '../search/search.ts';
import { noteObservation } from '../belief.ts';

/** Sample sizes (REVIEW_SCALE scales them all, for tests; a Reviewer may take its own scale too: the phone's is smaller). */
const SCALE = Number((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.REVIEW_SCALE ?? 1);
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
export type Sizes = typeof SIZES;

/** SIZES, scaled by `scale`. */
export const scaledSizes = (scale: number): Sizes =>
  Object.fromEntries(Object.entries(SIZES).map(([k, n]) => [k, Math.max(1, Math.round(n * scale))])) as Sizes;
/** Playouts per job: small, so dropped work stops soon. */
export const CHUNK = 24;

// -- What runs the jobs ----------------------------------------------------------

/**
 * What runs the review's jobs (review-pool.ts: worker processes, or a remote worker; in the app, Web Workers): queued
 * by group (a game), tagged by round, keyed by what they estimate.
 */
export interface ReviewJobs {
  submit(group: string, tag: number, job: ReviewJob, done: (result: ReviewResult | null) => void, key?: string | null): void;
  /** Drops a group's jobs; how many there were. */
  cancel(group: string): number;
  /** Takes a round's queued jobs out, to be submitted again later. */
  setAside(group: string, tag: number): { job: ReviewJob; done: (result: ReviewResult | null) => void }[];
  /** Drops the jobs for one estimate; how many there were. */
  drop(group: string, key: string): number;
}

// -- A game's reviews ---------------------------------------------------------------

interface Tally {
  wins: number;
  n: number;
  /** Taken from the live game's search: playouts finishing later don't change it. */
  fixed?: boolean;
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
  /**
   * Each player's log, kept as BotPlayer keeps the bot's: their events as the game goes, and what their view showed
   * at each of their decisions (noteObservation). A view shows what no event names (a face-up pile's top), so a
   * player's estimates come from what they saw, not only from what happened.
   */
  logs: Map<Seat, TraceEvent[]>;
  /** How many of the game's events the logs have read. */
  read: number;
}

/** What a game looks like to the reviewer. */
export interface ReviewedGame {
  state: GameState;
  events: TraceEvent[];
  startedAt: number;
}

export class Reviewer {
  private games = new WeakMap<ReviewedGame, GameData>();
  /** The position after each move of a reviewed round, by the game's state there. */
  private positions = new WeakMap<GameState, { g: GameData; round: RoundData; index: number }>();
  /** Searches of a position that started before the move leading to it was recorded (training mode's advice starts at once). */
  private early = new WeakMap<GameState, { seat: Seat; report: Promise<SearchReport | null> }[]>();

  private readonly pool: ReviewJobs;
  /** Sends a review to the person. */
  private readonly send: (game: ReviewedGame, review: RoundReview) => void;
  /** Its sample sizes. */
  private readonly sizes: Sizes;

  constructor(pool: ReviewJobs, send: (game: ReviewedGame, review: RoundReview) => void, sizes: Sizes = SIZES) {
    this.pool = pool;
    this.send = send;
    this.sizes = sizes;
  }

  /**
   * The live game searched `state` for `seat` (the bot's move, or training mode's advice), so it has that
   * player's estimate there: its options' chances weighted by how likely the network is to play each, the
   * same measure as the review's own (the network's usual move, then play on), in the search's worlds. Not
   * the picked move's chance: that assumes the best move and, as the best of several noisy estimates, reads
   * high (about 3 points on average, up to 15), which would make the line jump at the searched points.
   * It replaces the review's own work for that point, which is dropped if it hasn't started, unless it searched
   * fewer worlds than that work would (the bot's medium level): then the review's own estimate stands.
   */
  searched(state: GameState, seat: Seat, report: Promise<SearchReport | null>): void {
    const at = this.positions.get(state);
    if (!at) {
      this.early.set(state, [...(this.early.get(state) ?? []), { seat, report }]);
      return;
    }
    const { g, round, index } = at;
    report
      .catch(() => null)
      .then((r) => {
        if (!r?.outcomes || !r.moves.length || r.worlds < this.sizes.worlds || this.games.get(g.game) !== g) return;
        const t = round.moves[index]?.info.get(seat);
        if (!t) return;
        const total = r.moves.reduce((a, m) => a + m.policy, 0);
        t.wins = r.moves.reduce((a, m) => a + (m.policy / total) * m.win, 0);
        t.n = 1;
        t.fixed = true;
        round.pending -= this.pool.drop(g.id, `${round.round}:${index}:${seat}`);
        this.updated(g, round);
      });
  }

  /** Whether the game is being reviewed. */
  has(game: ReviewedGame): boolean {
    return this.games.has(game);
  }

  /** Starts reviewing a game against the bot (one person, one bot). */
  start(code: string, game: ReviewedGame, person: Seat, bot: Seat, names: (string | null)[]): void {
    this.games.set(game, { id: `${code}-${game.startedAt}`, game, person, bot, names: [...names], rounds: new Map(), logs: new Map([[person, []], [bot, []]]), read: 0 });
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
    /** The game's own object for `after` (live searches of the next decision are keyed by it). */
    afterInGame?: GameState,
  ): void {
    const g = this.games.get(game);
    if (!g) return;
    const playing = before.phase === 'playing' || before.phase === 'post-round';
    const logs = this.follow(g, events, newEvents, playing ? { state: before, seat } : null);
    // (Leaving is no move to judge: the round, or the game, ends there.)
    if (!playing || command.type === 'leave') return;
    const round = g.rounds.get(before.round) ?? this.newRound(g, before.round);
    const live = after.phase === 'playing' || after.phase === 'post-round';
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
      const myLog = logs.before.get(seat)!;
      const both: [Seat, TraceEvent[]][] = [g.person, g.bot].map((s) => [s, logs.before.get(s)!]);
      const search = () =>
        this.worlds(g, round, before, seat, myLog, legal, this.sizes.optionWorlds, (rows) => {
          decision.rows.push(...rows);
          this.judge(g, round, decision, before, myLog);
        });
      if (searched) {
        // The live search's worlds, as they were: no need to play them again (if there are as many as the review's own).
        round.pending++;
        searched
          .catch(() => null)
          .then((report) => {
            round.pending--;
            if (this.games.get(game) !== g) return;
            const out = report?.outcomes;
            if (!out || out.rows.length < this.sizes.optionWorlds) return search();
            const at = legal.map((c) => out.commands.findIndex((o) => same(o, c)));
            decision.rows = out.rows.map((row) => at.map((j) => (j < 0 ? null : row[j]! > 0 ? 1 : 0)));
            const pick = report.moves.find((m) => m.chosen);
            decision.chosen = pick ? legal.findIndex((c) => same(c, pick.command)) : null;
            if (decision.chosen === -1) decision.chosen = null;
            this.judge(g, round, decision, before, myLog);
            this.updated(g, round);
          });
      } else search();
      legal.forEach((c, k) =>
        this.chunks(g, round, this.sizes.optionTruth, (n) => ({ kind: 'truth', state: before, logs: both, first: { seat, command: c }, n }), (r) => {
          if ('wins' in r) {
            decision.truth[k]!.wins += r.wins[seat] ?? 0;
            decision.truth[k]!.n += r.n;
          }
          this.judge(g, round, decision, before, myLog);
        }),
      );
    }

    // The position after it.
    if (live) {
      const both: [Seat, TraceEvent[]][] = [g.person, g.bot].map((s) => [s, logs.after.get(s)!]);
      this.chunks(g, round, this.sizes.truth, (n) => ({ kind: 'truth', state: after, logs: both, first: null, n }), (r) => {
        if ('wins' in r) {
          move.truth.wins += r.wins[g.person] ?? 0;
          move.truth.n += r.n;
        }
      });
      // Each player's own estimate. When the live game searches this position for that player (the
      // bot's move, training mode's advice), the search's estimate replaces this work (see searched()).
      for (const s of [g.person, g.bot]) {
        this.worlds(
          g,
          round,
          after,
          s,
          logs.after.get(s)!,
          null,
          this.sizes.worlds,
          (rows) => {
            const t = move.info.get(s)!;
            if (t.fixed) return;
            t.wins += rows.reduce((a, r) => a + r[0]!, 0);
            t.n += rows.length;
          },
          `${round.round}:${index}:${s}`,
        );
      }
      for (const state of [after, ...(afterInGame ? [afterInGame] : [])]) {
        this.positions.set(state, { g, round, index });
        for (const { seat: s, report } of this.early.get(state) ?? []) this.searched(state, s, report);
        this.early.delete(state);
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

  /**
   * Brings the players' logs (GameData.logs) through a move: their events up to it, what the view showed the player
   * who made it (`decided`: as they decided), then the move's own events. The logs as they were at the decision and
   * after the move, as copies (the jobs keep them while the logs grow).
   */
  private follow(
    g: GameData,
    events: TraceEvent[],
    newEvents: TraceEvent[],
    decided: { state: GameState; seat: Seat } | null,
  ): { before: Map<Seat, TraceEvent[]>; after: Map<Seat, TraceEvent[]> } {
    const seats = [g.person, g.bot];
    const upTo = events.length - newEvents.length;
    for (const s of seats) g.logs.get(s)!.push(...eventsFor(events.slice(g.read, upTo), s));
    if (decided) noteObservation(g.logs.get(decided.seat)!, viewFor(decided.state, decided.seat), decided.seat);
    const copies = () => new Map(seats.map((s) => [s, [...g.logs.get(s)!]]));
    const before = copies();
    for (const s of seats) g.logs.get(s)!.push(...eventsFor(events.slice(upTo), s));
    g.read = events.length;
    return { before, after: copies() };
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

  /** Worlds from `seat`'s information in `state` (their log, `myLog`): each played on (commands null), or once per command. */
  private worlds(
    g: GameData,
    round: RoundData,
    state: GameState,
    seat: Seat,
    myLog: TraceEvent[],
    commands: Command[] | null,
    total: number,
    add: (rows: number[][]) => void,
    key: string | null = null,
  ): void {
    const job = (n: number): ReviewJob => ({ kind: 'worlds', state, me: seat, myLog, commands, n });
    // Each world plays every command: fewer worlds per job when there are many.
    const per = Math.max(2, Math.floor(CHUNK / Math.max(1, (commands?.length ?? 1) / 2)));
    for (let left = total; left > 0; left -= per) {
      round.pending++;
      this.pool.submit(
        g.id,
        round.round,
        job(Math.min(per, left)),
        (result) => {
          round.pending--;
          if (result && 'rows' in result) add(result.rows);
          this.updated(g, round);
        },
        key,
      );
    }
  }

  /** The person's decisions: when one looks like a mistake that isn't clear yet, more worlds for the best option and the one played. */
  private judge(g: GameData, round: RoundData, d: DecisionData, before: GameState, myLog: TraceEvent[]): void {
    if (d.seat !== g.person || d.rechecked) return;
    if (d.chosen === null && d.rows.length < this.sizes.optionWorlds) return;
    const v = verdictOf(d);
    if (v.unclear) {
      d.rechecked = true;
      const pair = [v.best, d.played];
      this.worlds(g, round, before, d.seat, myLog, pair.map((k) => d.commands[k]!), this.sizes.recheck, (rows) => {
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
