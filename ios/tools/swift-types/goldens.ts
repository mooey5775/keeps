// Golden messages for the app's Swift types: whole games on the core's own local server, through the core's own
// bridge (ios/core/bridge.ts), every message both ways recorded as the app would send and get it. ios/Tests decodes
// each into the generated types (ios/Shared/Protocol.swift) and encodes it back, which must give the same JSON.
//   node ios/tools/swift-types/goldens.ts <out dir>     writes from-app.jsonl and to-app.jsonl
// Midstrike searches a few worlds here (the messages are the same at any size); its reviews run in this process, small.
// Every client and server message type is sent at least once, rejected ones included. Then quick games (easy, no
// hints) go on until every kind of event, prompt, command, answer, action and ability (the generator's list:
// ios/build/protocol-tags.json) has come up, keeping only the messages that show something new; it fails if one
// never does, but for events the engine never shows a client (server-only in every game played).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.REVIEW_SCALE ??= '0.05';
const ROOT = join(import.meta.dirname, '..', '..', '..');
const WEIGHTS = join(ROOT, 'packages/bot/weights/midstrike.bin');
const out = process.argv[2];
if (!out) throw new Error('usage: goldens.ts <out dir>');

const { Policy } = await import('../../../packages/bot/src/policy.ts');
const { midstrikeHost } = await import('../../../packages/bot/src/host.ts');
const { setSearchLog, setSearchMode, setWorlds } = await import('../../../packages/bot/src/search/search.ts');
const { RolloutPool } = await import('../../../packages/bot/src/search/rollout-pool.ts');
const { reviewRunner } = await import('../../../packages/bot/src/review/jobs.ts');
const { LocalServer } = await import('../../core/local-server.ts');
const { coreBridge, savedMessage } = await import('../../core/bridge.ts');
const { capped } = await import('../../core/search-pool.ts');
const { composeHooks } = await import('../../../packages/bot/src/host.ts');
const { seeded } = await import('../../../packages/bot/src/random.ts');
// Seeded throughout (deals, the room's choices, Midstrike's at easy, the moves played here), so the coverage games are
// the same games every run: the check passes or fails the same way until the engine or the bot changes.
const chance = seeded(2026, 1);
let deals = 0;
type FromApp = import('../../core/bridge.ts').FromApp;
type ToApp = import('../../core/bridge.ts').ToApp;
type ReviewJobs = import('../../../packages/bot/src/review/review.ts').ReviewJobs;
type Command = import('../../../packages/engine/src/index.ts').Command;
const { apply } = await import('../../../packages/engine/src/index.ts');
const { click, clickable, panelItems } = await import('../../../packages/table/src/options.ts');
type Option = import('../../../packages/table/src/options.ts').Option;
type Ref = import('../../../packages/table/src/options.ts').Ref;

// Anything the server or the bot reports as gone wrong (a search or training mode's advice that failed and fell back to
// the network, a review job the sampler gave up on) is logged and play goes on, as on the site; here it fails the run.
const problems: string[] = [];
const logError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  problems.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ').slice(0, 300));
  logError(...args);
};

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
    // The coverage games skip their reviews (the scripted games' are recorded): the job's done, with nothing.
    if (!recordAll) return void setImmediate(() => done(null));
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
  // A job that fails counts as done with nothing, as review-pool.ts has it, so the games go on; the run fails at the end.
  let result: ReturnType<typeof run> | null = null;
  try {
    result = run(task.job);
  } catch (error) {
    console.error(`review: a job failed: ${error instanceof Error ? error.message : error}`);
  }
  task.done(result);
  if (queue.length) setImmediate(pump);
}

const host = midstrikeHost({ name: 'Midstrike', search: { hard: capped(pool, 8), medium: capped(pool, 4) }, reviews });

