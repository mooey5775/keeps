// Positions where the world sampler gave up, and what fixed it.
//
// The opponent's card waiting for its keep: drawn unseen, it stays theirs while Duplicity's holder turns a
// face-down card up (Belief.waitingTake), so the position samples.
//
// The guided rebuild of the deal (worlds.ts, rebuildDeal). Unguided, the sampler draws the position each unseen
// take came from and the order of each pile uniformly, and turns down the draws that contradict what the player saw:
// exact, but where the player saw a pile whole and the opponent then took from it unseen, hardly any draw fits (1 in
// 5,400 and 1 in 40,000 in the two positions below, where it gave up). Guided, those draws only pick among what fits,
// and each history is kept with a chance that makes it as likely as unguided. These tests hold it to that:
//   1. the positions it gave up on: sampled, nearly every plan kept, every history replaying to the player's log;
//   2. elsewhere (nothing taken unseen from a pile the player saw into), the very same draws as unguided;
//   3. the same posterior as the unguided sampler (two-sample chi-square, pooled over positions): where the opponent took
//      from a pile seen into twice (saved positions), and at positions of random rounds where the player saw into piles
//      and the opponent took from them unseen.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apply, eventsFor, legalCommands, newGame, viewFor, type Command, type GameState, type Seat, type TraceEvent } from '@keeps/engine';
import { Belief, noteObservation } from '../src/belief.ts';
import { sampleHistory, worldModel, type History, type WorldModel } from '../src/worlds.ts';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** The model a search or review job builds: the player's log with what they see now noted. */
function modelOf(state: GameState, me: Seat, myLog: readonly TraceEvent[]): WorldModel {
  const view = viewFor(state, me);
  const log = noteObservation([...myLog], view, me);
  return worldModel(state, me, new Belief(me, { sound: true }).update(log), view, log);
}

/** Events as a player compares them (the order of cards listed from a hand says nothing). */
const canon = (e: TraceEvent) => {
  const p = e.payload;
  if (p.type === 'look-hands' && p.hands) return JSON.stringify({ ...p, hands: p.hands.map((h) => ({ ...h, cards: [...h.cards].sort() })) });
  if ((p.type === 'steal' && p.cards) || (p.type === 'discard' && p.from === 'hand')) return JSON.stringify({ ...p, cards: [...p.cards!].sort() });
  return JSON.stringify(p);
};

/** Replays a history on its own: the player's events must be the end of their log (observations aside). */
function replays(h: History, me: Seat, myLog: readonly TraceEvent[]): boolean {
  let state = h.start;
  const mine: TraceEvent[] = [];
  for (const { seat, command, rng: chance } of h.commands) {
    const r = apply(chance ? { ...state, rng: chance } : state, seat, command);
    if (!r.ok) return false;
    state = r.state;
    mine.push(...eventsFor(r.events, me));
  }
  const want = myLog.filter((e) => e.payload.type !== ('observed' as string));
  return want.slice(want.length - mine.length).map(canon).join('\n') === mine.map(canon).join('\n');
}

/** What the guided draws decide, as a world shows it: the opponent's hand, and the top two cards of the pile the player last saw into or saw taken from unseen. */
const handKey = (world: GameState, me: Seat) => JSON.stringify([...world.hands[(me + 2) % 4]!].sort());
function pileKey(world: GameState, model: WorldModel): string {
  const op = model.belief.pileOps.findLast((o) => o.op === 'look' || (o.op === 'pop' && o.from === 'any'))!;
  const position = model.belief.at.indexOf(op.p) as Seat;
  return JSON.stringify(world.piles[world.pileAt[position]!].cards.slice(0, 2).map((c) => c.id));
}

/** Two samples' counts by category → chi-square (bins merged, rarest first, until each holds 10) and its degrees of freedom. */
function twoSample(a: Map<string, number>, b: Map<string, number>, n1: number, n2: number): { x2: number; df: number } {
  // (Ties in order of the category itself, not of which sample had it first.)
  const total = (k: string) => (a.get(k) ?? 0) + (b.get(k) ?? 0);
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => total(x) - total(y) || (x < y ? -1 : x > y ? 1 : 0));
  const bins: [number, number][] = [];
  let cur: [number, number] = [0, 0];
  for (const k of keys) {
    cur = [cur[0] + (a.get(k) ?? 0), cur[1] + (b.get(k) ?? 0)];
    if (cur[0] + cur[1] >= 10) {
      bins.push(cur);
      cur = [0, 0];
    }
  }
  if (cur[0] + cur[1] > 0) {
    if (bins.length) bins[bins.length - 1] = [bins.at(-1)![0] + cur[0], bins.at(-1)![1] + cur[1]];
    else bins.push(cur);
  }
  let x2 = 0;
  for (const [x, y] of bins) x2 += (x * n2 - y * n1) ** 2 / (n1 * n2 * (x + y));
  return { x2, df: bins.length - 1 };
}

