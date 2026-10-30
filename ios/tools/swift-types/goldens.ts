// Golden messages for the app's Swift types: whole games on the core's own local server, through the core's own
// bridge (ios/core/bridge.ts), every message both ways recorded as the app would send and get it. ios/Tests decodes
// each into the generated types (ios/Shared/Protocol.swift) and encodes it back, which must give the same JSON.
//   node ios/tools/swift-types/goldens.ts <out dir>     writes from-app.jsonl and to-app.jsonl
// Midstrike searches a few worlds here (the messages are the same at any size); its reviews run in this process, small.
// Every client and server message type is sent at least once, rejected ones included; it fails if one isn't.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.REVIEW_SCALE ??= '0.05';
const ROOT = join(import.meta.dirname, '..', '..', '..');
const WEIGHTS = join(ROOT, 'packages/learn/demo/weights/midstrike.bin');
const out = process.argv[2];
if (!out) throw new Error('usage: goldens.ts <out dir>');

const { Policy } = await import('../../../packages/learn/src/policy.ts');
const { midstrikeHost } = await import('../../../packages/learn/demo/host.ts');
const { setSearchLog, setSearchMode, setWorlds } = await import('../../../packages/learn/demo/search-bot.ts');
const { RolloutPool } = await import('../../../packages/learn/demo/rollout-pool.ts');
const { reviewRunner } = await import('../../../packages/learn/demo/review-jobs.ts');
const { LocalServer } = await import('../../core/local-server.ts');
const { coreBridge } = await import('../../core/bridge.ts');
const { capped } = await import('../../core/search-pool.ts');
type FromApp = import('../../core/bridge.ts').FromApp;
type ToApp = import('../../core/bridge.ts').ToApp;
type ReviewJobs = import('../../../packages/learn/demo/review.ts').ReviewJobs;
type Command = import('../../../packages/engine/src/index.ts').Command;

const policy = Policy.load(readFileSync(WEIGHTS));
const pool = new RolloutPool(4, WEIGHTS, true);
setSearchMode('best-q');
setWorlds(8);
setSearchLog(() => {});

// The review's jobs, run here one at a time (the app runs them in Web Workers).
let x = 12345;
const run = reviewRunner(policy, () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32);
type Task = { group: string; tag: number; key: string | null; job: Parameters<typeof run>[0]; done: (r: ReturnType<typeof run> | null) => void };
let queue: Task[] = [];
const reviews: ReviewJobs = {
  submit(group, tag, job, done, key = null) {
    queue.push({ group, tag, key, job, done });
    setImmediate(pump);
  },
  cancel(group) {
    const n = queue.filter((t) => t.group === group).length;
    queue = queue.filter((t) => t.group !== group);
    return n;
  },
  setAside(group, tag) {
    const aside = queue.filter((t) => t.group === group && t.tag === tag);
    queue = queue.filter((t) => !aside.includes(t));
    return aside.map(({ job, done }) => ({ job, done }));
  },
  drop(group, key) {
    const n = queue.filter((t) => t.group === group && t.key === key).length;
    queue = queue.filter((t) => !(t.group === group && t.key === key));
    return n;
  },
};
function pump(): void {
  const task = queue.shift();
  if (!task) return;
  task.done(run(task.job));
  if (queue.length) setImmediate(pump);
}

const host = midstrikeHost({ name: 'Midstrike', search: { hard: capped(pool, 8), medium: capped(pool, 4) }, reviews });
const server = new LocalServer({
  token: () => Math.random().toString(36).slice(2),
  id: () => Math.random().toString(36).slice(2, 10),
  seed: () => Math.random().toString(16).slice(2),
  random: Math.random,
  now: Date.now,
  bot: {
    policy,
    schedule: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
    delay: () => 0,
    name: 'Midstrike',
    ...host.bot,
  },
  hooks: host.hooks,
});

const fromApp: string[] = [];
const toApp: string[] = [];
const listeners = new Set<(m: ToApp) => void>();
const receive = coreBridge(server, (m) => {
  toApp.push(JSON.stringify(m));
  for (const l of listeners) l(m);
}, () => {});
const send = (m: FromApp) => {
  const json = JSON.stringify(m);
  fromApp.push(json);
  receive(json);
};
let nextId = 1;
const settle = () => new Promise((r) => setTimeout(r, 20));

