import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { Policy } from '@keeps/learn';
import { ROOM_CODE, type ClientMessage, type ServerMessage } from '@keeps/protocol';
import { WebSocketServer, type WebSocket } from 'ws';
import { serveAdmin, VisitorLog, type AdminSnapshot } from './admin.ts';
import { noTracker, type Tracker } from './analytics.ts';
import { buildDispute, RateLimiter } from './dispute.ts';
import { replayFileName, ReplayStore, type DiskSpace } from './replays.ts';
import { Room, type BotDeps, type RoomDeps, type Send } from './room.ts';

export interface ServerOptions {
  port: number;
  /** Built web client to serve (index.html + assets). Optional in development. */
  webDir?: string;
  /** Card images, served at /cards/. */
  cardsDir: string;
  /** Where replay logs go (data/replays/<code>-<time>.jsonl). Omit to disable. */
  dataDir?: string;
  /** Rooms with nobody connected are deleted after this long. */
  idleRoomMs?: number;
  /** Rooms where nobody has done anything are closed after this long, even with people connected (a forgotten tab). */
  abandonedRoomMs?: number;
  /** Free space on the replay disk (tests fake a full disk with this). */
  diskSpace?: (dir: string) => DiskSpace | null;
  /** Product analytics (PostHog in production). */
  tracker?: Tracker;
  /** Password for /admin (HTTP basic auth). Without it, there is no admin page. */
  adminToken?: string;
  /** Settings the browser may read from /config.json (the public PostHog project key). */
  publicConfig?: { posthogKey?: string; posthogHost?: string };
  /** The bot's trained weights (packages/learn/weights/bot.bin). Without them, there is no bot. */
  botWeights?: string;
  /** Milliseconds the bot waits before each move (default: about a second). */
  botDelay?: () => number;
}

export interface KeepsServer {
  http: Server;
  rooms: Map<string, Room>;
  /** Runs the once-a-minute cleanup now (tests pass a future `now`). */
  sweep(now?: number): void;
  close(): Promise<void>;
}

// Unambiguous letters for room codes (no I, O, L).
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
};

