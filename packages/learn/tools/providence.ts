// Providence benchmark: does a network play Providence where it should, and pick the right pair?
//
// Midstrike's network rarely plays Providence (16% on average where it's playable, under 1% at three positions in four),
// yet in game XDMY (2026-10-30, on the phone) one Providence swap won a round outright, and only search found it. This
// measures the gap, from the decider's own information (ex ante), so a future network can be held to it.
//
//   node packages/learn/tools/providence.ts positions <games> <seed> <out.jsonl>
//       Midstrike's network plays itself; each decision where Providence is playable is kept (at most two a game), as
//       the game's options, its commands so far and the seat: a position any network can be put in.
//   node packages/learn/tools/providence.ts reference <positions.jsonl> <worlds> <out.jsonl> [shard] [shards]     (FROM=n: from position n)
//       At each position, Midstrike's search (best-Q, sampled rollouts, from the decider's information) gives every
//       move's chance of winning the round; Providence's is its best pair's (a second search, once it's played). Give
//       it a GPU: SEARCH_INFERENCE=<socket> with the network served there (training/keeps_bot/serve.py), about 5 s a
//       position at 1,024 worlds; on the CPU alone, minutes.
//   node packages/learn/tools/providence.ts score <positions.jsonl> <reference.jsonl> <weights.bin>
//       A network against the reference: how likely it plays Providence where Providence is clearly best (by 3 points
//       or more) and where it's clearly worse; its expected loss of win chance from its choice (the reference's best,
//       less the chances of its moves weighted by how likely it plays them); and, where Providence is best, how likely
//       it picks the best pair. Network only: seconds.
//
// The positions and the reference for the vrpo1 40,000 network (Midstrike since 2026-10-26) are in benchmarks/.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apply, legalCommands, newGame, type Command, type GameState, type NewGameOptions, type Seat, type TraceEvent } from '@keeps/engine';
import { BotPlayer, Policy } from '@keeps/bot';

const MIDSTRIKE = join(import.meta.dirname, '../../bot/weights/midstrike.bin');

interface Position {
  options: NewGameOptions;
  commands: { seat: Seat; command: Command }[];
  seat: Seat;
}
interface Reference {
  /** Each move at the decision, by its key (canonical JSON), with its chance of winning; Providence's is its best pair's. */
  moves: Record<string, { move: string; win: number }>;
  /** Providence's pairs, by key, with their chances. */
  pairs: Record<string, { move: string; win: number }>;
  worlds: number;
}

const canon = (c: unknown): string =>
  JSON.stringify(c, (_k, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));
const isProvidence = (c: Command) => c.type === 'answer' && c.answer.kind === 'action' && c.answer.choice.action === 'play' && c.answer.choice.card === 'providence';
const readLines = <T>(file: string) => readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as T);

/** The position replayed, with `seat`'s player (the network given) having observed each of its decisions, as it would have. */
function replayed(p: Position, policy: Policy): { state: GameState; events: TraceEvent[]; bot: BotPlayer } {
  let { state, events } = newGame(p.options) as { state: GameState; events: TraceEvent[] };
  const bot = new BotPlayer(policy, p.seat);
  for (const { seat, command } of p.commands) {
    if (seat === p.seat && bot.wantsToMove(state)) bot.observe(state, events);
    const r = apply(state, seat, command);
    if (!r.ok) throw new Error(r.error.message);
    state = r.state;
    events = [...events, ...r.events];
  }
  return { state, events, bot };
}

