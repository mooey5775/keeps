// Worlds judged by the engine alone.
//
// All of a round's chance is in its deal, and the engine is deterministic, so a world a player can't
// tell from the real one is exactly this: a deal and a choice for each of the opponent's hidden
// decisions that, replayed through the engine, give that player's own log, event for event. These
// tests use nothing else: no belief, no hidden log, no model of what can be hidden (every bug so far
// in sampling worlds was a gap in such a model).
//
//   1. Replaying a history is a sound judge: the true history replays to the player's log and the state.
//   2. The exact posterior, by brute force: at positions where few cards' places in the deal are unknown
//      to the player, every arrangement of them and every choice of the opponent's indistinguishable
//      moves is replayed; those reproducing the player's log are the posterior (each history equally
//      likely, as the shuffle and counting make them). The sampler's worlds must match it.
//   3. (The sampler rewrite's contract.) Every sampled world comes with its history, and the history
//      replays to the player's log and to that world.
import {
  apply,
  CARD_IDS,
  CARDS,
  eventsFor,
  legalCommands,
  newGame,
  viewFor,
  type CardId,
  type Command,
  type GameState,
  type PileId,
  type Seat,
  type TraceEvent,
} from '@keeps/engine';
import { describe, expect, it } from 'vitest';
import { Belief } from '../src/belief.ts';
import { sampleHistory, sampleWorld, worldModel } from '../src/worlds.ts';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A round as it was played: its deal (the state after dealing) and every command. */
interface Round {
  start: GameState;
  startEvents: TraceEvent[];
  commands: { seat: Seat; command: Command }[];
}

interface Position {
  round: Round;
  /** Commands played so far this round. */
  k: number;
  state: GameState;
  /** The game's events so far (the server's, secrets in full), and this round's (from its start). */
  events: TraceEvent[];
  roundEvents: TraceEvent[];
}

/** Cards whose plays hide things; the biased rounds favour them. */
const HARD = ['acquisition', 'invocation', 'joker', 'duplicity', 'resurrection', 'offering', 'pickpocket', 'pluck', 'legerdemain', 'epiphany', 'prayer', 'hocus-pocus', 'juggling', 'sanction'];

/**
 * Every position of random two-player rounds (`bias`: moves using HARD cards that many times likelier), in
 * games of two rounds: the second round's positions have a log that starts long before their round.
 */
function* positions(rounds: number, seed: string, random: () => number, bias = 1): Generator<Position> {
  for (let g = 0; g < rounds; g += 2) {
    const dealt = newGame({ players: 2, seed: `${seed}-${g}`, marksToWin: 2 }) as { state: GameState; events: TraceEvent[] };
    let round: Round = { start: dealt.state, startEvents: dealt.events.slice(dealt.events.findIndex((e) => e.payload.type === 'round-start')), commands: [] };
    let state = dealt.state;
    let events = dealt.events;
    let roundEvents = round.startEvents;
    for (;;) {
      if (state.phase === 'round-over') {
        if (state.round >= 2) break;
        const r = apply(state, 0, { type: 'next-round' });
        if (!r.ok) throw new Error(r.error.message);
        state = r.state;
        events = [...events, ...r.events];
        round = { start: state, startEvents: r.events.slice(r.events.findIndex((e) => e.payload.type === 'round-start')), commands: [] };
        roundEvents = round.startEvents;
        continue;
      }
      if (state.phase !== 'playing' && state.phase !== 'post-round') break;
      yield { round, k: round.commands.length, state, events, roundEvents };
      const seat = state.prompts[0]!.seat;
      const legal = legalCommands(state, seat).filter((c) => c.type !== 'next-round');
      const weight = (c: Command) => (HARD.some((card) => JSON.stringify(c).includes(`"${card}"`)) ? bias : 1);
      let u = random() * legal.reduce((a, c) => a + weight(c), 0);
      const command = legal.find((c) => (u -= weight(c)) < 0) ?? legal.at(-1)!;
      const r = apply(state, seat, command);
      if (!r.ok) throw new Error(r.error.message);
      round.commands.push({ seat, command });
      state = r.state;
      events = [...events, ...r.events];
      roundEvents = [...roundEvents, ...r.events];
    }
  }
}

/**
 * Events as a player compares them: the order of cards listed from a hand says nothing (with real cards,
 * a hand has no order; the engine keeps the order cards came in, and lists hands so).
 */
