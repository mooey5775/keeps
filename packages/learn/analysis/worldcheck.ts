// Soundness harness for worlds.ts: random-move self-play; at every decision, for the decider:
// the model builds, sampled worlds pass the engine's invariants and look exactly like the real
// game to the decider, and the truth is in the model's support (σ, hidden counts by origin and
// place, known face-down cards, Mask tallies).
//   node worldcheck.ts <rounds> <seed>
import {
  apply, checkInvariants, eventsFor, legalCommands, newGame, viewFor, CARDS,
  type CardId, type GameState, type Seat, type TraceEvent,
} from '../../engine/src/index.ts';
import { Belief } from '@keeps/bot';
import { sampleWorld, worldModel } from '@keeps/bot';

const rounds = Number(process.argv[2] ?? 50);
const seed = process.argv[3] ?? 'wc';
let x = 12345;
const random = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;
const counts = { decisions: 0, built: 0, worlds: 0, invariant: 0, viewMismatch: 0, truthMissing: 0, threw: 0 };
const failures = new Map<string, number>();
const fail = (why: string) => failures.set(why, (failures.get(why) ?? 0) + 1);

for (let g = 0; g < rounds; g++) {
  let { state, events } = newGame({ players: 2, seed: `${seed}-${g}`, marksToWin: 1 }) as { state: GameState; events: TraceEvent[] };
  const initial = state;
  // True identity of the pile dealt to each position.
  const beliefs = new Map<Seat, { belief: Belief; read: number; log: TraceEvent[] }>(
    ([0, 2] as Seat[]).map((s) => [s, { belief: new Belief(s, { sound: true }), read: 0, log: [] }]),
  );
  while (state.phase === 'playing' || state.phase === 'post-round') {
    const seat = state.prompts[0]!.seat;
    const b = beliefs.get(seat)!;
    b.log.push(...eventsFor(events.slice(b.read), seat));
    b.read = events.length;
    const view = viewFor(state, seat);
    b.belief.update(b.log).observe(view);
    counts.decisions++;
    try {
      const model = worldModel(state, seat, b.belief, view);
      counts.built++;
      for (let k = 0; k < 2; k++) {
        const world = sampleWorld(model, state, b.belief, random);
        counts.worlds++;
        const problems = checkInvariants(world);
        if (problems.length) {
          counts.invariant++;
          fail(`invariant: ${problems[0]!.replace(/\d+/g, 'N')}`);
        }
        if (JSON.stringify(viewFor(world, seat)) !== JSON.stringify(view)) {
          counts.viewMismatch++;
          const a = viewFor(world, seat) as unknown as Record<string, unknown>, v = view as unknown as Record<string, unknown>;
          fail(`view differs in: ${Object.keys(v).filter((key) => JSON.stringify(a[key]) !== JSON.stringify(v[key])).join(',')}`);
        }
      }
      // The truth in the support: σ, hidden counts by origin (hand vs face-down), known face-down cards, Mask tallies.
      const opp = ((seat + 2) % 4) as Seat;
      const sigma = [0, 1, 2, 3].map((p) => {
        // Physical pile p was dealt to position p (pile-placed events come in position order).
        return initial.pileAt[p as Seat];
      });
      const trueOrigin = new Map<CardId, number>();
      for (let p = 0; p < 4; p++) for (const c of initial.piles[sigma[p]!].cards) trueOrigin.set(c.id, p);
      const known = new Set(b.belief.opponentKnown);
      const held = [0, 1, 2, 3].map(() => [0, 0]);
      for (const card of state.hands[opp]!) if (!known.has(card)) held[trueOrigin.get(card)!]![0]! += 1;
      const knownDown: CardId[] = [];
      for (const keep of view.keeps) keep.cards.forEach((c, i) => {
        if (!c.faceDown || c.id) return;
        const card = state.keeps[keep.seat]![i]!.id;
        if (known.has(card)) knownDown.push(card);
        else held[trueOrigin.get(card)!]![1]! += 1;
      });
      const toMask = [0, 0, 0];
      const maskPile = sigma.indexOf('mask');
      // Cards out of their hidden cards for the first time, dealt where they were taken from (not a placed Blunder).
      const outBefore = new Set<CardId>();
      let lastHide: { pile: number; placed: CardId[] } | null = null;
      for (const e of b.belief.hiddenLog) {
        if (e.kind === 'hide') { lastHide = e; continue; }
        if (e.kind !== 'reveal' && e.kind !== 'turn-up') continue;
        const placedRedraw = e.kind === 'reveal' && e.just !== null && lastHide?.pile === e.just && lastHide.placed.includes(e.card);
        const first = !outBefore.has(e.card);
        outBefore.add(e.card);
        if (!first || placedRedraw || b.belief.origin.has(e.card)) continue;
        if (e.kind === 'turn-up' && b.belief.hiddenLog.some((f) => f.kind === 'face-down' && f.known.includes(e.card))) continue;
        if (trueOrigin.get(e.card) === maskPile) toMask[['count', 'fool', 'friar'].indexOf(CARDS[e.card].character)]! += 1;
      }
      const match = model.classes.some((c) =>
        c.sigma.every((id, p) => id === sigma[p]) &&
        c.hidden.held.every((r, p) => r[1]! + r[2]! === held[p]![0]! && r[3]! + r[4]! === held[p]![1]!) &&
        [...c.hidden.knownDown].sort().join() === [...knownDown].sort().join() &&
        c.hidden.toMask.every((v, i) => v === toMask[i]));
      if (!match) {
        counts.truthMissing++;
        const sigmaOk = model.classes.some((c) => c.sigma.every((id, p) => id === sigma[p]));
        fail(sigmaOk ? 'truth missing (σ present)' : 'truth missing (true σ excluded)');
        const forSigma = model.classes.filter((c) => c.sigma.every((id, p) => id === sigma[p]));
        const seen = new Set(forSigma.map((c) => JSON.stringify({ held: c.hidden.held.map((r) => [r[1]! + r[2]!, r[3]! + r[4]!]), down: c.hidden.knownDown, toMask: c.hidden.toMask })));
        console.log(`MISSING round ${seed}-${g} turn ${state.turnNumber} seat ${seat}: truth ${JSON.stringify({ held, down: knownDown, toMask })}; model has ${[...seen].slice(0, 4).join(' | ')}; log ${JSON.stringify(b.belief.hiddenLog.map((e) => (e.kind === 'hide' ? `h${e.pile}${e.placed.length ? '[' + e.placed + ']' : ''}` : e.kind === 'reveal' ? `r:${e.card}${e.just !== null ? '@' + e.just : ''}` : e.kind === 'turn-up' ? `t:${e.card}` : e.kind === 'face-down' ? `fd[${e.known}]` : 'nc')))}`);
      }
    } catch (error) {
      counts.threw++;
      fail(`threw: ${String((error as Error).message).slice(0, 900)}`);
    }
    const legal = legalCommands(state, seat).filter((c) => c.type !== 'next-round');
    const r = apply(state, seat, legal[Math.floor(random() * legal.length)]!);
    if (!r.ok) throw new Error(r.error.message);
    state = r.state;
    events = [...events, ...r.events];
  }
}
console.log(JSON.stringify(counts));
for (const [why, n] of [...failures].sort((a, b) => b[1] - a[1])) console.log(`  ${n}× ${why}`);
