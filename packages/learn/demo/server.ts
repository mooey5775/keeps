// Local demo: the site with a bot (e1, or BOT=<name> for weights/<name>.bin) playing by search (search-bot.ts), a page showing what the
// bot thinks as you play, and a coach page: what the bot would play in YOUR seat, from your
// information only.
//   node server.ts   → the game at http://localhost:8788, bot insight at http://localhost:8789,
//                      the coach at http://localhost:8789/coach
// The bot plays a move sampled from one damped policy-improvement step (SEARCH_MODE=best-q: the best rollout move instead).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { apply, CARDS, viewFor, type Command, type GameState, type Seat, type TraceEvent } from '../../engine/src/index.ts';
import type { BotLevel, Settings } from '../../protocol/src/index.ts';
import { logLines } from '../../web/src/game/log.ts';
import { describeOptions, makeNames } from '../../web/src/game/options.ts';
import { BotPlayer } from '../src/bot.ts';
import { Policy } from '../src/policy.ts';
import { Room } from '../../server/src/room.ts';
import { createKeepsServer } from '../../server/src/server.ts';
import { replayFileName } from '../../server/src/replays.ts';
import { authorized } from '../../server/src/admin.ts';
import { RemoteAway, RemoteEvaluator, RemoteQueue } from './remote.ts';
import { ReviewPool, Reviewer, type ReviewedGame } from './review.ts';
import { ALPHA, BETA, RolloutPool, searchAdvise, searchChoose, setSearchMode, setWorlds, WORLDS, type Evaluator, type SearchReport } from './search-bot.ts';

const root = join(import.meta.dirname, '..', '..', '..');
// Replays, sessions.jsonl, the admin-token file (KEEPS_DATA_DIR in a container; ./data locally).
const DATA = process.env.KEEPS_DATA_DIR ?? join(import.meta.dirname, 'data');
mkdirSync(DATA, { recursive: true });
// The bot's network (BOT=vrpo1 → vrpo1.bin; e1 by default). VRPO's actor has no value head: its pages show none.
const botName = process.env.BOT ?? 'e1';
// The bot's name at the table.
const DISPLAY_NAME = process.env.BOT_NAME ?? 'Midstrike';
// The admin password for /bot/: ADMIN_TOKEN, or data/admin-token (git-ignored). Without one, /bot/ is off.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? (existsSync(join(DATA, 'admin-token')) ? readFileSync(join(DATA, 'admin-token'), 'utf8').trim() : '');
const weights = join(import.meta.dirname, 'weights', `${botName}.bin`);
// The searches' and reviews' heavy work can run on another machine (remote.ts; remote-worker.ts there): REMOTE_TOKEN
// turns it on. That machine searches REMOTE_WORLDS worlds (512); this one WORLDS, whenever it's away or slow, unless
// LOCAL_SEARCH=off: then this server does no search or review work at all (a small machine), and while the remote is
// away the bot plays its network's own move, training mode shows the network's suggestion, and reviews wait.
const REMOTE_TOKEN = process.env.REMOTE_TOKEN ?? '';
const REMOTE_WORLDS = Number(process.env.REMOTE_WORLDS ?? 512);
const LOCAL_SEARCH = process.env.LOCAL_SEARCH !== 'off';
// The search (on unless SEARCH=off), and the coach (COACH=1), play out moves in these worker threads.
const SEARCH = process.env.SEARCH !== 'off' && (LOCAL_SEARCH || REMOTE_TOKEN !== '');
// Not started at all when nothing here needs it: no second copy of the network in memory.
const pool = LOCAL_SEARCH && (SEARCH || process.env.COACH === '1') ? new RolloutPool(Math.max(1, availableParallelism() - 2), weights) : null;
const remote = REMOTE_TOKEN ? new RemoteQueue(REMOTE_TOKEN, (({ step, fingerprint }) => `${step}:${fingerprint}`)(Policy.load(readFileSync(weights)).info)) : null;
const search = (remote ? new RemoteEvaluator(remote, pool, REMOTE_WORLDS) : pool) as Evaluator;
// The bot's difficulty (the room's Settings.botLevel, chosen by the host): hard searches as above; medium searches
// MEDIUM_WORLDS worlds (64), wherever it searches; easy plays its network's own move. On 30 decisions judged on
// held-out worlds, a decision loses about 1.9 points of win chance against the best move with the network alone,
// 0.4 at 64 worlds and 0.07 at 2,048. Training mode's advice and the round reviews are the same at every level.
const MEDIUM_WORLDS = Number(process.env.MEDIUM_WORLDS ?? 64);
const capped = (n: number): Evaluator | null => pool && { evaluate: (job) => pool.evaluate({ ...job, n: Math.min(job.n, n) }) };
const medium = (remote ? new RemoteEvaluator(remote, capped(MEDIUM_WORLDS), MEDIUM_WORLDS) : capped(MEDIUM_WORLDS)) as Evaluator;
const levelOf = (room: unknown): BotLevel => (room as { settings?: Settings }).settings?.botLevel ?? 'hard';
const MODE = process.env.SEARCH_MODE === 'best-q' ? 'best-q' : 'damped';
setSearchMode(MODE);