const canon = (e: TraceEvent) => {
  const p = e.payload;
  if (p.type === 'look-hands' && p.hands) return JSON.stringify({ ...p, hands: p.hands.map((h) => ({ ...h, cards: [...h.cards].sort() })) });
  if ((p.type === 'steal' && p.cards) || (p.type === 'discard' && p.from === 'hand')) return JSON.stringify({ ...p, cards: [...p.cards!].sort() });
  return JSON.stringify(p);
};
const same = (a: readonly TraceEvent[], b: readonly TraceEvent[]) => a.length === b.length && a.every((e, i) => canon(e) === canon(b[i]!));

/** Replays a history (a deal and the first `k` commands); null if a command doesn't apply. */
function replay(start: GameState, startEvents: TraceEvent[], commands: Round['commands'], k: number): { state: GameState; events: TraceEvent[] } | null {
  let state = start;
  let events = startEvents;
  for (const { seat, command } of commands.slice(0, k)) {
    const r = apply(state, seat, command);
    if (!r.ok) return null;
    state = r.state;
    events = [...events, ...r.events];
  }
  return { state, events };
}

/** What a player can't see of a state, by position (relative to nothing: seats and positions are absolute here). */
function hiddenKey(state: GameState, me: Seat): string {
  const opp = ((me + 2) % 4) as Seat;
  return JSON.stringify({
    hand: [...state.hands[opp]!].sort(),
    piles: [0, 1, 2, 3].map((p) => state.piles[state.pileAt[p as Seat]!].cards.map((c) => c.id)),
    faceDown: state.keeps.map((keep) => keep.filter((c) => c.faceDown).map((c) => c.id)),
  });
}

/** A deal the shuffle can make: each character's pile holds 9 of its cards, the Mask 3 of each. */
function validDeal(state: GameState): boolean {
  return (Object.keys(state.piles) as PileId[]).every((id) => {
    const cards = state.piles[id].cards.map((c) => CARDS[c.id].character);
    if (id === 'mask') return ['count', 'fool', 'friar'].every((x) => cards.filter((c) => c === x).length === 3);
    return cards.every((c) => c === id);
  });
}

/** Cards the player saw in a pile (drawn, taken, looked at, discarded from it, put on it): their places in the deal are known. */
function seenInPiles(myLog: readonly TraceEvent[]): Set<CardId> {
  const seen = new Set<CardId>();
  for (const e of myLog) {
    const p = e.payload;
    if ((p.type === 'draw' || p.type === 'take') && p.card && (p.type === 'draw' || p.from !== 'discard')) seen.add(p.card);
    if (p.type === 'look' && p.cards) for (const c of p.cards) seen.add(c);
    if (p.type === 'discard' && p.from === 'pile') for (const c of p.cards) seen.add(c);
    if (p.type === 'place-on-pile') seen.add(p.card);
    if (p.type === 'pile-reorder' && p.order) for (const c of p.order) seen.add(c);
  }
  return seen;
}

/** The opponent moved cards within piles where the player couldn't see (a hidden reorder, a take from any position): places in the deal no longer follow from the public record. */
function hiddenPileMoves(myLog: readonly TraceEvent[], me: Seat): boolean {
  const opp = ((me + 2) % 4) as Seat;
  return myLog.some((e) => {
    const p = e.payload;
    return (p.type === 'pile-reorder' && p.seat === opp && !p.order) || (p.type === 'play' && p.seat === opp && (p.card === 'requisition' || p.copy === 'requisition'));
  });
}

function* permutations<T>(items: T[]): Generator<T[]> {
  if (items.length <= 1) {
    yield [...items];
    return;
  }
  for (let i = 0; i < items.length; i++) for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) yield [items[i]!, ...rest];
}

/** Where each card of the deal is: [pile, index]. */
function places(state: GameState): Map<CardId, [PileId, number]> {
  const out = new Map<CardId, [PileId, number]>();
  for (const id of Object.keys(state.piles) as PileId[]) state.piles[id].cards.forEach((c, i) => out.set(c.id, [id, i]));
  return out;
}