// What must come up: every value of these tagged unions (the generator's list), where the messages hold them.
const TAGS = JSON.parse(readFileSync(join(ROOT, 'ios/build/protocol-tags.json'), 'utf8')) as Record<string, { values: (string | boolean)[] }>;
const KINDS = { event: 'TracePayload', prompt: 'PromptViewMine', command: 'Command', answer: 'Answer', action: 'ActionChoice', ability: 'ActionChoiceAbility' } as const;
type Kind = keyof typeof KINDS;
const want = Object.fromEntries(Object.entries(KINDS).map(([k, e]) => [k, new Set(TAGS[e]!.values.map(String))])) as Record<Kind, Set<string>>;
const seen = Object.fromEntries(Object.keys(KINDS).map((k) => [k, new Set<string>()])) as Record<Kind, Set<string>>;
/** Notes what `m` shows (from the core, or from the app); true if it's something not seen before. */
function observe(m: ToApp | FromApp): boolean {
  let fresh = false;
  const note = (kind: Kind, value: unknown) => {
    if (typeof value !== 'string' || seen[kind].has(value)) return;
    seen[kind].add(value);
    fresh = true;
  };
  const command = (c: Command) => {
    note('command', c.type);
    if (c.type !== 'answer') return;
    note('answer', c.answer.kind);
    if (c.answer.kind !== 'action') return;
    note('action', c.answer.choice.action);
    if (c.answer.choice.action === 'ability') note('ability', c.answer.choice.card);
  };
  const events = (log: readonly { payload: { type: string } }[]) => log.forEach((e) => note('event', e.payload.type));
  if (m.t === 'client' && m.message.t === 'command') command(m.message.command);
  if (m.t !== 'server') return fresh;
  const message = m.message;
  if (message.t === 'game') {
    events(message.log);
    for (const p of message.view.prompts) if (p.mine) note('prompt', p.kind);
    message.view.legal.forEach(command);
    m.options?.forEach((o) => command(o.command));
  }
  if (message.t === 'review') for (const move of message.review.moves) events(move.events);
  return fresh;
}
// The events the engine makes, as the server has them, and the payload types a client can be given: an event's own if
// some seat may see it, its redacted copy's otherwise (pile-dealt, the dealt pile's cards, reaches clients only as
// pile-placed). A kind made but never given to a client is excused.
const madeEvents = new Map<string, boolean>(); // type → ever given to a client
/** The rooms, by code: the coverage games look one move ahead in the real game (see `curious`). */
const rooms = new Map<string, { runningGame: { state: import('../../../packages/engine/src/index.ts').GameState } | null }>();
const serverSide = {
  sent(room: { code: string; runningGame: { state: import('../../../packages/engine/src/index.ts').GameState } | null }) {
    rooms.set(room.code, room);
  },
  // The game's whole log, as it stands (the deal's events come before any command).
  commanded(_room: unknown, move: { events: readonly { payload: { type: string }; visibility: unknown; redacted?: { type: string } }[] }) {
    for (const e of move.events) {
      const visible = e.visibility === 'all' || (Array.isArray(e.visibility) && e.visibility.length > 0);
      madeEvents.set(e.payload.type, (madeEvents.get(e.payload.type) ?? false) || visible);
      if (e.redacted) madeEvents.set(e.redacted.type, true);
    }
  },
};
/** Record every message (the scripted games), or only those showing something new (the coverage games). */
let recordAll = true;
const server = new LocalServer({
  token: () => chance().toString(36).slice(2),
  id: () => chance().toString(36).slice(2, 10),
  seed: () => `golden-${deals++}`,
  random: chance,
  now: Date.now,
  // The app keeps each game's replay: the core sends it after every move (recorded in the scripted games).
  saveReplay: (code: string, startedAt: number, log: import('../../../packages/engine/src/index.ts').ReplayLog) => {
    const saved = savedMessage(server, code, startedAt, log);
    if (recordAll) toApp.push(JSON.stringify(saved));
    for (const l of listeners) l(saved);
  },
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
  hooks: composeHooks(host.hooks, serverSide as never),
});