// What the bot thought at each of its decisions, by room, for the insight page.
const rooms = new Map<string, { reports: SearchReport[]; updated: number }>();
let latest: string | null = null;
function record(code: string, report: SearchReport): void {
  const room = rooms.get(code) ?? { reports: [], updated: 0 };
  room.reports.push(report);
  const g = globalThis as unknown as { __reports?: Map<string, SearchReport[]> };
  (g.__reports ??= new Map()).set(code, room.reports);
  room.updated = Date.now();
  rooms.set(code, room);
  latest = code;
}
// Read on each request, so edits to the pages show without a restart.
const page = () => readFileSync(join(import.meta.dirname, 'insight.html'));
const spectatePage = () => readFileSync(join(import.meta.dirname, 'spectate.html'));

// Live rooms, for the spectator page (local only: the insight server isn't exposed).
type LiveRoom = { code: string; lastActivity: number; game: { state: GameState; events: TraceEvent[] } | null; players: { id: string; name: string; seat: number | null; bot?: boolean; training?: boolean }[] };
const liveRooms = new Map<string, LiveRoom>();
const sendGame = (Room.prototype as unknown as { sendGame: (...a: unknown[]) => unknown }).sendGame;
(Room.prototype as unknown as { sendGame: (...a: unknown[]) => unknown }).sendGame = function (this: LiveRoom, ...args: unknown[]) {
  liveRooms.set(this.code, this);
  noteSession(this);
  try {
    if (COACH) coachUpdate(this);
  } catch (error) {
    console.error(`room ${this.code}: the coach failed: ${String(error instanceof Error ? error.stack : error)}`);
  }
  return sendGame.apply(this, args);
};
// Who played each game, by its replay file (replays record only the moves): data/sessions.jsonl,
// one line per game when it starts (with whether each player's training mode is on), and one each
// time a player switches training mode during a game. sessions.ts joins them into a summary of who
// played and how it went.
const noted = new Set<string>();
function noteSession(room: LiveRoom): void {
  const startedAt = (room.game as { startedAt?: number } | null)?.startedAt;
  if (!startedAt) return;
  const replay = replayFileName(room.code, startedAt);
  if (noted.has(replay)) return;
  noted.add(replay);
  const players = room.players.filter((p) => p.seat !== null).map((p) => ({ seat: p.seat, name: p.name, bot: !!p.bot, training: !!p.training }));
  appendFileSync(join(DATA, 'sessions.jsonl'), JSON.stringify({ replay, room: room.code, startedAt, bot: botName, ...(SEARCH ? { level: levelOf(room) } : {}), players }) + '\n');
}
const handle = (Room.prototype as unknown as { handle: (id: string, message: { t: string }) => void }).handle;
(Room.prototype as unknown as { handle: (id: string, message: { t: string }) => void }).handle = function (this: LiveRoom, id, message) {
  const player = message.t === 'training' ? this.players.find((p) => p.id === id) : undefined;
  const was = !!player?.training;
  handle.call(this, id, message);
  if (!player || !!player.training === was) return;
  const game = this.game as { startedAt?: number; state: GameState } | null;
  try {
    appendFileSync(
      join(DATA, 'sessions.jsonl'),
      JSON.stringify({
        event: 'training',
        on: !!player.training,
        room: this.code,
        replay: game?.startedAt ? replayFileName(this.code, game.startedAt) : null,
        at: Date.now(),
        name: player.name,
        seat: player.seat,
        ...(game ? { round: game.state.round, turn: game.state.turnNumber } : {}),
      }) + '\n',
    );
  } catch (error) {
    console.error(`room ${this.code}: could not record training mode:`, error);
  }
};
const namesOf = (room: LiveRoom): (string | null)[] => {
  const names: (string | null)[] = [null, null, null, null];
  for (const p of room.players) if (p.seat !== null) names[p.seat] = p.name;
  return names;
};

