// Midstrike on the website: the bot people play, at the level the host chooses (packages/bot's host: its moves
// searched, training mode's advice, the round reviews), with its search and reviews on a remote machine when one is
// connected, and two admin pages about it. Configured once, from the environment, here.
import { appendFileSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import { CARDS, viewFor } from '@keeps/engine';
import { logLines, makeNames } from '@keeps/table';
import { Policy } from '@keeps/bot';
import { composeHooks, midstrikeHost } from './host.ts';
import { RemoteAway, RemoteEvaluator, RemoteQueue } from '@keeps/bot/remote/remote.ts';
import { ReviewPool } from '@keeps/bot/review/pool.ts';
import { RolloutPool } from '@keeps/bot/search/rollout-pool.ts';
import { atWorlds, type Evaluator, type SearchReport } from '@keeps/bot/search/search.ts';
import { authorized } from './admin.ts';
import { replayFileName } from './replays.ts';
import type { BotFailure, Room, RoomHooks } from './room.ts';
import type { ServerOptions } from './server.ts';

export interface MidstrikeConfig {
  /** Its network. */
  weights: string;
  /** Its name at the table. */
  name: string;
  /**
   * The remote machine's token (remote.ts): with it, the search and the reviews run there (`remoteWorlds` worlds per
   * decision) whenever it's connected. Without it, they run here.
   */
  remoteToken: string | null;
  remoteWorlds: number;
  /** Worlds per decision at the medium level (hard: `remoteWorlds` there, `localWorlds` here). */
  mediumWorlds: number;
  localWorlds: number;
  /**
   * Whether this machine searches and reviews at all. Off on a small machine: then everything waits for the remote
   * machine (the table is told while it's away).
   */
  localSearch: boolean;
  /** Round reviews for games against it. */
  reviews: boolean;
}

/** The configuration from the environment, production's by default. */
export function midstrikeConfig(env: NodeJS.ProcessEnv, root: string): MidstrikeConfig {
  const number = (name: string, fallback: number) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive whole number, not ${env[name]}`);
    return value;
  };
  return {
    weights: env.BOT_WEIGHTS ?? join(root, 'packages/bot/weights/midstrike.bin'),
    name: env.BOT_NAME ?? 'Midstrike',
    remoteToken: env.REMOTE_TOKEN || null,
    remoteWorlds: number('REMOTE_WORLDS', 2048),
    mediumWorlds: number('MEDIUM_WORLDS', 64),
    localWorlds: number('LOCAL_WORLDS', 256),
    localSearch: env.LOCAL_SEARCH !== 'off',
    reviews: env.REVIEWS !== 'off',
  };
}

/** How many of a room's latest search reports the insight page keeps. */
const REPORTS_KEPT = 40;
/** How many of the bot's latest failures the status page shows. */
const FAILURES_KEPT = 20;

/**
 * Midstrike, set up: what the server takes (its options for the bot, its rooms' hooks, the remote machine's and the
 * admin pages' routes). `dataDir` is where the session log goes; `rooms`, the server's live rooms (for the admin
 * pages, once the server is made); `adminToken`, the admin pages' password.
 */
export function midstrike(
  config: MidstrikeConfig,
  { dataDir, adminToken, rooms }: { dataDir: string | undefined; adminToken: string | undefined; rooms: () => ReadonlyMap<string, Room> },
): Pick<ServerOptions, 'botWeights' | 'botName' | 'botLevels' | 'botPlay' | 'roomHooks' | 'extraRoutes'> & { describe: string } {
  const threads = Math.max(1, availableParallelism() - 2);
  const pool = config.localSearch ? new RolloutPool(threads, config.weights, true) : null;
  const policy = Policy.load(readFileSync(config.weights));
  const remote = config.remoteToken ? new RemoteQueue(config.remoteToken, `${policy.info.step}:${policy.info.fingerprint}`) : null;
  const here = (worlds: number): Evaluator | null => pool && atWorlds(pool, Math.min(worlds, config.localWorlds));
  const searchAt = (worlds: number) => (remote ? new RemoteEvaluator(remote, here(worlds), worlds) : here(worlds));
  const hard = searchAt(config.remoteToken ? config.remoteWorlds : config.localWorlds);
  const medium = searchAt(config.mediumWorlds);
  const reviewPool = config.reviews && (pool || remote) ? new ReviewPool(config.localSearch ? threads : 0, config.weights) : null;
  if (reviewPool && remote) {
    reviewPool.remote = remote;
    remote.onPoll = () => reviewPool.kick();
  }

  // The latest of each room's search reports, for the insight page; gone with the room. (A report's outcomes, one row
  // per world, are what the round review needed: not kept.)
  const reports = new WeakMap<Room, SearchReport[]>();
  const record = (room: Room, report: SearchReport) => {
    const list = reports.get(room) ?? [];
    const { outcomes: _, ...kept } = report;
    list.push(kept as SearchReport);
    if (list.length > REPORTS_KEPT) list.splice(0, list.length - REPORTS_KEPT);
    reports.set(room, list);
  };

  const host = midstrikeHost({
    name: config.name,
    ...(hard && medium ? { search: { medium, hard } } : {}),
    ...(reviewPool ? { reviews: reviewPool } : {}),
    // Searching nothing here, the remote machine being away is no bug: the bot waits for it, and the table is told.
    away: (error) => error instanceof RemoteAway,
    onSearch: record,
  });

  // The bot's failures (bugs: the room played on without what failed), for the status page.
  const failures = { counts: { search: 0, move: 0, advice: 0 } as Record<BotFailure, number>, latest: [] as object[] };
  const failed: RoomHooks = {
    botFailed(room, what, error) {
      failures.counts[what]++;
      failures.latest.push({ at: new Date().toISOString(), room: room.code, what, error });
      if (failures.latest.length > FAILURES_KEPT) failures.latest.shift();
    },
  };

  return {
    botWeights: config.weights,
    botName: config.name,
    botLevels: Boolean(hard),
    ...(hard ? { botPlay: host.bot } : {}),
    roomHooks: composeHooks(sessionLog(dataDir, basename(config.weights, '.bin')), host.hooks, failed),
    extraRoutes: (req, res, path) => {
      if (remote?.handle(req, res, path)) return true;
      if (path !== '/admin/bot' && !path.startsWith('/admin/bot/')) return false;
      if (!adminToken) {
        res.writeHead(404).end('Not found');
      } else if (!authorized(req, adminToken)) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="Keeps admin"', 'content-type': 'text/plain' }).end('Unauthorized');
      } else if (path === '/admin/bot') {
        res.writeHead(302, { location: '/admin/bot/' }).end();
      } else adminPages(req, res, path.slice('/admin/bot'.length), rooms(), reports, () => ({
        remote: remote ? { connected: remote.connected(), worlds: config.remoteWorlds, load: remote.load(), failures: remote.failures } : null,
        reviews: reviewPool?.load() ?? null,
        failures,
      }));
      return true;
    },
    describe: `${config.name}: ${hard ? `searching ${config.remoteToken ? `${config.remoteWorlds} worlds on the remote machine${config.localSearch ? `, ${config.localWorlds} here while it's away` : ' (nothing here: while it is away, the bot waits)'}` : `${config.localWorlds} worlds here`}` : "no search: its network's own moves"}${reviewPool ? ', round reviews' : ''}`,
  };
}

/**
 * Who played each game, by its replay file (replays record only the moves): `sessions.jsonl` in the data directory,
 * one line per game as it starts (each player, and whether their training mode is on) and one each time a player
 * switches training mode during a game. packages/server's sessions.ts joins them into a summary.
 */
function sessionLog(dataDir: string | undefined, network: string): RoomHooks {
  if (!dataDir) return {};
  const note = (line: object) => appendFileSync(join(dataDir, 'sessions.jsonl'), JSON.stringify(line) + '\n');
  return {
    gameStarted(room) {
      const game = room.runningGame!;
      const players = room.members.filter((p) => p.seat !== null).map((p) => ({ seat: p.seat, name: p.name, bot: p.bot, training: p.training }));
      note({ replay: replayFileName(room.code, game.startedAt), room: room.code, startedAt: game.startedAt, bot: network, level: room.roomSettings.botLevel ?? 'hard', players });
    },
    trainingChanged(room, player) {
      const game = room.runningGame;
      note({
        event: 'training',
        on: player.training,
        room: room.code,
        replay: game ? replayFileName(room.code, game.startedAt) : null,
        at: Date.now(),
        name: player.name,
        seat: player.seat,
        ...(game ? { round: game.state.round, turn: game.state.turnNumber } : {}),
      });
    },
  };
}

// The admin's pages about Midstrike: insight (its chance to win before and after each search, and the candidates it
// weighed) and spectate (a game with both hands and the unredacted log: an admin page, as it shows everything).
const page = (name: string) => readFileSync(join(import.meta.dirname, 'pages', name));
const cardName = (id: string) => CARDS[id as keyof typeof CARDS]?.name ?? id;
const namesOf = (room: Room): (string | null)[] => {
  const names: (string | null)[] = [null, null, null, null];
  for (const p of room.members) if (p.seat !== null) names[p.seat] = p.name;
  return names;
};

function adminPages(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  rooms: ReadonlyMap<string, Room>,
  reports: WeakMap<Room, SearchReport[]>,
  status: () => object,
): void {
  const json = (data: unknown): void => {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(data));
  };
  const html = (name: string): void => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page(name));
  };
  const playing = [...rooms.values()].filter((r) => r.runningGame).sort((a, b) => b.lastActivity - a.lastActivity);
  const chosen = new URL(req.url ?? '/', 'http://x').searchParams.get('room');
  if (path === '/status.json') return json(status());
  if (path === '/data') {
    const withReports = playing.filter((r) => reports.has(r));
    return json({ latest: withReports[0]?.code ?? null, rooms: Object.fromEntries(withReports.map((r) => [r.code, { reports: reports.get(r), updated: r.lastActivity }])) });
  }
  if (path === '/spectate') return html('spectate.html');
  if (path === '/spectate.json') {
    const room = (chosen && rooms.get(chosen)) || playing[0];
    if (!room?.runningGame) return json({ rooms: playing.map((r) => r.code), room: null });
    const { state, events } = room.runningGame;
    const names = namesOf(room);
    const view = viewFor(state, 'spectator');
    const seats = state.config.seats.flatMap((kind, seat) => (kind === 'player' ? [seat] : []));
    return json({
      rooms: playing.map((r) => r.code),
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
      bot: reports.get(room)?.at(-1) ?? null,
    });
  }
  return html('insight.html');
}