const fromApp: string[] = [];
const toApp: string[] = [];
const listeners = new Set<(m: ToApp) => void>();
const receive = coreBridge(server, (m) => {
  if (observe(m) || recordAll) toApp.push(JSON.stringify(m));
  for (const l of listeners) l(m);
}, () => {});
const send = (m: FromApp) => {
  const json = JSON.stringify(m);
  if (observe(m) || recordAll) fromApp.push(json);
  receive(json);
};
let nextId = 1;
const settle = () => new Promise((r) => setTimeout(r, 20));

/**
 * For the coverage games: of `commands`, one that brings an event or prompt kind not seen yet, looking one move ahead
 * in the real game (the room's chance is seeded, so what it shows is what happens); null if none does. Unlike the
 * random moves, it may reveal Duplicity's card (only a reveal ever shackles a turn).
 */
function curious(code: string, seat: number, commands: readonly Command[]): Command | null {
  const state = rooms.get(code)?.runningGame?.state;
  if (!state) return null;
  for (const command of commands) {
    const r = apply(state, seat as 0, command);
    if (!r.ok) continue;
    const events = r.events.flatMap((e) => [e.payload.type, ...(e.redacted ? [e.redacted.type] : [])]);
    const prompts = r.state.prompts.filter((p) => p.seat === seat).map((p) => p.kind);
    if (events.some((t) => want.event.has(t) && !seen.event.has(t)) || prompts.some((k) => !seen.prompt.has(k))) return command;
  }
  return null;
}

/** `cards` in a seeded random order. */
function shuffled<T>(cards: readonly T[]): T[] {
  const out = [...cards];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(chance() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * A game at `level`, to `marks`, played by random legal moves (training mode on: hints); `extras` sends the rarer
 * messages; `resignAfter`, the person resigns after that many moves (the game ends there).
 */
async function game(level: string, marks: number, extras: boolean, training = true, resignAfter?: number): Promise<void> {
  let id = nextId++;
  let token = '';
  let code = '';
  let started = false;
  const answered = new Set<string>();
  let over = false;
  let moves = 0;
  let kept: Extract<ToApp, { t: 'saved' }> | null = null;
  const listener = (m: ToApp) => {
    if (m.t === 'saved') kept = m;
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
        if (training) send({ t: 'client', id, message: { t: 'training', on: true } });
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
      ? ({ type: 'answer', promptId: order.id, answer: { kind: 'order-pile', order: shuffled(order.cards) } } as Command)
      : (!recordAll && view.viewer !== 'spectator' ? curious(code, view.viewer, view.legal) : null) ??
        (choices.length ? choices : view.legal)[Math.floor(chance() * (choices.length || view.legal.length))];
    if (!command) return;
    // Duplicity's free reveal answers no prompt: the decision is still to make when the game comes back.
    if (command.type === 'reveal-duplicity') answered.delete(decision);
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
  let restored = false;
  let resigned = false;
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
    if (resignAfter !== undefined && moves >= resignAfter && !resigned) {
      resigned = true;
      send({ t: 'client', id, message: { t: 'command', command: { type: 'resign' } } });
    }
    if (extras && moves >= 12 && kept && !restored) {
      // The app closed and opened again: the game taken up from what it kept, on a new connection.
      restored = true;
      await settle();
      const back = nextId++;
      send({ t: 'restore', id: back, game: kept.game, replay: kept.text });
      id = back;
      answered.clear();
    }
  }
  if (!over) throw new Error(`the ${level} game didn't end`);
  if (!sentExtras) throw new Error(`the ${level} game ended before the rarer messages were sent`);
  if (extras && !restored) throw new Error(`the ${level} game ended before it was taken up again`);
  // The last round's review: its jobs run here, after the game.
  for (let wait = 0; queue.length && wait < 3000; wait++) await settle();
  await settle();
  if (extras) send({ t: 'client', id, message: { t: 'back-to-lobby' } });
  send({ t: 'close', id });
  listeners.delete(listener);
}

await game('hard', 2, true);
await game('medium', 1, false, true, 8);
await game('easy', 1, false);
// Then quick games until every kind has come up (an event the engine never shows a client excused).
const missing = () =>
  (Object.keys(KINDS) as Kind[]).flatMap((k) => [...want[k]].filter((v) => !seen[k].has(v) && !(k === 'event' && madeEvents.get(v) === false)).map((v) => `${k} ${v}`));
recordAll = false;
let coverageGames = 0;
for (; missing().length && coverageGames < 3000; coverageGames++) {
  await game('easy', 1, false, false);
  if ((coverageGames + 1) % 25 === 0) console.log(`${coverageGames + 1} coverage games: still to come up: ${missing().join(', ')}`);
}
await pool.close?.();

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'from-app.jsonl'), fromApp.join('\n') + '\n');
writeFileSync(join(out, 'to-app.jsonl'), toApp.join('\n') + '\n');