// The coach: at each of a human player's decisions, what the bot would play in their seat. It is a
// bot of its own in that seat, seeing only that player's view and log (its belief built at each of
// their decisions, as the bot's is at its own), searching worlds sampled from THEIR information.
// First the network's probabilities, then the search's win chances when the rollouts finish.
// Off unless COACH=1: it searches at every one of the human's decisions, competing with the bot's search.
const COACH = process.env.COACH === '1';
const coachPolicy = Policy.load(readFileSync(weights));
type CoachMove = { label: string; policy: number; win: number | null; chosen: boolean };
type Coach = {
  game: unknown;
  bots: Map<number, BotPlayer>;
  key: string;
  seat: number | null;
  name: string | null;
  turn: number;
  kind: string;
  status: 'waiting' | 'thinking' | 'searched' | 'forced' | 'error';
  before: number | null;
  after: number | null;
  recommended: string | null;
  moves: CoachMove[];
  worlds: number;
  ms: number;
  error: string | null;
  updated: number;
};
const coaches = new Map<string, Coach>();
/** A candidate's text as the game's own buttons word it (the move ids if the game has no button for it). */
function moveLabel(labels: Map<string, string>, command: unknown, move: string): string {
  return labels.get(JSON.stringify(command)) ?? move.split(' ').map((id) => CARDS[id as keyof typeof CARDS]?.name ?? id).join(' → ');
}
function coachUpdate(room: LiveRoom): void {
  const game = room.game;
  if (!game) return;
  let c = coaches.get(room.code);
  if (!c || c.game !== game) {
    c = { game, bots: new Map(), key: '', seat: null, name: null, turn: 0, kind: '', status: 'waiting', before: null, after: null, recommended: null, moves: [], worlds: 0, ms: 0, error: null, updated: Date.now() };
    coaches.set(room.code, c);
  }
  const { state, events } = game;
  if (state.phase !== 'playing' && state.phase !== 'post-round') return;
  const humans = room.players.filter((p) => !p.bot && p.seat !== null).map((p) => p.seat!);
  const seat = humans.find((s) => state.prompts.some((p) => p.seat === s));
  if (seat === undefined) return; // the bot's decision: keep showing the last one
  const key = `${events.length}:${state.prompts.map((p) => p.id).join(',')}`;
  if (c.key === key) return;
  const entry = c;
  entry.key = key;
  const names = namesOf(room);
  const labels = new Map(describeOptions(viewFor(state, seat as 0), makeNames(names, seat as 0)).map((o) => [JSON.stringify(o.command), o.label]));
  Object.assign(entry, {
    seat, name: names[seat], turn: state.turnNumber, kind: state.prompts.find((p) => p.seat === seat)?.kind ?? '?',
    status: 'thinking', before: null, after: null, recommended: null, moves: [], worlds: 0, ms: 0, error: null, updated: Date.now(),
  });
  const bot = entry.bots.get(seat) ?? new BotPlayer(coachPolicy, seat as 0);
  entry.bots.set(seat, bot);
  const started = Date.now();
  searchChoose(
    bot, state, events as never, search,
    (r) => {
      if (entry.key !== key) return;
      entry.status = r.after === null ? 'forced' : 'searched';
      entry.after = r.after;
      entry.worlds = r.worlds;
      entry.moves = r.moves.map((m) => ({ label: moveLabel(labels, m.command, m.move), policy: m.policy, win: m.win, chosen: m.chosen }));
      entry.recommended = entry.moves.find((m) => m.chosen)?.label ?? null;
      entry.updated = Date.now();
    },
    (e) => {
      if (entry.key !== key) return;
      entry.before = e.before;
      entry.moves = e.moves
        .map((m) => ({ label: moveLabel(labels, m.command, m.move), policy: m.policy, win: null, chosen: false }))
        .sort((a, b) => b.policy - a.policy);
      entry.recommended = entry.moves[0]?.label ?? null;
      entry.updated = Date.now();
    },
  ).then(
    (command) => {
      if (entry.key !== key) return;
      // A pile reorder is searched card by card, without a report: show the order it settled on.
      if (entry.status === 'thinking') {
        entry.status = 'searched';
        entry.recommended = moveLabel(labels, command, ((command as { answer?: { order?: string[] } }).answer?.order ?? []).join(' '));
      }
      entry.ms = Date.now() - started;
      entry.updated = Date.now();
    },
    (error: unknown) => {
      if (entry.key !== key) return;
      entry.status = 'error';
      entry.error = String(error instanceof Error ? error.message : error);
      console.error(`room ${room.code}: the coach's search failed: ${String(error instanceof Error ? error.stack : error)}`);
    },
  );
}
const coachPage = () => readFileSync(join(import.meta.dirname, 'coach.html'));
const cardName = (id: string) => CARDS[id as keyof typeof CARDS]?.name ?? id;
function spectate(code: string | null) {
  const rooms = [...liveRooms.values()].filter((r) => r.game).sort((a, b) => b.lastActivity - a.lastActivity);
  const room = (code && liveRooms.get(code)) || rooms[0];
  if (!room?.game) return { rooms: rooms.map((r) => r.code), room: null };
  const { state, events } = room.game;
  const names: (string | null)[] = [null, null, null, null];
  for (const p of room.players) if (p.seat !== null) names[p.seat] = p.name;
  const view = viewFor(state, 'spectator');
  const seats = state.config.seats.map((kind, seat) => ({ kind, seat })).filter((s) => s.kind === 'player').map((s) => s.seat);
  return {
    rooms: rooms.map((r) => r.code),
    room: room.code,
    round: state.round,
    turn: state.turnNumber,
    phase: state.phase,
    marks: state.marks,
    marksToWin: state.config.marksToWin,
    toMove: state.prompts.map((p) => ({ seat: p.seat, kind: p.kind, name: names[p.seat] })),
    players: seats.map((seat) => ({
      seat,
      name: names[seat],
      score: view.scores[seat],
      hand: state.hands[seat]!.map(cardName),
      keep: state.keeps[seat]!.map((c) => ({ name: cardName(c.id), faceDown: !!c.faceDown })),
    })),
    piles: [0, 1, 2, 3].map((position) => {
      const pile = state.piles[state.pileAt[position as 0]!];
      return { position, owner: names[position], identity: pile.id, cards: pile.cards.map((c) => ({ name: cardName(c.id), faceUp: c.faceUp })) };
    }),
    discard: state.discard.map(cardName),
    log: logLines(events, makeNames(names, 'spectator')).slice(-60),
    bot: rooms.length && room ? (globalThis as unknown as { __reports?: Map<string, SearchReport[]> }).__reports?.get(room.code)?.slice(-1)[0] ?? null : null,
  };
}
function insightPages(req: IncomingMessage, res: ServerResponse): void {
  // Settings while it runs (no restart, so games in progress continue): /settings?worlds=512
  if (req.url?.startsWith('/settings')) {
    const worlds = Number(new URL(req.url, 'http://x').searchParams.get('worlds'));
    if (Number.isInteger(worlds) && worlds > 0) setWorlds(worlds);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ worlds: WORLDS, mode: MODE, remote: remote ? { connected: remote.connected(), worlds: REMOTE_WORLDS, load: remote.load() } : null, reviews: reviewPool?.load() ?? null }));
    return;
  }
  if (req.url?.startsWith('/coach.json')) {
    const code = new URL(req.url, 'http://x').searchParams.get('room');
    const live = [...coaches.entries()].filter(([, c]) => c.seat !== null).sort((a, b) => b[1].updated - a[1].updated);
    const [room, c] = (code && coaches.has(code) ? [code, coaches.get(code)!] : live[0]) ?? [null, null];
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ rooms: live.map(([r]) => r), room, coach: c && { ...c, game: undefined, bots: undefined } }));
    return;
  }
  if (req.url?.startsWith('/coach')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(COACH ? coachPage() : 'The coach is off. Start the server with COACH=1 to use it.');
    return;
  }
  if (req.url?.startsWith('/spectate.json')) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(spectate(new URL(req.url, 'http://x').searchParams.get('room'))));
    return;
  }
  if (req.url?.startsWith('/spectate')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(spectatePage());
    return;
  }
  if (req.url === '/data') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ latest, rooms: Object.fromEntries(rooms) }));
  } else {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page());
  }
}
// Local only: it shows both hands. The same pages are on the game's address under /bot/, behind the admin password.
const INSIGHT_PORT = Number(process.env.INSIGHT_PORT ?? 8789);
createServer(insightPages).listen(INSIGHT_PORT, '127.0.0.1');

