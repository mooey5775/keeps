import {
  apply,
  CARDS,
  checkInvariants,
  eventsFor,
  isCoinCard,
  legalCommands,
  newGame,
  viewFor,
  type CardId,
  type GameState,
  type PlayerView,
  type Seat,
  type TraceEvent,
} from '@keeps/engine';
import { describe, expect, it } from 'vitest';
import { Belief, type HiddenEvent } from '../src/belief.ts';
import { gatherFacts, revealRoles, sampleWorld, worldModel, type Facts } from '../src/worlds.ts';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface Decision {
  state: GameState;
  initial: GameState;
  seat: Seat;
  belief: Belief;
  view: PlayerView;
}

/** Every decision of random-move rounds, with the decider's belief observed as the bot's is. */
function* decisions(rounds: number, seed: string, random: () => number): Generator<Decision> {
  for (let g = 0; g < rounds; g++) {
    let { state, events } = newGame({ players: 2, seed: `${seed}-${g}`, marksToWin: 1 }) as { state: GameState; events: TraceEvent[] };
    const initial = state;
    const players = new Map<Seat, { belief: Belief; read: number; log: TraceEvent[] }>(
      ([0, 2] as Seat[]).map((s) => [s, { belief: new Belief(s, { sound: true }), read: 0, log: [] }]),
    );
    while (state.phase === 'playing' || state.phase === 'post-round') {
      const seat = state.prompts[0]!.seat;
      const p = players.get(seat)!;
      p.log.push(...eventsFor(events.slice(p.read), seat));
      p.read = events.length;
      const view = viewFor(state, seat);
      p.belief.update(p.log).observe(view);
      yield { state, initial, seat, belief: p.belief, view };
      const legal = legalCommands(state, seat).filter((c) => c.type !== 'next-round');
      const r = apply(state, seat, legal[Math.floor(random() * legal.length)]!);
      if (!r.ok) throw new Error(r.error.message);
      state = r.state;
      events = [...events, ...r.events];
    }
  }
}

