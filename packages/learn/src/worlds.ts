import {
  apply,
  CARD_IDS,
  CARDS,
  eventsFor,
  isCoinCard,
  legalCommands,
  viewFor,
  type CardId,
  type Command,
  type GameState,
  type PileId,
  type PlayerView,
  type Seat,
  type TraceEvent,
} from '@keeps/engine';
import { isObserved, noteObservation, observes, type Belief, type HiddenEvent, type PileOp } from './belief.ts';

// Whole histories a player can't tell from the real one, sampled exactly from the chance-only posterior.
//
// All of a round's chance is in its deal (and in which card Legerdemain steals: the card is played face up,
// so every world sees the same one, each equally likely), and the engine is deterministic. So a history
// is a deal and a choice for each of the opponent's decisions the player couldn't see (which card Duplicity
// hid, where Requisition took from, the order Tithes left), and it is possible exactly when, replayed through
// the engine, it gives the player's own log, event for event. The posterior: every possible history equally
// likely, as the shuffle makes deals; the opponent's choices carry no weight (card counting, not opponent
// modelling). A history gives the world and the opponent's own log of it: what they know in that world.
// (Hands have no order with real cards; the engine keeps the order cards came in and lists hands so, in
// Pluck's look, Pickpocket's steal, Offering's discard. Logs and views are compared without that order.)
//
// Proposal and judge. A counting model proposes histories, and the engine accepts or turns each down:
// rejection from a proposal that is exact over a superset of the possible histories is exact, and what the
// model misses costs only a retry (about 1 plan in 30, in random games).
//
// The counting model (belief.ts explains the physical piles):
//   - the four physical piles' identities σ: Count, Fool, Friar, Mask, one each;
//   - the deal: a character's pile gets 9 of its 12 cards, the Mask 3 of each character;
//   - since then, every card the player can't place is either still in the pile it was dealt
//     into (at a position they don't know), or one of the opponent's hidden cards: those came
//     one by one from piles the opponent was seen taking from (Belief.hiddenLog), and some have
//     come out again (played, shown, given) without saying which they were.
// Its constraints: a card hidden face down is a Keep card; none of the cards hidden when our Pickpocket
// came up empty-handed or took every Coin card is a Coin card; a HOT card is never held (played the moment
// it's taken: a HOT card that comes out is the last one taken), except a Keep card they just drew unseen
// that waits for them to choose its keep (HOT, or any Keep card under Invocation). Cards matter to these
// only through their character, and whether they're Coin, Keep and HOT cards, so histories are counted by kind:
//   1. for each σ, a pass over the hidden log counts the ways each state of the opponent's hidden cards
//      (by pile of origin and constraint, and how many of the cards that came out of them were dealt into
//      the Mask) arises, event by event: each card that came out was one of the hidden cards then held
//      that it can be, each of them a different past card;
//   2. for each end state, exact counting of the ways to complete the deal: which unplaced cards were dealt
//      into the Mask (each character's Mask share is fixed by σ), then, pile by pile, which of the cards
//      dealt there are still there and which are hidden where.
// A history is drawn (samplePlan): a class in proportion to its count; the hidden log back from its end,
// each step in proportion to the ways it arises; forward again, which hidden card each step moved,
// uniformly among those it could be; the cards; the piles now. The deal follows by unwinding where each
// pile place went (rebuildDeal, from Belief.pileOps); the replay (replayPlan) takes, at each step, the
// command whose events are the log's next ones and whose hidden effects are the plan's.

type Character = 'count' | 'fool' | 'friar';
const CHARACTERS: Character[] = ['count', 'fool', 'friar'];
type Identity = Character | 'mask';
const IDENTITIES: Identity[] = ['count', 'fool', 'friar', 'mask'];
const ASSIGNMENTS: Identity[][] = permutations(IDENTITIES); // assignment[p] = identity of physical pile p

/**
 * A card's kind, as the constraints see it: bit 0 Coin card, bit 1 Keep card, bit 2 HOT. Blunder, a
 * HOT Keep card that goes straight into its owner's keep, counts as HOT without Keep: it is never
 * held, hidden face down or left waiting for a keep.
 */
const kindOf = (card: CardId) => (isCoinCard(card) ? 1 : 0) | (CARDS[card].keep && card !== 'blunder' ? 2 : 0) | (CARDS[card].hot ? 4 : 0);
const KINDS = [0, 1, 2, 3, 4, 5, 6, 7];
/**
 * Where a card dealt into a pile is now: 0 still in the pile; 1 the opponent's hand; 2 their hand,
 * hidden when they held no Coin cards; 3 face down where they hid it; 4 face down, hidden when they
 * held no Coin cards; 5 in their hand, the HOT Keep card they just drew, waiting for its keep; 6 the
 * same, drawn by Invocation (any Keep card). Hidden cells as indices into a pile's counts: 1..6.
 */
const CELLS = [0, 1, 2, 3, 4, 5, 6];
const accepts = (cell: number, kind: number) => {
  if (cell === 0) return true;
  if (cell === 5) return (kind & 6) === 6;
  if (cell === 6) return (kind & 2) !== 0;
  if (kind & 4) return false;
  return (cell !== 2 && cell !== 4 ? true : (kind & 1) === 0) && (cell < 3 ? true : (kind & 2) !== 0);
};

/** The opponent's hidden cards at a point of the hidden log, for one σ. */
interface HiddenState {
  /** [physical pile][cell 1..6]: hidden cards dealt into that pile, by where they are (index 0 unused). */
  held: number[][];
  /** Keep cards we knew they held that are now the face-down card(s) they hid. */
  knownDown: CardId[];
  /** Of the cards that came out of their hidden cards with unknown origin, per character: how many were dealt into the Mask. */
  toMask: number[];
}

interface WorldClass {
  sigma: Identity[];
  hidden: HiddenState;
  split: number[][];
  weight: number;
  pileCounts: number[][];
  caps: number[][];
  /** The hidden log's states for this σ, event by event (for drawing the history back). */
  layers: Map<string, { s: HiddenState; w: number }>[];
}

export interface WorldModel {
  me: Seat;
  opponent: Seat;
  /** Each completion class: a σ, a hidden end state and a Mask split, with its number of worlds. */
  classes: WorldClass[];
  total: number;
  /** Facts the worlds are built from. */
  facts: Facts;
  /** The player's log this round (from its round-start; `roundAt` in the whole log), and the state now. */
  log: TraceEvent[];
  roundAt: number;
  state: GameState;
  belief: Belief;
  /** The round's start, to replay from (built once). */
  start?: { state: GameState; events: TraceEvent[] };
  /** The command that worked at each step of the replay last time (tried first). */
  tried: Map<number, string>;
  /** Plans drawn and why each was turned down (see sampleHistory). */
  stats: { plans: number; accepted: number; rejected: Map<string, number> };
}