// The room plays the bot synchronously (bot.choose); here it waits for the search instead. While
// the search runs, botTimer holds its cancel, so the room neither schedules the bot twice nor
// plays a move for a state that has changed.
type RoomInternals = {
  game: { state: GameState; events: unknown[] } | null;
  botTimer: (() => void) | null;
  code: string;
  players: { seat: number | null; bot?: boolean; send: ((m: unknown) => void) | null }[];
  playerAt(seat: number): unknown;
  command(player: unknown, command: unknown): string | null;
  scheduleBot(): void;
};
// The live game's searches, by the position they searched (the bot's own moves, training mode's advice):
// the round review reuses them rather than search again.
const liveSearches = new WeakMap<GameState, Promise<SearchReport | null>>();
function liveSearch(state: GameState, seat: Seat): (report: SearchReport | null) => void {
  let resolve!: (report: SearchReport | null) => void;
  const report = new Promise<SearchReport | null>((r) => (resolve = r));
  liveSearches.set(state, report);
  // Also the seat's own estimate of the position, for the round review's lines.
  reviewer?.searched(state, seat, report);
  return resolve;
}
// With no search here (LOCAL_SEARCH=off), the search machine being away is an error the player is told about (at most
// once a minute per room): the bot waits for it, trying again every 15 s, and training mode shows no hint.
const awayNoticeAt = new Map<string, number>();
function noticeAway(room: RoomInternals, seat?: number): void {
  const now = Date.now();
  if (now - (awayNoticeAt.get(room.code) ?? 0) < 60_000) return;
  awayNoticeAt.set(room.code, now);
  console.error(`room ${room.code}: the search machine is unavailable`);
  for (const p of room.players) {
    if (p.bot || !p.send || (seat !== undefined && p.seat !== seat)) continue;
    p.send({ t: 'error', message: `${DISPLAY_NAME}'s search machine is unavailable right now. ${seat === undefined ? 'It will move as soon as it is back.' : 'No hint until it is back.'}` });
  }
}

