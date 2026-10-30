import {
  CARD_IDS,
  CARDS,
  rotatedTo,
  type CardId,
  type PlayerView,
  type Seat,
  type TraceEvent,
} from '@keeps/engine';
import { History, type PileMap } from './history.ts';

// What one player can know about the hidden cards in a heads-up round, built only
// from what they've been shown (their view and their own log), so it can't leak.
//
// Physical piles. The four piles are dealt to positions 0..3 and then only move
// as wholes (Juggling, Pandemonium, Fiat), always in public, so a player can
// follow each one. A pile's identity (the Count, Fool, Friar or Mask pile) is
// hidden, but every card's front shows its character, so each card known to have
// come from a pile is evidence: a character pile holds 9 cards of one character,
// the Mask 3 of each.
//
// Unlocated cards. A card the player can't place exactly (not in their hand, a
// keep, the discard, or a pile position they know; not known to be in the
// opponent's hand) is in one of two places: still in the pile it was dealt into,
// or among the opponent's hidden cards (their hand, or one they placed face
// down), because in heads-up every hidden card the opponent holds came from a
// pile they were seen taking from.
//
// The beliefs:
//   - identity: an exact weighting of the 24 ways to assign identities to the
//     physical piles, from the characters of cards whose pile of origin is known.
//   - where each unlocated card is: its pile of origin (from the identities and
//     how many of each character the Mask still needs), then whether it's still
//     there or among the opponent's hidden cards (in proportion to that pile's
//     unseen cards and the opponent's hidden cards from it).

export const NUM_PILES = 4;

/**
 * The opponent's hidden holdings as exact, integer facts, in order (for sampling whole worlds:
 * worlds.ts). opponentHidden keeps expectations instead, which is what the observation encodes.
 *   hide       they took a card we can't name from physical pile `pile`: one more hidden card;
 *              `placed`: cards put on that pile (not dealt there) it may have been
 *   reveal     a card we couldn't name left their hidden cards (played, shown, given, stolen):
 *              it was one of them; `just`: the one just taken from that pile (a HOT card,
 *              played the moment it enters a hand)
 *   no-coins   our Pickpocket found or took every Coin card in their hand: none of the cards
 *              hidden now is a Coin card
 *   face-down  they hid a card face down (Duplicity): one of their hidden cards, or one of
 *              `known` (Keep cards we knew they held); a Keep card either way
 *   turn-up    a card they had hidden face down was turned up
 */
export type HiddenEvent =
  | { kind: 'hide'; pile: number; placed: CardId[] }
  | { kind: 'reveal'; card: CardId; just: number | null }
  | { kind: 'no-coins' }
  | { kind: 'face-down'; known: CardId[] }
  | { kind: 'turn-up'; card: CardId };
/**
 * What happened to the places in the piles, in the order the player saw it (for rebuilding a deal from a
 * sampled world: worlds.ts). Piles are physical (0..3, as dealt to positions 0..3); `at` is the index of
 * the log event it came from.
 *   deal     the pile was dealt `size` cards: its places, top first
 *   pop      a card left the pile: from the top, a known index, or any position (the opponent's choice);
 *            `card` if the player knows which, `hide` (index into hiddenLog) if it became a hidden card
 *   push     a card was put on top (Blunder)
 *   look     the player saw cards at places: the whole pile (`whole`), or only the top
 *   reorder  the pile's cards were put in a new order: `order` (the player's own), or one they can't see
 *   flip     the pile was turned over
 */
export type PileOp =
  | { op: 'deal'; p: number; size: number; at: number }
  | { op: 'pop'; p: number; from: 'top' | 'any' | number; card: CardId | null; hide: number | null; at: number }
  | { op: 'push'; p: number; card: CardId; at: number }
  | { op: 'look'; p: number; cards: CardId[]; whole: boolean; at: number }
  | { op: 'reorder'; p: number; order: CardId[] | null; at: number }
  | { op: 'flip'; p: number; at: number };
type Character = 'count' | 'fool' | 'friar';
const CHARACTERS: Character[] = ['count', 'fool', 'friar'];
/** Identity of a physical pile: one of the three characters, or the Mask. */
export type Identity = Character | 'mask';
export const IDENTITIES: Identity[] = ['count', 'fool', 'friar', 'mask'];

/** The 24 ways to give the four physical piles the four identities. */
const ASSIGNMENTS: Identity[][] = permutations(IDENTITIES);

interface PhysicalPile {
  size: number;
  /** Top first; a known card or null. Only meaningful positions are known ones. */
  slots: (CardId | null)[];
  /** Cards known to be in this pile (positions possibly unknown). */
  members: Set<CardId>;
  /** Cards put on this pile that weren't dealt into it (Blunder). */
  placed: Set<CardId>;
}

