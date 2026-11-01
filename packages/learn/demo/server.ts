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
import { CARDS, viewFor } from '../../engine/src/index.ts';
import { logLines } from '@keeps/table';
import { describeOptions, makeNames } from '@keeps/table';
import { BotPlayer } from '@keeps/bot';
import { Policy } from '@keeps/bot';
import type { Room, RoomHooks } from '../../server/src/room.ts';
import { createKeepsServer } from '../../server/src/server.ts';
import { replayFileName } from '../../server/src/replays.ts';
import { authorized } from '../../server/src/admin.ts';
import { RemoteAway, RemoteEvaluator, RemoteQueue } from '@keeps/bot/remote/remote.ts';
import { composeHooks, midstrikeHost } from '@keeps/bot/host.ts';
import { ReviewPool } from '@keeps/bot/review/pool.ts';
import { ALPHA, BETA, searchChoose, setSearchMode, setWorlds, WORLDS, type Evaluator, type SearchReport } from '@keeps/bot/search/search.ts';
import { RolloutPool } from '@keeps/bot/search/rollout-pool.ts';

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
// (Midstrike's network is committed with the bot; the research networks aren't.)
const weights = join(root, botName === 'midstrike' ? 'packages/bot/weights' : 'packages/learn/weights', `${botName}.bin`);
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
type LiveRoom = Room;
const liveRooms = new Map<string, LiveRoom>();
// Who played each game, by its replay file (replays record only the moves): data/sessions.jsonl,
// one line per game when it starts (with whether each player's training mode is on), and one each
// time a player switches training mode during a game. sessions.ts joins them into a summary of who
// played and how it went.
const noted = new Set<string>();
function noteSession(room: LiveRoom): void {
  const startedAt = room.runningGame?.startedAt;
  if (!startedAt) return;
  const replay = replayFileName(room.code, startedAt);
  if (noted.has(replay)) return;
  noted.add(replay);
  const players = room.members.filter((p) => p.seat !== null).map((p) => ({ seat: p.seat, name: p.name, bot: p.bot, training: p.training }));
  appendFileSync(join(DATA, 'sessions.jsonl'), JSON.stringify({ replay, room: room.code, startedAt, bot: botName, ...(SEARCH ? { level: room.roomSettings.botLevel ?? 'hard' } : {}), players }) + '\n');
}
// This server's own additions to its rooms: the spectator page's list, the session log, the coach.
const nodeHooks: RoomHooks = {
  sent(room) {
    liveRooms.set(room.code, room);
    noteSession(room);
    try {
      if (COACH) coachUpdate(room);
    } catch (error) {
      console.error(`room ${room.code}: the coach failed: ${String(error instanceof Error ? error.stack : error)}`);
    }
  },
  trainingChanged(room, player) {
    const game = room.runningGame;
    try {
      appendFileSync(
        join(DATA, 'sessions.jsonl'),
        JSON.stringify({
          event: 'training',
          on: player.training,
          room: room.code,
          replay: game ? replayFileName(room.code, game.startedAt) : null,
          at: Date.now(),
          name: player.name,
          seat: player.seat,
          ...(game ? { round: game.state.round, turn: game.state.turnNumber } : {}),
        }) + '\n',
      );
    } catch (error) {
      console.error(`room ${room.code}: could not record training mode:`, error);
    }
  },
};
const namesOf = (room: LiveRoom): (string | null)[] => {
  const names: (string | null)[] = [null, null, null, null];
  for (const p of room.members) if (p.seat !== null) names[p.seat] = p.name;
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
  const game = room.runningGame;
  if (!game) return;
  let c = coaches.get(room.code);
  if (!c || c.game !== game) {
    c = { game, bots: new Map(), key: '', seat: null, name: null, turn: 0, kind: '', status: 'waiting', before: null, after: null, recommended: null, moves: [], worlds: 0, ms: 0, error: null, updated: Date.now() };
    coaches.set(room.code, c);
  }
  const { state, events } = game;
  if (state.phase !== 'playing' && state.phase !== 'post-round') return;
  const humans = room.members.filter((p) => !p.bot && p.seat !== null).map((p) => p.seat!);
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
  const rooms = [...liveRooms.values()].filter((r) => r.runningGame).sort((a, b) => b.lastActivity - a.lastActivity);
  const room = (code && liveRooms.get(code)) || rooms[0];
  if (!room?.runningGame) return { rooms: rooms.map((r) => r.code), room: null };
  const { state, events } = room.runningGame;
  const names: (string | null)[] = [null, null, null, null];
  for (const p of room.members) if (p.seat !== null) names[p.seat] = p.name;
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

// Midstrike's host (host.ts): its moves searched at the room's difficulty (SEARCH=off: its network plays directly),
// training mode's advice from the same search, and round reviews (REVIEW=off: none), their jobs in worker processes
// at the lowest CPU priority, or on the remote worker when it's connected.
const REVIEW = process.env.REVIEW !== 'off';
const reviewPool = REVIEW ? new ReviewPool(LOCAL_SEARCH ? Math.max(1, availableParallelism() - 2) : 0, weights) : null;
if (reviewPool && remote) {
  reviewPool.remote = remote;
  remote.onPoll = () => reviewPool.kick();
}
const host = midstrikeHost({
  name: DISPLAY_NAME,
  ...(SEARCH ? { search: { medium, hard: search } } : {}),
  ...(reviewPool ? { reviews: reviewPool } : {}),
  // With no search here (LOCAL_SEARCH=off), the search machine being away is no bug: the bot waits for it.
  away: (error) => error instanceof RemoteAway,
  onSearch: (room, report) => record(room.code, report),
});

await createKeepsServer({
  port: Number(process.env.PORT ?? 8788),
  webDir: join(root, 'packages/web/dist'),
  cardsDir: join(root, 'cards'),
  dataDir: DATA,
  botWeights: weights,
  botName: DISPLAY_NAME,
  botLevels: SEARCH,
  ...(SEARCH ? { botPlay: host.bot } : {}),
  roomHooks: composeHooks(nodeHooks, host.hooks),
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