describe('worlds', () => {
  it('samples worlds the player can not tell from the real one, and never excludes the real one', () => {
    const random = rng(11);
    let checked = 0;
    for (const d of decisions(12, 'worlds-sound', random)) {
      const model = worldModel(d.state, d.seat, d.belief, d.view);
      for (let k = 0; k < 2; k++) {
        const world = sampleWorld(model, d.state, d.belief, random);
        expect(checkInvariants(world)).toEqual([]);
        expect(JSON.stringify(viewFor(world, d.seat))).toBe(JSON.stringify(d.view));
      }
      // The truth: σ, the opponent's hidden cards by pile of origin (hand, face down), known face-down cards.
      const opp = ((d.seat + 2) % 4) as Seat;
      const sigma = [0, 1, 2, 3].map((p) => d.initial.pileAt[p as Seat]);
      const origin = new Map<CardId, number>();
      for (let p = 0; p < 4; p++) for (const c of d.initial.piles[sigma[p]!].cards) origin.set(c.id, p);
      const known = new Set(d.belief.opponentKnown);
      const held = [0, 1, 2, 3].map(() => [0, 0]);
      for (const card of d.state.hands[opp]!) if (!known.has(card)) held[origin.get(card)!]![0]! += 1;
      const down: CardId[] = [];
      for (const keep of d.view.keeps)
        keep.cards.forEach((c, i) => {
          if (!c.faceDown || c.id) return;
          const card = d.state.keeps[keep.seat]![i]!.id;
          if (known.has(card)) down.push(card);
          else held[origin.get(card)!]![1]! += 1;
        });
      const inSupport = model.classes.some(
        (c) =>
          c.sigma.every((id, p) => id === sigma[p]) &&
          c.hidden.held.every((r, p) => r[1]! + r[2]! === held[p]![0]! && r[3]! + r[4]! === held[p]![1]!) &&
          [...c.hidden.knownDown].sort().join() === [...down].sort().join(),
      );
      expect(inSupport).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(400);
  });

  it('draws worlds in the proportions of the exact posterior', () => {
    const random = rng(23);
    let pooled = 0, df = 0, tested = 0;
    for (const d of decisions(400, 'worlds-exact', random)) {
      const facts = gatherFacts(d.state, d.seat, ((d.seat + 2) % 4) as Seat, d.belief, d.view);
      const unplaced = facts.unknownOrigin.flat(2).length + facts.knownOrigin.flat(2).length;
      if (unplaced < 4 || unplaced > 6 || !d.belief.hiddenLog.some((e) => e.kind !== 'hide') || random() > 0.2) continue;
      const exact = enumerate(d.belief.hiddenLog, facts);
      if (!exact || exact.size < 3) continue;
      const total = [...exact.values()].reduce((a, b) => a + b, 0);
      const model = worldModel(d.state, d.seat, d.belief, d.view);
      const samples = 3000;
      const seen = new Map<string, number>();
      for (let s = 0; s < samples; s++) {
        const key = sampledKey(d, facts, sampleWorld(model, d.state, d.belief, random));
        expect(exact.has(key)).toBe(true);
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      let accE = 0, accO = 0;
      for (const [k, c] of [...exact].sort((a, b) => a[1] - b[1])) {
        accE += (c / total) * samples;
        accO += seen.get(k) ?? 0;
        if (accE >= 5) {
          pooled += (accO - accE) ** 2 / accE;
          df++;
          accE = accO = 0;
        }
      }
      df--;
      if (++tested === 8) break;
    }
    expect(tested).toBe(8);
    // Exact sampling: the pooled chi-square is within a few standard deviations of its degrees of freedom.
    expect(Math.abs((pooled - df) / Math.sqrt(2 * df))).toBeLessThan(4);
  }, 120_000);
});

// -- An independent enumeration of the posterior: slots named, every history counted once. -------

const CH = ['count', 'fool', 'friar'] as const;
const IDS = ['count', 'fool', 'friar', 'mask'] as const;
const perms = <T,>(a: T[]): T[][] => (a.length <= 1 ? [a] : a.flatMap((v, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((r) => [v, ...r])));
type Slot = { pile: number; nc: boolean; fd: boolean };

function enumerate(log: HiddenEvent[], facts: Facts): Map<string, number> | null {
  const roles = revealRoles(log, facts);
  const unplaced = [...facts.unknownOrigin.flat(2), ...facts.knownOrigin.flat(2)];
  const out = new Map<string, number>();
  let work = 0;
  for (const sigma of perms([...IDS])) {
    const mask = sigma.indexOf('mask');
    const own = (card: CardId) => sigma.indexOf(CARDS[card].character as (typeof IDS)[number]);
    if ([...facts.origin].some(([card, p]) => p !== own(card) && p !== mask)) continue;
    const finish = (slots: Slot[], down: CardId[], tally: number[]) => {
      if (down.some((c) => !facts.opponentKnown.includes(c))) return;
      const hand = slots.filter((s) => !s.fd), fd = slots.filter((s) => s.fd);
      if (hand.length + facts.opponentKnown.length - down.length !== facts.handSize) return;
      if (fd.length + down.length !== facts.faceDownSlots.length) return;
      const targets = [
        ...hand.map((s) => ({ pile: s.pile, where: 'hand', nc: s.nc })),
        ...fd.map((s) => ({ pile: s.pile, where: 'fd', nc: s.nc })),
        ...[0, 1, 2, 3].flatMap((p) => Array.from({ length: facts.stillIn[p]! }, () => ({ pile: p, where: 'pile', nc: false }))),
      ];
      if (targets.length !== unplaced.length) return;
      for (const order of perms(targets.map((_, i) => i))) {
        if (++work > 5e6) return;
        const toMask = [...tally], toOwn = [0, 0, 0];
        const ok = unplaced.every((card, c) => {
          const t = targets[order[c]!]!;
          const known = facts.origin.get(card);
          if (known !== undefined ? t.pile !== known : t.pile !== own(card) && t.pile !== mask) return false;
          if ((t.nc && isCoinCard(card)) || (t.where === 'fd' && !CARDS[card].keep)) return false;
          if (known === undefined) (t.pile === mask ? toMask : toOwn)[CH.indexOf(CARDS[card].character as (typeof CH)[number])]! += 1;
          return true;
        });
        if (!ok) continue;
        const fits = CH.every((x, xi) => {
          const o = sigma.indexOf(x);
          return facts.dealtKnown[mask]![xi]! + toMask[xi]! === 3 && facts.dealtKnown[o]![xi]! + (facts.revealedUnknown[xi]! - tally[xi]!) + toOwn[xi]! === 9;
        });
        if (!fits) continue;
        const where = (w: string, p?: number) =>
          unplaced.filter((_, c) => targets[order[c]!]!.where === w && (p === undefined || targets[order[c]!]!.pile === p)).sort();
        const key = JSON.stringify({ sigma, piles: [0, 1, 2, 3].map((p) => where('pile', p)), inHand: where('hand'), faceDown: [...where('fd'), ...down].sort() });
        out.set(key, (out.get(key) ?? 0) + 1);
      }
    };
    const go = (i: number, slots: Slot[], down: CardId[], tally: number[]): void => {
      if (++work > 5e6) return;
      if (i === log.length) return finish(slots, down, tally);
      const e = log[i]!;
      if (e.kind === 'hide') return go(i + 1, [...slots, { pile: e.pile, nc: false, fd: false }], down, tally);
      if (e.kind === 'no-coins') return go(i + 1, slots.map((s) => (s.fd ? s : { ...s, nc: true })), down, tally);
      if (e.kind === 'face-down') {
        for (const k of e.known) if (!down.includes(k)) go(i + 1, slots, [...down, k], tally);
        slots.forEach((s, j) => !s.fd && go(i + 1, slots.map((t, m) => (m === j ? { ...t, fd: true } : t)), down, tally));
        return;
      }
      if (e.kind === 'turn-up' && down.includes(e.card)) return go(i + 1, slots, down.filter((c) => c !== e.card), tally);
      if (e.kind === 'turn-up' && log.some((f) => f.kind === 'face-down' && f.known.includes(e.card))) return;
      const role = roles.get(i)!;
      const known = facts.origin.get(e.card);
      const allowed = role.dealt ? (known !== undefined ? [known] : e.kind === 'reveal' && e.just !== null ? [e.just] : [own(e.card), mask]) : role.piles;
      slots.forEach((s, j) => {
        if (s.fd !== (e.kind === 'turn-up') || !allowed.includes(s.pile) || (s.nc && isCoinCard(e.card)) || (s.fd && !CARDS[e.card].keep)) return;
        const t = [...tally];
        if (role.dealt && known === undefined && s.pile === mask) t[CH.indexOf(CARDS[e.card].character as (typeof CH)[number])]! += 1;
        go(i + 1, slots.filter((_, m) => m !== j), down, t);
      });
    };
    go(0, [], [], [0, 0, 0]);
  }
  return work > 5e6 ? null : out;
}

function sampledKey(d: Decision, facts: Facts, world: GameState): string {
  const opp = ((d.seat + 2) % 4) as Seat;
  const unplaced = new Set([...facts.unknownOrigin.flat(2), ...facts.knownOrigin.flat(2)]);
  const sigma: string[] = [];
  const piles: CardId[][] = [[], [], [], []];
  for (let position = 0; position < 4; position++) {
    const p = d.belief.at[position]!;
    sigma[p] = world.pileAt[position as Seat]!;
    piles[p] = world.piles[world.pileAt[position as Seat]!].cards.map((c) => c.id).filter((c) => unplaced.has(c)).sort();
  }
  return JSON.stringify({
    sigma,
    piles,
    inHand: world.hands[opp]!.filter((c) => unplaced.has(c)).sort(),
    faceDown: facts.faceDownSlots.map(([s, i]) => world.keeps[s]![i]!.id).sort(),
  });
}