/**
 * What a player's view showed at one of their decisions, as an entry in their own log. The engine's events say what
 * happened; a view also shows what is face up, which no event names: the top of a pile Revelation turned over, the
 * next card of a face-up pile. Kept in the log at each decision (noteObservation), a belief rebuilt from the log
 * alone knows all the player saw, exactly as one that observed the views as they came; and whoever is given the log
 * (the search, its world sampler) is given that too. Not an engine event: only the learning code makes one.
 */
export interface Observed {
  type: 'observed';
  /** Each pile's face-up top, by position (null: face down or empty). */
  tops: (CardId | null)[];
  /** The cards in sight elsewhere: the player's hand, the discard, face-up keep cards. */
  visible: CardId[];
}

export const isObserved = (e: TraceEvent): boolean => (e.payload as { type: string }).type === 'observed';

/** What `view` shows of the cards, as an observation entry's payload. */
function observedIn(view: PlayerView, me: Seat): Observed {
  const visible = [...(view.hands[me]!.cards ?? []), ...view.discard];
  for (const keep of view.keeps) for (const c of keep.cards) if (c.id) visible.push(c.id);
  return { type: 'observed', tops: view.piles.map((p) => p.top), visible };
}

/** Whether an observation entry is what `view` shows `me` (the visible cards in any order). */
export function observes(entry: TraceEvent, view: PlayerView, me: Seat): boolean {
  const seen = entry.payload as unknown as Observed;
  const now = observedIn(view, me);
  return JSON.stringify(seen.tops) === JSON.stringify(now.tops) && JSON.stringify([...seen.visible].sort()) === JSON.stringify(now.visible.sort());
}

/**
 * Adds to `me`'s log what their view shows now (an Observed entry), unless the log's last entry already is that
 * observation: the same view seen again, nothing having happened since, adds nothing. Returns the log.
 */
export function noteObservation(log: TraceEvent[], view: PlayerView, me: Seat): TraceEvent[] {
  const payload = observedIn(view, me);
  const last = log.at(-1);
  if (last && isObserved(last)) {
    const was = last.payload as unknown as Observed;
    const same = (a: readonly (CardId | null)[], b: readonly (CardId | null)[]) => a.length === b.length && a.every((x, i) => x === b[i]);
    if (same(was.tops, payload.tops) && same(was.visible, payload.visible)) return log;
  }
  log.push({
    seq: last?.seq ?? 0,
    round: last?.round ?? 0,
    turn: last?.turn ?? 0,
    depth: 0,
    cause: null,
    visibility: [me],
    payload: payload as unknown as TraceEvent['payload'],
  });
  return log;
}

export class Belief implements PileMap {
  readonly me: Seat;
  /** What has happened, anchored to cards and piles (observation v2). */
  readonly history = new History();
  readonly opponent: Seat;
  /** Which physical pile sits at each position. */
  at: number[] = [0, 1, 2, 3];
  piles: PhysicalPile[] = [];
  /** Cards whose pile of origin is known: card → physical pile. */
  origin = new Map<CardId, number>();
  /** Cards known to be in the opponent's hand. */
  opponentKnown = new Set<CardId>();
  /** The opponent's hidden cards, as expected counts by pile of origin. */
  opponentHidden: number[] = [0, 0, 0, 0];
  /** Cards known to be in the opponent's hand that might be the one they since hid face down. */
  opponentMaybeHidden = new Set<CardId>();
  /** The face-down card we placed (we know it). */
  private myFaceDown = new Set<CardId>();
  /**
   * The pile of the opponent's hidden card taken just now, until something else
   * happens: a HOT card played right after is that card (it's played the moment it
   * enters a hand). Not after a steal: Legerdemain plays a random card.
   */
  private justHidden: number | null = null;
  /** The last card each seat played, for telling Requisition's takes (any position) from top takes. */
  private lastPlayed = new Map<Seat, CardId>();
  /** The piles each seat last looked at (Prayer's discard comes off the top of that one). */
  private lastLooked = new Map<Seat, Seat[]>();
  /** Fiat: piles by their position before it, and the claims made so far. */
  private fiat: { before: number[]; claims: { claimant: Seat; from: Seat }[] } | null = null;
  private processed = 0;
  /** The opponent's hidden holdings, exactly (see HiddenEvent). */
  hiddenLog: HiddenEvent[] = [];
  /** For each hiddenLog event, the index of the log event it came from. */
  hiddenAt: number[] = [];
  /** What happened to the places in the piles (see PileOp). */
  pileOps: PileOp[] = [];
  /** Derived from `origin` (recomputed when it changes): evidence, identity weights, origins by character. */
  private derived: { counts: number[][]; weights: { assignment: Identity[]; weight: number }[]; byCharacter: Map<string, number[]>; identities?: number[][] } | null = null;