export interface Facts {
  /** Cards the player can place for certain. */
  located: Set<CardId>;
  /** Cards dealt into a known physical pile, by card. */
  origin: Map<CardId, number>;
  /** Unplaced cards, by character (index in CHARACTERS) and kind, with unknown origin. */
  unknownOrigin: CardId[][][];
  /** Unplaced cards with known origin, by physical pile and kind. */
  knownOrigin: CardId[][][];
  /** Physical pile p: unplaced cards still in it (size minus the cards known to be in it). */
  stillIn: number[];
  /** Cards of each character known to have been dealt into each physical pile. */
  dealtKnown: number[][];
  /** Cards of each character that came out of the opponent's hidden cards with unknown origin. */
  revealedUnknown: number[];
  /** Opponent's hand: known cards in it (possibly hidden face down since), and its size. */
  opponentKnown: CardId[];
  handSize: number;
  /** Keep slots holding a face-down card the player can't see: [seat, index]. */
  faceDownSlots: [Seat, number][];
  /** The opponent's last hidden card, drawn unseen, waits for its keep: the cell it's in (5 HOT Keep card, 6 any Keep card), or null. */
  waiting: 5 | 6 | null;
  /** The kind bits that can matter (see gatherFacts). */
  kindMask: number;
  /** The opponent's hidden-card history the worlds follow (the belief's, and what an open prompt shows). */
  hiddenLog: HiddenEvent[];
}

/** Everything needed to draw worlds for `me` now. Throws if the facts contradict each other (a bug). */
export function worldModel(state: GameState, me: Seat, belief: Belief, view: PlayerView, myLog: readonly TraceEvent[]): WorldModel {
  const opponent = ((me + 2) % 4) as Seat;
  const facts = gatherFacts(state, me, opponent, belief, view);
  const classes: WorldModel['classes'] = [];
  for (const sigma of ASSIGNMENTS) {
    const own = CHARACTERS.map((x) => sigma.indexOf(x));
    const mask = sigma.indexOf('mask');
    // Known origins must fit σ: a character's cards come from its pile or the Mask.
    const dealt = facts.dealtKnown;
    if (CHARACTERS.some((_, x) => dealt.some((row, p) => row[x]! > 0 && p !== own[x] && p !== mask))) continue;
    const layers = hiddenLayers(facts.hiddenLog, sigma, facts);
    for (const { s: hidden, w: ways } of layers.at(-1)!.values()) {
      if (!fitsView(hidden, facts)) continue;
      for (const { split, ways: splitWays, pileCounts } of maskSplits(sigma, hidden, facts)) {
        const caps = [0, 1, 2, 3].map((p) => [facts.stillIn[p]!, ...hidden.held[p]!.slice(1)]);
        let weight = ways * splitWays;
        for (let p = 0; p < 4 && weight > 0; p++) weight *= countPile(pileCounts[p]!, caps[p]!);
        if (weight > 0) classes.push({ sigma, hidden, split, weight, pileCounts, caps, layers });
      }
    }
  }
  const total = classes.reduce((a, c) => a + c.weight, 0);
  if (!(total > 0)) throw new Error(`no world is consistent with what the player knows: ${diagnose(facts)}`);
  const roundAt = myLog.findLastIndex((e) => e.payload.type === 'round-start');
  return {
    me,
    opponent,
    classes,
    total,
    facts,
    log: myLog.slice(roundAt),
    roundAt,
    state,
    belief,
    tried: new Map(),
    stats: { plans: 0, accepted: 0, rejected: new Map() },
  };
}

/** A world with the history that leads to it: replayed from the round's start, event for event the player's log. */
export interface History {
  world: GameState;
  /** The round's start (the deal in it) and every command since; `rng`: chance as it stood (Legerdemain's steal), if set. */
  start: GameState;
  commands: { seat: Seat; command: Command; rng?: GameState['rng'] }[];
  /** What each player has seen this round, from its round-start: the opponent's own log, in this world. */
  logs: Record<number, TraceEvent[]>;
}

/** One world, drawn exactly from the model (see sampleHistory). */
export function sampleWorld(model: WorldModel, random: () => number): GameState {
  return sampleHistory(model, random).world;
}

/**
 * A whole history, drawn exactly from the posterior: every history (a deal, and a choice for each of the
 * opponent's hidden decisions) that replays to the player's log equally likely, as the shuffle makes deals
 * (the opponent's choices carry no weight: card counting, not opponent modelling).
 *
 * The counting model above proposes: a class in proportion to its count, then the hidden log drawn back
 * event by event in proportion to the ways each step arises, which of the opponent's hidden cards each
 * step moved (uniformly, among those it could be), the cards themselves, and the deal rebuilt from where
 * the pile places went. Every history the model counts is drawn equally likely, and the real ones are
 * among them: the model knows less than the engine (it ignores what a Duplicity that did nothing says, or
 * the order a revealed hand is in), never more. The engine then decides: the history is replayed, and
 * kept only if it gives the player's log exactly and ends where the player sees the game now. Rejection
 * from an exact proposal over a superset is exact, and whatever the model misses costs only a retry.
 */
export function sampleHistory(model: WorldModel, random: () => number): History {
  // A position the proposal can't reach is a bug: give up quickly (callers fall back to the network alone).
  const deadline = Date.now() + 3000;
  for (let attempt = 0; attempt < 20000 && (attempt % 64 !== 0 || Date.now() < deadline); attempt++) {
    model.stats.plans++;
    const result = tryHistory(model, random);
    if (typeof result !== 'string') {
      model.stats.accepted++;
      return result;
    }
    model.stats.rejected.set(result, (model.stats.rejected.get(result) ?? 0) + 1);
  }
  throw new Error(`no history replays to the player's log: ${JSON.stringify([...model.stats.rejected])}`);
}

/** A history drawn from the proposal and replayed, or why it was turned down. */
function tryHistory(model: WorldModel, random: () => number): History | string {
  const plan = samplePlan(model, random);
  const deal = rebuildDeal(plan, model.belief.pileOps, random);
  if (typeof deal === 'string') return deal;
  return replayPlan(model, plan, deal, random);
}

/** What a history must do that the player didn't see: the opponent's hidden cards and the piles now. */
interface Plan {
  sigma: Identity[];
  /** By hidden-log index: the card a hide took, the card a face-down hid. */
  cards: Map<number, CardId>;
  /** Physical pile → its cards now, top first. */
  piles: CardId[][];
}

