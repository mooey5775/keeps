import { CARDS, type CardId, type Seat, type TraceEvent } from '@keeps/engine';

// What has happened, from one player's log, anchored to the things it happened
// to (for observation v2): each card's last move and whether the opponent knows
// where it is now; each physical pile's recent events and whether the opponent
// knows its top or its order; and the opponent's recent turns. No inference:
// only what the log says. The belief owns one and feeds it every event (with
// the pile positions as they were at that moment).

/** Places a card moves between, relative to the player. */
export const MOVE_PLACES = ['my-hand', 'opp-hand', 'my-keep', 'opp-keep', 'discard', 'pile-own', 'pile-left', 'pile-opposite', 'pile-right', 'limbo'] as const;
export type MovePlace = (typeof MOVE_PLACES)[number];

/** How a card moved. */
export const MOVE_KINDS = ['draw', 'take', 'play', 'discard', 'give', 'steal', 'swap', 'hide', 'reveal', 'place-on-pile'] as const;
export type MoveKind = (typeof MOVE_KINDS)[number];

/** Things that happen to a pile. */
export const PILE_EVENTS = ['drawn', 'top-looked', 'searched', 'taken-from', 'placed-on', 'moved', 'flipped', 'reordered'] as const;
export type PileEventKind = (typeof PILE_EVENTS)[number];

export const PILE_HISTORY = 3;
export const OPPONENT_TURNS = 6;

export interface CardMove {
  kind: MoveKind;
  byMe: boolean;
  from: MovePlace;
  to: MovePlace;
  turn: number;
}

export interface PileEvent {
  kind: PileEventKind;
  byMe: boolean;
  turn: number;
}

export interface OpponentTurn {
  turn: number;
  handAtStart: number;
  draws: number;
  keepToOwn: number;
  keepToMine: number;
  actionCards: number;
  abilities: number;
  passes: number;
  gained: number;
}

/** What History needs from the belief: pile mapping and the opponent's hand tally, at the event's moment. */
export interface PileMap {
  readonly me: Seat;
  readonly opponent: Seat;
  physicalAt(position: Seat): number;
  opponentHandTally(): number;
}

export class History {
  /** Turns started this round. */
  turn = 0;
  readonly lastMove = new Map<CardId, CardMove>();
  /** Cards whose current place the opponent knows. */
  readonly opponentKnows = new Set<CardId>();
  /** By physical pile. */
  pileEvents: PileEvent[][] = [[], [], [], []];
  opponentKnowsTop = [false, false, false, false];
  opponentKnowsOrder = [false, false, false, false];
  opponentTurns: OpponentTurn[] = [];
  private readonly myHand = new Set<CardId>();
  private readonly lastPlayed = new Map<Seat, CardId>();
  private readonly lastLooked = new Map<Seat, Seat[]>();

  /** An independent copy. */
  clone(): History {
    const copy = new History();
    for (const [key, value] of Object.entries(this)) (copy as unknown as Record<string, unknown>)[key] = structuredClone(value);
    return copy;
  }

  private reset(): void {
    this.turn = 0;
    this.lastMove.clear();
    this.opponentKnows.clear();
    this.pileEvents = [[], [], [], []];
    this.opponentKnowsTop = [false, false, false, false];
    this.opponentKnowsOrder = [false, false, false, false];
    this.opponentTurns = [];
    this.myHand.clear();
    this.lastPlayed.clear();
    this.lastLooked.clear();
  }

  record(e: TraceEvent['payload'], map: PileMap): void {
    const me = map.me;
    const hand = (seat: Seat): MovePlace => (seat === me ? 'my-hand' : 'opp-hand');
    const keep = (seat: Seat): MovePlace => (seat === me ? 'my-keep' : 'opp-keep');
    const pile = (position: Seat): MovePlace => (['pile-own', 'pile-left', 'pile-opposite', 'pile-right'] as const)[(position - me + 4) % 4]!;
    const byMe = (seat: Seat) => seat === me;
    const pileEvent = (position: Seat, kind: PileEventKind, seat: Seat) => {
      const p = map.physicalAt(position);
      this.pileEvents[p] = [{ kind, byMe: byMe(seat), turn: this.turn }, ...this.pileEvents[p]!].slice(0, PILE_HISTORY);
    };
    const move = (card: CardId | null, kind: MoveKind, seat: Seat, from: MovePlace, to: MovePlace, public_: boolean) => {
      if (!card) return;
      this.lastMove.set(card, { kind, byMe: byMe(seat), from, to, turn: this.turn });
      if (from === 'my-hand') this.myHand.delete(card);
      if (to === 'my-hand') this.myHand.add(card);
      // The opponent knows where it is now if it moved in public, or into their own hand.
      if (public_ || to === 'opp-hand') this.opponentKnows.add(card);
      else this.opponentKnows.delete(card);
    };
    const current = () => this.opponentTurns[0];