export function createKeepsServer(options: ServerOptions): Promise<KeepsServer> {
  const rooms = new Map<string, Room>();
  const tracker = options.tracker ?? noTracker;
  const visitors = new VisitorLog();
  const disputeLimit = new RateLimiter(5, 10 * 60 * 1000);
  const startedAt = Date.now();
  const replays = options.dataDir
    ? new ReplayStore(join(options.dataDir, 'replays'), {
        // A game's log is in use while its room is.
        active: () => new Set([...rooms.values()].flatMap((r) => (r.gameStartedAt === null ? [] : [replayFileName(r.code, r.gameStartedAt)]))),
        ...(options.diskSpace ? { diskSpace: options.diskSpace } : {}),
      })
    : null;

  // The web build's id (written by its Vite build), so outdated pages reload.
  const buildFile = options.webDir ? join(options.webDir, 'build-id.txt') : null;
  const build = buildFile && existsSync(buildFile) ? readFileSync(buildFile, 'utf8').trim() : undefined;

  const bot = options.botWeights ? loadBot(options.botWeights, options.botDelay) : { deps: undefined, status: 'off (no weights configured)' };

  const deps: RoomDeps = {
    ...(bot.deps ? { bot: bot.deps } : {}),
    tracker,
    ...(build ? { build } : {}),
    token: () => randomBytes(18).toString('base64url'),
    id: () => randomBytes(6).toString('base64url'),
    seed: () => randomBytes(12).toString('hex'),
    random: () => randomInt(0, 2 ** 32) / 2 ** 32,
    now: () => Date.now(),
    ...(replays ? { saveReplay: (code, at, log) => replays.save(code, at, log) } : {}),
  };

  function newCode(): string {
    for (;;) {
      const code = Array.from({ length: 4 }, () => CODE_LETTERS[randomInt(0, CODE_LETTERS.length)]).join('');
      if (!rooms.has(code)) return code;
    }
  }

  const snapshot = (): AdminSnapshot => ({
    startedAt,
    now: Date.now(),
    rooms: [...rooms.values()].map((r) => r.info()),
    visitors: visitors.top(),
    bot: bot.status,
  });

  const http = createServer((req, res) => {
    try {
      route(req, res);
    } catch (error) {
      // A bad request (e.g. a malformed URL) must not take down every room.
      console.error(`error serving ${req.method} ${String(req.url).slice(0, 200)}`, error);
      if (!res.headersSent) res.writeHead(400).end('Bad request');
      else res.destroy();
    }
  });

  function route(req: IncomingMessage, res: ServerResponse): void {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/admin' || path === '/admin.json') return serveAdmin(req, res, path, options.adminToken, snapshot);
    if (path === '/dispute' && req.method === 'POST') {
      void readJson(req, 512 * 1024).then((body) => {
        const reply = (status: number, data: object) =>
          res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
        const ip = clientIp(req);
        if (!disputeLimit.allow(ip ?? 'unknown', Date.now())) return reply(429, { error: 'Too many reports. Please try again later.' });
        if (body === undefined) return reply(400, { error: 'Malformed report.' });
        const result = buildDispute(body, (code, token) => rooms.get(code)?.disputeInfo(token) ?? null);
        if (!result.ok) return reply(400, { error: result.error });
        tracker.capture('rules_dispute', { ...result.who, ip }, result.properties);
        // A backup in the server log, in case analytics is off or delayed.
        console.log(`[dispute] ${result.who.name} (${ip}) ${String(result.properties.mode)}: ${String(result.properties.text).slice(0, 300).replace(/\s+/g, ' ')}`);
        reply(200, { ok: true });
      }).catch((error: unknown) => {
        // Outside the request handler's try/catch: an unhandled rejection would crash the server.
        console.error('error handling a dispute', error);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Something went wrong. Please try again.' }));
      });
      return;
    }
    if (path === '/config.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' }).end(JSON.stringify(options.publicConfig ?? {}));
      return;
    }
    serveStatic(req, res, options);
  }
  // Client messages are small (the largest is a command); refuse anything bigger.
  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 64 * 1024 });

  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    const ip = clientIp(req);
    let room: Room | null = null;
    let playerId: string | null = null;
    let alive = true;
    const send: Send = (message: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      // This connection no longer has a seat (taken by another tab, or the room
      // closed): end it, so it can't hold on to the room. Browsers don't reconnect after these.
      if (message.t === 'replaced' || message.t === 'gone') socket.close();
    };
    const fail = (message: string) => send({ t: 'error', message });

    // Without a listener, a socket error (e.g. an oversized message) would crash the server.
    socket.on('error', () => socket.terminate());
    socket.on('pong', () => (alive = true));
    const heartbeat = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, 30_000);

    socket.on('message', (data) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(String(data)) as ClientMessage;
      } catch {
        return fail('Malformed message.');
      }
      if (room && playerId) {
        try {
          room.handle(playerId, message);
        } catch (error) {
          // An engine bug must not take down every room on the server.
          console.error(`room ${room.code}: error handling ${JSON.stringify(message).slice(0, 200)}`, error);
          fail('Something went wrong handling that. Please try again.');
        }
        return;
      }
      if (!message || typeof message !== 'object') return fail('Malformed message.');
      switch (message.t) {
        case 'create': {
          const code = newCode();
          room = new Room(code, deps);
          rooms.set(code, room);
          const player = room.join(message.name, send, { ip, client: message.client ?? null });
          visitors.record(ip, player.name, Date.now());
          playerId = player.id;
          if (message.bot === true) room.handle(player.id, { t: 'add-bot' });
          return;
        }
        case 'join': {
          const code = String(message.code ?? '').toUpperCase();
          const found = ROOM_CODE.test(code) ? rooms.get(code) : undefined;
          if (!found) return fail(`No room called ${code}.`);
          room = found;
          const player = found.join(message.name, send, { ip, client: message.client ?? null });
          visitors.record(ip, player.name, Date.now());
          playerId = player.id;
          return;
        }
        case 'resume': {
          const found = rooms.get(String(message.code ?? '').toUpperCase());
          const player = found?.resume(String(message.token ?? ''), send, { ip, client: message.client ?? null });
          if (!found || !player) return send({ t: 'gone' });
          visitors.record(ip, player.name, Date.now());
          room = found;
          playerId = player.id;
          return;
        }
        default:
          return fail('Join or create a room first.');
      }
    });

    socket.on('close', () => {
      clearInterval(heartbeat);
      if (room && playerId) room.disconnect(playerId, send);
    });
  });

  const idleMs = options.idleRoomMs ?? 2 * 60 * 60 * 1000;
  const abandonedMs = options.abandonedRoomMs ?? 6 * 60 * 60 * 1000;
  const sweepNow = (now = Date.now()) => {
    for (const [code, room] of rooms) {
      const idle = now - room.lastActivity;
      if ((room.connectedCount === 0 && idle > idleMs) || idle > abandonedMs) {
        room.close();
        rooms.delete(code);
      }
    }
    disputeLimit.prune(now);
    replays?.cleanup();
  };
  const sweep = setInterval(() => sweepNow(), 60_000);

  return new Promise((resolvePromise) => {
    http.listen(options.port, () =>
      resolvePromise({
        http,
        rooms,
        sweep: sweepNow,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(sweep);
            for (const client of wss.clients) client.terminate();
            wss.close(() => http.close(() => void tracker.shutdown().finally(done)));
          }),
      }),
    );
  });
}