// SEARCH=off, or the easy level: the room's own bot plays instead, straight from its network (no search, instant moves).
const playBot = (Room.prototype as unknown as { playBot: (game: RoomInternals['game'], bot: BotPlayer) => void }).playBot;
if (SEARCH) (Room.prototype as unknown as { playBot: (game: RoomInternals['game'], bot: BotPlayer) => void }).playBot = function (
  this: RoomInternals,
  game,
  bot,
) {
  const level = levelOf(this);
  if (level === 'easy') return playBot.call(this, game, bot);
  const player = this.playerAt(bot.seat);
  if (!player || !game) return;
  const state = game.state;
  let cancelled = false;
  this.botTimer = () => {
    cancelled = true;
  };
  // A search failure is a bug to fix (it is logged loudly); meanwhile the network plays its own move, unsearched.
  const fallback = (why: string) => {
    console.error(`room ${this.code}: SEARCH FAILED (${why}); playing the network's own move instead`);
    const error = this.command(player, bot.choose(game.state, game.events as never));
    if (error !== null) console.error(`room ${this.code}: the network's own move failed too: ${error}`);
  };
  const found = liveSearch(state, bot.seat);
  searchChoose(bot, state, game.events as never, level === 'medium' ? medium : search, (r) => {
    record(this.code, r);
    found(r);
  }).then(
    (command) => {
      found(null); // (no report: nothing to compare)
      this.botTimer = null;
      if (cancelled || this.game !== game || game.state !== state) return this.scheduleBot();
      const error = this.command(player, command);
      if (error !== null) fallback(error);
    },
    (error: unknown) => {
      found(null);
      this.botTimer = null;
      if (cancelled || this.game !== game || game.state !== state) return this.scheduleBot();
      if (error instanceof RemoteAway) {
        noticeAway(this);
        const retry = setTimeout(() => {
          if (this.botTimer !== cancel) return;
          this.botTimer = null;
          this.scheduleBot();
        }, 15_000);
        const cancel = () => clearTimeout(retry);
        this.botTimer = cancel;
        return;
      }
      fallback(String(error instanceof Error ? error.stack : error));
    },
  );
};
// Training mode's advice comes from the same search, from the seat's own information (the room shows
// "thinking" until it's ready, and falls back to the network's suggestion if the search fails; with the
// search machine away, no hint at all).
if (SEARCH)
  (Room.prototype as unknown as { advise: (bot: BotPlayer, state: GameState, events: readonly TraceEvent[]) => Promise<unknown> }).advise = function (
    this: RoomInternals,
    bot,
    state,
    events,
  ) {
    const found = liveSearch(state, bot.seat);
    return searchAdvise(bot, state, events, search, found)
      .catch((error: unknown) => {
        if (!(error instanceof RemoteAway)) throw error;
        noticeAway(this, bot.seat);
        return [];
      })
      .finally(() => found(null));
  };

