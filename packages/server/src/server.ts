import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { formatReplayLog } from '@keeps/engine';
import { ROOM_CODE, type ClientMessage, type ServerMessage } from '@keeps/protocol';
import { WebSocketServer, type WebSocket } from 'ws';
import { Room, type RoomDeps, type Send } from './room.ts';

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
}

export interface KeepsServer {
  http: Server;
  rooms: Map<string, Room>;
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
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

export function createKeepsServer(options: ServerOptions): Promise<KeepsServer> {
  const rooms = new Map<string, Room>();

  const deps: RoomDeps = {
    token: () => randomBytes(18).toString('base64url'),
    id: () => randomBytes(6).toString('base64url'),
    seed: () => randomBytes(12).toString('hex'),
    random: () => randomInt(0, 2 ** 32) / 2 ** 32,
    now: () => Date.now(),
    ...(options.dataDir ? { saveReplay: replaySaver(options.dataDir) } : {}),
  };

  function newCode(): string {
    for (;;) {
      const code = Array.from({ length: 4 }, () => CODE_LETTERS[randomInt(0, CODE_LETTERS.length)]).join('');
      if (!rooms.has(code)) return code;
    }
  }

  const http = createServer((req, res) => serveStatic(req, res, options));
  const wss = new WebSocketServer({ server: http, path: '/ws' });

  wss.on('connection', (socket: WebSocket) => {
    let room: Room | null = null;
    let playerId: string | null = null;
    let alive = true;
    const send: Send = (message: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };
    const fail = (message: string) => send({ t: 'error', message });

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
      if (room && playerId) return room.handle(playerId, message);
      switch (message.t) {
        case 'create': {
          const code = newCode();
          room = new Room(code, deps);
          rooms.set(code, room);
          playerId = room.join(message.name, send).id;
          return;
        }
        case 'join': {
          const code = String(message.code ?? '').toUpperCase();
          const found = ROOM_CODE.test(code) ? rooms.get(code) : undefined;
          if (!found) return fail(`No room called ${code}.`);
          room = found;
          playerId = found.join(message.name, send).id;
          return;
        }
        case 'resume': {
          const found = rooms.get(String(message.code ?? '').toUpperCase());
          const player = found?.resume(String(message.token ?? ''), send);
          if (!found || !player) return send({ t: 'gone' });
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
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (room.connectedCount === 0 && now - room.lastActivity > idleMs) rooms.delete(code);
    }
  }, 60_000);

  return new Promise((resolvePromise) => {
    http.listen(options.port, () =>
      resolvePromise({
        http,
        rooms,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(sweep);
            for (const client of wss.clients) client.terminate();
            wss.close(() => http.close(() => done()));
          }),
      }),
    );
  });
}

function replaySaver(dataDir: string): NonNullable<RoomDeps['saveReplay']> {
  const dir = join(dataDir, 'replays');
  mkdirSync(dir, { recursive: true });
  return (code, startedAt, log) => {
    const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
    writeFileSync(join(dir, `${code}-${stamp}.jsonl`), formatReplayLog(log));
  };
}

function serveStatic(req: IncomingMessage, res: ServerResponse, options: ServerOptions): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = decodeURIComponent(url.pathname);

  if (path === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  if (path.startsWith('/cards/')) {
    sendFile(res, safeJoin(options.cardsDir, path.slice('/cards/'.length)), 'public, max-age=86400');
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