  /**
   * Sound origin inference (observation v2 and later). Off, the belief behaves
   * exactly as observation v1 was trained with: it also concluded a card's pile
   * of origin when probabilities rounded to certainty, which can be wrong and
   * then contradicts the rest of the evidence (rare: about once in 36,000 rounds).
   */
  readonly sound: boolean;

  constructor(me: Seat, { sound = false }: { sound?: boolean } = {}) {
    this.me = me;
    this.opponent = ((me + 2) % 4) as Seat;
    this.sound = sound;
  }

  /** An independent copy (what this player has seen and concluded, so far). */
  clone(): Belief {
    const copy = new Belief(this.me, { sound: this.sound });
    for (const [key, value] of Object.entries(this)) {
      if (key === 'history' || key === 'me' || key === 'opponent' || key === 'sound') continue;
      (copy as unknown as Record<string, unknown>)[key] = structuredClone(value);
    }
    (copy as unknown as { history: History }).history = this.history.clone();
    return copy;
  }

  /**
   * The card the opponent just took unseen, if it's still waiting to be played (a HOT card waiting for
   * its keep, or Invocation's draw): 'hot' after an ordinary draw or take (only a HOT card waits), 'any'
   * under Invocation (any card drawn waits, played as if HOT). Null if no card they took unseen is waiting.
   */
  waitingUnseen(): 'hot' | 'any' | null {
    if (this.justHidden === null) return null;
    return this.lastPlayed.get(this.opponent) === 'invocation' ? 'any' : 'hot';
  }

  /** Reads the player's log from where it left off (a new round starts over). */
  update(log: readonly TraceEvent[]): this {
    for (; this.processed < log.length; this.processed++) {
      const e = log[this.processed]!;
      // An observation is what the player saw, not something that happened: it ends nothing (a Fiat, "just hidden").
      if (isObserved(e)) this.see(e.payload as unknown as Observed);
      else this.apply(e.payload);
    }
    this.finishFiat();
    return this;
  }

  private reset(): void {
    this.at = [0, 1, 2, 3];
    this.piles = [];
    this.origin.clear();
    this.derived = null;
    this.opponentKnown.clear();
    this.opponentHidden = [0, 0, 0, 0];
    this.opponentMaybeHidden.clear();
    this.myFaceDown.clear();
    this.justHidden = null;
    this.lastPlayed.clear();
    this.lastLooked.clear();
    this.fiat = null;
    this.hiddenLog = [];
    this.hiddenAt = [];
    this.pileOps = [];
  }

  private hide(e: HiddenEvent): void {
    this.hiddenLog.push(e);
    this.hiddenAt.push(this.processed);
  }

  private pileAt(position: Seat): number {
    return this.at[position]!;
  }

  /** The physical pile at a position now (for History). */
  physicalAt(position: Seat): number {
    return this.at[position]!;
  }

  /** How many cards the opponent holds, by our count (for History). */
  opponentHandTally(): number {
    return this.opponentKnown.size + Math.round(this.opponentHidden.reduce((a, b) => a + b, 0));
  }

