// The app's core, in a hidden web view (WebKit's JIT runs the rules and the search): the game server the app plays
// on, offline, with Midstrike's host (packages/learn/demo/host.ts), its searches in Web Workers and its network in
// Core ML on the Neural Engine (the app's keeps:// scheme).
//
// The app (Swift) talks to it in JSON strings: it calls keepsCore.receive(json) and gets messages back through the
// `core` message handler. A connection speaks the website's own protocol (packages/protocol), so the app is a client
// like a browser; each game message comes with what the web client works out for itself: the options (every legal
// move, with what it involves on the table: web/src/game/options.ts) and the log's lines (web/src/game/log.ts).
import { Policy } from '../../packages/learn/src/policy.ts';
import { midstrikeHost } from '../../packages/learn/demo/host.ts';
import { setSearchMode, setWorlds } from '../../packages/learn/demo/search-bot.ts';
import type { ClientMessage, ServerMessage } from '../../packages/protocol/src/index.ts';
import { logLines, type LogLine } from '../../packages/web/src/game/log.ts';
import { describeOptions, makeNames, type Option } from '../../packages/web/src/game/options.ts';
import type { Seat, TraceEvent } from '../../packages/engine/src/index.ts';
import { LocalServer } from './local-server.ts';
import { capped, WorkerSearch } from './search-pool.ts';

/** Worlds per search at each level that searches (Hard: 512 on a phone, as decided; Medium as on the website). */
const WORLDS = { hard: 512, medium: 64 };

export type FromApp =
  | { t: 'connect'; id: number }
  | { t: 'client'; id: number; message: ClientMessage }
  | { t: 'close'; id: number }
  /** How long Midstrike waits before each move, so a person can follow it (0 for tests). */
  | { t: 'config'; botDelayMs: number };

export type ToApp =
  | { t: 'ready'; workers: number; network: string }
  | { t: 'server'; id: number; message: ServerMessage; options?: Option[]; lines?: LogLine[] }
  /** Each of Midstrike's searches, as it finishes. */
  | { t: 'search'; room: string; seat: number; turn: number; worlds: number; moves: number; ms: number }
  | { t: 'failed'; message: string };

const handler = (window as unknown as { webkit?: { messageHandlers?: { core?: { postMessage(s: string): void } } } }).webkit?.messageHandlers?.core;
function post(m: ToApp): void {
  handler?.postMessage(JSON.stringify(m));
}

const randomString = (bytes: number) => {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** Each connection's game log so far, for the log's lines (they're worked out from the whole log, as the web client does). */
type Connection = { receive(m: ClientMessage): void; close(): void; events: TraceEvent[] };

async function boot(): Promise<void> {
  const weights = await (await fetch('midstrike.bin')).arrayBuffer();
  const policy = Policy.load(new Uint8Array(weights));
  const info = (await (await fetch('/nn/info')).json()) as Record<string, string>;
  if (info.fingerprint !== policy.info.fingerprint || Number(info.step) !== policy.info.step) {
    throw new Error(`the Core ML model (${info.step}, ${info.fingerprint}) is another network than midstrike.bin (${policy.info.step}, ${policy.info.fingerprint})`);
  }
  // One worker per core but two: the page, WebKit's own processes and Core ML's CPU-side work need the rest.
  const search = await WorkerSearch.start(Math.max(1, Number(info.cores) - 2), weights);
  setSearchMode('best-q');
  setWorlds(WORLDS.hard);
  let botDelayMs = 900;
  const host = midstrikeHost({
    name: 'Midstrike',
    search: { hard: capped(search, WORLDS.hard), medium: capped(search, WORLDS.medium) },
    onSearch: (room, r) => post({ t: 'search', room: room.code, seat: r.seat, turn: r.turn, worlds: r.worlds, moves: r.moves.length, ms: r.ms }),
  });
  const server = new LocalServer({
    token: () => randomString(18),
    id: () => randomString(6),
    seed: () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join(''),
    random: Math.random,
    now: Date.now,
    bot: {
      policy,
      schedule: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
      delay: () => botDelayMs,
      name: 'Midstrike',
      ...host.bot,
    },
    hooks: host.hooks,
  });

  const connections = new Map<number, Connection>();
  const deliver = (id: number, message: ServerMessage) => {
    const connection = connections.get(id);
    if (message.t !== 'game' || !connection) return post({ t: 'server', id, message });
    connection.events = message.reset ? [...message.log] : [...connection.events, ...message.log];
    const viewer = message.view.viewer;
    const anchor = (viewer === 'spectator' ? 0 : viewer) as Seat;
    const options = viewer === 'spectator' ? [] : describeOptions(message.view, makeNames(message.names, viewer, anchor));
    const lines = logLines(connection.events, makeNames(message.names, 'spectator', anchor));
    post({ t: 'server', id, message, options, lines });
  };
  (window as unknown as { keepsCore: { receive(json: string): void } }).keepsCore = {
    receive(json: string) {
      try {
        const m = JSON.parse(json) as FromApp;
        if (m.t === 'config') botDelayMs = m.botDelayMs;
        else if (m.t === 'connect') connections.set(m.id, { ...server.connect((message) => deliver(m.id, message)), events: [] });
        else if (m.t === 'client') connections.get(m.id)?.receive(m.message);
        else if (m.t === 'close') {
          connections.get(m.id)?.close();
          connections.delete(m.id);
        }
      } catch (error) {
        post({ t: 'failed', message: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) });
      }
    },
  };
  post({ t: 'ready', workers: search.size, network: `${policy.info.run} ${policy.info.step} (${policy.info.fingerprint})` });
}

boot().catch((error: unknown) => post({ t: 'failed', message: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) }));