/**
 * Whether `world` is possible for `me` at this position: a history (a deal, and the opponent's moves
 * `me` can't tell apart from the real ones) that replays to `me`'s log and ends in `world`'s hidden
 * state. The deal: the places `me` saw keep their cards; places still in a pile and never seen get the
 * world's pile cards there (the real round says which deal place each pile position holds); the places
 * whose cards left their pile unseen get every arrangement of the remaining cards. Null when there are
 * too many of those to try.
 */
function possible(pos: Position, me: Seat, world: GameState, maxUnseen: number): boolean | null {
  const { round, k } = pos;
  const myLog = eventsFor(pos.roundEvents, me);
  const seen = seenInPiles(myLog);
  // Which pile is which is the world's: piles move only in public, so the physical pile now at a
  // position is the one the real round has there, under the world's identity.
  const identity = new Map<PileId, PileId>([0, 1, 2, 3].map((p) => [pos.state.pileAt[p as Seat]!, world.pileAt[p as Seat]!]));
  const deal = structuredClone(round.start);
  deal.pileAt = round.start.pileAt.map((id) => identity.get(id)!) as GameState['pileAt'];
  deal.piles = Object.fromEntries(
    (Object.keys(round.start.piles) as PileId[]).map((id) => [identity.get(id)!, { ...structuredClone(round.start.piles[id]), id: identity.get(id)! }]),
  ) as GameState['piles'];
  const dealt = new Map([...places(round.start)].map(([card, [id, i]]) => [card, [identity.get(id)!, i] as [PileId, number]]));
  const set = ([id, i]: [PileId, number], card: CardId) => (deal.piles[id].cards[i] = { ...deal.piles[id].cards[i]!, id: card });
  const used = new Set<CardId>(seen);
  // Places still in a pile, never seen: the world's card at the same pile position.
  for (let position = 0; position < 4; position++) {
    const real = pos.state.piles[pos.state.pileAt[position as Seat]!].cards;
    const theirs = world.piles[world.pileAt[position as Seat]!].cards;
    if (real.length !== theirs.length) return false;
    real.forEach((c, i) => {
      if (seen.has(c.id) || !dealt.has(c.id)) return;
      set(dealt.get(c.id)!, theirs[i]!.id);
      used.add(theirs[i]!.id);
    });
  }
  // Places whose cards left their pile unseen: every arrangement of the cards not yet placed.
  const stillInPiles = new Set(Object.values(pos.state.piles).flatMap((pile) => pile.cards.map((c) => c.id)));
  const unseenPlaces = [...dealt].filter(([card]) => !seen.has(card) && !stillInPiles.has(card)).map(([, place]) => place);
  const rest = CARD_IDS.filter((c) => !used.has(c));
  if (rest.length !== unseenPlaces.length) return false;
  if (unseenPlaces.length > maxUnseen) return null;
  const want = hiddenKey(world, me);
  const startSeen = eventsFor(round.startEvents, me).length;
  for (const arrangement of permutations(rest)) {
    unseenPlaces.forEach((place, j) => set(place, arrangement[j]!));
    if (!validDeal(deal)) continue;
    let found = false;
    const go = (state: GameState, j: number, cursor: number) => {
      if (found) return;
      if (j === k) {
        if (cursor === myLog.length && hiddenKey(state, me) === want) found = true;
        return;
      }
      const { seat, command } = round.commands[j]!;
      for (const c of seat === me ? [command] : legalCommands(state, seat)) {
        const r = apply(state, seat, c);
        if (!r.ok) continue;
        const seenNow = eventsFor(r.events, me);
        if (same(seenNow, myLog.slice(cursor, cursor + seenNow.length))) go(r.state, j + 1, cursor + seenNow.length);
      }
    };
    go(structuredClone(deal), 0, startSeen);
    if (found) return true;
  }
  return false;
}