  private apply(e: TraceEvent['payload']): void {
    if (this.fiat && e.type !== 'pile-claim' && e.type !== 'prompt') this.finishFiat();
    // A HOT card's keep prompt can come between its draw and its play; anything else ends "just taken".
    if (e.type !== 'prompt' && e.type !== 'play') this.justHidden = null;
    this.history.record(e, this);
    switch (e.type) {
      case 'round-start':
        this.reset();
        return;
      case 'pile-placed':
        this.piles[e.position] = { size: e.size, slots: Array(e.size).fill(null), members: new Set(), placed: new Set() };
        this.pileOps.push({ op: 'deal', p: e.position, size: e.size, at: this.processed });
        return;
      case 'draw': {
        const p = this.pileAt(e.from);
        const known = this.removeTop(p, e.card);
        const card = e.card ?? known;
        if (card) {
          if (e.card && !known) this.learnOrigin(card, p);
          if (e.seat === this.opponent) this.opponentKnown.add(card);
        } else {
          this.hideFrom(p); // the opponent drew a card we can't name
        }
        return;
      }
      case 'take': {
        if (e.from === 'discard') {
          if (e.seat === this.opponent && e.card) this.opponentKnown.add(e.card);
          return;
        }
        const p = this.pileAt(e.from.pile);
        const anyPosition = this.lastPlayed.get(e.seat) === 'requisition';
        if (e.card) {
          // We know the card: it leaves its known position, or the top.
          this.removeCard(p, e.card, anyPosition);
          this.learnOrigin(e.card, p);
          if (e.seat === this.opponent) this.opponentKnown.add(e.card);
        } else if (anyPosition) {
          this.removeUnknown(p); // the opponent's Requisition: some card, from some position
          this.hideFrom(p);
        } else {
          const known = this.removeTop(p, null);
          if (known) this.opponentKnown.add(known);
          else this.hideFrom(p);
        }
        return;
      }
      case 'look': {
        if (e.seat === this.opponent) this.lastLooked.set(e.seat, e.piles);
        if (!e.cards) return;
        this.lastLooked.set(e.seat, e.piles);
        if (e.piles.length === 1 && e.cards.length === this.piles[this.pileAt(e.piles[0]!)]!.size) {
          // A whole pile, top first (Requisition, Tithes).
          const p = this.pileAt(e.piles[0]!);
          const pile = this.piles[p]!;
          pile.slots = [...e.cards];
          for (const card of e.cards) this.addMember(p, card);
          this.pileOps.push({ op: 'look', p, cards: [...e.cards], whole: true, at: this.processed });
        } else {
          // Top cards (Epiphany: one per pile listed; Prayer: one).
          e.piles.forEach((position, i) => {
            const p = this.pileAt(position);
            const card = e.cards![i]!;
            this.piles[p]!.slots[0] = card;
            this.addMember(p, card);
            this.pileOps.push({ op: 'look', p, cards: [card], whole: false, at: this.processed });
          });
        }
        return;
      }
      case 'discard': {
        if (e.from === 'pile') {
          const [position] = this.lastLooked.get(e.seat) ?? [];
          if (position === undefined) return;
          const p = this.pileAt(position);
          for (const card of e.cards) {
            this.removeCard(p, card, false);
            this.learnOrigin(card, p);
          }
        } else if (e.from === 'hand' && e.seat === this.opponent) {
          for (const card of e.cards) this.revealFromOpponent(card, false);
        }
        return;
      }
      case 'play':
        this.lastPlayed.set(e.seat, e.copy ?? e.card);
        if (e.seat === this.opponent) this.revealFromOpponent(e.card, e.hot && this.justHidden !== null);
        this.justHidden = null;
        return;
      case 'reveal-card':
        // Joker shows a card from the opponent's hand; it stays there.
        if (e.seat === this.opponent && !this.opponentKnown.has(e.card)) {
          this.revealFromOpponent(e.card, false);
          this.opponentKnown.add(e.card);
        }
        return;
      case 'steal':
        if (!e.cards) return;
        if (e.from === this.opponent) for (const card of e.cards) this.revealFromOpponent(card, false);
        if (e.seat === this.opponent) for (const card of e.cards) this.opponentKnown.add(card);
        if (e.seat === this.me && e.from === this.opponent && this.lastPlayed.get(this.me) === 'pickpocket') this.hide({ kind: 'no-coins' });
        return;
      case 'no-effect':
        // Our Pickpocket on them, with nothing to take (engine: effects.ts, "S<seat> has no Coin cards in hand").
        if (e.seat === this.me && e.card === 'pickpocket' && e.reason.startsWith(`S${this.opponent} has no Coin`)) this.hide({ kind: 'no-coins' });
        return;
      case 'give':
        if (!e.card) return;
        if (e.seat === this.opponent) this.revealFromOpponent(e.card, false);
        if (e.to === this.opponent) this.opponentKnown.add(e.card);
        return;
      case 'look-hands':
        // Pluck: the opponent's whole hand, shown to us. Every hidden card is now named.
        for (const hand of e.hands ?? []) {
          if (hand.seat !== this.opponent) continue;
          for (const card of hand.cards) {
            if (this.opponentKnown.has(card)) continue;
            this.revealFromOpponent(card, false);
            this.opponentKnown.add(card);
          }
        }
        return;
      case 'reveal':
        // A face-down card turned up. If the opponent hid it, it was one of their hidden cards.
        if (this.myFaceDown.delete(e.card)) return;
        this.hide({ kind: 'turn-up', card: e.card });
        if (this.opponentMaybeHidden.has(e.card)) {
          // One of the cards we knew they held: so it wasn't still in their hand.
          this.opponentKnown.delete(e.card);
          this.opponentMaybeHidden.clear();
          return;
        }
        this.opponentMaybeHidden.clear();
        this.revealFromOpponent(e.card, false, false);
        return;
      case 'place-face-down':
        if (e.seat === this.me && e.card) this.myFaceDown.add(e.card);
        // The opponent hid a card we can't see: it may be a Keep card we knew they held.
        if (e.seat === this.opponent && !e.card) {
          for (const card of this.opponentKnown) if (CARDS[card].keep) this.opponentMaybeHidden.add(card);
          this.hide({ kind: 'face-down', known: [...this.opponentKnown].filter((card) => CARDS[card].keep) });
        }
        return;
      case 'pile-swap': {
        const [a, b] = [this.at[e.a]!, this.at[e.b]!];
        this.at[e.a] = b;
        this.at[e.b] = a;
        return;
      }
      case 'pile-rotate': {
        const next = [...this.at];
        for (let s = 0; s < 4; s++) next[rotatedTo(s as Seat, e.direction)] = this.at[s]!;
        this.at = next;
        return;
      }
      case 'pile-flip': {
        const pile = this.piles[this.pileAt(e.pile)]!;
        pile.slots.reverse();
        this.pileOps.push({ op: 'flip', p: this.pileAt(e.pile), at: this.processed });
        return;
      }
      case 'place-on-pile': {
        const p = this.pileAt(e.pile);
        const pile = this.piles[p]!;
        // A card is in one place: if we still counted it in another pile (taken from there unseen), it isn't.
        for (const other of this.piles) {
          if (other === pile || !other.members.delete(e.card)) continue;
          other.placed.delete(e.card);
          other.slots = other.slots.map((c) => (c === e.card ? null : c));
        }
        pile.slots.unshift(e.card);
        pile.size++;
        pile.members.add(e.card);
        pile.placed.add(e.card);
        this.pileOps.push({ op: 'push', p, card: e.card, at: this.processed });
        return;
      }
      case 'pile-reorder': {
        const p = this.pileAt(e.pile);
        const pile = this.piles[p]!;
        // Our own reorder: we know the new order. The opponent's: positions unknown, contents unchanged.
        pile.slots = e.order ? [...e.order] : Array(pile.size).fill(null);
        this.pileOps.push({ op: 'reorder', p, order: e.order ? [...e.order] : null, at: this.processed });
        return;
      }
      case 'piles-to-center':
        this.fiat = { before: [...this.at], claims: [] };
        return;
      case 'pile-claim':
        this.fiat?.claims.push({ claimant: e.claimant, from: e.from });
        return;
      default:
        return;
    }
  }

