// A game's value move by move: from the TRUE position after each of the first K commands, `seat`'s win
// rate over R playouts with the network sampling every move for both sides (each side observing from
// its own seat). Run over a range of positions so it can be split across processes.
//   node valuetrace.ts <replay.jsonl> <weights> <seat> <R> <from> <to>   → one JSON line per position
import { readFileSync } from 'node:fs';
import { apply, eventsFor, legalCommands, newGame, viewFor, type Command, type GameState, type Seat, type TraceEvent } from '../../engine/src/index.ts';
import { Decision, NUM_ACTIONS } from '@keeps/bot';
import { Belief } from '@keeps/bot';
import { encodeObservation2 } from '@keeps/bot';
import { Policy, sample } from '@keeps/bot';
const [path, weights, seatArg, rArg, fromArg, toArg] = process.argv.slice(2);
const policy = Policy.load(readFileSync(weights!));
const forSeat = Number(seatArg) as Seat, R = Number(rArg);
let x = 777 + Number(fromArg);
const random = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;
const lines = readFileSync(path!, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

function move(s: GameState, seat: Seat, belief: Belief, log: TraceEvent[]): Command {
  const view = viewFor(s, seat);
  belief.update(log).observe(view);
  const decision = new Decision(view, legalCommands(s, seat));
  const prefix: number[] = [];
  for (;;) {
    const ids = decision.next(prefix);
    const mask = new Uint8Array(NUM_ACTIONS);
    for (const id of ids) mask[id] = 1;
    prefix.push(sample(policy.probabilities(encodeObservation2(view, belief, prefix, ids), mask), random));
    const c = decision.complete(prefix);
    if (c) return c;
  }
}

let { state, events } = newGame(lines[0].options) as { state: GameState; events: TraceEvent[] };
for (let k = 0; k < Math.min(Number(toArg), lines.length - 1); k++) {
  if (k >= Number(fromArg) && (state.phase === 'playing' || state.phase === 'post-round')) {
    let wins = 0;
    for (let n = 0; n < R; n++) {
      const players = new Map<Seat, { belief: Belief; log: TraceEvent[] }>(([0, 2] as Seat[]).map((s) => [s, { belief: new Belief(s, { sound: true }), log: eventsFor(events, s) }]));
      let s = state;
      while (s.phase === 'playing' || s.phase === 'post-round') {
        const seat = s.prompts[0]!.seat;
        const p = players.get(seat)!;
        const r = apply(s, seat, move(s, seat, p.belief, p.log), { trusted: true });
        if (!r.ok) throw new Error(r.error.message);
        s = r.state;
        for (const [q, pl] of players) pl.log.push(...eventsFor(r.events, q));
      }
      if (s.lastRoundWinner === forSeat) wins++;
    }
    const next = lines[1 + k];
    console.log(JSON.stringify({ k, turn: state.turnNumber, decider: state.prompts[0]!.seat, kind: state.prompts[0]!.kind, played: next.command.answer ?? next.command, value: wins / R }));
  }
  const { seat, command } = lines[1 + k];
  const r = apply(state, seat, command);
  if (!r.ok) throw new Error(r.error.message);
  state = r.state;
  events = [...events, ...r.events];
}
