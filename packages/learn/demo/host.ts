// Midstrike's host: what a server (the website's, or the app's own) adds to its rooms to play Midstrike. Its moves
// searched at the room's difficulty, training mode's advice from the same search, and each round of a game against
// it reviewed for the person. It plugs into a room through room.ts's BotDeps (choose, advise) and RoomHooks; the
// searching and the review's playouts run wherever the server says (its Evaluators, its ReviewJobs), so this file
// runs in Node or in a browser alike.
import type { GameState, Seat } from '../../engine/src/index.ts';
import type { BotDeps, BotTurn, Room, RoomHooks, RoomMember, RunningGame } from '../../server/src/room.ts';
import { Reviewer, type ReviewedGame, type ReviewJobs } from './review.ts';
import { searchAdvise, searchChoose, Superseded, type Evaluator, type SearchReport } from './search-bot.ts';

/** `pool`, its searches dropped once `wanted` says their position has passed (rather than played out for nothing). */
const whileWanted = (pool: Evaluator, wanted: () => boolean): Evaluator => ({ evaluate: (job) => pool.evaluate({ ...job, wanted }) });

export interface MidstrikeOptions {
  /** The bot's name, as the table knows it. */
  name: string;
  /** The search for each level that searches (easy plays its network's own move); without it, the bot plays its
   * network's move at every level, and training mode gives the network's suggestions. */
  search?: { medium: Evaluator; hard: Evaluator };
  /** What runs the round reviews' jobs; without it, no reviews. */
  reviews?: ReviewJobs;
  /**
   * Whether a search that failed with `error` failed because its machine is away (remote.ts's RemoteAway): the bot
   * then waits and tries again, and the table is told. Any other failure is a bug: the network's move is played.
   */
  away?: (error: unknown) => boolean;
  /** Each search's report, as it's made (the insight page shows them). */
  onSearch?: (room: Room, report: SearchReport) => void;
}

export interface MidstrikeHost {
  /** For the room's BotDeps. */
  bot: Pick<BotDeps, 'choose' | 'advise' | 'levels'>;
  hooks: RoomHooks;
  reviewer: Reviewer | null;
}

/** How long the bot waits before trying a search again while its machine is away. */
const AWAY_RETRY_MS = 15_000;