  /** Fiat: once claiming is over, ghosts left without a pile get the rest in seat order (as the engine does). */
  private finishFiat(): void {
    if (!this.fiat) return;
    const { before, claims } = this.fiat;
    // Heads-up: both players claim, then Fiat's player places one ghost pile; the last pile goes to the other ghost.
    if (claims.length < 3) return;
    const unclaimed = [0, 1, 2, 3].filter((from) => !claims.some((c) => c.from === from));
    const unfilled = [0, 1, 2, 3].filter((s) => !claims.some((c) => c.claimant === s));
    const all = [...claims, ...unfilled.map((claimant, i) => ({ claimant: claimant as Seat, from: unclaimed[i]! as Seat }))];
    for (const c of all) this.at[c.claimant] = before[c.from]!;
    this.fiat = null;
  }

  /**
   * What the view adds. A card the view shows anywhere else (a hand, a keep, the
   * discard) is no longer in any pile (say the opponent took a placed Blunder from
   * an unknown position: it's played at once, in public). A face-up top card
   * (Revelation) shows a card in that pile.
   */
  observe(view: PlayerView): this {
    return this.see(observedIn(view, this.me));
  }

  /** Learns from what a view showed (observe(), or an observation entry in the log). */
  private see(seen: Observed): this {
    const elsewhere = new Set<CardId>(seen.visible);
    for (const pile of this.piles) {
      for (const card of [...pile.members]) {
        if (!elsewhere.has(card)) continue;
        pile.members.delete(card);
        pile.placed.delete(card);
        pile.slots = pile.slots.map((c) => (c === card ? null : c));
      }
    }
    for (let position = 0; position < 4; position++) {
      const top = seen.tops[position];
      if (!top) continue;
      const p = this.pileAt(position as Seat);
      const pile = this.piles[p]!;
      if (pile.size > 0) pile.slots[0] = top;
      if (!pile.members.has(top)) this.addMember(p, top);
      const last = this.pileOps.at(-1);
      if (!(last?.op === 'look' && last.p === p && last.cards[0] === top && !last.whole && last.at === this.processed)) {
        this.pileOps.push({ op: 'look', p, cards: [top], whole: false, at: this.processed });
      }
    }
    return this;
  }