/** A game at `level`, to `marks`, played by random legal moves with training mode on; `extras` sends the rarer messages. */
async function game(level: string, marks: number, extras: boolean): Promise<void> {
  let id = nextId++;
  let token = '';
  let code = '';
  let started = false;
  const answered = new Set<string>();
  let over = false;
  let moves = 0;
  const listener = (m: ToApp) => {
    if (m.t !== 'server' || m.id !== id) return;
    const message = m.message;
    if (message.t === 'welcome') {
      token = message.token;
      code = message.code;
    }
    if (message.t === 'room' && !started) {
      const s = message.room.settings;
      if (s.botLevel !== level || s.marksToWin !== marks) return send({ t: 'client', id, message: { t: 'settings', settings: { ...s, marksToWin: marks, botLevel: level as 'hard' } } });
      started = true;
      setImmediate(() => {
        send({ t: 'client', id, message: { t: 'start' } });
        send({ t: 'client', id, message: { t: 'training', on: true } });
      });
    }
    if (message.t !== 'game') return;
    const view = message.view;
    if (view.phase === 'game-over') {
      over = true;
      return;
    }
    const prompts = view.prompts.filter((p) => p.mine);
    const between = view.legal.some((c) => c.type === 'next-round');
    if (!prompts.length && !between) return;
    const decision = prompts.length ? prompts.map((p) => p.id).join(',') : `next-round-${view.round}`;
    if (answered.has(decision)) return;
    answered.add(decision);
    const order = prompts.find((p) => p.kind === 'order-pile') as { id: string; cards: string[] } | undefined;
    const choices = view.legal.filter((c) => c.type !== 'reveal-duplicity');
    const command: Command | undefined = order
      ? ({ type: 'answer', promptId: order.id, answer: { kind: 'order-pile', order: [...order.cards].sort(() => Math.random() - 0.5) } } as Command)
      : (choices.length ? choices : view.legal)[Math.floor(Math.random() * (choices.length || view.legal.length))];
    if (!command) return;
    moves++;
    setImmediate(() => send({ t: 'client', id, message: { t: 'command', command } }));
  };
  listeners.add(listener);
  send({ t: 'connect', id });
  if (extras) {
    // In the lobby: the bot added, removed and added again.
    send({ t: 'client', id, message: { t: 'create', name: 'Golden' } });
    await settle();
    send({ t: 'client', id, message: { t: 'add-bot' } });
    send({ t: 'client', id, message: { t: 'remove-bot' } });
    send({ t: 'client', id, message: { t: 'add-bot' } });
    // Someone else joins and leaves (the bot only plays two: they must go for the game to start).
    const other = nextId++;
    send({ t: 'connect', id: other });
    send({ t: 'client', id: other, message: { t: 'join', code, name: 'Visitor' } });
    send({ t: 'client', id: other, message: { t: 'leave' } });
    send({ t: 'close', id: other });
    send({ t: 'client', id, message: { t: 'settings', settings: { marksToWin: marks, firstPlayer: 'random', botLevel: level as 'hard' } } });
  } else {
    send({ t: 'client', id, message: { t: 'create', name: 'Golden', bot: true } });
  }
  let sentExtras = !extras;
  for (let wait = 0; !over && wait < 6000; wait++) {
    await settle();
    if (!sentExtras && moves >= 6) {
      sentExtras = true;
      // Rejected ones: a command for no prompt, undo (off against the bot), a vote with nothing to vote on.
      send({ t: 'client', id, message: { t: 'command', command: { type: 'answer', promptId: 'nope', answer: { kind: 'choose-direction', direction: 'left' } } as Command } });
      send({ t: 'client', id, message: { t: 'propose-undo' } });
      send({ t: 'client', id, message: { t: 'vote-undo', accept: true } });
      send({ t: 'client', id, message: { t: 'training', on: false } });
      send({ t: 'client', id, message: { t: 'training', on: true } });
      // The same seat from another connection: the first is told it's replaced, and play goes on from the new one.
      const again = nextId++;
      send({ t: 'connect', id: again });
      send({ t: 'client', id: again, message: { t: 'resume', code, token } });
      send({ t: 'close', id });
      id = again;
      // A resume that finds nothing.
      const lost = nextId++;
      send({ t: 'connect', id: lost });
      send({ t: 'client', id: lost, message: { t: 'resume', code, token: 'not-a-token' } });
      send({ t: 'close', id: lost });
      answered.clear();
    }
  }
  if (!over) throw new Error(`the ${level} game didn't end`);
  if (!sentExtras) throw new Error(`the ${level} game ended before the rarer messages were sent`);
  // The last round's review: its jobs run here, after the game.
  for (let wait = 0; queue.length && wait < 3000; wait++) await settle();
  await settle();
  if (extras) send({ t: 'client', id, message: { t: 'back-to-lobby' } });
  send({ t: 'close', id });
  listeners.delete(listener);
}

await game('hard', 2, true);
await game('medium', 1, false);
await game('easy', 1, false);
await pool.close?.();

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'from-app.jsonl'), fromApp.join('\n') + '\n');
writeFileSync(join(out, 'to-app.jsonl'), toApp.join('\n') + '\n');

// Every kind of message, both ways, must be there.
const seen = (lines: string[], pick: (m: Record<string, unknown>) => unknown) => new Set(lines.map((l) => pick(JSON.parse(l))).filter(Boolean) as string[]);
const client = seen(fromApp, (m) => (m.t === 'client' ? (m.message as { t: string }).t : null));
const serverTypes = seen(toApp, (m) => (m.t === 'server' ? (m.message as { t: string }).t : null));
const wantClient = ['add-bot', 'back-to-lobby', 'command', 'create', 'join', 'leave', 'propose-undo', 'remove-bot', 'resume', 'settings', 'start', 'training', 'vote-undo'];
const wantServer = ['error', 'game', 'gone', 'replaced', 'review', 'room', 'welcome'];
const missing = [...wantClient.filter((t) => !client.has(t)).map((t) => `client ${t}`), ...wantServer.filter((t) => !serverTypes.has(t)).map((t) => `server ${t}`)];
const payloads = new Set<string>();
for (const l of toApp) for (const e of (JSON.parse(l).message?.log ?? []) as { payload: { type: string } }[]) payloads.add(e.payload.type);
console.log(`${fromApp.length} messages to the core, ${toApp.length} from it; ${payloads.size} kinds of event; client ${[...client].sort().join(' ')}; server ${[...serverTypes].sort().join(' ')}`);
if (missing.length) {
  console.error(`missing: ${missing.join(', ')}`);
  process.exit(1);
}
process.exit(0);