export function midstrikeHost(options: MidstrikeOptions): MidstrikeHost {
  const isAway = options.away ?? (() => false);

  // The live game's searches, by the position they searched (the bot's own moves, training mode's advice): the round
  // review reuses them rather than search again.
  const liveSearches = new WeakMap<GameState, Promise<SearchReport | null>>();
  const reviewer = options.reviews
    ? new Reviewer(options.reviews, (game, review) => {
        const room = roomOfGame.get(game);
        if (room?.runningGame !== game) return;
        for (const p of room.members) if (!p.bot && p.seat === review.seat) p.send({ t: 'review', review });
      })
    : null;
  function liveSearch(state: GameState, seat: Seat): (report: SearchReport | null) => void {
    let resolve!: (report: SearchReport | null) => void;
    const report = new Promise<SearchReport | null>((r) => (resolve = r));
    liveSearches.set(state, report);
    // Also the seat's own estimate of the position, for the round review's lines.
    reviewer?.searched(state, seat, report);
    return resolve;
  }

  // While the search's machine is away, the people at the table are told so (at most once a minute per room).
  const toldAt = new WeakMap<Room, number>();
  function tellAway(room: Room, seat?: Seat): void {
    const now = Date.now();
    if (now - (toldAt.get(room) ?? 0) < 60_000) return;
    toldAt.set(room, now);
    console.error(`room ${room.code}: the search machine is unavailable`);
    room.notify(`${options.name}'s search machine is unavailable right now. ${seat === undefined ? 'It will move as soon as it is back.' : 'No hint until it is back.'}`, seat);
  }

  const search = options.search;
  const bot: MidstrikeHost['bot'] = !search ? {} : {
    levels: true,
    async choose({ room, bot, state, events, level, wanted }: BotTurn) {
      if (level === 'easy') return { command: bot.choose(state, events) };
      const found = liveSearch(state, bot.seat);
      try {
        // (Dropped, the search fails with Superseded: the room drops a move for a position that's gone anyway.)
        const command = await searchChoose(bot, state, events, whileWanted(level === 'medium' ? search.medium : search.hard, wanted), (report) => {
          options.onSearch?.(room, report);
          found(report);
        });
        return { command };
      } catch (error) {
        if (!isAway(error)) throw error;
        tellAway(room);
        return { retryAfter: AWAY_RETRY_MS };
      } finally {
        found(null); // (no report: nothing to compare)
      }
    },
    // Training mode's advice comes from the same search, at full strength whatever the difficulty, from the seat's
    // own information; with the search machine away, no hint at all.
    advise({ room, bot, state, events, wanted }: BotTurn) {
      const found = liveSearch(state, bot.seat);
      return searchAdvise(bot, state, events, whileWanted(search.hard, wanted), found)
        .catch((error: unknown) => {
          // Advice for a decision already made: none.
          if (error instanceof Superseded) return [];
          if (!isAway(error)) throw error;
          tellAway(room, bot.seat);
          return [];
        })
        .finally(() => found(null));
    },
  };

  // Round reviews: every move of a game against the bot (one person, one bot) judged as the round goes, and each
  // round's review sent to the person once it's over.
  const roomOfGame = new WeakMap<ReviewedGame, Room>();
  const reviewedGameOf = new WeakMap<Room, ReviewedGame>();
  /** Keeps the reviewer on the room's current game: stops the old one, starts a new game against the bot. */
  function followGame(room: Room): void {
    if (!reviewer) return;
    const old = reviewedGameOf.get(room);
    const game = room.runningGame as (RunningGame & ReviewedGame) | null;
    if (old && old !== game) {
      reviewer.stop(old);
      reviewedGameOf.delete(room);
    }
    if (!game || reviewedGameOf.get(room) === game) return;
    const seated = room.members.filter((p) => p.seat !== null);
    const bots = seated.filter((p) => p.bot);
    const people = seated.filter((p) => !p.bot);
    if (bots.length !== 1 || people.length !== 1) return;
    const names: (string | null)[] = [null, null, null, null];
    for (const p of seated) names[p.seat!] = p.name;
    roomOfGame.set(game, room);
    reviewedGameOf.set(room, game);
    reviewer.start(room.code, game, people[0]!.seat!, bots[0]!.seat!, names);
  }
  // The person going away sets the round in play aside; coming back (the game sent afresh) resumes it.
  function personAway(room: Room): void {
    const game = reviewedGameOf.get(room);
    if (game && !room.members.some((p) => !p.bot && p.seat !== null && p.connected)) reviewer!.pause(game);
  }
  const hooks: RoomHooks = reviewer
    ? {
        commanded(room, move) {
          followGame(room);
          const game = room.runningGame as ReviewedGame | null;
          if (!game || !reviewer.has(game)) return;
          reviewer.moved(game, move.before, move.seat, move.command, move.after, [...move.events], [...move.newEvents], liveSearches.get(move.before), move.after);
        },
        // A player who (re)connects gets the finished rounds' reviews again; a game that ended back in the lobby
        // stops being reviewed.
        sent(room, player: RoomMember, reset) {
          followGame(room);
          const game = room.runningGame as ReviewedGame | null;
          if (!reset || !game || player.bot || !player.connected) return;
          reviewer.resume(game);
          for (const review of reviewer.finished(game)) if (review.seat === player.seat) player.send({ t: 'review', review });
        },
        left: (room) => personAway(room),
        disconnected: (room) => personAway(room),
        closing(room) {
          const game = reviewedGameOf.get(room);
          if (game) reviewer.stop(game);
        },
      }
    : {};
  return { bot, hooks, reviewer };
}

/** Several hooks as one: each of them told, in order. */
export function composeHooks(...all: RoomHooks[]): RoomHooks {
  const each =
    <K extends keyof RoomHooks>(name: K) =>
    (...args: Parameters<NonNullable<RoomHooks[K]>>) => {
      for (const hooks of all) (hooks[name] as ((...a: typeof args) => void) | undefined)?.(...args);
    };
  return {
    sent: each('sent'),
    commanded: each('commanded'),
    trainingChanged: each('trainingChanged'),
    left: each('left'),
    disconnected: each('disconnected'),
    closing: each('closing'),
  };
}
