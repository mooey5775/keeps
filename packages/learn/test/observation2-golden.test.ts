// The network's observations, held to the encoder known to be right (3ceacaa) and to the information they may use.
//
// A recorded run: seeded random games over several rounds, every decision of both players (each step of a
// multi-part command too) encoded from that player's view and belief, hashed game by game. Any change to what an
// observation holds (a value, a position made absolute instead of relative to the player, something hidden leaking
// in, one player's data cached into the other's) changes a hash. After a change meant to change the observations,
// record them again: UPDATE_GOLDEN=1 pnpm --filter @keeps/learn exec vitest run test/observation2-golden.test.ts
//
// And with no recording: a player's observation must be the same in every world consistent with what they know.
// (There the belief is built from the player's log in one go, the same way in each world. The bot's belief, updated
// at each of its decisions, can also remember things from the views it saw on the way, so it can differ from one
// built from the log; the recorded run holds that path exactly.)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apply, eventsFor, legalCommands, newGame, viewFor, type Command, type GameState, type Seat, type TraceEvent } from '@keeps/engine';
import { Decision } from '../src/actions.ts';
import { Belief } from '../src/belief.ts';
import { encodeObservation2 } from '../src/observation2.ts';
import { sampleHistory, worldModel } from '../src/worlds.ts';
import { seeded } from '../demo/random.ts';

const GAMES = 40;

/** FNV-1a over an observation's float bits, continuing `h`. */
function hash(h: number, obs: Float32Array): number {
  const bits = new Uint32Array(obs.buffer, obs.byteOffset, obs.length);
  for (let i = 0; i < bits.length; i++) h = Math.imul(h ^ bits[i]!, 16777619) >>> 0;
  return h;
}

type Seen = { state: GameState; events: TraceEvent[]; seat: Seat; prefix: number[]; ids: number[]; obs: Float32Array };

/**
 * A seeded random game (two players, first to 2 marks): every observation of every decision, in order, to `see`.
 * Each player's belief reads their own log as the game goes, as the bot's does.
 */
function play(g: number, see: (s: Seen) => void): void {
  let { state, events } = newGame({ players: 2, seed: `obs-golden-${g}`, marksToWin: 2 }) as { state: GameState; events: TraceEvent[] };
  const random = seeded(g, 7);
  const beliefs = new Map<Seat, Belief>();
  for (let step = 0; step < 2000 && state.phase !== 'game-over'; step++) {
    if (state.phase === 'round-over') {
      const r = apply(state, 0, { type: 'next-round' });
      if (!r.ok) throw new Error(`game ${g}: ${r.error.message}`);
      state = r.state;
      events = [...events, ...r.events];
      continue;
    }
    const seat = state.prompts[0]!.seat as Seat;
    const view = viewFor(state, seat);
    const belief = beliefs.get(seat) ?? new Belief(seat, { sound: true });
    beliefs.set(seat, belief);
    belief.update(eventsFor(events, seat)).observe(view);
    const decision = new Decision(view, legalCommands(state, seat));
    const prefix: number[] = [];
    let command: Command | null = null;
    while (!command) {
      const ids = decision.next(prefix);
      see({ state, events, seat, prefix: [...prefix], ids, obs: encodeObservation2(view, belief, prefix, ids) });
      prefix.push(ids[Math.floor(random() * ids.length)]!);
      command = decision.complete(prefix);
    }
    const r = apply(state, seat, command);
    if (!r.ok) throw new Error(`game ${g}: ${r.error.message}`);
    state = r.state;
    events = [...events, ...r.events];
  }
}

describe('observations, against a recorded run', () => {
  const path = new URL('./fixtures/observation2-golden.json', import.meta.url);
  it('encode every decision of whole games exactly as recorded', () => {
    const games: number[] = [];
    let observations = 0;
    for (let g = 0; g < GAMES; g++) {
      let h = 2166136261;
      play(g, ({ obs }) => {
        h = hash(h, obs);
        observations++;
      });
      games.push(h);
    }
    const run = { observations, games };
    if (process.env.UPDATE_GOLDEN || !existsSync(path)) writeFileSync(path, JSON.stringify(run) + '\n');
    expect(run).toEqual(JSON.parse(readFileSync(path, 'utf8')));
  });
});

describe("a player's observation", () => {
  it('is the same in every world consistent with what they know', () => {
    let checked = 0;
    for (let g = 0; g < 6; g++) {
      const random = seeded(g, 99);
      let n = 0;
      play(g, ({ state, events, seat, prefix, ids }) => {
        if (n++ % 7 !== 0) return;
        const myLog = eventsFor(events, seat);
        const view = viewFor(state, seat);
        const obs = encodeObservation2(view, new Belief(seat, { sound: true }).update(myLog).observe(view), prefix, ids);
        const model = worldModel(state, seat, new Belief(seat, { sound: true }).update(myLog).observe(view), view, myLog);
        for (let w = 0; w < 3; w++) {
          const world = sampleHistory(model, random);
          const theirView = viewFor(world.world, seat);
          const belief = new Belief(seat, { sound: true }).update(world.logs[seat]!).observe(theirView);
          expect(encodeObservation2(theirView, belief, prefix, ids)).toEqual(obs);
          checked++;
        }
      });
    }
    expect(checked).toBeGreaterThan(100);
  });
});