// Round reviews (REVIEW=off: none): every move of a game against the bot judged as the round goes, in
// worker processes at the lowest CPU priority, and each round's review sent to the person once it's over.
type ReviewRoom = {
  code: string;
  game: (ReviewedGame & { state: GameState }) | null;
  players: { id: string; name: string; seat: number | null; bot?: boolean; send: ((m: unknown) => void) | null }[];
};
const REVIEW = process.env.REVIEW !== 'off';
const reviewPool = REVIEW ? new ReviewPool(LOCAL_SEARCH ? Math.max(1, availableParallelism() - 2) : 0, weights) : null;
if (reviewPool && remote) {
  reviewPool.remote = remote;
  remote.onPoll = () => reviewPool.kick();
}
const roomOfGame = new WeakMap<ReviewedGame, ReviewRoom>();
const reviewedGameOf = new WeakMap<ReviewRoom, ReviewedGame>();
const reviewer = reviewPool
  ? new Reviewer(reviewPool, (game, review) => {
      const room = roomOfGame.get(game);
      if (room?.game !== game) return;
      for (const p of room.players) if (!p.bot && p.seat === review.seat) p.send?.({ t: 'review', review });
    })
  : null;
/** Keeps the reviewer on the room's current game: stops the old one, starts a new game against the bot. */
function followGame(room: ReviewRoom): void {
  if (!reviewer) return;
  const old = reviewedGameOf.get(room);
  if (old && old !== room.game) {
    reviewer.stop(old);
    reviewedGameOf.delete(room);
  }
  const game = room.game;
  if (!game || reviewedGameOf.get(room) === game) return;
  const seated = room.players.filter((p) => p.seat !== null);
  const bots = seated.filter((p) => p.bot);
  const people = seated.filter((p) => !p.bot);
  if (bots.length !== 1 || people.length !== 1) return;
  const names: (string | null)[] = [null, null, null, null];
  for (const p of seated) names[p.seat!] = p.name;
  roomOfGame.set(game, room);
  reviewedGameOf.set(room, game);
  reviewer.start(room.code, game, people[0]!.seat as Seat, bots[0]!.seat as Seat, names);
}
if (reviewer) {
  const proto = Room.prototype as unknown as {
    command: (player: { seat: number | null }, command: Command) => string | null;
    close: () => void;
    sendGame: (player: { seat: number | null; bot?: boolean; send: ((m: unknown) => void) | null }, reset: boolean, ...rest: unknown[]) => unknown;
  };
  const command = proto.command;
  proto.command = function (this: ReviewRoom, player, cmd) {
    const game = this.game;
    const before = game?.state;
    const eventsBefore = game?.events;
    const error = command.call(this, player, cmd);
    if (error !== null || !game || !before || !eventsBefore || player.seat === null) return error;
    followGame(this);
    if (!reviewer.has(game)) return error;
    // The move's own result, recomputed (the engine is deterministic): the bot may already have moved since.
    const r = apply(before, player.seat as Seat, cmd);
    // The game's own object for the position after the move (searches of the next decision are keyed by it).
    const history = (game as unknown as { history: { state: GameState }[] }).history;
    const afterInGame = history.at(-1)?.state === before ? game.state : undefined;
    if (r.ok) reviewer.moved(game, before, player.seat as Seat, cmd, r.state, [...eventsBefore, ...r.events], r.events, liveSearches.get(before), afterInGame);
    return error;
  };
  // The person going away sets the round in play aside; coming back (the game sent afresh) resumes it.
  const away = (room: ReviewRoom) => {
    const game = reviewedGameOf.get(room);
    if (game && !room.players.some((p) => !p.bot && p.seat !== null && p.send)) reviewer.pause(game);
  };
  const protoAway = Room.prototype as unknown as { disconnect: (...a: unknown[]) => unknown; handle: (id: string, message: { t: string }) => unknown };
  const disconnect = protoAway.disconnect;
  protoAway.disconnect = function (this: ReviewRoom, ...args: unknown[]) {
    const out = disconnect.apply(this, args);
    away(this);
    return out;
  };
  const handleMessage = protoAway.handle;
  protoAway.handle = function (this: ReviewRoom, id, message) {
    const out = handleMessage.call(this, id, message);
    if (message.t === 'leave') away(this);
    return out;
  };
  const close = proto.close;
  proto.close = function (this: ReviewRoom) {
    const game = reviewedGameOf.get(this);
    if (game) reviewer.stop(game);
    return close.call(this);
  };
  // A player who (re)connects gets the finished rounds' reviews again; a game that ended back in the lobby stops being reviewed.
  const sendGameWithReviews = proto.sendGame;
  proto.sendGame = function (this: ReviewRoom, player, reset, ...rest) {
    const out = sendGameWithReviews.call(this, player, reset, ...rest);
    followGame(this);
    if (reset && this.game && !player.bot && player.send) {
      reviewer.resume(this.game);
      for (const review of reviewer.finished(this.game)) if (review.seat === player.seat) player.send({ t: 'review', review });
    }
    return out;
  };
}