async function positions(games: number, seed: number, out: string): Promise<void> {
  const policy = Policy.load(readFileSync(MIDSTRIKE));
  const { seeded } = await import('@keeps/bot');
  const random = seeded(seed, 1);
  const kept: string[] = [];
  for (let g = 0; g < games; g++) {
    const options: NewGameOptions = { players: 2, seed: `providence-${seed}-${g}`, marksToWin: 1 };
    let { state, events } = newGame(options) as { state: GameState; events: TraceEvent[] };
    const bots = new Map<Seat, BotPlayer>([[0, new BotPlayer(policy, 0, random)], [2, new BotPlayer(policy, 2, random)]]);
    const commands: Position['commands'] = [];
    let inGame = 0;
    while ((state.phase === 'playing' || state.phase === 'post-round') && inGame < 2) {
      const seat = state.prompts[0]!.seat as Seat;
      if (legalCommands(state, seat).some(isProvidence)) {
        kept.push(JSON.stringify({ options, commands: [...commands], seat } satisfies Position));
        inGame++;
      }
      const command = bots.get(seat)!.choose(state, events);
      const r = apply(state, seat, command);
      if (!r.ok) throw new Error(r.error.message);
      commands.push({ seat, command });
      state = r.state;
      events = [...events, ...r.events];
    }
  }
  writeFileSync(out, kept.join('\n') + '\n');
  console.log(`${kept.length} positions from ${games} games → ${out}`);
}

async function reference(file: string, worlds: number, out: string, shard: number, shards: number): Promise<void> {
  const { atWorlds, searchChoose, setSearchLog } = await import('@keeps/bot/search/search.ts');
  const { RolloutPool } = await import('@keeps/bot/search/rollout-pool.ts');
  const { BatchedPool } = await import('@keeps/bot/search/batch-search.ts');
  const policy = Policy.load(readFileSync(MIDSTRIKE));
  setSearchLog(() => {});
  // With SEARCH_INFERENCE (the socket of training/keeps_bot/serve.py, the network on a GPU), batched: about a second a
  // search; without, the network on the CPU in each worker: tens of seconds.
  const inference = process.env.SEARCH_INFERENCE ?? null;
  const workers = Number(process.env.WORKERS ?? (inference ? 12 : 48));
  const threads = inference ? new BatchedPool(workers, MIDSTRIKE, inference, true, () => {}) : new RolloutPool(workers, MIDSTRIKE, true);
  const pool = atWorlds(threads, worlds);
  type Report = { moves: { move: string; win: number; command: Command }[] };
  const search = async (bot: BotPlayer, state: GameState, events: TraceEvent[]) => {
    let report: Report | null = null;
    await searchChoose(bot, state, events, pool, { report: (r: Report) => (report = r), by: 'mode' });
    return report as Report | null;
  };
  const rows: string[] = [];
  const all = readLines<Position>(file);
  for (const [i, p] of all.entries()) {
    if (i % shards !== shard || i < Number(process.env.FROM ?? 0)) continue;
    const t = Date.now();
    const { state, events, bot } = replayed(p, policy);
    const first = await search(bot, state, events);
    // Providence played, then its pairs searched (from the decider's information: every keep is public).
    const providence = legalCommands(state, p.seat).find(isProvidence)!;
    const after = replayed({ ...p, commands: [...p.commands] }, policy);
    after.bot.observe(after.state, after.events);
    const played = apply(after.state, p.seat, providence);
    if (!played.ok) throw new Error(played.error.message);
    // (With fewer than two Keep cards in play, Providence swaps nothing: no pair to choose.)
    const choosing = played.state.prompts.some((q) => q.seat === p.seat && q.kind === 'choose-keep-pair');
    const pairs = choosing ? await search(after.bot, played.state, [...after.events, ...played.events]) : null;
    const ref: Reference = { moves: {}, pairs: {}, worlds };
    for (const m of first?.moves ?? []) ref.moves[canon(m.command)] = { move: m.move, win: m.win };
    for (const m of pairs?.moves ?? []) ref.pairs[canon(m.command)] = { move: m.move, win: m.win };
    // Providence's chance: its best pair's (a single pair, or none to choose: the first search's).
    const bestPair = Math.max(...Object.values(ref.pairs).map((m) => m.win));
    if (Number.isFinite(bestPair)) ref.moves[canon(providence)] = { move: 'providence', win: bestPair };
    rows.push(JSON.stringify({ index: i, ...ref }));
    writeFileSync(out, rows.join('\n') + '\n');
    console.log(`#${i}: ${Object.keys(ref.moves).length} moves, ${Object.keys(ref.pairs).length} pairs (${Math.round((Date.now() - t) / 1000)} s)`);
  }
  await threads.close();
}

