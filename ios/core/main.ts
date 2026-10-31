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
import { seeded } from '../../packages/learn/demo/random.ts';
import { setSearchMode, setWorlds } from '../../packages/learn/demo/search-bot.ts';
import { cardCatalog, coreBridge, savedMessage, type ToApp } from './bridge.ts';
import { LocalServer } from './local-server.ts';
import { capped, WorkerSearch } from './search-pool.ts';

/** Worlds per search at each level that searches (Hard: 512 on a phone, as decided; Medium as on the website). */
const WORLDS = { hard: 512, medium: 64 };

const handler = (window as unknown as { webkit?: { messageHandlers?: { core?: { postMessage(s: string): void } } } }).webkit?.messageHandlers?.core;
function post(m: ToApp): void {
  handler?.postMessage(JSON.stringify(m));
}

const randomString = (bytes: number) => {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

// Whatever the server or Midstrike's host reports as gone wrong (a search that failed and fell back to the network's
// move, a review job) goes to the app too, not only to this hidden page's console, where no one would see it.
const logError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  logError(...args);
  post({ t: 'failed', message: args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(' ').slice(0, 2000) });
};

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
  // For tests (FromApp config's seed): every game dealt the same, and the server's chance (the seating, Midstrike's
  // draws from its network) drawn from that seed.
  let fixedSeed: string | null = null;
  let fixedRandom: (() => number) | null = null;
  const host = midstrikeHost({
    name: 'Midstrike',
    search: { hard: capped(search, WORLDS.hard), medium: capped(search, WORLDS.medium) },
    onSearch: (room, r) => post({ t: 'search', room: room.code, seat: r.seat, turn: r.turn, worlds: r.worlds, moves: r.moves.length, ms: r.ms }),
  });
  const server = new LocalServer({
    token: () => randomString(18),
    id: () => randomString(6),
    seed: () => fixedSeed ?? [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join(''),
    random: () => (fixedRandom ?? Math.random)(),
    now: Date.now,
    // Each game's replay, after every move, for the app to keep (it can be replayed, or looked into, later), and what
    // taking it up again takes (should the app close).
    saveReplay: (code, startedAt, log) => post(savedMessage(server, code, startedAt, log)),
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

  (window as unknown as { keepsCore: { receive(json: string): void } }).keepsCore = {
    receive: coreBridge(server, post, (ms, seed) => {
      botDelayMs = ms;
      if (seed !== undefined) {
        fixedSeed = seed;
        fixedRandom = seeded([...seed].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261), 1);
      }
    }),
  };
  post({ t: 'ready', workers: search.size, network: `${policy.info.run} ${policy.info.step} (${policy.info.fingerprint})`, cards: cardCatalog() });
}

boot().catch((error: unknown) => post({ t: 'failed', message: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) }));
