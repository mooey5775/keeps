// The network's observations, held to the encoder known to be right (3ceacaa) and to the information they may use.
//
// A recorded run: seeded random games over several rounds, every decision of both players (each step of a
// multi-part command too) encoded from that player's view and belief, hashed game by game. Any change to what an
// observation holds (a value, a position made absolute instead of relative to the player, something hidden leaking
// in, one player's data cached into the other's) changes a hash. After a change meant to change the observations,
// record them again: UPDATE_GOLDEN=1 pnpm --filter @keeps/learn exec vitest run test/observation2-golden.test.ts
//
// And with no recording: a belief rebuilt from a player's log, which notes what their view showed at each of their
// decisions (noteObservation), is the one they built up as the game went; and a player's observation is the same
// in every world consistent with what they know.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apply, CARD_IDS, eventsFor, legalCommands, newGame, viewFor, type Command, type GameState, type Seat, type TraceEvent } from '@keeps/engine';
import { Decision } from '../src/actions.ts';
import { Belief, isObserved, noteObservation } from '../src/belief.ts';
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
  it('is the same from a belief rebuilt from their log as from one built up as the game went', () => {
    let checked = 0;
    for (let g = 0; g < GAMES; g++) {
      const logs = new Map<Seat, TraceEvent[]>();
      let read = 0;
      play(g, ({ state, events, seat, prefix, ids, obs }) => {
        // Each player's log as BotPlayer keeps it: their events as they come, and their view at each decision.
        for (const s of [0, 2] as Seat[]) {
          const log = logs.get(s) ?? [];
          logs.set(s, log);
          log.push(...eventsFor(events.slice(read), s));
        }
        read = events.length;
        const log = noteObservation(logs.get(seat)!, viewFor(state, seat), seat);
        const rebuilt = new Belief(seat, { sound: true }).update(log);
        expect(encodeObservation2(viewFor(state, seat), rebuilt, prefix, ids)).toEqual(obs);
        checked++;
      });
    }
    expect(checked).toBeGreaterThan(6000);
  });

  it('comes from worlds that showed them what they saw', () => {
    let checked = 0;
    for (let g = 0; g < 12; g++) {
      const random = seeded(g, 77);
      const logs = new Map<Seat, TraceEvent[]>();
      let read = 0;
      let n = 0;
      play(g, ({ state, events, seat, prefix }) => {
        for (const s of [0, 2] as Seat[]) {
          const log = logs.get(s) ?? [];
          logs.set(s, log);
          log.push(...eventsFor(events.slice(read), s));
        }
        read = events.length;
        const view = viewFor(state, seat);
        const myLog = noteObservation(logs.get(seat)!, view, seat);
        if (prefix.length || n++ % 5 !== 0) return;
        const model = worldModel(state, seat, new Belief(seat, { sound: true }).update(myLog), view, myLog);
        const round = myLog.slice(myLog.findLastIndex((e) => e.payload.type === 'round-start'));
        for (let w = 0; w < 3; w++) {
          const h = sampleHistory(model, random);
          // Replayed independently: what the player would have noted at each of their decisions in this world.
          let world = h.start;
          const noted: TraceEvent[] = [];
          for (const { seat: s, command, rng: chance } of h.commands) {
            if (s === seat) noteObservation(noted, viewFor(world, seat), seat);
            const r = apply(chance ? { ...world, rng: chance } : world, s, command);
            if (!r.ok) throw new Error(r.error.message);
            world = r.state;
            noted.push(...eventsFor(r.events, seat));
          }
          noteObservation(noted, viewFor(world, seat), seat);
          // (A hand's order says nothing: worlds may hold the same cards in another order.)
          const seen = (log: TraceEvent[]) =>
            log.filter(isObserved).map((e) => {
              const o = e.payload as unknown as { tops: unknown[]; visible: string[] };
              return { tops: o.tops, visible: [...o.visible].sort() };
            });
          expect(seen(noted)).toEqual(seen(round));
          checked++;
        }
      });
    }
    expect(checked).toBeGreaterThan(300);
  });

  it("rules out every world that didn't show them what their log says they saw", () => {
    let tested = 0;
    for (let g = 0; g < 4; g++) {
      const logs = new Map<Seat, TraceEvent[]>();
      let read = 0;
      let done = false;
      play(g, ({ state, events, seat, prefix }) => {
        for (const s of [0, 2] as Seat[]) {
          const log = logs.get(s) ?? [];
          logs.set(s, log);
          log.push(...eventsFor(events.slice(read), s));
        }
        read = events.length;
        const view = viewFor(state, seat);
        const myLog = noteObservation(logs.get(seat)!, view, seat);
        const notes = myLog.map((e, i) => [e, i] as const).filter(([e]) => isObserved(e));
        if (done || prefix.length || notes.length < 4 || myLog.slice(notes[0]![1]).some((e) => e.payload.type === 'round-start')) return;
        // The model from the true log; then an earlier observation in it claims a card in sight that wasn't.
        const model = worldModel(state, seat, new Belief(seat, { sound: true }).update(myLog), view, myLog);
        const [entry] = notes[1]!;
        const seen = entry.payload as unknown as { visible: string[] };
        const absent = CARD_IDS.find((c) => !seen.visible.includes(c))!;
        const tampered = { ...entry, payload: { ...entry.payload, visible: [...seen.visible, absent] } as unknown as TraceEvent['payload'] };
        const at = model.log.indexOf(entry);
        expect(at).toBeGreaterThan(0);
        (model.log as TraceEvent[])[at] = tampered;
        expect(() => sampleHistory(model, seeded(g, 3))).toThrow(/no history replays/);
        tested++;
        done = true;
      });
    }
    expect(tested).toBe(4);
  });

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