/** Cards that look into piles or take from them unseen; the rounds below favour them. */
const SEEING = ['tithes', 'requisition', 'epiphany', 'prayer', 'revelation', 'providence', 'juggling', 'acquisition'];

/**
 * Positions of random two-player rounds whose pile ops have a look or an unseen take, with the player's log; `taken`:
 * a take from an unknown position in a pile the player had seen into (where the belief forgets what the pile ops
 * remember: what the guided draws change).
 */
function* positions(games: number, random: () => number): Generator<{ state: GameState; me: Seat; myLog: TraceEvent[]; taken: boolean }> {
  for (let g = 0; g < games; g++) {
    let { state, events } = newGame({ players: 2, seed: `guided-${g}`, marksToWin: 1 }) as { state: GameState; events: TraceEvent[] };
    while (state.phase === 'playing' || state.phase === 'post-round') {
      for (const me of [0, 2] as Seat[]) {
        if (random() > 0.25) continue;
        const myLog = eventsFor(events, me);
        const ops = new Belief(me, { sound: true }).update(noteObservation([...myLog], viewFor(state, me), me)).pileOps;
        const seen = [false, false, false, false];
        let taken = false;
        for (const op of ops) {
          if (op.op === 'deal') seen[op.p] = false;
          else if (op.op === 'look' || op.op === 'push' || (op.op === 'reorder' && op.order)) seen[op.p] = true;
          else if (op.op === 'reorder') seen[op.p] = false;
          else if (op.op === 'pop' && op.from === 'any' && seen[op.p]) taken = true;
        }
        if (taken || ops.some((op) => op.op === 'look' || (op.op === 'pop' && op.from === 'any'))) yield { state, me, myLog, taken };
      }
      const seat = state.prompts[0]!.seat;
      const legal = legalCommands(state, seat).filter((c) => c.type !== 'next-round');
      const weight = (c: Command) => (SEEING.some((card) => JSON.stringify(c).includes(`"${card}"`)) ? 20 : 1);
      let u = random() * legal.reduce((s, c) => s + weight(c), 0);
      const command = legal.find((c) => (u -= weight(c)) < 0) ?? legal.at(-1)!;
      const r = apply(state, seat, command);
      if (!r.ok) throw new Error(r.error.message);
      state = r.state;
      events = [...events, ...r.events];
    }
  }
}

describe("the opponent's card waiting for its keep", () => {
  it('stays theirs while the Duplicity holder turns the face-down card up: those positions sample, every history replaying', () => {
    // The belief ended "just taken" at any event but a prompt or a play, so after the reveal the model had the HOT card
    // they drew unseen held in their hand, which a HOT card never is: no history fitted.
    const { games } = JSON.parse(readFileSync(new URL('./fixtures/worlds-duplicity-reveal.json', import.meta.url), 'utf8')) as {
      games: { options: Parameters<typeof newGame>[0]; commands: { seat: Seat; command: Command }[]; me: Seat }[];
    };
    for (const { options, commands, me } of games) {
      let { state, events } = newGame(options) as { state: GameState; events: TraceEvent[] };
      for (const { seat, command } of commands) {
        const r = apply(state, seat, command);
        if (!r.ok) throw new Error(r.error.message);
        state = r.state;
        events = [...events, ...r.events];
      }
      expect(eventsFor(events, me).at(-1)!.payload.type).toBe('reveal');
      const model = modelOf(state, me, eventsFor(events, me));
      const random = rng(3);
      for (let i = 0; i < 50; i++) expect(replays(sampleHistory(model, random), me, model.log)).toBe(true);
    }
  });
});

