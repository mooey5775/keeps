import { apply, eventsFor, legalCommands, newGame, viewFor, type GameState, type Seat, type TraceEvent } from '../../engine/src/index.ts';
import { Belief } from '@keeps/bot';
import { sampleWorld, worldModel } from '@keeps/bot';
let x = 7;
const random = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;
const build: number[] = [], sample: number[] = [], classes: number[] = [];
for (let g = 0; g < 40; g++) {
  let { state, events } = newGame({ players: 2, seed: `speed-${g}`, marksToWin: 1 }) as { state: GameState; events: TraceEvent[] };
  const bs = new Map<Seat, { belief: Belief; read: number; log: TraceEvent[] }>(([0, 2] as Seat[]).map((s) => [s, { belief: new Belief(s, { sound: true }), read: 0, log: [] }]));
  while (state.phase === 'playing' || state.phase === 'post-round') {
    const seat = state.prompts[0]!.seat;
    const b = bs.get(seat)!;
    b.log.push(...eventsFor(events.slice(b.read), seat));
    b.read = events.length;
    const view = viewFor(state, seat);
    b.belief.update(b.log).observe(view);
    let t = performance.now();
    const model = worldModel(state, seat, b.belief, view);
    build.push(performance.now() - t);
    classes.push(model.classes.length);
    t = performance.now();
    for (let k = 0; k < 64; k++) sampleWorld(model, state, b.belief, random);
    sample.push((performance.now() - t) / 64);
    const legal = legalCommands(state, seat).filter((c) => c.type !== 'next-round');
    const r = apply(state, seat, legal[Math.floor(random() * legal.length)]!);
    if (!r.ok) throw new Error(r.error.message);
    state = r.state;
    events = [...events, ...r.events];
  }
}
const q = (a: number[], f: number) => [...a].sort((u, v) => u - v)[Math.floor(f * (a.length - 1))]!;
console.log(`${build.length} decisions. model build ms: median ${q(build, 0.5).toFixed(2)}, p95 ${q(build, 0.95).toFixed(2)}, max ${Math.max(...build).toFixed(1)}; classes median ${q(classes, 0.5)}, max ${Math.max(...classes)}; one world ms: median ${q(sample, 0.5).toFixed(3)}, p95 ${q(sample, 0.95).toFixed(3)}`);