await createKeepsServer({
  port: Number(process.env.PORT ?? 8788),
  webDir: join(root, 'packages/web/dist'),
  cardsDir: join(root, 'cards'),
  dataDir: DATA,
  botWeights: weights,
  botName: DISPLAY_NAME,
  botLevels: SEARCH,
  // The bot pages, for the admin only: /bot/ (insight), /bot/spectate, /bot/coach.
  extraRoutes: (req, res, path) => {
    if (remote?.handle(req, res, path)) return true;
    if (path !== '/bot' && !path.startsWith('/bot/')) return false;
    if (!ADMIN_TOKEN) {
      res.writeHead(404).end('Not found');
      return true;
    }
    if (!authorized(req, ADMIN_TOKEN)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="Keeps admin"', 'content-type': 'text/plain' }).end('Unauthorized');
      return true;
    }
    if (path === '/bot') {
      res.writeHead(302, { location: '/bot/' }).end();
      return true;
    }
    req.url = (req.url ?? '/').slice('/bot'.length) || '/';
    insightPages(req, res);
    return true;
  },
});
console.log(`search demo on http://localhost:${process.env.PORT ?? 8788}, bot insight on http://localhost:${INSIGHT_PORT}${COACH ? `, coach on http://localhost:${INSIGHT_PORT}/coach` : ''} (${botName}, ${SEARCH ? `${WORLDS} worlds per decision, ${process.env.SEARCH_ROLLOUTS === 'sampled' ? 'sampled' : 'greedy'} rollouts, ${MODE === 'best-q' ? 'best-Q play' : `damped update, alpha ${ALPHA}, beta ${BETA}`}` : 'no search: its network plays directly'}${remote ? `; a remote worker searches ${REMOTE_WORLDS} worlds and runs the reviews when connected${LOCAL_SEARCH ? '' : ', and nothing is searched here (while it is away, the bot waits and the player is told)'}` : ''})`);

// Stop promptly when asked (Fly stops an idle machine, and deploys, with SIGINT/SIGTERM).
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(0));
