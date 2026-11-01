// The search at real pile reorders (Tithes): finds positions in e1 self-play, searches there, checks the move applies.
import { readFileSync } from 'node:fs';
import { apply, newGame, type GameState, type Seat, type TraceEvent } from '../../engine/src/index.ts';
import { BotPlayer } from '@keeps/bot';
import { Policy } from '@keeps/bot';
import { searchChoose, setSearchLog, setSearchMode, setWorlds } from '@keeps/bot/search/search.ts';
import { RolloutPool } from '@keeps/bot/search/rollout-pool.ts';
setSearchMode('best-q'); setWorlds(Number(process.argv[2] ?? 16));
const lines: string[] = []; setSearchLog((l) => lines.push(l));
const policy = Policy.load(readFileSync(new URL('weights/e1.bin', import.meta.url)));
const pool = new RolloutPool(8, new URL('weights/e1.bin', import.meta.url).pathname);
let found = 0;
for (let g = 0; g < 2000 && found < Number(process.argv[3] ?? 4); g++) {
  let { state, events } = newGame({ players: 2, seed: `order-${g}`, marksToWin: 1 }) as { state: GameState; events: TraceEvent[] };
  const bots = new Map<Seat, BotPlayer>(([0, 2] as Seat[]).map((s) => [s, new BotPlayer(policy, s)]));
  while (state.phase === 'playing' || state.phase === 'post-round') {
    const seat = state.prompts[0]!.seat;
    const prompt = state.prompts[0]!;
    let command;
    if (prompt.kind === 'order-pile') {
      lines.length = 0;
      const t0 = Date.now();
      command = await searchChoose(bots.get(seat)!, state, events, pool);
      console.log(`  searched in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      found++;
      console.log(`game ${g}: reorder of ${(prompt as { cards: string[] }).cards.length} cards → ${JSON.stringify((command as { answer: unknown }).answer)}`);
      console.log(lines.slice(0, 5).join('\n'));
    } else command = bots.get(seat)!.choose(state, events);
    const r = apply(state, seat, command);
    if (!r.ok) throw new Error(`${prompt.kind}: ${r.error.message}`);
    state = r.state; events = [...events, ...r.events];
  }
}
console.log(`searched ${found} reorders; every move applied`);
process.exit(0);
