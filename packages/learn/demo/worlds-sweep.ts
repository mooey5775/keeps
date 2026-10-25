// Sampler sweep over real replays: at positions of each game, both players' worlds, any failure reported.
//   node demo/worlds-sweep.ts <replay.jsonl>...
import { readFileSync } from 'node:fs';
import { apply, eventsFor, newGame, viewFor, type GameState, type Seat, type TraceEvent } from '../../engine/src/index.ts';
import { Belief } from '../src/belief.ts';
import { sampleHistory, worldModel } from '../src/worlds.ts';

let x = 99;
const random = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;
let positions = 0, plans = 0, accepted = 0, slowest = 0, failures = 0;
for (const path of process.argv.slice(2)) {
  const lines = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  if (!lines[0]?.options) continue;
  let { state, events } = newGame(lines[0].options) as { state: GameState; events: TraceEvent[] };
  for (let k = 0; k <= lines.length - 1; k++) {
    if ((state.phase === 'playing' || state.phase === 'post-round') && random() < 0.3) {
      for (const me of [0, 2] as Seat[]) {
        const log = eventsFor(events, me);
        const view = viewFor(state, me);
        const t = Date.now();
        try {
          const belief = new Belief(me, { sound: true }).update(log).observe(view);
          const model = worldModel(state, me, belief, view, log);
          for (let i = 0; i < 4; i++) sampleHistory(model, random);
          plans += model.stats.plans;
          accepted += model.stats.accepted;
        } catch (error) {
          failures++;
          console.log(`${path} K=${k} seat ${me}: ${String(error).slice(0, 300)}`);
        }
        slowest = Math.max(slowest, Date.now() - t);
        positions++;
      }
    }
    if (k === lines.length - 1) break;
    const { seat, command } = lines[k + 1];
    const r = apply(state, seat, command);
    if (!r.ok) break;
    state = r.state;
    events = [...events, ...r.events];
  }
}
console.log(`${positions} positions: ${failures} failures, ${(plans / accepted).toFixed(3)} plans per history, slowest ${slowest} ms`);
