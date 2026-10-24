// Local demo: the site with a bot (e1, or BOT=<name> for weights/<name>.bin) playing by search (search-bot.ts), a page showing what the
// bot thinks as you play, and a coach page: what the bot would play in YOUR seat, from your
// information only.
//   node server.ts   → the game at http://localhost:8788, bot insight at http://localhost:8789,
//                      the coach at http://localhost:8789/coach
// The bot plays the best rollout move (SEARCH_MODE=sample: Ataraxos's sampling instead).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { CARDS, viewFor, type GameState, type TraceEvent } from '../../engine/src/index.ts';
import { logLines } from '../../web/src/game/log.ts';
import { describeOptions, makeNames } from '../../web/src/game/options.ts';
import { BotPlayer } from '../src/bot.ts';
import { Policy } from '../src/policy.ts';
import { Room } from '../../server/src/room.ts';
import { createKeepsServer } from '../../server/src/server.ts';
import { replayFileName } from '../../server/src/replays.ts';
import { authorized } from '../../server/src/admin.ts';
import { BETA, RolloutPool, searchChoose, setSearchMode, setWorlds, WORLDS, type SearchReport } from './search-bot.ts';

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
// The search (on unless SEARCH=off), and the coach (COACH=1), play out moves in these worker threads.
const SEARCH = process.env.SEARCH !== 'off';
// Not started at all when neither needs it (SEARCH=off, no coach): no second copy of the network in memory.
const pool = (SEARCH || process.env.COACH === '1' ? new RolloutPool(Math.max(1, availableParallelism() - 2), weights) : null) as RolloutPool;
const MODE = process.env.SEARCH_MODE === 'sample' ? 'sample' : 'best-q';
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
type LiveRoom = { code: string; lastActivity: number; game: { state: GameState; events: TraceEvent[] } | null; players: { name: string; seat: number | null; bot?: boolean }[] };
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
// one line per game when it starts. sessions.ts joins the two into a summary of who played and how it went.
const noted = new Set<string>();
function noteSession(room: LiveRoom): void {
  const startedAt = (room.game as { startedAt?: number } | null)?.startedAt;
  if (!startedAt) return;
  const replay = replayFileName(room.code, startedAt);
  if (noted.has(replay)) return;
  noted.add(replay);
  const players = room.players.filter((p) => p.seat !== null).map((p) => ({ seat: p.seat, name: p.name, bot: !!p.bot }));
  appendFileSync(join(DATA, 'sessions.jsonl'), JSON.stringify({ replay, room: room.code, startedAt, bot: botName, players }) + '\n');
}
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
    bot, state, events as never, pool,
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
    res.end(JSON.stringify({ worlds: WORLDS, mode: MODE }));
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
createServer(insightPages).listen(8789, '127.0.0.1');

// The room plays the bot synchronously (bot.choose); here it waits for the search instead. While
// the search runs, botTimer holds its cancel, so the room neither schedules the bot twice nor
// plays a move for a state that has changed.
type RoomInternals = {
  game: { state: GameState; events: unknown[] } | null;
  botTimer: (() => void) | null;
  code: string;
  playerAt(seat: number): unknown;
  command(player: unknown, command: unknown): string | null;
  scheduleBot(): void;
};
// SEARCH=off: the room's own bot plays instead, straight from its network (no search, instant moves).
if (SEARCH) (Room.prototype as unknown as { playBot: (game: RoomInternals['game'], bot: BotPlayer) => void }).playBot = function (
  this: RoomInternals,
  game,
  bot,
) {
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
  searchChoose(bot, state, game.events as never, pool, (r) => record(this.code, r)).then(
    (command) => {
      this.botTimer = null;
      if (cancelled || this.game !== game || game.state !== state) return this.scheduleBot();
      const error = this.command(player, command);
      if (error !== null) fallback(error);
    },
    (error: unknown) => {
      this.botTimer = null;
      if (cancelled || this.game !== game || game.state !== state) return this.scheduleBot();
      fallback(String(error instanceof Error ? error.stack : error));
    },
  );
};

await createKeepsServer({
  port: Number(process.env.PORT ?? 8788),
  webDir: join(root, 'packages/web/dist'),
  cardsDir: join(root, 'cards'),
  dataDir: DATA,
  botWeights: weights,
  botName: DISPLAY_NAME,
  // The bot pages, for the admin only: /bot/ (insight), /bot/spectate, /bot/coach.
  extraRoutes: (req, res, path) => {
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
console.log(`search demo on http://localhost:${process.env.PORT ?? 8788}, bot insight on http://localhost:8789${COACH ? ', coach on http://localhost:8789/coach' : ''} (${botName}, ${SEARCH ? `${WORLDS} worlds per decision, ${process.env.SEARCH_ROLLOUTS === 'sampled' ? 'sampled' : 'greedy'} rollouts, ${MODE === 'best-q' ? 'best-Q play' : `sampled, beta ${BETA}`}` : 'no search: its network plays directly'})`);

// Stop promptly when asked (Fly stops an idle machine, and deploys, with SIGINT/SIGTERM).
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(0));