describe('the guided rebuild of the deal', () => {
  it('samples the positions the unguided sampler gave up on, keeping most plans; every history replays', () => {
    for (const name of ['worlds-seen-pile-1', 'worlds-seen-pile-2']) {
      const job = JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as { state: GameState; me: Seat; myLog: TraceEvent[] };
      const model = modelOf(job.state, job.me, job.myLog);
      const random = rng(1);
      for (let i = 0; i < 200; i++) expect(replays(sampleHistory(model, random), job.me, model.log)).toBe(true);
      const kept = model.stats.accepted / model.stats.plans;
      console.log(`${name}: 1 plan in ${(1 / kept).toFixed(1)} kept; turned down: ${JSON.stringify([...model.stats.rejected])}`);
      expect(kept).toBeGreaterThan(0.1);
    }
  }, 300_000);

  it('where nothing was taken unseen from a pile seen into, draws exactly what the unguided sampler draws', () => {
    // The guided draws keep the unguided one whenever it fits, and keep every history when nothing was forgotten.
    const random = rng(5);
    let tested = 0;
    for (const pos of positions(400, random)) {
      if (tested === 60) break;
      if (pos.taken) continue;
      const seed = Math.floor(random() * 2 ** 31);
      const worlds = [true, false].map((guided) => {
        const model = modelOf(pos.state, pos.me, pos.myLog);
        model.guided = guided;
        const r = rng(seed);
        return Array.from({ length: 20 }, () => JSON.stringify(sampleHistory(model, r).world));
      });
      expect(worlds[0]).toEqual(worlds[1]);
      tested++;
    }
    expect(tested).toBe(60);
  }, 600_000);

  it('draws the same posterior as the unguided sampler where the opponent took from a seen pile twice', () => {
    // Positions found by random rounds favouring Requisition (fixtures/worlds-repeated-takes.json): after a first unseen
    // take, the bound for the second one is loose, so its correction is below 1 (the guided draws keep a history less often).
    const { positions: saved } = JSON.parse(readFileSync(new URL('./fixtures/worlds-repeated-takes.json', import.meta.url), 'utf8')) as {
      positions: { state: GameState; me: Seat; myLog: TraceEvent[] }[];
    };
    const random = rng(17);
    const N = 800;
    let x2 = 0;
    let df = 0;
    for (const pos of saved) {
      const models = [true, false].map((guided) => {
        const model = modelOf(pos.state, pos.me, pos.myLog);
        model.guided = guided;
        return model;
      });
      // The pile taken from most: its top two cards; and the opponent's hand.
      const takes = [0, 0, 0, 0];
      for (const op of models[0]!.belief.pileOps) if (op.op === 'pop' && op.from === 'any') takes[op.p]!++;
      const position = models[0]!.belief.at.indexOf(takes.indexOf(Math.max(...takes))) as Seat;
      const counts = models.map(() => [new Map<string, number>(), new Map<string, number>()]);
      models.forEach((model, j) => {
        for (let i = 0; i < N; i++) {
          const world = sampleHistory(model, random).world;
          const keys = [JSON.stringify(world.piles[world.pileAt[position]!].cards.slice(0, 2).map((c) => c.id)), handKey(world, pos.me)];
          keys.forEach((key, q) => counts[j]![q]!.set(key, (counts[j]![q]!.get(key) ?? 0) + 1));
        }
      });
      for (const q of [0, 1]) {
        const r = twoSample(counts[0]![q]!, counts[1]![q]!, N, N);
        x2 += r.x2;
        df += r.df;
      }
    }
    console.log(`repeated takes: ${saved.length} positions, chi-square ${x2.toFixed(1)} on ${df}`);
    expect(saved.length).toBe(10);
    expect(Math.abs((x2 - df) / Math.sqrt(2 * df))).toBeLessThan(4);
  }, 900_000);

  it('draws the same posterior as the unguided sampler', () => {
    const random = rng(11);
    const N = 600;
    const pooled = { hand: { x2: 0, df: 0 }, piles: { x2: 0, df: 0 } };
    let tested = 0;
    let withTaken = 0;
    const plans = [0, 0];
    // Half the positions with a take from a pile the player saw into (the rare kind, and what the guide changes), half others.
    for (const pos of positions(4000, random)) {
      if (tested === 40) break;
      if (pos.taken ? withTaken === 20 : tested - withTaken === 20) continue;
      // Only positions the unguided sampler draws in reasonable time (it is the slow reference).
      const unguided = modelOf(pos.state, pos.me, pos.myLog);
      unguided.guided = false;
      try {
        for (let i = 0; i < 5; i++) sampleHistory(unguided, random);
      } catch {
        continue;
      }
      if (unguided.stats.plans / unguided.stats.accepted > 300) continue;
      const guided = modelOf(pos.state, pos.me, pos.myLog);
      const counts = { hand: [new Map<string, number>(), new Map<string, number>()], piles: [new Map<string, number>(), new Map<string, number>()] };
      [unguided, guided].forEach((model, j) => {
        for (let i = 0; i < N; i++) {
          const world = sampleHistory(model, random).world;
          for (const [k, key] of [['hand', handKey(world, pos.me)], ['piles', pileKey(world, model)]] as const) counts[k][j]!.set(key, (counts[k][j]!.get(key) ?? 0) + 1);
        }
      });
      for (const k of ['hand', 'piles'] as const) {
        const { x2, df } = twoSample(counts[k][0]!, counts[k][1]!, N, N);
        pooled[k].x2 += x2;
        pooled[k].df += df;
      }
      [unguided, guided].forEach((m, j) => (plans[j]! += m.stats.plans / m.stats.accepted));
      tested++;
      if (pos.taken) withTaken++;
    }
    console.log(
      `guided vs unguided: ${tested} positions (${withTaken} with a take from a pile seen into; plans per world kept, on average: unguided ${(plans[0]! / tested).toFixed(1)}, guided ${(plans[1]! / tested).toFixed(1)}); ` +
        `hands chi-square ${pooled.hand.x2.toFixed(1)} on ${pooled.hand.df}, pile tops ${pooled.piles.x2.toFixed(1)} on ${pooled.piles.df}`,
    );
    expect(tested).toBe(40);
    expect(withTaken).toBe(20);
    for (const k of ['hand', 'piles'] as const) expect(Math.abs((pooled[k].x2 - pooled[k].df) / Math.sqrt(2 * pooled[k].df))).toBeLessThan(4);
  }, 1_800_000);
});
