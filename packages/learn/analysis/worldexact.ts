// Exactness test for worlds.ts: on positions small enough to enumerate, compare the sampler's
// distribution with the posterior enumerated independently (named slots, every history once).
//   node worldexact.ts <positions> <samples> <seed>
import {
  apply, CARDS, eventsFor, isCoinCard, legalCommands, newGame, viewFor,
  type CardId, type GameState, type PlayerView, type Seat, type TraceEvent,
} from '../../engine/src/index.ts';
import { Belief, type HiddenEvent } from '@keeps/bot';
import { gatherFacts, revealRoles, sampleWorld, worldModel, type Facts } from '@keeps/bot';

const wanted = Number(process.argv[2] ?? 20), samples = Number(process.argv[3] ?? 4000), seed = process.argv[4] ?? 'ex';
let x = 99991;
const random = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;
const CH = ['count', 'fool', 'friar'] as const;
const IDS = ['count', 'fool', 'friar', 'mask'] as const;
const perms = <T,>(a: T[]): T[][] => (a.length <= 1 ? [a] : a.flatMap((v, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((r) => [v, ...r])));
const SIGMAS = perms([...IDS]);

interface Position { state: GameState; seat: Seat; belief: Belief; view: PlayerView; facts: Facts }

// --- collect small positions from random play ---
const positions: Position[] = [];
for (let g = 0; positions.length < wanted && g < 5000; g++) {
  let { state, events } = newGame({ players: 2, seed: `${seed}-${g}`, marksToWin: 1 }) as { state: GameState; events: TraceEvent[] };
  const bs = new Map<Seat, { belief: Belief; read: number; log: TraceEvent[] }>(([0, 2] as Seat[]).map((s) => [s, { belief: new Belief(s, { sound: true }), read: 0, log: [] }]));
  let taken = 0;
  while ((state.phase === 'playing' || state.phase === 'post-round') && taken < 2) {
    const seat = state.prompts[0]!.seat;
    const b = bs.get(seat)!;
    b.log.push(...eventsFor(events.slice(b.read), seat));
    b.read = events.length;
    const view = viewFor(state, seat);
    b.belief.update(b.log).observe(view);
    const facts = gatherFacts(state, seat, ((seat + 2) % 4) as Seat, b.belief, view);
    const unplaced = facts.unknownOrigin.flat(2).length + facts.knownOrigin.flat(2).length;
    const interesting = b.belief.hiddenLog.some((e) => e.kind !== 'hide');
    if (unplaced >= 4 && unplaced <= Number(process.env.MAX_UNPLACED ?? 6) && interesting && random() < 0.3) {
      positions.push({ state, seat, belief: b.belief.clone(), view, facts });
      taken++;
    }
    const legal = legalCommands(state, seat).filter((c) => c.type !== 'next-round');
    const r = apply(state, seat, legal[Math.floor(random() * legal.length)]!);
    if (!r.ok) throw new Error(r.error.message);
    state = r.state;
    events = [...events, ...r.events];
  }
}

// --- independent enumeration ---
type Slot = { pile: number; nc: boolean; fd: boolean };
function enumerate(pos: Position): Map<string, number> | null {
  const { facts, belief } = pos;
  const log = belief.hiddenLog;
  const roles = revealRoles(log, facts);
  const unplaced = [...facts.unknownOrigin.flat(2), ...facts.knownOrigin.flat(2)];
  const out = new Map<string, number>();
  let work = 0;
  for (const sigma of SIGMAS) {
    const mask = sigma.indexOf('mask');
    const own = (card: CardId) => sigma.indexOf(CARDS[card].character as (typeof IDS)[number]);
    if ([...facts.origin].some(([card, p]) => p !== own(card) && p !== mask)) continue;
    // Paths through the hidden log, slots named.
    const go = (i: number, slots: Slot[], down: CardId[], tally: number[]): void => {
      if (++work > 5e6) throw new Error('too big');
      if (i === log.length) return finish(slots, down, tally);
      const e: HiddenEvent = log[i]!;
      if (e.kind === 'hide') return go(i + 1, [...slots, { pile: e.pile, nc: false, fd: false }], down, tally);
      if (e.kind === 'no-coins') return go(i + 1, slots.map((s) => (s.fd ? s : { ...s, nc: true })), down, tally);
      if (e.kind === 'face-down') {
        for (const k of e.known) if (!down.includes(k)) go(i + 1, slots, [...down, k], tally);
        slots.forEach((s, j) => { if (!s.fd) go(i + 1, slots.map((t, m) => (m === j ? { ...t, fd: true } : t)), down, tally); });
        return;
      }
      // reveal / turn-up
      if (e.kind === 'turn-up' && down.includes(e.card)) return go(i + 1, slots, down.filter((c) => c !== e.card), tally);
      if (e.kind === 'turn-up' && log.some((f) => f.kind === 'face-down' && f.known.includes(e.card))) return;
      const role = roles.get(i)!;
      const coin = isCoinCard(e.card), keep = CARDS[e.card].keep;
      const known = facts.origin.get(e.card);
      const allowed = role.dealt
        ? known !== undefined ? [known] : e.kind === 'reveal' && e.just !== null ? [e.just] : [own(e.card), mask]
        : role.piles;
      slots.forEach((s, j) => {
        if (s.fd !== (e.kind === 'turn-up') || !allowed.includes(s.pile)) return;
        if (s.nc && coin) return;
        if (s.fd && !keep) return;
        const t = [...tally];
        if (role.dealt && known === undefined && s.pile === mask) t[CH.indexOf(CARDS[e.card].character as (typeof CH)[number])]! += 1;
        go(i + 1, slots.filter((_, m) => m !== j), down, t);
      });
    };
    const finish = (slots: Slot[], down: CardId[], tally: number[]) => {
      if (down.some((c) => !facts.opponentKnown.includes(c))) return;
      const hand = slots.filter((s) => !s.fd), fd = slots.filter((s) => s.fd);
      if (hand.length + facts.opponentKnown.length - down.length !== facts.handSize) return;
      if (fd.length + down.length !== facts.faceDownSlots.length) return;
      // Targets, named: hand slots, face-down slots, each pile's places.
      const targets: { pile: number; where: 'hand' | 'fd' | 'pile'; nc: boolean }[] = [
        ...hand.map((s) => ({ pile: s.pile, where: 'hand' as const, nc: s.nc })),
        ...fd.map((s) => ({ pile: s.pile, where: 'fd' as const, nc: s.nc })),
        ...[0, 1, 2, 3].flatMap((p) => Array.from({ length: facts.stillIn[p]! }, () => ({ pile: p, where: 'pile' as const, nc: false }))),
      ];
      if (targets.length !== unplaced.length) return;
      for (const order of perms(targets.map((_, i) => i))) {
        if (++work > 5e6) throw new Error('too big');
        let ok = true;
        const toMask = [...tally], toOwn = [0, 0, 0];
        for (let c = 0; c < unplaced.length && ok; c++) {
          const card = unplaced[c]!, t = targets[order[c]!]!;
          const known = facts.origin.get(card);
          if (known !== undefined ? t.pile !== known : t.pile !== own(card) && t.pile !== mask) ok = false;
          if (t.nc && isCoinCard(card)) ok = false;
          if (t.where === 'fd' && !CARDS[card].keep) ok = false;
          if (ok && known === undefined) (t.pile === mask ? toMask : toOwn)[CH.indexOf(CARDS[card].character as (typeof CH)[number])]! += 1;
        }
        if (!ok) continue;
        // The deal: each character's Mask share is 3, its own pile's 9.
        const fits = CH.every((_, xi) => {
          const o = sigma.indexOf(CH[xi]!);
          return facts.dealtKnown[mask]![xi]! + toMask[xi]! === 3 && facts.dealtKnown[o]![xi]! + (facts.revealedUnknown[xi]! - tally[xi]!) + toOwn[xi]! === 9;
        });
        if (!fits) continue;
        const piles = [0, 1, 2, 3].map((p) => unplaced.filter((_, c) => targets[order[c]!]!.where === 'pile' && targets[order[c]!]!.pile === p).sort());
        const inHand = unplaced.filter((_, c) => targets[order[c]!]!.where === 'hand').sort();
        const faceDown = [...unplaced.filter((_, c) => targets[order[c]!]!.where === 'fd'), ...down].sort();
        const key = JSON.stringify({ sigma, piles, inHand, faceDown });
        out.set(key, (out.get(key) ?? 0) + 1);
      }
    };
    go(0, [], [], [0, 0, 0]);
  }
  return out;
}

function sampledKey(pos: Position, world: GameState): string {
  const { facts, belief, seat } = pos;
  const opp = ((seat + 2) % 4) as Seat;
  const unplaced = new Set([...facts.unknownOrigin.flat(2), ...facts.knownOrigin.flat(2)]);
  const sigma: string[] = [];
  const piles: CardId[][] = [[], [], [], []];
  for (let position = 0; position < 4; position++) {
    const p = belief.at[position]!;
    sigma[p] = world.pileAt[position as Seat]!;
    piles[p] = world.piles[world.pileAt[position as Seat]!].cards.map((c) => c.id).filter((c) => unplaced.has(c)).sort();
  }
  const inHand = world.hands[opp]!.filter((c) => unplaced.has(c)).sort();
  const faceDown = facts.faceDownSlots.map(([s, i]) => world.keeps[s]![i]!.id).sort();
  return JSON.stringify({ sigma, piles, inHand, faceDown });
}

let tested = 0, skipped = 0, worst = 0;
const pooled = { chi: 0, df: 0 };
const tvs: number[] = [];
for (const [n, pos] of positions.entries()) {
  let exact: Map<string, number> | null;
  try {
    exact = enumerate(pos);
  } catch {
    skipped++;
    continue;
  }
  if (!exact || exact.size === 0) {
    console.log(`position ${n}: enumeration found no world`);
    continue;
  }
  if (exact.size < Number(process.env.MIN_WORLDS ?? 1)) continue;
  const total = [...exact.values()].reduce((a, b) => a + b, 0);
  const model = worldModel(pos.state, pos.seat, pos.belief, pos.view);
  const seen = new Map<string, number>();
  for (let s = 0; s < samples; s++) {
    const k = sampledKey(pos, sampleWorld(model, pos.state, pos.belief, random));
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const outside = [...seen.keys()].filter((k) => !exact!.has(k)).length;
  // Total variation, and a chi-square over the exact support (bins merged until expected >= 5).
  let tv = 0;
  for (const k of new Set([...exact.keys(), ...seen.keys()])) tv += Math.abs((exact.get(k) ?? 0) / total - (seen.get(k) ?? 0) / samples);
  tv /= 2;
  let chi = 0, df = -1, accE = 0, accO = 0;
  for (const [k, c] of [...exact].sort((a, b) => a[1] - b[1])) {
    accE += (c / total) * samples;
    accO += seen.get(k) ?? 0;
    if (accE >= 5) {
      chi += (accO - accE) ** 2 / accE;
      df++;
      accE = 0;
      accO = 0;
    }
  }
  // Expected TV from sampling noise alone is about sqrt(support / (2π·samples)).
  const z = df > 0 ? (chi - df) / Math.sqrt(2 * df) : 0;
  worst = Math.max(worst, z);
  pooled.chi += chi;
  pooled.df += Math.max(0, df);
  tvs.push(tv);
  tested++;
  console.log(`position ${n}: ${exact.size} worlds (${total} histories), log ${pos.belief.hiddenLog.length}; sampler outside support ${outside}; TV ${tv.toFixed(3)}; chi² ${chi.toFixed(1)} on ${df} df (z ${z.toFixed(2)})`);
}
console.log(`tested ${tested}, skipped (too big to enumerate) ${skipped}; worst chi-square z ${worst.toFixed(2)}; pooled chi² ${pooled.chi.toFixed(1)} on ${pooled.df} df (z ${((pooled.chi - pooled.df) / Math.sqrt(2 * pooled.df)).toFixed(2)})`);