  private addMember(p: number, card: CardId): void {
    this.piles[p]!.members.add(card);
    if (!this.piles[p]!.placed.has(card)) this.learnOrigin(card, p);
  }

  private learnOrigin(card: CardId, p: number): void {
    if (!this.origin.has(card)) {
      this.origin.set(card, p);
      this.derived = null;
    }
  }

  /**
   * Takes the top card off a pile; returns it if we knew it was on top. `seen`
   * is the card if we saw it (our own draw, or a face-up one).
   */
  private removeTop(p: number, seen: CardId | null): CardId | null {
    const pile = this.piles[p]!;
    if (pile.size === 0) return null;
    const [top] = pile.slots.splice(0, 1);
    pile.size--;
    const card = top ?? seen;
    this.pileOps.push({ op: 'pop', p, from: 'top', card: card ?? null, hide: null, at: this.processed });
    if (card) {
      pile.members.delete(card);
      pile.placed.delete(card);
      return top ?? null;
    }
    // Someone took an unknown top while we know some cards are in here (but not where): one of them may have gone.
    this.forgetMembers(p);
    return null;
  }

  /** A known card leaves a pile (from its known position, the top, or anywhere). */
  private removeCard(p: number, card: CardId, anyPosition: boolean): void {
    const pile = this.piles[p]!;
    const index = pile.slots.indexOf(card);
    this.pileOps.push({ op: 'pop', p, from: index >= 0 ? index : anyPosition ? 'any' : 'top', card, hide: null, at: this.processed });
    if (index >= 0) pile.slots.splice(index, 1);
    else if (anyPosition) {
      // We know which card, not where it was: the remaining positions are uncertain.
      pile.slots = Array(pile.size - 1).fill(null);
    } else pile.slots.splice(0, 1);
    pile.size--;
    pile.members.delete(card);
    pile.placed.delete(card);
  }

  /** A card we can't name leaves a pile from some position. */
  private removeUnknown(p: number): void {
    const pile = this.piles[p]!;
    this.pileOps.push({ op: 'pop', p, from: 'any', card: null, hide: null, at: this.processed });
    pile.size--;
    pile.slots = Array(pile.size).fill(null);
    this.forgetMembers(p);
  }

  /** Cards we knew were in a pile may have left unseen: they become unlocated (their origin stays known). */
  private forgetMembers(p: number): void {
    const pile = this.piles[p]!;
    for (const card of [...pile.members]) {
      if (pile.placed.has(card)) continue; // a placed card is HOT (Blunder): it would have been played in public
      pile.members.delete(card);
    }
    pile.slots = pile.slots.map((c) => (c && pile.members.has(c) ? c : null));
  }

  /** The opponent took a card we can't name from pile `p`. */
  private hideFrom(p: number): void {
    const pop = this.pileOps.at(-1);
    if (pop?.op !== 'pop' || pop.p !== p || pop.card !== null) throw new Error('a hidden card came from no pile');
    pop.hide = this.hiddenLog.length;
    this.hide({ kind: 'hide', pile: p, placed: [...this.piles[p]!.placed] });
    this.opponentHidden[p]! += 1;
    this.justHidden = p;
  }

  /** A card left the opponent's hand (or was shown from it): which of their hidden cards was it? */
  private revealFromOpponent(card: CardId, hot: boolean, log = true): void {
    if (this.opponentKnown.delete(card)) return;
    if (log) this.hide({ kind: 'reveal', card, just: hot && this.justHidden !== null ? this.justHidden : null });
    const total = this.opponentHidden.reduce((a, b) => a + b, 0);
    if (total <= 1e-9) return; // not one of their hidden cards (e.g. it came from our hand)
    let weights: number[];
    const known = this.origin.get(card);
    if (known !== undefined && this.opponentHidden[known]! > 1e-9) {
      weights = [0, 1, 2, 3].map((p) => (p === known ? 1 : 0));
    } else if (hot && this.justHidden !== null && this.opponentHidden[this.justHidden]! > 1e-9) {
      // A HOT card is played the moment it enters a hand: it's the one just taken.
      const just = this.justHidden;
      weights = [0, 1, 2, 3].map((p) => (p === just ? 1 : 0));
      if (this.sound) this.learnOrigin(card, just);
    } else {
      // Only probable: spread over the piles their hidden cards came from. Never learn an
      // origin from this (the hidden counts are expectations, so a weight that rounds to 1
      // isn't certainty, and a wrong origin would contradict the rest of the evidence).
      const origins = this.originProbabilities(card);
      weights = this.opponentHidden.map((h, p) => h * origins[p]!);
      const sum = weights.reduce((a, b) => a + b, 0);
      weights = sum > 0 ? weights.map((w) => w / sum) : this.opponentHidden.map((h) => h / total);
    }
    weights.forEach((w, p) => {
      this.opponentHidden[p] = Math.max(0, this.opponentHidden[p]! - w);
    });
    if (!this.sound) {
      // v1's behaviour, kept so v1 observations are exactly what v1 policies were trained on.
      const certain = weights.findIndex((w) => w > 1 - 1e-9);
      if (certain >= 0) this.learnOrigin(card, certain);
    }
  }