/** A plan drawn from the counting model: each history it counts equally likely. */
function samplePlan(model: WorldModel, random: () => number): Plan {
  const { facts } = model;
  const log = facts.hiddenLog;
  // 1. A class, in proportion to its worlds.
  let u = random() * model.total;
  let chosen = model.classes[model.classes.length - 1]!;
  for (const c of model.classes) {
    if (u < c.weight) {
      chosen = c;
      break;
    }
    u -= c.weight;
  }
  const { sigma, layers } = chosen;
  // 2. The hidden log, drawn back from its end state: each step in proportion to the ways it arises.
  const context: LogContext = { log, sigma, facts, reveals: revealRoles(log, facts), taken: justTaken(log) };
  const labels: Label[] = [];
  let at = chosen.hidden;
  for (let i = log.length - 1; i >= 0; i--) {
    const target = keyOf(at);
    const options: { s: HiddenState; w: number; label: Label }[] = [];
    let total = 0;
    for (const { s, w } of layers[i]!.values()) {
      for (const { t, m, label } of steps(s, i, context)) {
        if (keyOf(t) !== target) continue;
        options.push({ s, w: w * m, label });
        total += w * m;
      }
    }
    let v = random() * total;
    let pick = options[options.length - 1]!;
    for (const o of options) {
      if (v < o.w) {
        pick = o;
        break;
      }
      v -= o.w;
    }
    labels[i] = pick.label;
    at = pick.s;
  }
  // 3. Forward again: which hidden card each step moved, uniformly among those in its cell (a hidden card is
  // named by the index of the hide that took it).
  const tokens = [0, 1, 2, 3].map(() => CELLS.map(() => [] as number[]));
  const take = (p: number, cell: number) => tokens[p]![cell]!.splice(Math.floor(random() * tokens[p]![cell]!.length), 1)[0]!;
  const cards = new Map<number, CardId>();
  const hidden = new Map<number, number>();
  log.forEach((e, i) => {
    const l = labels[i]!;
    if (l.kind === 'in' && l.cell < 0) return;
    if (l.kind === 'out' && l.cell < 0) cards.set(context.taken.get(i)!, (e as { card: CardId }).card);
    else if (l.kind === 'in') tokens[l.p]![l.cell]!.push(i);
    else if (l.kind === 'none') {
      for (const row of tokens) row[2]!.push(...row[1]!.splice(0));
    } else if (l.kind === 'known') {
      if (e.kind === 'face-down') cards.set(i, l.card);
    } else if (l.kind === 'move') {
      const token = take(l.p, l.from);
      tokens[l.p]![l.to]!.push(token);
      hidden.set(i, token);
    } else {
      cards.set(take(l.p, l.cell), (e as { card: CardId }).card);
    }
  });
  // 4. The cards: which were dealt where, and where each is now; the hidden cards still held get theirs.
  const cells = completion(chosen, facts, random);
  for (let p = 0; p < 4; p++) {
    for (let cell = 1; cell < CELLS.length; cell++) {
      const here = tokens[p]![cell]!;
      const which = shuffled(cells[p]![cell]!, random);
      if (which.length !== here.length) throw new Error(`pile ${p} cell ${cell}: ${which.length} cards for ${here.length} hidden cards`);
      here.forEach((token, j) => cards.set(token, which[j]!));
    }
  }
  for (const [i, token] of hidden) cards.set(i, cards.get(token)!);
  // 5. The piles now: the places the player knows, and the rest in any order.
  const piles = [0, 1, 2, 3].map((p) => {
    const knowledge = model.belief.piles[p]!;
    const known = knowledge.slots;
    const placed = new Set(known.filter((c): c is CardId => c !== null));
    const free = shuffled([...[...knowledge.members].filter((c) => !placed.has(c)), ...cells[p]![0]!], random);
    let next = 0;
    const out = Array.from({ length: knowledge.size }, (_, i) => known[i] ?? free[next++]!);
    if (next !== free.length) throw new Error(`pile ${p}: ${free.length} cards for ${next} unknown positions`);
    return out;
  });
  return { sigma, cards, piles };
}

/** For a class: which unplaced cards were dealt into which pile, and where each is now (cells[pile][cell]). */
function completion(chosen: WorldClass, facts: Facts, random: () => number): CardId[][][] {
  const { sigma, split, caps } = chosen;
  const mask = sigma.indexOf('mask');
  // Which unknown-origin cards were dealt into the Mask (split[x][kind] of them), the rest into their own pile.
  const dealtInto: CardId[][][] = [0, 1, 2, 3].map((p) => KINDS.map((k) => [...facts.knownOrigin[p]![k]!]));
  CHARACTERS.forEach((x, xi) => {
    const own = sigma.indexOf(x);
    for (const k of KINDS) {
      const cards = shuffled(facts.unknownOrigin[xi]![k]!, random);
      const toMask = split[xi]![k]!;
      dealtInto[mask]![k]!.push(...cards.slice(0, toMask));
      dealtInto[own]![k]!.push(...cards.slice(toMask));
    }
  });
  // Pile by pile: where each of those cards is now, an allocation drawn in proportion to its ways.
  const cells: CardId[][][] = [0, 1, 2, 3].map(() => CELLS.map(() => []));
  for (let p = 0; p < 4; p++) {
    const a = KINDS.map((k) => dealtInto[p]![k]!.length);
    const m = sampleAllocation(a, caps[p]!, random);
    for (const k of KINDS) {
      const cards = shuffled(dealtInto[p]![k]!, random);
      let at = 0;
      for (const cell of CELLS) {
        cells[p]![cell]!.push(...cards.slice(at, at + m[k]![cell]!));
        at += m[k]![cell]!;
      }
    }
  }
  return cells;
}

/** A deal and the piles after each of the player's log events, rebuilt from a plan: or why there is none. */
interface Deal {
  /** Physical pile → its cards as dealt, top first. */
  piles: CardId[][];
  /** The piles (physical, top first) after each pile op (`at`: the log event it came from), in order. */
  snapshots: { at: number; piles: CardId[][] }[];
  /** The pile ops, in the same order. */
  ops: readonly PileOp[];
}

/**
 * Follows the pile places through what happened to them (Belief.pileOps): a card that left a pile was the
 * one the player saw, or the hidden card the plan says; the places still in a pile hold the plan's cards
 * now. The opponent's choices the player couldn't see are drawn uniformly, as the counting makes them: the
 * position Requisition took from, and the order Tithes left (resolved backward from what the places
 * held afterwards, uniformly among the orders that fit). Every place then has its card, the deal included.
 */
