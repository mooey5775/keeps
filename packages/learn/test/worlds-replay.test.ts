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
import { sampleWorld, worldModel } from '../src/worlds.ts';

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
  /** Commands played so far. */
  k: number;
  state: GameState;
  /** The round's events so far (the server's, secrets in full). */
  events: TraceEvent[];
}

/** Cards whose plays hide things; the biased rounds favour them. */
const HARD = ['acquisition', 'invocation', 'joker', 'duplicity', 'resurrection', 'offering', 'pickpocket', 'pluck', 'legerdemain', 'epiphany', 'prayer', 'hocus-pocus', 'juggling', 'sanction'];

/** Every position of random two-player rounds (`bias`: moves using HARD cards that many times likelier). */
function* positions(rounds: number, seed: string, random: () => number, bias = 1): Generator<Position> {
  for (let g = 0; g < rounds; g++) {
    const dealt = newGame({ players: 2, seed: `${seed}-${g}`, marksToWin: 1 }) as { state: GameState; events: TraceEvent[] };
    const round: Round = { start: dealt.state, startEvents: dealt.events, commands: [] };
    let state = dealt.state;
    let events = dealt.events;
    while (state.phase === 'playing' || state.phase === 'post-round') {
      yield { round, k: round.commands.length, state, events };
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
    }
  }
}

const same = (a: readonly TraceEvent[], b: readonly TraceEvent[]) => a.length === b.length && a.every((e, i) => JSON.stringify(e.payload) === JSON.stringify(b[i]!.payload));

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
  const myLog = eventsFor(pos.events, me);
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
      for (const me of [0, 2] as Seat[]) expect(same(eventsFor(r.events, me), eventsFor(pos.events, me))).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(1000);
  });

  // Not yet (2026-10-25: 18 of 4,935 worlds impossible). The sampler ignores two things the player saw:
  // Duplicity doing nothing ("no other Keep card in hand": no Keep card in their hand), and the order of a
  // hand Pluck shows (the engine keeps hands in the order cards came, so it tells which draw was which).
  it.fails('every sampled world is possible: some history replays to the player\'s log and ends in it', () => {
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
          if (hiddenPileMoves(myLog, me) || random() > 0.35) continue;
          const truth = possible(pos, me, pos.state, 6);
          if (truth === null) continue;
          expect(truth, `the real world, turn ${pos.state.turnNumber}`).toBe(true);
          const view = viewFor(pos.state, me);
          const belief = new Belief(me, { sound: true });
          belief.update(myLog).observe(view);
          const model = worldModel(pos.state, me, belief, view);
          for (let s = 0; s < 3; s++) {
            const world = sampleWorld(model, pos.state, belief, random);
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

  // The rewrite's contract: worlds as whole histories. `sampleHistory` (to come) returns the deal and the
  // opponent's hidden choices; replaying them must give the player's log and the world it samples, and the
  // opponent's own log is then the replay's. Its distribution must match the posterior above, now over
  // histories (what the opponent knows), not only what the player can't see.
  it.todo('every sampled world comes with a history that replays to the player\'s log and to that world');
  it.todo("sampled histories (the opponent's own log included) follow the exact posterior over histories");
});