    switch (e.type) {
      case 'round-start':
        this.reset();
        return;
      case 'turn-start':
        this.turn++;
        if (e.seat === map.opponent) {
          this.opponentTurns = [
            { turn: this.turn, handAtStart: map.opponentHandTally(), draws: 0, keepToOwn: 0, keepToMine: 0, actionCards: 0, abilities: 0, passes: 0, gained: 0 },
            ...this.opponentTurns,
          ].slice(0, OPPONENT_TURNS);
        }
        return;
      case 'action': {
        const row = current();
        if (e.seat !== map.opponent || !row) return;
        const c = e.choice;
        if (c.action === 'draw') row.draws++;
        else if (c.action === 'pass') row.passes++;
        else if (c.action === 'ability') row.abilities++;
        else if (CARDS[c.card].keep) {
          if (c.target === me) row.keepToMine++;
          else row.keepToOwn++;
        } else row.actionCards++;
        return;
      }
      case 'draw': {
        const p = map.physicalAt(e.from);
        // We drew a card the opponent knew was on top: they know we have it.
        const theyKnew = this.opponentKnowsTop[p]!;
        move(e.card, 'draw', e.seat, pile(e.from), hand(e.seat), e.seat !== me ? false : theyKnew);
        pileEvent(e.from, 'drawn', e.seat);
        this.opponentKnowsTop[p] = this.opponentKnowsOrder[p]!;
        return;
      }
      case 'take': {
        if (e.from === 'discard') {
          move(e.card, 'take', e.seat, 'discard', hand(e.seat), true);
        } else {
          const p = map.physicalAt(e.from.pile);
          move(e.card, 'take', e.seat, pile(e.from.pile), hand(e.seat), false);
          pileEvent(e.from.pile, 'taken-from', e.seat);
          this.opponentKnowsTop[p] = this.opponentKnowsOrder[p]!;
        }
        if (e.seat === map.opponent && current()) current()!.gained++;
        return;
      }
      case 'play':
        this.lastPlayed.set(e.seat, e.copy ?? e.card);
        move(e.card, 'play', e.seat, hand(e.seat), e.target === null ? 'limbo' : keep(e.target), true);
        return;
      case 'discard':
        for (const card of e.cards) {
          const from = e.from === 'hand' ? hand(e.seat) : e.from === 'keep' ? keep(e.seat) : pile((this.lastLooked.get(e.seat) ?? [map.me])[0]!);
          move(card, 'discard', e.seat, from, 'discard', true);
        }
        if (e.from === 'pile') {
          const [position] = this.lastLooked.get(e.seat) ?? [];
          if (position !== undefined) {
            const p = map.physicalAt(position);
            pileEvent(position, 'taken-from', e.seat);
            this.opponentKnowsTop[p] = this.opponentKnowsOrder[p]!;
          }
        }
        return;
      case 'keep-swap':
        move(e.a.card, 'swap', e.seat, keep(e.a.seat), keep(e.b.seat), true);
        move(e.b.card, 'swap', e.seat, keep(e.b.seat), keep(e.a.seat), true);
        return;
      case 'place-on-pile': {
        move(e.card, 'place-on-pile', e.seat, keep(e.seat), pile(e.pile), true);
        pileEvent(e.pile, 'placed-on', e.seat);
        this.opponentKnowsTop[map.physicalAt(e.pile)] = true; // placed face up
        return;
      }
      case 'steal':
        for (const card of e.cards ?? []) move(card, 'steal', e.seat, hand(e.from), hand(e.seat), true);
        if (e.seat === map.opponent && current()) current()!.gained += e.count;
        return;
      case 'give':
        move(e.card, 'give', e.seat, hand(e.seat), hand(e.to), true);
        return;
      case 'look-hands':
        // The opponent's Pluck: they've seen our whole hand.
        if (e.seat === map.opponent) for (const card of this.myHand) this.opponentKnows.add(card);
        return;
      case 'reveal-card':
        this.opponentKnows.add(e.card);
        return;
      case 'place-face-down':
        move(e.card, 'hide', e.seat, hand(e.seat), keep(e.target), false);
        return;
      case 'reveal': {
        const before = this.lastMove.get(e.card);
        move(e.card, 'reveal', e.seat, before?.to ?? keep(e.keep), keep(e.keep), true);
        return;
      }
      case 'look': {
        this.lastLooked.set(e.seat, e.piles);
        // Requisition searches a whole pile; Prayer and Epiphany look at tops.
        const whole = this.lastPlayed.get(e.seat) === 'requisition' && e.piles.length === 1;
        for (const position of e.piles) {
          pileEvent(position, whole ? 'searched' : 'top-looked', e.seat);
          if (e.seat === map.opponent) {
            const p = map.physicalAt(position);
            this.opponentKnowsTop[p] = true;
            if (whole) this.opponentKnowsOrder[p] = true;
          }
        }
        return;
      }
      case 'pile-flip': {
        pileEvent(e.pile, 'flipped', e.seat);
        const p = map.physicalAt(e.pile);
        this.opponentKnowsTop[p] = true; // its top now lies face up
        this.opponentKnowsOrder[p] = false;
        return;
      }
      case 'pile-reorder': {
        pileEvent(e.pile, 'reordered', e.seat);
        const p = map.physicalAt(e.pile);
        const theirs = e.seat === map.opponent;
        this.opponentKnowsTop[p] = theirs;
        this.opponentKnowsOrder[p] = theirs;
        return;
      }
      case 'pile-swap':
        pileEvent(e.a, 'moved', e.seat);
        pileEvent(e.b, 'moved', e.seat);
        return;
      case 'pile-rotate':
        for (const position of [0, 1, 2, 3] as Seat[]) pileEvent(position, 'moved', e.seat);
        return;
      case 'piles-to-center':
        for (const position of [0, 1, 2, 3] as Seat[]) pileEvent(position, 'moved', e.seat);
        return;
      default:
        return;
    }
  }
}