  // -- Beliefs --------------------------------------------------------------

  private derive() {
    if (!this.derived) {
      const counts = this.countEvidence();
      this.derived = { counts, weights: this.weigh(counts), byCharacter: new Map() };
    }
    return this.derived;
  }

  /** Cards of each character known to come from each physical pile. */
  private countEvidence(): number[][] {
    const counts = [0, 1, 2, 3].map(() => [0, 0, 0]);
    for (const [card, p] of this.origin) counts[p]![CHARACTERS.indexOf(CARDS[card].character)]! += 1;
    return counts;
  }

  /** Weights of the 24 identity assignments (assignment[p] = identity of physical pile p), normalized. */
  identityWeights(): { assignment: Identity[]; weight: number }[] {
    return this.derive().weights;
  }

  private weigh(counts: number[][]): { assignment: Identity[]; weight: number }[] {
    const weighted = ASSIGNMENTS.map((assignment) => {
      let weight = 1;
      for (let p = 0; p < 4 && weight > 0; p++) {
        const id = assignment[p]!;
        if (id === 'mask') {
          if (counts[p]!.some((n) => n > 3)) weight = 0;
        } else if (counts[p]!.some((n, x) => n > 0 && CHARACTERS[x] !== id) || counts[p]![CHARACTERS.indexOf(id)]! > 9) {
          weight = 0;
        }
      }
      if (weight > 0) {
        const mask = assignment.indexOf('mask');
        for (let x = 0; x < 3; x++) {
          const own = assignment.indexOf(CHARACTERS[x]!);
          const inMask = counts[mask]![x]!;
          const inOwn = counts[own]![x]!;
          weight *= choose(12 - inOwn - inMask, 3 - inMask);
        }
      }
      return { assignment, weight };
    });
    const total = weighted.reduce((a, w) => a + w.weight, 0);
    return total > 0 ? weighted.map((w) => ({ ...w, weight: w.weight / total })) : weighted.map((w) => ({ ...w, weight: 1 / 24 }));
  }

  /** Probability that each physical pile has each identity: [pile][identity]. */
  identities(): number[][] {
    const derived = this.derive();
    if (derived.identities) return derived.identities;
    const out = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
    for (const { assignment, weight } of this.identityWeights()) {
      assignment.forEach((id, p) => {
        out[p]![IDENTITIES.indexOf(id)]! += weight;
      });
    }
    derived.identities = out;
    return out;
  }

  /** Probability that a card was dealt into each physical pile. */
  originProbabilities(card: CardId): readonly number[] {
    const known = this.origin.get(card);
    if (known !== undefined) return ONE_PILE[known]!;
    // The same for every card of a character whose origin isn't known.
    const { counts, weights, byCharacter } = this.derive();
    const character = CARDS[card].character;
    const cached = byCharacter.get(character);
    if (cached) return cached;
    const x = CHARACTERS.indexOf(character);
    const out = [0, 0, 0, 0];
    byCharacter.set(character, out);
    for (const { assignment, weight } of weights) {
      if (weight === 0) continue;
      const mask = assignment.indexOf('mask');
      const own = assignment.indexOf(CARDS[card].character);
      const inMask = counts[mask]![x]!;
      const unknown = 12 - counts[own]![x]! - inMask;
      // Clamped: contradictory evidence (it shouldn't happen) must still give probabilities.
      const share = unknown > 0 ? (3 - inMask) / unknown : 0;
      const toMask = this.sound ? Math.min(1, Math.max(0, share)) : share;
      out[mask]! += weight * toMask;
      out[own]! += weight * (1 - toMask);
    }
    return out;
  }

  /** Unseen cards still in each physical pile (dealt there, position unknown or not yet seen). */
  unseenIn(p: number): number {
    const pile = this.piles[p]!;
    return pile.size - pile.members.size;
  }

  /**
   * Where each card is, as this player sees it. Located cards are certain;
   * unlocated ones are spread over the piles (by current position) and the
   * opponent's hidden cards.
   */
  locations(view: PlayerView): Map<CardId, Location> {
    const table = this.locationTable(view);
    const out = new Map<CardId, Location>();
    CARD_IDS.forEach((card, c) => {
      const loc: Location = {};
      PLACES.forEach((place, i) => {
        const v = table[c * PLACES.length + i]!;
        if (v > 0) loc[place] = v;
      });
      out.set(card, loc);
    });
    return out;
  }

