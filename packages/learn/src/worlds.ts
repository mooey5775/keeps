import { CARD_IDS, CARDS, isCoinCard, type CardId, type GameState, type PileId, type PlayerView, type Seat } from '@keeps/engine';
import type { Belief, HiddenEvent } from './belief.ts';

// Whole worlds a player can't tell from the real one, sampled exactly from the chance-only
// posterior: every hidden arrangement consistent with what the player knows for certain is
// equally likely, as the shuffle made them. (How the opponent chose to play carries more
// information; this ignores it on purpose: card counting, not opponent modelling.)
//
// The generative model (belief.ts explains the physical piles):
//   - the four physical piles' identities σ: Count, Fool, Friar, Mask, one each;
//   - the deal: a character's pile gets 9 of its 12 cards, the Mask 3 of each character;
//   - since then, every card the player can't place is either still in the pile it was dealt
//     into (at a position they don't know), or one of the opponent's hidden cards: those came
//     one by one from piles the opponent was seen taking from (Belief.hiddenLog), and some have
//     come out again (played, shown, given) without saying which they were.
// A world is a deal (σ, which cards went where, in which order) consistent with every fact
// the player has: what they see, the cards they know are in each pile (and where), the origins
// they know, the opponent's cards they know, and the log of the opponent's hidden cards, with
// its constraints (a card hidden face down is a Keep card; none of the cards hidden when our
// Pickpocket came up empty-handed or took every Coin card is a Coin card; no card they hold or hid
// face down is HOT, since HOT cards are played as soon as they're drawn, except a Keep card they
// just drew unseen that waits for them to choose its keep: HOT, or any Keep card under Invocation).
//
// Exact sampling. Cards matter to the constraints only through their character (where they could
// have been dealt), whether they're Coin cards, Keep cards and HOT cards, so worlds are counted by kind:
//   1. for each σ, a pass over the hidden log counts the ways each end state (the opponent's
//      hidden cards by pile of origin and constraint, and how many of the cards that came out
//      of them were dealt into the Mask) can arise: each card that came out was one of the
//      hidden cards then held that it can be, each of them a different past card;
//   2. for each end state, exact counting of the ways to complete the deal: which unplaced cards
//      were dealt into the Mask (each character's Mask share is fixed by σ), then, pile by pile,
//      which of the cards dealt there are still there and which are hidden where;
//   3. a world is drawn in proportion to its count; the cards themselves, the orders of the
//      unknown positions and of the opponent's hand, then uniformly.
// The opponent's open prompts are rebuilt from the world's own cards (the pile they're looking
// through, the card in their hand they'll hide face down). A prompt that exists only because their
// hand holds a card of some kind (Duplicity's, Joker's) rejects the worlds whose hand holds none:
// the only rejection, and rare.
// Positions the player knew but forgot (when a card left a pile from a position they couldn't
// see) are treated as unknown: that only widens the set of worlds, and never excludes the real one.
// One approximation: with two or more cards the opponent hid face down without our seeing them
// (Duplicity, replayed with Resurrection: rare), which went into which keep slot is drawn
// uniformly, although the view knows the order they were placed in.

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