/** Reads a JSON request body up to `limit` bytes; undefined if too big or not JSON. */
function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolveBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        resolveBody(undefined);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolveBody(undefined);
      }
    });
    req.on('error', () => resolveBody(undefined));
  });
}

/**
 * The visitor's IP. Behind Fly's proxy the socket's address is the proxy, and
 * the real one is in Fly-Client-IP (or the first X-Forwarded-For entry).
 */
export function clientIp(req: IncomingMessage): string | null {
  const fly = req.headers['fly-client-ip'];
  if (typeof fly === 'string' && fly) return fly;
  const forwarded = req.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  if (first) return first;
  return req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? null;
}

function serveStatic(req: IncomingMessage, res: ServerResponse, options: ServerOptions): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = decodeURIComponent(url.pathname);

  if (path === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  if (path.startsWith('/cards/')) {
    // Optimized images from the web build first, then the original card scans.
    const name = path.slice('/cards/'.length);
    const built = options.webDir ? safeJoin(join(options.webDir, 'cards'), name) : null;
    const file = built && existsSync(built) ? built : safeJoin(options.cardsDir, name);
    sendFile(res, file, 'public, max-age=86400');
    return;
  }
  if (!options.webDir) {
    res.writeHead(404).end('Web client not built. Run the Vite dev server, or build packages/web.');
    return;
  }
  const file = safeJoin(options.webDir, path === '/' ? 'index.html' : path.slice(1));
  // Client-side routes (e.g. /r/ABCD) fall back to the app.
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    sendFile(res, join(options.webDir, 'index.html'), 'no-cache');
    return;
  }
  sendFile(res, file, path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
}

/** Joins a request path under a root directory, refusing to escape it. */
function safeJoin(root: string, relative: string): string | null {
  const full = resolve(root, normalize(relative));
  return full.startsWith(resolve(root)) ? full : null;
}

function sendFile(res: ServerResponse, file: string | null, cache: string): void {
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': cache });
  res.end(readFileSync(file));
}

/**
 * Loads the bot. Weights trained with a different observation encoder are
 * refused: the network would read its inputs wrong and play nonsense (legal
 * moves, but silently bad). Then the server runs without the bot and says why,
 * at startup and on the admin page, rather than taking human games down too.
 */
function loadBot(path: string, delay?: () => number): { deps: BotDeps | undefined; status: string } {
  try {
    const policy = Policy.load(readFileSync(path));
    const { run, step, fingerprint } = policy.info;
    console.log(`Bot: ${run} step ${step} (encoder ${fingerprint})`);
    return {
      deps: {
        policy,
        schedule: (fn, ms) => {
          const timer = setTimeout(fn, ms);
          return () => clearTimeout(timer);
        },
        delay: delay ?? (() => 800 + Math.random() * 400),
      },
      status: `on: ${run} step ${step}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`BOT DISABLED: ${message}`);
    return { deps: undefined, status: `DISABLED: ${message}` };
  }
}