function rebuildDeal(plan: Plan, ops: readonly PileOp[], random: () => number): Deal | string {
  let next = 0;
  const dealt: number[][] = [[], [], [], []];
  const piles: number[][] = [[], [], [], []];
  const card = new Map<number, CardId>();
  const links: { before: number[]; after: number[] }[] = [];
  const history: { at: number; piles: number[][] }[] = [];
  const bind = (place: number, c: CardId) => {
    const had = card.get(place);
    if (had !== undefined && had !== c) return false;
    card.set(place, c);
    return true;
  };
  for (const op of ops) {
    const pile = piles[op.p]!;
    switch (op.op) {
      case 'deal':
        piles[op.p] = Array.from({ length: op.size }, () => next++);
        dealt[op.p] = [...piles[op.p]!];
        break;
      case 'pop': {
        const index = op.from === 'top' ? 0 : op.from === 'any' ? Math.floor(random() * pile.length) : op.from;
        if (index >= pile.length) return 'a card left a pile with no card there';
        const [place] = pile.splice(index, 1);
        const c = op.card ?? (op.hide !== null ? plan.cards.get(op.hide) : undefined);
        if (!c) throw new Error('a card left a pile unseen and unaccounted for');
        if (!bind(place!, c)) return 'pile place: two cards';
        break;
      }
      case 'push': {
        const place = next++;
        card.set(place, op.card);
        pile.unshift(place);
        break;
      }
      case 'look': {
        if (op.whole && op.cards.length !== pile.length) return 'a look at a whole pile of another size';
        for (let i = 0; i < op.cards.length; i++) if (!bind(pile[i]!, op.cards[i]!)) return 'pile place: seen as another card';
        break;
      }
      case 'reorder': {
        if (op.order) {
          const order = op.order.map((c) => pile.find((place) => card.get(place) === c));
          if (order.some((place) => place === undefined) || order.length !== pile.length) throw new Error('a reorder of cards the player did not see');
          piles[op.p] = order as number[];
        } else {
          const after = pile.map(() => next++);
          links.push({ before: [...pile], after: [...after] });
          piles[op.p] = after;
        }
        break;
      }
      case 'flip':
        pile.reverse();
        break;
    }
    history.push({ at: op.at, piles: piles.map((x) => [...x]) });
  }
  // The places in the piles now hold the plan's cards.
  for (let p = 0; p < 4; p++) {
    if (piles[p]!.length !== plan.piles[p]!.length) throw new Error(`pile ${p}: ${piles[p]!.length} places, ${plan.piles[p]!.length} cards`);
    for (let i = 0; i < piles[p]!.length; i++) if (!bind(piles[p]![i]!, plan.piles[p]![i]!)) return 'pile place now: another card';
  }
  // Hidden reorders, latest first: a place the player had seen goes where its card went; the others, uniformly.
  for (const { before, after } of links.reverse()) {
    const cards = after.map((place) => card.get(place));
    if (cards.some((c) => c === undefined)) throw new Error('a reordered place without a card');
    const left = new Set(cards as CardId[]);
    for (const place of before) {
      const c = card.get(place);
      if (c === undefined) continue;
      if (!left.delete(c)) return 'reorder: a card seen before is not there after';
    }
    const rest = shuffled([...left], random);
    let i = 0;
    for (const place of before) if (!card.has(place)) card.set(place, rest[i++]!);
  }
  const deal = dealt.map((places) => places.map((place) => card.get(place)!));
  if (deal.some((pile) => pile.some((c) => c === undefined))) throw new Error(`a dealt place without a card: ${JSON.stringify(deal.map((pile) => pile.map((c) => c ?? '?')))} now ${JSON.stringify(piles)} links ${JSON.stringify(links.map((l) => [l.before, l.before.map((x) => card.get(x) ?? "?"), l.after, l.after.map((x) => card.get(x) ?? "?")]))} ops ${JSON.stringify(ops.map((o) => [o.op, o.p, o.op === 'pop' ? o.from : o.op === 'deal' ? o.size : '', o.op === 'pop' ? (o.card ?? o.hide) : '']))}`);
  // The deal is one the shuffle makes, with this σ.
  const all = new Set(deal.flat());
  if (all.size !== CARD_IDS.length) return 'deal: a card twice';
  for (let p = 0; p < 4; p++) {
    const id = plan.sigma[p]!;
    const characters = deal[p]!.map((c) => CARDS[c].character);
    if (id === 'mask' ? CHARACTERS.some((x) => characters.filter((c) => c === x).length !== 3) : characters.some((c) => c !== id)) return 'deal: not one the shuffle makes';
  }
  return { piles: deal, ops, snapshots: history.map(({ at, piles }) => ({ at, piles: piles.map((x) => x.map((place) => card.get(place)!)) })) };
}

/**
 * An event as compared: the order of cards listed from a hand says nothing (the engine keeps hands in the order
 * cards came, and lists them so: Pluck's look, Pickpocket's steal, Offering's discard).
 */
function canonical(e: TraceEvent): string {
  const p = e.payload;
  if (p.type === 'look-hands' && p.hands) return JSON.stringify({ ...p, hands: p.hands.map((h) => ({ ...h, cards: [...h.cards].sort() })) });
  if ((p.type === 'steal' && p.cards) || (p.type === 'discard' && p.from === 'hand')) return JSON.stringify({ ...p, cards: [...p.cards!].sort() });
  return JSON.stringify(p);
}

/**
 * The view as compared: hands, and the options and commands listed from them, in any order (and the discard pile:
 * Offering discards a hand in the order it was drawn); prompts without their ids
 * (the engine numbers them by its event count, which counts events nobody sees; the world takes the real ids).
 */
export function canonicalView(view: PlayerView): string {
  const sorted = (v: unknown[]) => v.map((x) => JSON.stringify(x)).sort();
  return JSON.stringify(view, (k, v) =>
    k === 'id' || k === 'promptId' ? undefined : Array.isArray(v) && (k === 'options' || k === 'legal' || k === 'discard' || (k === 'cards' && v.every((x) => typeof x === 'string'))) ? sorted(v) : v,
  );
}

/** The round's start in a world: the real one's public state, dealt as `deal` says. */
function startOf(model: WorldModel): { state: GameState; events: TraceEvent[] } {
  if (model.start) return model.start;
  const t = structuredClone(model.state);
  const first = model.log[0]!.payload;
  if (first.type !== 'round-start') throw new Error("the player's log has no round start");
  t.phase = 'round-over';
  t.round -= 1;
  t.traceSeq = model.log[0]!.seq - 1;
  t.lastRoundWinner = first.startingSeat;
  const r = apply(t, model.me, { type: 'next-round' }, { trusted: true });
  if (!r.ok) throw new Error(r.error.message);
  r.state.lastRoundWinner = model.state.lastRoundWinner;
  const from = r.events.findIndex((e) => e.payload.type === 'round-start');
  model.start = { state: r.state, events: r.events.slice(from) };
  return model.start;
}

const seeded = (n: number) => ({ a: Math.imul(n + 1, 0x9e3779b1) >>> 0, b: Math.imul(n + 7, 0x85ebca6b) >>> 0, c: Math.imul(n + 13, 0xc2b2ae35) >>> 0, d: (n + 1) >>> 0 });

/**
 * Replays the round from the plan's deal, the player's log as the guide: at each step, the command (the
 * player's, or the opponent's) whose events are the log's next ones and whose hidden effects are the
 * plan's (the piles as rebuilt, the card hidden face down). Legerdemain's random steal takes the card the
 * log shows (each card is equally likely, in every world). Null if no command fits: a history the
 * proposal counted that the engine doesn't allow. What the player's log says they saw at their decisions
 * (its Observed entries: what was face up) the world must have shown them too; and the opponent's log in
 * the world notes what they saw at theirs, as BotPlayer's does.
 */
