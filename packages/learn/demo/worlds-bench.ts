// Sampler statistics on random games of two rounds: plans per accepted history, why plans are turned down, time per world.
//   node demo/worlds-bench.ts [rounds] [bias]
import { apply, eventsFor, legalCommands, newGame, viewFor, type Command, type GameState, type Seat, type TraceEvent } from '../../engine/src/index.ts';
import { Belief } from '../src/belief.ts';
import { sampleHistory, worldModel } from '../src/worlds.ts';

const rounds = Number(process.argv[2] ?? 20);
const bias = Number(process.argv[3] ?? 4);
let x = 12345;
const random = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;
const HARD = ['acquisition', 'invocation', 'joker', 'duplicity', 'resurrection', 'offering', 'pickpocket', 'pluck', 'legerdemain', 'epiphany', 'prayer', 'hocus-pocus', 'juggling', 'sanction', 'requisition', 'tithes'];
let plans = 0, accepted = 0, ms = 0, models = 0, worst = 0;
const rejected = new Map<string, number>();
for (let g = 0; g < rounds; g++) {
  const dealt = newGame({ players: 2, seed: `bench-${g}`, marksToWin: 2 }) as { state: GameState; events: TraceEvent[] };
  let state = dealt.state;
  let events = dealt.events;
  for (;;) {
    if (state.phase === 'round-over' && state.round < 2) {
      const r = apply(state, 0, { type: 'next-round' });
      if (!r.ok) throw new Error(r.error.message);
      state = r.state;
      events = [...events, ...r.events];
    }
    if (state.phase !== 'playing' && state.phase !== 'post-round') break;
    for (const me of [0, 2] as Seat[]) {
      if (random() > 0.3) continue;
      const log = eventsFor(events, me);
      const view = viewFor(state, me);
      const belief = new Belief(me, { sound: true }).update(log).observe(view);
      const t = performance.now();
      const model = worldModel(state, me, belief, view, log);
      for (let k = 0; k < 16; k++) sampleHistory(model, random);
      ms += performance.now() - t;
      models++;
      plans += model.stats.plans;
      accepted += model.stats.accepted;
      worst = Math.max(worst, model.stats.plans / model.stats.accepted);
      for (const [r, n] of model.stats.rejected) rejected.set(r, (rejected.get(r) ?? 0) + n);
    }
    const seat = state.prompts[0]!.seat;
    const legal = legalCommands(state, seat).filter((c) => c.type !== 'next-round');
    const weight = (c: Command) => (HARD.some((card) => JSON.stringify(c).includes(`"${card}"`)) ? bias : 1);
    let u = random() * legal.reduce((a, c) => a + weight(c), 0);
    const command = legal.find((c) => (u -= weight(c)) < 0) ?? legal.at(-1)!;
    const r = apply(state, seat, command);
    if (!r.ok) throw new Error(r.error.message);
    state = r.state;
    events = [...events, ...r.events];
  }
}
console.log(`${models} positions, ${accepted} histories: ${(plans / accepted).toFixed(3)} plans each (worst position ${worst.toFixed(1)}), ${(ms / accepted).toFixed(2)} ms per history`);
for (const [r, n] of [...rejected].sort((a, b) => b[1] - a[1])) console.log(`  ${n}  ${r}`);