export interface WorldModel {
  me: Seat;
  opponent: Seat;
  /** Each completion class: a σ, a hidden end state and a Mask split, with its number of worlds. */
  classes: { sigma: Identity[]; hidden: HiddenState; split: number[][]; weight: number; pileCounts: number[][]; caps: number[][] }[];
  total: number;
  /** Facts the worlds are built from. */
  facts: Facts;
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
export function worldModel(state: GameState, me: Seat, belief: Belief, view: PlayerView): WorldModel {
  const opponent = ((me + 2) % 4) as Seat;
  const facts = gatherFacts(state, me, opponent, belief, view);
  const classes: WorldModel['classes'] = [];
  for (const sigma of ASSIGNMENTS) {
    const own = CHARACTERS.map((x) => sigma.indexOf(x));
    const mask = sigma.indexOf('mask');
    // Known origins must fit σ: a character's cards come from its pile or the Mask.
    const dealt = facts.dealtKnown;
    if (CHARACTERS.some((_, x) => dealt.some((row, p) => row[x]! > 0 && p !== own[x] && p !== mask))) continue;
    for (const [hidden, ways] of hiddenEndStates(facts.hiddenLog, sigma, facts)) {
      if (!fitsView(hidden, facts)) continue;
      for (const { split, ways: splitWays, pileCounts } of maskSplits(sigma, hidden, facts)) {
        const caps = [0, 1, 2, 3].map((p) => [facts.stillIn[p]!, ...hidden.held[p]!.slice(1)]);
        let weight = ways * splitWays;
        for (let p = 0; p < 4 && weight > 0; p++) weight *= countPile(pileCounts[p]!, caps[p]!);
        if (weight > 0) classes.push({ sigma, hidden, split, weight, pileCounts, caps });
      }
    }
  }
  const total = classes.reduce((a, c) => a + c.weight, 0);
  if (!(total > 0)) throw new Error(`no world is consistent with what the player knows: ${diagnose(facts)}`);
  return { me, opponent, classes, total, facts };
}

/** One world, drawn exactly from the model. */
export function sampleWorld(model: WorldModel, state: GameState, belief: Belief, random: () => number): GameState {
  for (let attempt = 0; attempt < 10000; attempt++) {
    const world = drawWorld(model, state, belief, random);
    if (world) return world;
  }
  throw new Error("no world fits the opponent's open prompt");
}

/** A world drawn from the model, or null if it can't hold the opponent's open prompt (rejected). */
function drawWorld(model: WorldModel, state: GameState, belief: Belief, random: () => number): GameState | null {
  const { facts, me, opponent } = model;
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
  const { sigma, hidden, split, caps } = chosen;
  const mask = sigma.indexOf('mask');
  // 2. Which unknown-origin cards were dealt into the Mask (split[x][kind] of them), the rest into their own pile.
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
  // 3. Pile by pile: where each of those cards is now, an allocation drawn in proportion to its ways.
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
  // 4. Build it.
  const world = structuredClone(state);
  const pileId = (p: number): PileId => sigma[p]! as PileId;
  const piles = {} as GameState['piles'];
  for (let position = 0; position < 4; position++) {
    const p = belief.at[position]!;
    const knowledge = belief.piles[p]!;
    const real = state.piles[state.pileAt[position as Seat]!].cards;
    const known = knowledge.slots;
    const placed = new Set(known.filter((c): c is CardId => c !== null));
    const free = shuffled([...[...knowledge.members].filter((c) => !placed.has(c)), ...cells[p]![0]!], random);
    let next = 0;
    const cards = real.map((card, i) => ({ id: known[i] ?? free[next++]!, faceUp: card.faceUp }));
    if (next !== free.length) throw new Error(`pile at ${position}: ${free.length} cards for ${next} unknown positions`);
    piles[pileId(p)] = { id: pileId(p), cards };
    world.pileAt[position as Seat] = pileId(p);
  }
  world.piles = piles;
  const knownDown = new Set(hidden.knownDown);
  const hand = [...facts.opponentKnown.filter((c) => !knownDown.has(c))];
  const down: CardId[] = [...hidden.knownDown];
  for (let p = 0; p < 4; p++) {
    hand.push(...cells[p]![1]!, ...cells[p]![2]!, ...cells[p]![5]!, ...cells[p]![6]!);
    down.push(...cells[p]![3]!, ...cells[p]![4]!);
  }
  world.hands[opponent] = shuffled(hand, random);
  const slots = shuffled(facts.faceDownSlots, random);
  slots.forEach(([seat, index], i) => {
    world.keeps[seat]![index] = { ...world.keeps[seat]![index]!, id: down[i]! };
  });
  if (!fitPrompts(world, opponent, [0, 1, 2, 3].flatMap((p) => [...cells[p]![5]!, ...cells[p]![6]!])[0] ?? null)) return null;
  // Chance from here on is the world's own: a fresh generator.
  world.rng = { a: (random() * 2 ** 32) >>> 0, b: (random() * 2 ** 32) >>> 0, c: (random() * 2 ** 32) >>> 0, d: (random() * 2 ** 32) >>> 0 || 1 };
  void me;
  return world;
}

/**
 * The opponent's open prompts, rebuilt from the world's cards: the piles they're looking at, the HOT
 * card waiting for its keep (`waiting`, when we didn't see it), the cards in their hand they're choosing
 * from. False if the world's hand can't hold a prompt that needs a card of some kind.
 */
function fitPrompts(world: GameState, opponent: Seat, waiting: CardId | null): boolean {
  const pile = (position: Seat) => world.piles[world.pileAt[position]].cards.map((c) => c.id);
  const hand = world.hands[opponent];
  let fits = true;
  world.prompts = world.prompts.map((p) => {
    if (p.seat !== opponent) return p;
    switch (p.kind) {
      case 'hot-target':
        return waiting ? { ...p, card: waiting } : p;
      case 'choose-pile-card':
      case 'order-pile':
        return { ...p, cards: pile(p.pile) };
      case 'take-or-discard':
        return { ...p, card: pile(p.pile)[0]! };
      case 'choose-top-card':
        return { ...p, options: p.options.map((o) => ({ pile: o.pile, card: pile(o.pile)[0]! })) };
      case 'duplicity-hide': {
        const options = [...new Set(hand.filter((c) => CARDS[c].keep))];
        fits &&= options.length > 0;
        return { ...p, options };
      }
      case 'joker-copy': {
        const options = [...new Set(hand.filter((c) => c !== 'joker' && !CARDS[c].keep))];
        fits &&= options.length > 0;
        return { ...p, options };
      }
      default:
        return p;
    }
  });
  return fits;
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
  let lastHide: Extract<HiddenEvent, { kind: 'hide' }> | null = null;
  const hides: Extract<HiddenEvent, { kind: 'hide' }>[] = [];
  log.forEach((e, i) => {
    if (e.kind === 'hide') {
      lastHide = e;
      hides.push(e);
      return;
    }
    if (e.kind !== 'reveal' && e.kind !== 'turn-up') return;
    const just = e.kind === 'reveal' && e.just !== null && lastHide && lastHide.pile === e.just ? lastHide : null;
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

/** For one σ, the end states of the opponent's hidden cards and the number of ways each arises. */
function hiddenEndStates(log: HiddenEvent[], sigma: Identity[], facts: Facts): Map<HiddenState, number> {
  const mask = sigma.indexOf('mask');
  const originsOf = (card: CardId, just: number | null): number[] => {
    const known = facts.origin.get(card);
    if (known !== undefined) return [known];
    if (just !== null) return [just];
    const x = CARDS[card].character as Character;
    return [sigma.indexOf(x), mask];
  };
  let states = new Map<string, { s: HiddenState; w: number }>();
  const put = (into: typeof states, s: HiddenState, w: number) => {
    if (w <= 0) return;
    const key = JSON.stringify([s.held, [...s.knownDown].sort(), s.toMask]);
    const at = into.get(key);
    if (at) at.w += w;
    else into.set(key, { s, w });
  };
  put(states, { held: [0, 1, 2, 3].map(() => [0, 0, 0, 0, 0, 0, 0]), knownDown: [], toMask: [0, 0, 0] }, 1);
  const copy = (s: HiddenState): HiddenState => ({ held: s.held.map((r) => [...r]), knownDown: [...s.knownDown], toMask: [...s.toMask] });
  const reveals = revealRoles(log, facts);
  for (const [i, e] of log.entries()) {
    const next: typeof states = new Map();
    for (const { s, w } of states.values()) {
      switch (e.kind) {
        case 'hide': {
          const t = copy(s);
          t.held[e.pile]![facts.waiting !== null && i === log.length - 1 ? facts.waiting : 1]! += 1;
          put(next, t, w);
          break;
        }
        case 'no-coins': {
          const t = copy(s);
          for (const row of t.held) {
            row[2]! += row[1]!;
            row[1] = 0;
          }
          put(next, t, w);
          break;
        }
        case 'face-down': {
          for (const card of e.known) {
            if (s.knownDown.includes(card)) continue;
            const t = copy(s);
            t.knownDown.push(card);
            put(next, t, w);
          }
          for (let p = 0; p < 4; p++) {
            for (const [from, to] of [[1, 3], [2, 4]] as const) {
              const n = s.held[p]![from]!;
              if (n === 0) continue;
              const t = copy(s);
              t.held[p]![from]! -= 1;
              t.held[p]![to]! += 1;
              put(next, t, w * n);
            }
          }
          break;
        }
        case 'reveal':
        case 'turn-up': {
          if (e.kind === 'turn-up' && s.knownDown.includes(e.card)) {
            // The known Keep card they hid.
            const t = copy(s);
            t.knownDown = t.knownDown.filter((c) => c !== e.card);
            put(next, t, w);
            break;
          }
          // A card we knew they held can't have been one of their unknown hidden cards.
          if (e.kind === 'turn-up' && knownDownCandidate(log, e)) break;
          const kind = kindOf(e.card) & facts.kindMask;
          const from = e.kind === 'reveal' ? [1, 2] : [3, 4];
          const role = reveals.get(i)!;
          const unknownOrigin = role.dealt && !facts.origin.has(e.card);
          const piles = role.dealt ? originsOf(e.card, e.kind === 'reveal' ? e.just : null) : role.piles;
          for (const p of piles) {
            for (const cell of from) {
              const n = s.held[p]![cell]!;
              // A HOT card was held for a moment before it came out (played as soon as it was drawn):
              // "never HOT" is about the cards still hidden, not the ones that came out.
              if (n === 0 || !accepts(cell, kind & 3)) continue;
              const t = copy(s);
              t.held[p]![cell]! -= 1;
              if (unknownOrigin && p === mask) t.toMask[CHARACTERS.indexOf(CARDS[e.card].character as Character)]! += 1;
              put(next, t, w * n);
            }
          }
          break;
        }
      }
    }
    states = next;
  }
  return new Map([...states.values()].map(({ s, w }) => [s, w]));
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