const strict = Boolean((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.WORLDS_STRICT);

function replayPlan(model: WorldModel, plan: Plan, deal: Deal, random: () => number): History | string {
  const { me, opponent, log } = model;
  const start = startOf(model);
  let state = structuredClone(start.state);
  state.piles = {} as GameState['piles'];
  for (let p = 0; p < 4; p++) {
    const id = plan.sigma[p] as PileId;
    state.piles[id] = { id, cards: deal.piles[p]!.map((c) => ({ id: c, faceUp: false })) };
    state.pileAt[p as Seat] = id;
  }
  state.rng = seeded(Math.floor(random() * 2 ** 31));
  const s0 = state;
  const events = [...start.events];
  const seen0 = eventsFor(start.events, me);
  let cursor = seen0.length;
  for (let i = 0; i < cursor; i++) if (canonical(seen0[i]!) !== canonical(log[i]!)) return 'round start';
  // The hidden cards the opponent put face down, by the log index of the event that showed it.
  const faceDown = new Map<number, CardId>();
  model.facts.hiddenLog.forEach((e, i) => {
    if (e.kind === 'face-down' && model.belief.hiddenAt[i] !== undefined) faceDown.set(model.belief.hiddenAt[i]! - model.roundAt, plan.cards.get(i)!);
  });
  // (Pile ops count events in the whole log; the replay, from the round's start.)
  let snap = -1;
  const pilesAt = (at: number) => {
    while (snap + 1 < deal.snapshots.length && deal.snapshots[snap + 1]!.at - model.roundAt < at) snap++;
    return snap >= 0 ? deal.snapshots[snap]!.piles : deal.piles;
  };
  const commands: History['commands'] = [];
  // Each player's log in the world: the player's own is theirs, observations included; the opponent's notes theirs.
  const mine: TraceEvent[] = [...seen0];
  const theirs = eventsFor(start.events, opponent);
  const fits = (seen: TraceEvent[]) => seen.length > 0 && cursor + seen.length <= log.length && seen.every((e, i) => canonical(e) === canonical(log[cursor + i]!));
  const consistent = (s: GameState, from: number, to: number) => {
    const before = snap;
    const piles = pilesAt(to);
    snap = before;
    for (let p = 0; p < 4; p++) {
      const cards = s.piles[plan.sigma[p] as PileId].cards;
      if (cards.length !== piles[p]!.length || cards.some((c, i) => c.id !== piles[p]![i])) return false;
    }
    for (const [at, c] of faceDown) {
      if (at < from || at >= to) continue;
      if (!s.keeps.some((keep) => keep.some((k) => k.id === c && k.faceDown?.placedBy === opponent))) return false;
    }
    return true;
  };
  while (cursor < log.length) {
    if (isObserved(log[cursor]!)) {
      if (!observes(log[cursor]!, viewFor(state, me), me)) return 'replay: the player saw otherwise';
      mine.push(log[cursor]!);
      cursor++;
      continue;
    }
    const step = commands.length;
    const candidates = [me, opponent].flatMap((seat) => legalCommands(state, seat).map((command) => ({ seat, command, key: JSON.stringify(command) })));
    // A reorder (Tithes) lists no commands, any order being legal: the order is the one the pile was left in.
    for (const prompt of state.prompts) {
      if (prompt.kind !== 'order-pile') continue;
      const p = plan.sigma.indexOf(state.pileAt[prompt.pile] as Identity);
      const k = deal.ops.findIndex((op) => op.op === 'reorder' && op.p === p && op.at - model.roundAt >= cursor);
      if (k < 0) continue;
      const command: Command = { type: 'answer', promptId: prompt.id, answer: { kind: 'order-pile', order: deal.snapshots[k]!.piles[p]! } };
      candidates.push({ seat: prompt.seat, command, key: JSON.stringify(command) });
    }
    const tried = model.tried.get(step);
    candidates.sort((a, b) => Number(b.key === tried) - Number(a.key === tried));
    let found: { seat: Seat; command: Command; key: string; state: GameState; events: TraceEvent[]; seen: number; rng?: GameState['rng'] } | null = null;
    for (const c of candidates) {
      let r = apply(state, c.seat, c.command, { trusted: true });
      if (!r.ok) continue;
      let seen = eventsFor(r.events, me);
      let rng: GameState['rng'] | undefined;
      if (!fits(seen)) {
        // Legerdemain: the random card must be the one the log shows.
        const j = seen.findIndex((e, i) => canonical(e) !== canonical(log[cursor + i] ?? e));
        const want = log[cursor + j]?.payload;
        if (j < 0 || seen[j]!.payload.type !== 'steal' || want?.type !== 'steal' || want.count !== 1) continue;
        let ok = false;
        // (Each try draws the card with chance 1/hand: 4,000 tries miss it with chance below 10^-150.)
        for (let n = 0; n < 4000 && !ok; n++) {
          rng = seeded(n * 7919 + step);
          const retry = apply({ ...state, rng }, c.seat, c.command, { trusted: true });
          if (!retry.ok) break;
          const again = eventsFor(retry.events, me);
          if (fits(again)) {
            r = retry;
            seen = again;
            ok = true;
          }
        }
        if (!ok) continue;
      }
      if (!consistent(r.state, cursor, cursor + seen.length)) continue;
      if (found) {
        // (Checking, WORLDS_STRICT: a second command that fits would be a history the count misses.)
        if (JSON.stringify(found.state) !== JSON.stringify(r.state)) throw new Error(`two commands fit: ${found.key} and ${c.key}`);
        continue;
      }
      found = { ...c, state: r.state, events: r.events, seen: seen.length, rng };
      if (!strict) break;
    }
    if (!found) return `replay: no command fits (${log[cursor]!.payload.type})`;
    model.tried.set(step, found.key);
    commands.push(found.rng ? { seat: found.seat, command: found.command, rng: found.rng } : { seat: found.seat, command: found.command });
    if (found.seat === opponent) noteObservation(theirs, viewFor(state, opponent), opponent);
    mine.push(...eventsFor(found.events, me));
    theirs.push(...eventsFor(found.events, opponent));
    events.push(...found.events);
    state = found.state;
    cursor += found.seen;
    pilesAt(cursor);
  }
  if (canonicalView(viewFor(state, me)) !== canonicalView(viewFor(model.state, me))) return 'replay: ends elsewhere';
  const real = model.state.prompts;
  if (state.prompts.length !== real.length) return 'replay: ends elsewhere';
  const world: GameState = {
    ...state,
    prompts: state.prompts.map((p, i) => ({ ...p, id: real[i]!.id, event: real[i]!.event })),
    traceSeq: model.state.traceSeq,
    rng: seeded(Math.floor(random() * 2 ** 31)),
  };
  return { world, start: s0, commands, logs: { [me]: mine, [opponent]: theirs } };
}

/** Where counting fails, for an error message: per σ that fits the known origins, the stage that leaves nothing. */
function diagnose(facts: Facts): string {
  const stages = { origins: 0, noEndState: 0, view: 0, composition: 0, piles: 0 };
  let example = '';
  for (const sigma of ASSIGNMENTS) {
    const own = CHARACTERS.map((x) => sigma.indexOf(x));
    const mask = sigma.indexOf('mask');
    if (CHARACTERS.some((_, x) => facts.dealtKnown.some((row, p) => row[x]! > 0 && p !== own[x] && p !== mask))) {
      stages.origins++;
      continue;
    }
    const ends = [...hiddenEndStates(facts.hiddenLog, sigma, facts).keys()];
    if (!ends.length) {
      stages.noEndState++;
      continue;
    }
    const fit = ends.filter((h) => fitsView(h, facts));
    if (!fit.length) {
      stages.view++;
      example ||= `end states ${JSON.stringify(ends.slice(0, 2).map((h) => ({ held: h.held, down: h.knownDown })))} vs hand ${facts.handSize} (known ${facts.opponentKnown.join('/')}), face-down ${facts.faceDownSlots.length}`;
      continue;
    }
    const splits = fit.flatMap((h) => maskSplits(sigma, h, facts).map((m) => ({ h, m })));
    if (!splits.length) {
      stages.composition++;
      example ||= `composition: dealtKnown ${JSON.stringify(facts.dealtKnown)} revealedUnknown ${facts.revealedUnknown} toMask ${JSON.stringify(fit.map((h) => h.toMask))} unknown ${facts.unknownOrigin.map((r) => r.map((c) => c.length).join('+')).join(',')}`;
      continue;
    }
    stages.piles++;
    const { h, m } = splits[0]!;
    example ||= `piles: counts ${JSON.stringify(m.pileCounts)} caps ${JSON.stringify([0, 1, 2, 3].map((p) => [facts.stillIn[p]!, ...h.held[p]!.slice(1)]))}`;
  }
  return `${JSON.stringify(stages)} log ${JSON.stringify(facts.hiddenLog.map((e) => (e.kind === 'hide' ? `h${e.pile}` : e.kind === 'reveal' ? `r:${e.card}${e.just !== null ? '@' + e.just : ''}` : e.kind === 'turn-up' ? `t:${e.card}` : e.kind === 'face-down' ? `fd[${e.known}]` : 'nc')))} ${example}`;
}

// -- Facts ------------------------------------------------------------------

/** The facts worlds are built from (exported for the tests' independent enumeration). */
export function gatherFacts(state: GameState, me: Seat, opponent: Seat, belief: Belief, view: PlayerView): Facts {
  // A Joker the opponent drew unseen and plays as if HOT (Invocation) waits in their hand for the card it
  // copies: that prompt shows it's the Joker, as plain as playing it would. It counts as come out of
  // their hidden cards, from the pile just taken from, and held again, known.
  let hiddenLog = belief.hiddenLog;
  const opponentKnown = new Set(belief.opponentKnown);
  const lastHidden = belief.hiddenLog.at(-1);
  const jokerShown =
    view.prompts.some((p) => p.seat === opponent && p.kind === 'joker-copy') && !opponentKnown.has('joker') && belief.waitingUnseen() !== null && lastHidden?.kind === 'hide';
  if (jokerShown) {
    hiddenLog = [...hiddenLog, { kind: 'reveal', card: 'joker', just: lastHidden.pile }];
    opponentKnown.add('joker');
  }
  const located = new Set<CardId>();
  for (const card of view.hands.find((h) => h.seat === me)!.cards ?? []) located.add(card);
  for (const keep of view.keeps) for (const c of keep.cards) if (c.id) located.add(c.id);
  for (const card of view.discard) located.add(card);
  for (const card of opponentKnown) located.add(card);
  const stillIn = [0, 0, 0, 0];
  for (let p = 0; p < 4; p++) {
    const pile = belief.piles[p]!;
    for (const card of pile.members) located.add(card);
    for (const card of pile.slots) if (card && !pile.members.has(card)) throw new Error(`pile ${p}: ${card} has a known position but isn't a member`);
    stillIn[p] = pile.size - pile.members.size;
    if (stillIn[p]! < 0) throw new Error(`pile ${p}: more members than cards`);
  }
  for (let position = 0; position < 4; position++) {
    const top = view.piles[position]!.top;
    if (top && !located.has(top)) throw new Error(`the top of the pile at ${position} (${top}) isn't in the belief`);
    const size = state.piles[state.pileAt[position as Seat]!].cards.length;
    if (size !== belief.piles[belief.at[position]!]!.size) throw new Error(`pile at ${position}: the belief has the wrong size`);
  }
  // Cards in limbo the player can't see would be a hidden place we don't model.
  const prompts = JSON.stringify(view.prompts);
  for (const c of state.limbo) if (!located.has(c.id) && !prompts.includes(`"${c.id}"`)) throw new Error(`unknown card in limbo`);
  for (const c of state.limbo) located.add(c.id);

  const origin = new Map(belief.origin);
  if (jokerShown && !origin.has('joker') && lastHidden?.kind === 'hide') origin.set('joker', lastHidden.pile);
  const dealtKnown = [0, 1, 2, 3].map(() => [0, 0, 0]);
  for (const [card, p] of origin) dealtKnown[p]![CHARACTERS.indexOf(CARDS[card].character as Character)]! += 1;
  // Cards that came out of the opponent's hidden cards without a known origin.
  const revealedUnknown = [0, 0, 0];
  const roles = revealRoles(hiddenLog, null as never);
  hiddenLog.forEach((e, i) => {
    if ((e.kind === 'reveal' || e.kind === 'turn-up') && roles.get(i)!.dealt && !origin.has(e.card) && !knownDownCandidate(hiddenLog, e)) {
      revealedUnknown[CHARACTERS.indexOf(CARDS[e.card].character as Character)]! += 1;
    }
  });
  // A card waiting for its keep in the opponent's hand: the one they just took unseen, or one we know.
  const unseen = view.prompts.some((p) => p.seat === opponent && p.kind === 'hot-target') ? belief.waitingUnseen() : null;
  const waiting = unseen === 'hot' ? 5 : unseen === 'any' ? 6 : null;
  if (waiting && belief.hiddenLog.at(-1)?.kind !== 'hide') throw new Error('a card waits for its keep, but the last hidden event is not a draw');
  // The kind bits that can matter now (the rest are merged, which counts the same worlds with fewer
  // classes): Coin only if they held no Coin cards at some point, Keep only with cards hidden face down
  // or waiting for a keep, HOT only if they hold or held hidden cards at all.
  const log = hiddenLog;
  const kindMask =
    (log.some((e) => e.kind === 'no-coins') ? 1 : 0) | (log.some((e) => e.kind === 'face-down') || waiting !== null ? 2 : 0) | (log.some((e) => e.kind === 'hide') ? 4 : 0);
  const unknownOrigin = CHARACTERS.map(() => KINDS.map(() => [] as CardId[]));
  const knownOrigin = [0, 1, 2, 3].map(() => KINDS.map(() => [] as CardId[]));
  for (const card of CARD_IDS) {
    if (located.has(card)) continue;
    const o = origin.get(card);
    if (o !== undefined) knownOrigin[o]![kindOf(card) & kindMask]!.push(card);
    else unknownOrigin[CHARACTERS.indexOf(CARDS[card].character as Character)]![kindOf(card) & kindMask]!.push(card);
  }
  const faceDownSlots: [Seat, number][] = [];
  for (const keep of view.keeps) keep.cards.forEach((c, index) => c.faceDown && !c.id && faceDownSlots.push([keep.seat, index]));
  return {
    located,
    origin,
    unknownOrigin,
    knownOrigin,
    stillIn,
    dealtKnown,
    revealedUnknown,
    opponentKnown: [...opponentKnown],
    handSize: view.hands.find((h) => h.seat === opponent)!.count,
    faceDownSlots,
    waiting,
    kindMask,
    hiddenLog,
  };
}

/**
 * What each card that came out of the opponent's hidden cards tells us about the deal. `dealt`: it
 * was a card dealt into the pile it was taken from (its first time out, and not a card put on that
 * pile), so its slot's pile is its pile of origin; otherwise it was a card put on a pile (Blunder)
 * or one already out once before, taken again unseen: its slot is from one of `piles`, and it
 * says nothing about the deal.
 */
export function revealRoles(log: HiddenEvent[], facts: Facts): Map<number, { dealt: boolean; piles: number[] }> {
  const roles = new Map<number, { dealt: boolean; piles: number[] }>();
  const out = new Set<CardId>();
  const taken = justTaken(log);
  const hides: Extract<HiddenEvent, { kind: 'hide' }>[] = [];
  log.forEach((e, i) => {
    if (e.kind === 'hide') {
      hides.push(e);
      return;
    }
    if (e.kind !== 'reveal' && e.kind !== 'turn-up') return;
    const just = taken.has(i) ? (log[taken.get(i)!] as Extract<HiddenEvent, { kind: 'hide' }>) : null;
    if (just && just.placed.includes(e.card)) roles.set(i, { dealt: false, piles: [just.pile] });
    else if (out.has(e.card)) {
      const piles = [...new Set(hides.filter((h) => h.placed.includes(e.card)).map((h) => h.pile))];
      roles.set(i, { dealt: false, piles });
    } else roles.set(i, { dealt: true, piles: [] });
    out.add(e.card);
  });
  void facts;
  return roles;
}

/** A turn-up of a card that may be a known Keep card hidden face down: its origin doesn't enter the deal's unknowns. */
function knownDownCandidate(log: HiddenEvent[], e: HiddenEvent): boolean {
  if (e.kind !== 'turn-up') return false;
  return log.some((f) => f.kind === 'face-down' && f.known.includes(e.card));
}

// -- The hidden log ---------------------------------------------------------

/** What a step of the hidden log did, for drawing the history back (see samplePlan). */
type Label =
  | { kind: 'in'; p: number; cell: number }
  | { kind: 'none' }
  | { kind: 'known'; card: CardId }
  | { kind: 'move'; p: number; from: number; to: number }
  | { kind: 'out'; p: number; cell: number };

const keyOf = (s: HiddenState) => JSON.stringify([s.held, [...s.knownDown].sort(), s.toMask]);
const copyState = (s: HiddenState): HiddenState => ({ held: s.held.map((r) => [...r]), knownDown: [...s.knownDown], toMask: [...s.toMask] });

interface LogContext {
  log: HiddenEvent[];
  sigma: Identity[];
  facts: Facts;
  reveals: Map<number, { dealt: boolean; piles: number[] }>;
  /** Cards played the moment they were taken: hide index ↔ reveal index (see justTaken). */
  taken: Map<number, number>;
}

/**
 * The cards played the moment they were taken (HOT, never held; or as if HOT: Invocation's draw), as
 * pairs hide ↔ reveal, both ways. Such a card is the last one taken (a Duplicity reveal may come between).
 */
function justTaken(log: HiddenEvent[]): Map<number, number> {
  const pairs = new Map<number, number>();
  let last = -1;
  log.forEach((e, i) => {
    if (e.kind === 'hide') last = i;
    else if (e.kind === 'reveal' && (e.just !== null || CARDS[e.card].hot) && last >= 0 && !pairs.has(last)) {
      pairs.set(last, i);
      pairs.set(i, last);
    }
  });
  return pairs;
}

/** The states event `i` can lead to from `s`, each with its number of ways and what it did. */
function steps(s: HiddenState, i: number, c: LogContext): { t: HiddenState; m: number; label: Label }[] {
  const { log, sigma, facts } = c;
  const e = log[i]!;
  const mask = sigma.indexOf('mask');
  const out: { t: HiddenState; m: number; label: Label }[] = [];
  switch (e.kind) {
    case 'hide': {
      // A card played the moment it was taken never joins the hidden cards (cell -1, for the label only).
      if (c.taken.has(i)) {
        out.push({ t: s, m: 1, label: { kind: 'in', p: e.pile, cell: -1 } });
        break;
      }
      const t = copyState(s);
      const cell = facts.waiting !== null && i === log.length - 1 ? facts.waiting : 1;
      t.held[e.pile]![cell]! += 1;
      out.push({ t, m: 1, label: { kind: 'in', p: e.pile, cell } });
      break;
    }
    case 'no-coins': {
      const t = copyState(s);
      for (const row of t.held) {
        row[2]! += row[1]!;
        row[1] = 0;
      }
      out.push({ t, m: 1, label: { kind: 'none' } });
      break;
    }
    case 'face-down': {
      for (const card of e.known) {
        if (s.knownDown.includes(card)) continue;
        const t = copyState(s);
        t.knownDown.push(card);
        out.push({ t, m: 1, label: { kind: 'known', card } });
      }
      for (let p = 0; p < 4; p++) {
        for (const [from, to] of [[1, 3], [2, 4]] as const) {
          const n = s.held[p]![from]!;
          if (n === 0) continue;
          const t = copyState(s);
          t.held[p]![from]! -= 1;
          t.held[p]![to]! += 1;
          out.push({ t, m: n, label: { kind: 'move', p, from, to } });
        }
      }
      break;
    }
    case 'reveal':
    case 'turn-up': {
      if (e.kind === 'turn-up' && s.knownDown.includes(e.card)) {
        // The known Keep card they hid.
        const t = copyState(s);
        t.knownDown = t.knownDown.filter((x) => x !== e.card);
        out.push({ t, m: 1, label: { kind: 'known', card: e.card } });
        break;
      }
      // A card we knew they held can't have been one of their unknown hidden cards.
      if (e.kind === 'turn-up' && knownDownCandidate(log, e)) break;
      const kind = kindOf(e.card) & facts.kindMask;
      const from = e.kind === 'reveal' ? [1, 2] : [3, 4];
      const role = c.reveals.get(i)!;
      const unknownOrigin = role.dealt && !facts.origin.has(e.card);
      const known = facts.origin.get(e.card);
      const just = e.kind === 'reveal' ? e.just : null;
      if (c.taken.has(i)) {
        // The card just taken (see 'hide'): from its pile, which must be one it could have been dealt into.
        const pile = (log[c.taken.get(i)!] as { pile: number }).pile;
        const fromPile = role.dealt ? (known !== undefined ? known === pile : sigma.indexOf(CARDS[e.card].character as Character) === pile || mask === pile) : role.piles.includes(pile);
        if (!fromPile) break;
        const t = copyState(s);
        if (unknownOrigin && pile === mask) t.toMask[CHARACTERS.indexOf(CARDS[e.card].character as Character)]! += 1;
        out.push({ t, m: 1, label: { kind: 'out', p: pile, cell: -1 } });
        break;
      }
      const piles = role.dealt ? (known !== undefined ? [known] : just !== null ? [just] : [sigma.indexOf(CARDS[e.card].character as Character), mask]) : role.piles;
      for (const p of piles) {
        for (const cell of from) {
          const n = s.held[p]![cell]!;
          // A HOT card is never held: one played the moment it was taken is handled above.
          if (n === 0 || !accepts(cell, kind)) continue;
          const t = copyState(s);
          t.held[p]![cell]! -= 1;
          if (unknownOrigin && p === mask) t.toMask[CHARACTERS.indexOf(CARDS[e.card].character as Character)]! += 1;
          out.push({ t, m: n, label: { kind: 'out', p, cell } });
        }
      }
      break;
    }
  }
  return out;
}

/** For one σ, the states of the opponent's hidden cards after each event of the hidden log, with the number of ways each arises. */
function hiddenLayers(log: HiddenEvent[], sigma: Identity[], facts: Facts): Map<string, { s: HiddenState; w: number }>[] {
  const c: LogContext = { log, sigma, facts, reveals: revealRoles(log, facts), taken: justTaken(log) };
  const init: HiddenState = { held: [0, 1, 2, 3].map(() => [0, 0, 0, 0, 0, 0, 0]), knownDown: [], toMask: [0, 0, 0] };
  const layers = [new Map([[keyOf(init), { s: init, w: 1 }]])];
  for (let i = 0; i < log.length; i++) {
    const next = new Map<string, { s: HiddenState; w: number }>();
    for (const { s, w } of layers[i]!.values()) {
      for (const { t, m } of steps(s, i, c)) {
        const key = keyOf(t);
        const at = next.get(key);
        if (at) at.w += w * m;
        else next.set(key, { s: t, w: w * m });
      }
    }
    layers.push(next);
  }
  return layers;
}

/** For one σ, the end states of the opponent's hidden cards and the number of ways each arises. */
function hiddenEndStates(log: HiddenEvent[], sigma: Identity[], facts: Facts): Map<HiddenState, number> {
  return new Map([...hiddenLayers(log, sigma, facts).at(-1)!.values()].map(({ s, w }) => [s, w]));
}

/** Whether a hidden end state matches what the player sees now: the opponent's hand size and face-down cards. */
function fitsView(s: HiddenState, facts: Facts): boolean {
  const down = new Set(s.knownDown);
  for (const card of down) if (!facts.opponentKnown.includes(card)) return false;
  const inHand = s.held.reduce((a, r) => a + r[1]! + r[2]! + r[5]! + r[6]!, 0);
  const faceDown = s.held.reduce((a, r) => a + r[3]! + r[4]!, 0);
  return inHand + facts.opponentKnown.length - down.size === facts.handSize && faceDown + down.size === facts.faceDownSlots.length;
}

// -- Counting completions -----------------------------------------------------

/**
 * The ways, for σ and a hidden end state, to choose which unplaced cards of unknown origin were
 * dealt into the Mask: split[character][kind] of them; with the cards each pile then holds, by kind.
 */
function maskSplits(sigma: Identity[], hidden: HiddenState, facts: Facts): { split: number[][]; ways: number; pileCounts: number[][] }[] {
  const mask = sigma.indexOf('mask');
  // How many unknown-origin cards of each character go to the Mask: its 3, less those already known there.
  const need: number[] = [];
  for (let x = 0; x < 3; x++) {
    const own = sigma.indexOf(CHARACTERS[x]!);
    const total = KINDS.reduce((a, k) => a + facts.unknownOrigin[x]![k]!.length, 0);
    const toMask = 3 - facts.dealtKnown[mask]![x]! - hidden.toMask[x]!;
    const toOwn = 9 - facts.dealtKnown[own]![x]! - (facts.revealedUnknown[x]! - hidden.toMask[x]!);
    if (toMask < 0 || toOwn < 0 || toMask + toOwn !== total) return [];
    need.push(toMask);
  }
  const perCharacter = [0, 1, 2].map((x) => splitsOf(KINDS.map((k) => facts.unknownOrigin[x]![k]!.length), need[x]!));
  const out: { split: number[][]; ways: number; pileCounts: number[][] }[] = [];
  for (const a of perCharacter[0]!)
    for (const b of perCharacter[1]!)
      for (const c of perCharacter[2]!) {
        const split = [a.take, b.take, c.take];
        const pileCounts = [0, 1, 2, 3].map((p) => KINDS.map((k) => facts.knownOrigin[p]![k]!.length));
        split.forEach((take, x) => {
          const own = sigma.indexOf(CHARACTERS[x]!);
          for (const k of KINDS) {
            pileCounts[mask]![k]! += take[k]!;
            pileCounts[own]![k]! += facts.unknownOrigin[x]![k]!.length - take[k]!;
          }
        });
        out.push({ split, ways: a.ways * b.ways * c.ways, pileCounts });
      }
  return out;
}

/** Ways to take `total` cards from groups of sizes `sizes`: each choice of counts, with its number of ways. */
function splitsOf(sizes: number[], total: number): { take: number[]; ways: number }[] {
  const out: { take: number[]; ways: number }[] = [];
  const take = sizes.map(() => 0);
  const go = (i: number, left: number, ways: number) => {
    if (i === sizes.length) {
      if (left === 0) out.push({ take: [...take], ways });
      return;
    }
    for (let n = 0; n <= Math.min(left, sizes[i]!); n++) {
      take[i] = n;
      go(i + 1, left - n, ways * choose(sizes[i]!, n));
    }
    take[i] = 0;
  };
  go(0, total, 1);
  return out;
}

/** Allocations of a pile's cards (a[kind]) to its cells (caps[cell]), each with its relative weight Π 1/m!. */
function allocations(a: number[], caps: number[]): { m: number[][]; w: number }[] {
  const out: { m: number[][]; w: number }[] = [];
  const left = [...caps];
  const m = KINDS.map(() => CELLS.map(() => 0));
  const go = (k: number, cell: number, rest: number, w: number) => {
    if (k === KINDS.length) {
      if (left.every((v) => v === 0)) out.push({ m: m.map((r) => [...r]), w });
      return;
    }
    if (cell === CELLS.length) {
      if (rest === 0) go(k + 1, 0, a[k + 1] ?? 0, w);
      return;
    }
    const max = accepts(cell, k) ? Math.min(rest, left[cell]!) : 0;
    for (let n = 0; n <= max; n++) {
      m[k]![cell] = n;
      left[cell]! -= n;
      go(k, cell + 1, rest - n, w / factorial(n));
      left[cell]! += n;
    }
    m[k]![cell] = 0;
  };
  go(0, 0, a[0]!, 1);
  return out;
}

const pileCountCache = new Map<string, number>();
/** Ways to put a pile's distinct cards (a[kind]) into its distinct places (caps[cell]). */
function countPile(a: number[], caps: number[]): number {
  if (a.reduce((x, y) => x + y, 0) !== caps.reduce((x, y) => x + y, 0)) return 0;
  const key = `${a}|${caps}`;
  const cached = pileCountCache.get(key);
  if (cached !== undefined) return cached;
  const sum = allocations(a, caps).reduce((x, y) => x + y.w, 0);
  const ways = sum * a.reduce((x, n) => x * factorial(n), 1) * caps.reduce((x, n) => x * factorial(n), 1);
  pileCountCache.set(key, ways);
  return ways;
}

function sampleAllocation(a: number[], caps: number[], random: () => number): number[][] {
  const all = allocations(a, caps);
  let u = random() * all.reduce((x, y) => x + y.w, 0);
  for (const { m, w } of all) {
    if (u < w) return m;
    u -= w;
  }
  return all[all.length - 1]!.m;
}

// -- Helpers ----------------------------------------------------------------

const FACTORIALS = [1];
function factorial(n: number): number {
  while (FACTORIALS.length <= n) FACTORIALS.push(FACTORIALS[FACTORIALS.length - 1]! * FACTORIALS.length);
  return FACTORIALS[n]!;
}

function choose(n: number, k: number): number {
  return k < 0 || k > n ? 0 : factorial(n) / (factorial(k) * factorial(n - k));
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}
