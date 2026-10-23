// Which pile sits at each seat through a replay, and its size, printed whenever the assignment changes.
import { readFileSync } from 'node:fs';
import { apply, newGame, type GameState, type Seat } from '../../engine/src/index.ts';
const lines = readFileSync(process.argv[2]!, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
let state = newGame(lines[0].options).state as GameState;
const names = ['subagent (seat 0)', 'ghost 1', 'bot (seat 2)', 'ghost 3'];
const show = (label: string) => console.log(label.padEnd(34) + [0, 1, 2, 3].map((p) => `${names[p]}: ${state.pileAt[p as Seat]} (${state.piles[state.pileAt[p as Seat]].cards.length})`).join(' | '));
show('start');
let last = JSON.stringify(state.pileAt);
lines.slice(1).forEach(({ seat, command }: { seat: Seat; command: never }, i: number) => {
  const turn = state.turnNumber;
  const r = apply(state, seat, command);
  if (!r.ok) throw new Error(r.error.message);
  state = r.state;
  if (JSON.stringify(state.pileAt) !== last) {
    last = JSON.stringify(state.pileAt);
    show(`after #${i + 1} (turn ${turn}, ${JSON.stringify((command as { answer?: { kind?: string } }).answer?.kind)})`);
  }
});
show('end');