describe('worlds, judged by replaying the engine', () => {
  it("replaying a round's true history gives each player's log and the state, exactly", () => {
    const random = rng(5);
    let checked = 0;
    for (const pos of positions(30, 'replay-truth', random, 4)) {
      const r = replay(pos.round.start, pos.round.startEvents, pos.round.commands, pos.k)!;
      expect(JSON.stringify(r.state)).toBe(JSON.stringify(pos.state));
      for (const me of [0, 2] as Seat[]) expect(same(eventsFor(r.events, me), eventsFor(pos.roundEvents, me))).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(1000);
  });

  // Not yet (2026-10-25: 18 of 4,935 worlds impossible). The sampler ignores two things the player saw:
  // Duplicity doing nothing ("no other Keep card in hand": no Keep card in their hand), and the order of a
  // hand Pluck shows (the engine keeps hands in the order cards came, so it tells which draw was which).
  it('every sampled world is possible: some history replays to the player\'s log and ends in it', () => {
    const random = rng(7);
    const report = new Map<string, number>();
    const examples: string[] = [];
    let tested = 0;
    let impossible = 0;
    // The real world is possible (the test's own sanity), and every sampled one must be.
    for (const [seed, bias] of [['possible-random', 1], ['possible-hard', 6]] as const) {
      for (const pos of positions(40, seed, random, bias)) {
        for (const me of [0, 2] as Seat[]) {
          const myLog = eventsFor(pos.events, me);
          if (hiddenPileMoves(eventsFor(pos.roundEvents, me), me) || random() > 0.35) continue;
          const truth = possible(pos, me, pos.state, 6);
          if (truth === null) continue;
          expect(truth, `the real world, turn ${pos.state.turnNumber}`).toBe(true);
          const view = viewFor(pos.state, me);
          const belief = new Belief(me, { sound: true });
          belief.update(myLog).observe(view);
          const model = worldModel(pos.state, me, belief, view, myLog);
          for (let s = 0; s < 3; s++) {
            const world = sampleWorld(model, random);
            const ok = possible(pos, me, world, 6);
            tested++;
            const kind = pos.state.prompts.find((p) => p.seat !== me)?.kind ?? 'the player deciding';
            report.set(kind, (report.get(kind) ?? 0) + 1);
            if (!ok) {
              impossible++;
              if (examples.length < 5) examples.push(`turn ${pos.state.turnNumber}, seat ${me} watching (${kind}): ${hiddenKey(world, me).slice(0, 200)}`);
            }
          }
        }
      }
    }
    console.log(`${tested} sampled worlds checked (${[...report].map(([k, n]) => `${k} ${n}`).join(', ')}); impossible: ${impossible}\n${examples.join('\n')}`);
    expect(tested).toBeGreaterThan(300);
    expect(impossible).toBe(0);
  }, 900_000);

  it("every sampled world comes with a history that replays to the player's log, and to that world", () => {
    const random = rng(9);
    let checked = 0;
    for (const pos of positions(30, 'histories', random, 4)) {
      for (const me of [0, 2] as Seat[]) {
        if (random() > 0.3) continue;
        const myLog = eventsFor(pos.events, me);
        const view = viewFor(pos.state, me);
        const belief = new Belief(me, { sound: true }).update(myLog).observe(view);
        const model = worldModel(pos.state, me, belief, view, myLog);
        const opp = ((me + 2) % 4) as Seat;
        for (let s = 0; s < 2; s++) {
          const h = sampleHistory(model, random);
          // Replayed independently: the player's log, the opponent's own log, and the world (but its fresh chance, and the ids the engine gives prompts).
          let state = h.start;
          let events: TraceEvent[] = [];
          for (const { seat, command, rng: chance } of h.commands) {
            const r = apply(chance ? { ...state, rng: chance } : state, seat, command);
            expect(r.ok, JSON.stringify(command)).toBe(true);
            if (!r.ok) break;
            state = r.state;
            events = [...events, ...r.events];
          }
          const mine = eventsFor(events, me);
          const theirs = eventsFor(events, opp);
          expect(same(mine, myLog.slice(myLog.length - mine.length))).toBe(true);
          expect(h.logs[opp]!.slice(h.logs[opp]!.length - theirs.length).map(canon)).toEqual(theirs.map(canon));
          expect(hiddenKey(state, me)).toBe(hiddenKey(h.world, me));
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  }, 600_000);

  it('sampled histories follow the exact posterior, enumerated through the engine', () => {
    // Small positions: few cards left the piles unseen. Each history (an assignment of cards to those
    // places, and the opponent's moves the player can't tell apart) is replayed; the places never taken
    // are counted, not replayed (nothing reads them): for each σ, the ways to fill them as the shuffle can.
    // The sampler's (σ, opponent's hand, their face-down cards) must come in the posterior's proportions.
    const random = rng(31);
    let pooled = 0;
    let df = 0;
    let tested = 0;
    for (const pos of positions(300, 'posterior', random, 3)) {
      if (tested === 25) break;
      for (const me of [0, 2] as Seat[]) {
        if (random() > 0.15 || tested === 25) continue;
        const exact = posterior(pos, me);
        if (!exact || exact.size < 3) continue;
        const total = [...exact.values()].reduce((a, b) => a + b, 0);
        const myLog = eventsFor(pos.events, me);
        const view = viewFor(pos.state, me);
        const belief = new Belief(me, { sound: true }).update(myLog).observe(view);
        const model = worldModel(pos.state, me, belief, view, myLog);
        const samples = 4000;
        const seen = new Map<string, number>();
        for (let s = 0; s < samples; s++) {
          const key = historyKey(sampleHistory(model, random), me);
          expect(exact.has(key), key).toBe(true);
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
        tested++;
      }
    }
    expect(tested).toBe(25);
    console.log(`posterior: ${tested} positions, chi-square ${pooled.toFixed(1)} on ${df} degrees of freedom`);
    expect(Math.abs((pooled - df) / Math.sqrt(2 * df))).toBeLessThan(4);
  }, 1_800_000);
});

// -- The exact posterior, through the engine ---------------------------------------------------------

const CHARACTERS = ['count', 'fool', 'friar'] as const;
type PhysicalPlace = [number, number];

/** What the posterior is over: σ (by physical pile), the opponent's hand, the cards they hid face down. */
function key(sigma: readonly string[], state: GameState, opp: Seat): string {
  const down = state.keeps.flatMap((keep) => keep.filter((c) => c.faceDown?.placedBy === opp).map((c) => c.id)).sort();
  return JSON.stringify({ sigma, hand: [...state.hands[opp]!].sort(), down });
}

function historyKey(h: ReturnType<typeof sampleHistory>, me: Seat): string {
  return key([0, 1, 2, 3].map((p) => h.start.pileAt[p as Seat]), h.world, ((me + 2) % 4) as Seat);
}

/**
 * The exact posterior over (σ, the opponent's hand and face-down cards) for `me` at `pos`, each history
 * counted once (null when the position is out of reach: hidden pile moves, a random steal from the
 * opponent's hand, or more than 3 places left unseen).
 */
function posterior(pos: Position, me: Seat): Map<string, number> | null {
  const { round, k } = pos;
  const opp = ((me + 2) % 4) as Seat;
  const myLog = eventsFor(pos.roundEvents, me);
  if (hiddenPileMoves(myLog, me)) return null;
  if (myLog.some((e) => e.payload.type === 'steal' && e.payload.from === opp && e.payload.count === 1)) return null;
  const seen = seenInPiles(myLog);
  // A face-up pile's top (Revelation) is in the view, not the log.
  const view = viewFor(pos.state, me);
  for (const pile of view.piles) if (pile.top) seen.add(pile.top);
  // Physical piles are the deal's positions; places by [pile, index].
  const dealt = new Map<CardId, PhysicalPlace>();
  for (let p = 0; p < 4; p++) round.start.piles[round.start.pileAt[p as Seat]!].cards.forEach((c, i) => dealt.set(c.id, [p, i]));
  // Which dealt cards each command took from the piles (first time out only).
  const out = new Set<CardId>();
  const takes: CardId[][] = [];
  const befores: GameState[] = [];
  let state = round.start;
  const inPiles = (s: GameState) => new Set(Object.values(s.piles).flatMap((pile) => pile.cards.map((c) => c.id)));
  for (const { seat, command } of round.commands.slice(0, k)) {
    befores.push(state);
    const before = inPiles(state);
    const r = apply(state, seat, command);
    if (!r.ok) throw new Error(r.error.message);
    const after = inPiles(r.state);
    takes.push([...before].filter((c) => !after.has(c) && !out.has(c)));
    for (const c of before) if (!after.has(c)) out.add(c);
    state = r.state;
  }
  const unseen = new Set([...out].filter((c) => !seen.has(c)));
  if (unseen.size < 2 || unseen.size > 3) return null;
  const pinned = new Map([...dealt].filter(([c]) => seen.has(c)));
  const untouched = [0, 1, 2, 3].map((p) => [...dealt].filter(([c, [q]]) => q === p && !seen.has(c) && !out.has(c)).length);
  const pool = CARD_IDS.filter((c) => !seen.has(c));
  const startSeen = eventsFor(round.startEvents, me).length;
  const result = new Map<string, number>();
  let work = 0;
  const leaf = (s: GameState, bound: Map<CardId, PhysicalPlace>) => {
    // Every σ, with the ways to fill the places never taken.
    const known = [...pinned, ...bound];
    const left = new Set(pool.filter((c) => ![...bound.keys()].includes(c)));
    for (const sigma of permutations(['count', 'fool', 'friar', 'mask'])) {
      const mask = sigma.indexOf('mask');
      const count = [0, 1, 2, 3].map(() => [0, 0, 0]);
      let ok = true;
      for (const [c, [p]] of known) {
        const x = CHARACTERS.indexOf(CARDS[c].character as (typeof CHARACTERS)[number]);
        if (p !== mask && sigma[p] !== CARDS[c].character) ok = false;
        count[p]![x]! += 1;
      }
      if (!ok) continue;
      let ways = 1;
      for (let x = 0; x < 3 && ways > 0; x++) {
        const own = sigma.indexOf(CHARACTERS[x]!);
        const needMask = 3 - count[mask]![x]!;
        const rest = [...left].filter((c) => CARDS[c].character === CHARACTERS[x]).length;
        if (needMask < 0 || rest !== needMask + (9 - count[own]![x]!) || 9 - count[own]![x]! !== untouched[own]!) ways = 0;
        else ways *= choose(rest, needMask);
      }
      if (ways === 0 || untouched[mask] !== [0, 1, 2].reduce((a, x) => a + 3 - count[mask]![x]!, 0)) continue;
      for (const u of untouched) ways *= factorial(u);
      const sigmaIds = sigma.map((id) => id as PileId);
      const kk = key(sigmaIds, s, opp);
      result.set(kk, (result.get(kk) ?? 0) + ways);
    }
  };
  const go = (s: GameState, j: number, cursor: number, bound: Map<CardId, PhysicalPlace>, wanted: CardId[]) => {
    if (++work > 3e5) return;
    if (wanted.length > 0) {
      // A place about to be taken unseen: each card it could hold. Piles move only in public here, so the
      // place is where the real round has it now; the card swaps in from wherever it waits in a pile
      // (neither has been read yet, so this is the same as dealing them so).
      const [real, ...rest] = wanted;
      const [id, index] = where(befores[j]!, real!)!;
      for (const c of pool) {
        if (bound.has(c)) continue;
        const t = structuredClone(s);
        const at = where(t, c);
        if (!at) continue;
        const here = t.piles[id].cards[index]!;
        const there = t.piles[at[0]].cards[at[1]]!;
        [here.id, there.id] = [c, here.id];
        go(t, j, cursor, new Map([...bound, [c, dealt.get(real!)!]]), rest);
      }
      return;
    }
    if (j === k) {
      if (cursor === myLog.length) leaf(s, bound);
      return;
    }
    const { seat, command } = round.commands[j]!;
    const next = (t: GameState, events: TraceEvent[]) => {
      const mine = eventsFor(events, me);
      if (same(mine, myLog.slice(cursor, cursor + mine.length))) go(t, j + 1, cursor + mine.length, bound, j + 1 < k ? takes[j + 1]!.filter((c) => unseen.has(c)) : []);
    };
    for (const c of seat === me ? [command] : legalCommands(s, seat)) {
      const r = apply(s, seat, c, { trusted: true });
      if (r.ok) next(r.state, r.events);
    }
  };
  go(structuredClone(round.start), 0, startSeen, new Map(), takes[0]!.filter((c) => unseen.has(c)));
  return work > 3e5 ? null : result;
}

/** Where a card is in the piles: [pile id, index], or null. */
function where(state: GameState, card: CardId): [PileId, number] | null {
  for (const id of Object.keys(state.piles) as PileId[]) {
    const i = state.piles[id].cards.findIndex((c) => c.id === card);
    if (i >= 0) return [id, i];
  }
  return null;
}

const FACTORIALS = [1];
function factorial(n: number): number {
  while (FACTORIALS.length <= n) FACTORIALS.push(FACTORIALS[FACTORIALS.length - 1]! * FACTORIALS.length);
  return FACTORIALS[n]!;
}

function choose(n: number, k: number): number {
  return k < 0 || k > n ? 0 : factorial(n) / (factorial(k) * factorial(n - k));
}