function score(file: string, refFile: string, weights: string): void {
  const policy = Policy.load(readFileSync(weights));
  const all = readLines<Position>(file);
  const refs = readLines<Reference & { index: number }>(refFile);
  const MARGIN = 0.03;
  const best: number[] = [];
  const worse: number[] = [];
  const pairBest: number[] = [];
  let regret = 0;
  let counted = 0;
  const lossBest: number[] = [];
  const lossOther: number[] = [];
  for (const ref of refs) {
    const p = all[ref.index]!;
    const { state, events, bot } = replayed(p, policy);
    const moves = bot.suggest(state, events);
    const win = (c: Command) => ref.moves[canon(c)]?.win;
    const wins = Object.values(ref.moves).map((m) => m.win);
    if (wins.length < 2) continue;
    const top = Math.max(...wins);
    const providence = moves.filter((m) => isProvidence(m.command)).reduce((t, m) => t + m.probability, 0);
    const provWin = Object.entries(ref.moves).find(([, m]) => m.move === 'providence')?.[1].win;
    const others = Math.max(...Object.values(ref.moves).filter((m) => m.move !== 'providence').map((m) => m.win));
    if (provWin !== undefined && provWin >= others + MARGIN) best.push(providence);
    if (provWin !== undefined && provWin <= others - MARGIN) worse.push(providence);
    let expected = 0;
    let mass = 0;
    for (const m of moves) {
      const w = win(m.command);
      if (w === undefined) continue;
      expected += m.probability * w;
      mass += m.probability;
    }
    if (mass > 0) {
      const loss = top - expected / mass;
      regret += loss;
      counted++;
      (provWin !== undefined && provWin >= others + MARGIN ? lossBest : lossOther).push(loss);
    }
    // The pair, where Providence is best: the network's chance of the best one.
    if (provWin !== undefined && provWin >= others + MARGIN && Object.keys(ref.pairs).length > 1) {
      const providenceCommand = legalCommands(state, p.seat).find(isProvidence)!;
      bot.observe(state, events);
      const played = apply(state, p.seat, providenceCommand);
      if (!played.ok) throw new Error(played.error.message);
      const pairs = bot.suggest(played.state, [...events, ...played.events]);
      const topPair = Math.max(...Object.values(ref.pairs).map((m) => m.win));
      pairBest.push(pairs.filter((m) => (ref.pairs[canon(m.command)]?.win ?? -1) >= topPair - 1e-9).reduce((t, m) => t + m.probability, 0));
    }
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  console.log(`${weights}: ${counted} positions`);
  console.log(`  Providence clearly best (${best.length} positions): plays it ${pct(mean(best))} on average`);
  console.log(`  Providence clearly worse (${worse.length} positions): plays it ${pct(mean(worse))} on average`);
  console.log(`  where Providence is best, picks the best pair: ${pct(mean(pairBest))} on average (${pairBest.length} positions)`);
  console.log(`  expected loss of win chance from its choice: ${(100 * (regret / counted)).toFixed(2)} points a decision`);
  console.log(`    where Providence is clearly best: ${(100 * mean(lossBest)).toFixed(2)} points; elsewhere: ${(100 * mean(lossOther)).toFixed(2)}`);
}

const [command, ...args] = process.argv.slice(2);
if (command === 'positions') await positions(Number(args[0]), Number(args[1]), args[2]!);
else if (command === 'reference') await reference(args[0]!, Number(args[1]), args[2]!, Number(args[3] ?? 0), Number(args[4] ?? 1));
else if (command === 'score') score(args[0]!, args[1]!, args[2]!);
else console.log('usage: node providence.ts positions <games> <seed> <out> | reference <positions> <worlds> <out> [shard shards] | score <positions> <reference> <weights>');
process.exit(0);