// Choosing a move by touching the table (packages/table/src/options.ts), as the TypeScript answers it, for the app's port
// (ios/Shared/Choosing.swift; ChoosingTests): on the recorded options, touches drawn mostly among the elements worth
// touching (sometimes any element at all), each with what it does, what lights up before it, and the panel's buttons.
const choosing: string[] = [];
const decisions = toApp
  .map((line) => JSON.parse(line) as { t: string; options?: Option[] })
  .filter((m) => m.t === 'server' && (m.options?.length ?? 0) > 1)
  .map((m) => m.options!);
// (Rounds of fresh touches on the same decisions until there are enough: as many whatever length the games came out.)
for (let round = 0; round < 20 && choosing.length < 400; round++) for (const options of decisions) {
  const all = [...new Set(options.flatMap((o) => o.refs))];
  let picked: Ref[] = [];
  for (let step = 0; step < 4 && all.length; step++) {
    const lit = [...clickable(options, picked)].sort();
    const from = lit.length && chance() < 0.85 ? lit : all;
    const ref = from[Math.floor(chance() * from.length)]!;
    const panel = panelItems(options, picked).map((item) =>
      item.kind === 'group' ? { kind: 'group', ref: item.ref, label: item.label, count: item.count } : { kind: 'option', label: item.option.label },
    );
    const result = click(options, picked, ref);
    choosing.push(JSON.stringify({ options, picked, ref, clickable: lit, panel, result }));
    if (result.kind !== 'pick') break;
    picked = result.picked;
  }
}
writeFileSync(join(out, 'choosing.jsonl'), choosing.join('\n') + '\n');

// Every kind of message, both ways, must be there.
const typesIn = (lines: string[], pick: (m: Record<string, unknown>) => unknown) => new Set(lines.map((l) => pick(JSON.parse(l))).filter(Boolean) as string[]);
const client = typesIn(fromApp, (m) => (m.t === 'client' ? (m.message as { t: string }).t : null));
const serverTypes = typesIn(toApp, (m) => (m.t === 'server' ? (m.message as { t: string }).t : null));
const wantClient = ['add-bot', 'back-to-lobby', 'command', 'create', 'join', 'leave', 'propose-undo', 'remove-bot', 'resume', 'settings', 'start', 'training', 'vote-undo'];
const wantServer = ['error', 'game', 'gone', 'replaced', 'review', 'room', 'welcome'];
const unseen = [...wantClient.filter((t) => !client.has(t)).map((t) => `client ${t}`), ...wantServer.filter((t) => !serverTypes.has(t)).map((t) => `server ${t}`), ...missing()];
const excused = [...madeEvents].filter(([, shown]) => !shown).map(([t]) => t);
console.log(`${fromApp.length} messages to the core, ${toApp.length} from it, from 3 games and ${coverageGames} more for coverage; ${(Object.keys(KINDS) as Kind[]).map((k) => `${k}s ${seen[k].size}/${want[k].size}`).join(', ')}${excused.length ? ` (never shown to a client: ${excused.join(', ')})` : ''}`);
if (problems.length) {
  logError(`${problems.length} problem(s) while recording (above): the first, ${problems[0]}`);
  process.exit(1);
}
if (unseen.length) {
  logError(`never came up: ${unseen.join(', ')}`);
  process.exit(1);
}
process.exit(0);