  /** locations() as a flat table: [card (CARD_IDS order)][place (PLACES order)] → probability. */
  locationTable(view: PlayerView): Float32Array {
    const P = PLACES.length;
    const out = new Float32Array(CARD_IDS.length * P);
    const located = new Uint8Array(CARD_IDS.length);
    const set = (card: CardId, place: number, q = 1) => {
      const row = CARD_INDEX.get(card)! * P;
      out.fill(0, row, row + P);
      out[row + place] = q;
      located[row / P] = 1;
    };
    for (const card of view.hands[this.me]!.cards ?? []) set(card, PLACE.myHand);
    for (const keep of view.keeps) {
      const mine = keep.seat === this.me;
      for (const c of keep.cards) {
        if (!c.id) continue;
        if (c.faceDown) set(c.id, mine ? PLACE.myKeepFaceDown : PLACE.opponentKeepFaceDown);
        else set(c.id, mine ? PLACE.myKeep : PLACE.opponentKeep);
      }
    }
    for (const card of view.discard) set(card, PLACE.discard);
    const hidden = this.opponentHidden.reduce((a, b) => a + b, 0);
    for (const card of this.opponentKnown) {
      if (located[CARD_INDEX.get(card)!]) continue;
      if (this.opponentMaybeHidden.has(card)) {
        // Still in their hand, or the card they hid face down.
        const q = 1 / (this.opponentMaybeHidden.size + hidden);
        set(card, PLACE.opponentHand, 1 - q);
        out[CARD_INDEX.get(card)! * P + PLACE.opponentHidden] = q;
      } else set(card, PLACE.opponentHand);
    }
    for (let position = 0; position < 4; position++) {
      const place = PLACE.pile0 + ((position - this.me + 4) % 4);
      const top = view.piles[position]!.top;
      if (top) set(top, place);
      for (const card of this.piles[this.pileAt(position as Seat)]!.members) if (!located[CARD_INDEX.get(card)!]) set(card, place);
    }
    CARD_IDS.forEach((card, c) => {
      if (located[c]) return;
      const row = c * P;
      const origins = this.originProbabilities(card);
      let sum = 0;
      for (let position = 0; position < 4; position++) {
        const p = this.pileAt(position as Seat);
        const unseen = this.unseenIn(p);
        const inHand = this.opponentHidden[p]!;
        const total = unseen + inHand;
        if (origins[p]! === 0 || total <= 0) continue;
        const place = PLACE.pile0 + ((position - this.me + 4) % 4);
        out[row + place]! += origins[p]! * (unseen / total);
        out[row + PLACE.opponentHidden]! += origins[p]! * (inHand / total);
        sum += origins[p]!;
      }
      if (sum > 0) for (let i = 0; i < P; i++) out[row + i]! /= sum;
      else out[row + PLACE.other] = 1;
    });
    return out;
  }
}

/** Places a card can be, from one player's point of view; piles by position relative to them (0 = theirs, 1 = left, …). */
export const PLACES = [
  'my-hand',
  'my-keep',
  'opponent-keep',
  'my-keep-face-down',
  'opponent-keep-face-down',
  'discard',
  'opponent-hand',
  'opponent-hidden',
  'pile-0',
  'pile-1',
  'pile-2',
  'pile-3',
  'other',
] as const;
export type Place = (typeof PLACES)[number];
export type Location = Partial<Record<Place, number>>;

export const pilePlace = (me: Seat, position: Seat): Place => `pile-${(position - me + 4) % 4}` as Place;

const PLACE = {
  myHand: PLACES.indexOf('my-hand'),
  myKeep: PLACES.indexOf('my-keep'),
  opponentKeep: PLACES.indexOf('opponent-keep'),
  myKeepFaceDown: PLACES.indexOf('my-keep-face-down'),
  opponentKeepFaceDown: PLACES.indexOf('opponent-keep-face-down'),
  discard: PLACES.indexOf('discard'),
  opponentHand: PLACES.indexOf('opponent-hand'),
  opponentHidden: PLACES.indexOf('opponent-hidden'),
  pile0: PLACES.indexOf('pile-0'),
  other: PLACES.indexOf('other'),
};
const ONE_PILE: readonly (readonly number[])[] = [0, 1, 2, 3].map((known) => [0, 1, 2, 3].map((p) => (p === known ? 1 : 0)));
const CARD_INDEX = new Map(CARD_IDS.map((card, i) => [card, i]));

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}
