import { cardName, type CardId } from './cards.ts';
import type { ActionChoice } from './commands.ts';
import { rotatedFrom, SEATS } from './state.ts';
import type {
  ActionFrameOp,
  GameState,
  KeepRef,
  PileId,
  PromptKind,
  Seat,
  SeatKind,
  TriggerKind,
} from './state.ts';

// Every state change emits a TraceEvent. Events record what caused them
// (`cause`), how deep in the resolution they happened (`depth`), and who may
// see them (`visibility`, with an optional `redacted` payload for everyone
// else). Player-facing logs are this same stream filtered by eventsFor().

export type TracePayload =
  | { type: 'game-start'; seats: SeatKind[]; marksToWin: number }
  | { type: 'round-start'; round: number; startingSeat: Seat }
  /** Server-only: the hidden contents of a freshly dealt pile, top first. */
  | { type: 'pile-dealt'; position: Seat; pile: PileId; cards: CardId[] }
  /** Public counterpart of pile-dealt. */
  | { type: 'pile-placed'; position: Seat; size: number }
  | { type: 'turn-start'; seat: Seat; actions: number }
  | { type: 'turn-end'; seat: Seat }
  | { type: 'prompt'; seat: Seat; kind: PromptKind; card?: CardId }
  /** An action spent from a frame; `remaining` is what the frame has left afterward. */
  | { type: 'action'; seat: Seat; frame: ActionFrameOp['kind']; remaining: number; choice: ActionChoice }
  /** `card` is null in the redacted copy other players see. */
  | { type: 'draw'; seat: Seat; from: Seat; card: CardId | null }
  | { type: 'empty-draw'; seat: Seat; from: Seat; afterRoundEnd: boolean }
  | { type: 'play'; seat: Seat; card: CardId; target: Seat | null; hot: boolean; copy?: CardId }
  | { type: 'extra-actions'; seat: Seat; count: number; source: CardId }
  | { type: 'pile-swap'; seat: Seat; a: Seat; b: Seat }
  | { type: 'pile-rotate'; seat: Seat; direction: 'left' | 'right' }
  | { type: 'pile-flip'; seat: Seat; pile: Seat }
  /** `seat` privately looks at cards; `cards` is null in the redacted copy. */
  | { type: 'look'; seat: Seat; piles: Seat[]; cards: CardId[] | null }
  /** A card moves into `seat`'s hand from a pile or the discard (not a draw). */
  | { type: 'take'; seat: Seat; card: CardId | null; from: { pile: Seat } | 'discard' }
  | { type: 'discard'; seat: Seat; cards: CardId[]; from: 'hand' | 'keep' | 'pile' }
  /** Card ids are null for face-down cards in the public copy. */
  | { type: 'keep-swap'; seat: Seat; a: KeepRef & { card: CardId | null }; b: KeepRef & { card: CardId | null } }
  /** `order` is null in the redacted copy. */
  | { type: 'pile-reorder'; seat: Seat; pile: Seat; order: CardId[] | null }
  | { type: 'place-on-pile'; seat: Seat; card: CardId; pile: Seat }
  | { type: 'no-effect'; seat: Seat; card: CardId; reason: string }
  /** `seat` takes `cards` from `from`'s hand. `cards` is null in a redacted copy. */
  | { type: 'steal'; seat: Seat; from: Seat; cards: CardId[] | null; count: number }
  /** `seat` gives `card` to `to` (null when redacted). */
  | { type: 'give'; seat: Seat; to: Seat; card: CardId | null }
  /** Other players' hands revealed to `seat` only (Pluck). */
  | { type: 'look-hands'; seat: Seat; hands: { seat: Seat; cards: CardId[] }[] | null }
  /** `seat` reveals a card from their hand to everyone (Joker). */
  | { type: 'reveal-card'; seat: Seat; card: CardId }
  | { type: 'piles-to-center'; seat: Seat }
  | { type: 'pile-claim'; seat: Seat; claimant: Seat; from: Seat }
  | { type: 'last-laugh'; seat: Seat }
  /** Duplicity: `seat` places a card face down in `target`'s keep (`card` null when redacted). */
  | { type: 'place-face-down'; seat: Seat; target: Seat; card: CardId | null }
  /** `seat` reveals the face-down card in `keep`'s keep. */
  | { type: 'reveal'; seat: Seat; keep: Seat; card: CardId }
  /** A revealed Shackles cuts the current turn to one action. */
  | { type: 'shackled'; seat: Seat; remaining: number }
  /** After `card`'s play resolved, these triggers were queued (in resolution order). */
  | { type: 'triggers'; card: CardId; triggers: { kind: TriggerKind; seat: Seat }[] }
  | { type: 'trigger'; kind: TriggerKind; seat: Seat; source: CardId }
  | { type: 'round-end'; reason: 'empty-pile'; ender: Seat }
  | { type: 'round-end'; reason: 'tokens'; winner: Seat }
  | { type: 'round-end'; reason: 'left'; seat: Seat }
  /** A player left the game, giving it up: their seat is a ghost from now on. */
  | { type: 'left'; seat: Seat }
  /** Scores in half-coins; null for ghost seats. */
  | { type: 'score'; scores: (number | null)[]; winner: Seat; tiedWith: Seat[] }
  | { type: 'mark'; seat: Seat; marks: number }
  | { type: 'game-over'; winner: Seat }
  | { type: 'note'; text: string };

export type TraceType = TracePayload['type'];

/** 'all', or the seats allowed to see the full event. [] = server only. */
export type Visibility = 'all' | readonly Seat[];

export interface TraceEvent {
  seq: number;
  round: number;
  turn: number;
  depth: number;
  /** seq of the event that caused this one, if any. */
  cause: number | null;
  visibility: Visibility;
  payload: TracePayload;
  /** What viewers outside `visibility` see instead. Absent = they see nothing. */
  redacted?: TracePayload;
  /** Set on events produced by eventsFor() when the viewer got the redacted payload. */
  wasRedacted?: true;
}

export interface EmitOptions {
  visibility?: Visibility;
  redacted?: TracePayload;
  /** Overrides the cause inherited from the enclosing within() call. */
  cause?: number | null;
}

/**
 * Collects events for one engine call. Sequence numbers are stored in the
 * state, so they keep increasing across calls.
 */
export class Tracer {
  readonly events: TraceEvent[] = [];
  private depth = 0;
  private cause: number | null = null;

  private readonly state: GameState;

  constructor(state: GameState) {
    this.state = state;
  }

  emit(payload: TracePayload, options: EmitOptions = {}): number {
    const seq = ++this.state.traceSeq;
    const event: TraceEvent = {
      seq,
      round: this.state.round,
      turn: this.state.turnNumber,
      depth: this.depth,
      cause: options.cause !== undefined ? options.cause : this.cause,
      visibility: options.visibility ?? 'all',
      payload,
    };
    if (options.redacted) event.redacted = options.redacted;
    this.events.push(event);
    return seq;
  }

  /** The cause and depth new events (and ops pushed now) inherit. */
  context(): { cause: number | null; depth: number } {
    return { cause: this.cause, depth: this.depth };
  }

  /** Runs fn with the given default cause and absolute depth, then restores them. */
  at<T>(cause: number | null, depth: number, fn: () => T): T {
    const saved = { cause: this.cause, depth: this.depth };
    this.cause = cause;
    this.depth = depth;
    try {
      return fn();
    } finally {
      this.cause = saved.cause;
      this.depth = saved.depth;
    }
  }

  /** Runs fn one level deeper, with `cause` as the default cause of its events. */
  within<T>(cause: number, fn: () => T): T {
    return this.at(cause, this.depth + 1, fn);
  }
}

/** 'server' sees everything; 'spectator' sees only public events (and redacted copies). */
export type TraceViewer = Seat | 'server' | 'spectator';

export function canSee(event: TraceEvent, viewer: TraceViewer): boolean {
  if (viewer === 'server' || event.visibility === 'all') return true;
  return viewer !== 'spectator' && event.visibility.includes(viewer);
}

/**
 * The events a viewer may see. Hidden events are replaced by their redacted
 * payload, or dropped if they have none. The original payload never leaks.
 */
export function eventsFor(events: readonly TraceEvent[], viewer: TraceViewer): TraceEvent[] {
  const out: TraceEvent[] = [];
  for (const event of events) {
    if (canSee(event, viewer)) {
      const { redacted: _omit, ...visible } = event;
      out.push(viewer === 'server' ? event : visible);
    } else if (event.redacted) {
      const { redacted, payload: _hidden, ...base } = event;
      out.push({ ...base, payload: redacted, wasRedacted: true });
    }
  }
  return out;
}

export function seatLabel(seat: Seat): string {
  return `S${seat}`;
}

function cardList(ids: readonly CardId[]): string {
  return ids.length === 0 ? '(none)' : ids.map(cardName).join(', ');
}

/** Formats half-coins as coins: 9 → "4.5". */
export function coinsLabel(halfCoins: number): string {
  return String(halfCoins / 2);
}

function describeChoice(choice: ActionChoice): string {
  switch (choice.action) {
    case 'draw':
      return 'draw';
    case 'play':
      if (choice.copy) return `play ${cardName(choice.card)} as ${cardName(choice.copy)}`;
      return choice.target === undefined
        ? `play ${cardName(choice.card)}`
        : `play ${cardName(choice.card)} → keep(${seatLabel(choice.target)})`;
    case 'pass':
      return 'pass (decline the action)';
    case 'ability':
      switch (choice.card) {
        case 'juggling':
          return `use Juggling: swap piles @${seatLabel(choice.piles[0])} and @${seatLabel(choice.piles[1])}`;
        case 'sanction':
          return `use Sanction: draw from pile@${seatLabel(choice.from)}`;
        case 'acquisition':
          return `use Acquisition: discard ${cardName(choice.discard)}, draw ${choice.first} pile first`;
        case 'shackles':
          return 'use Shackles: discard it';
        case 'tithes':
          return 'use Tithes: discard all Coin cards, reorder pile';
        case 'blunder':
          return `use Blunder (2 actions): place it on pile@${seatLabel(choice.pile)}`;
        default:
          return assertNever(choice);
      }
    default:
      return assertNever(choice);
  }
}

function keepRefLabel(ref: KeepRef & { card: CardId | null }): string {
  return `${ref.card ? cardName(ref.card) : 'a face-down card'} (keep ${seatLabel(ref.seat)})`;
}

export function describe(payload: TracePayload): string {
  switch (payload.type) {
    case 'game-start':
      return `game start: seats [${payload.seats.join(', ')}], first to ${payload.marksToWin} marks`;
    case 'round-start':
      return `round ${payload.round} start: ${seatLabel(payload.startingSeat)} goes first`;
    case 'pile-dealt':
      return `pile '${payload.pile}' dealt to ${seatLabel(payload.position)} (top first): ${cardList(payload.cards)}`;
    case 'pile-placed':
      return `a pile of ${payload.size} cards placed at ${seatLabel(payload.position)}`;
    case 'turn-start':
      return `${seatLabel(payload.seat)} turn start (${payload.actions} action${payload.actions === 1 ? '' : 's'})`;
    case 'turn-end':
      return `${seatLabel(payload.seat)} turn end`;
    case 'prompt':
      return `waiting on ${seatLabel(payload.seat)}: ${payload.kind}${payload.card ? ` (${cardName(payload.card)})` : ''}`;
    case 'action':
      return `${seatLabel(payload.seat)} action [${payload.frame}, ${payload.remaining} left]: ${describeChoice(payload.choice)}`;
    case 'draw':
      return `${seatLabel(payload.seat)} draws ${payload.card ? cardName(payload.card) : 'a card'} from pile@${seatLabel(payload.from)}`;
    case 'empty-draw':
      return `${seatLabel(payload.seat)} draws from EMPTY pile@${seatLabel(payload.from)}${payload.afterRoundEnd ? ' (round already over: no effect)' : ''}`;
    case 'play':
      return `${seatLabel(payload.seat)} plays ${cardName(payload.card)}${payload.copy ? ` as ${cardName(payload.copy)}` : ''}${payload.hot ? ' (HOT!)' : ''}${payload.target !== null ? ` → keep(${seatLabel(payload.target)})` : ' → discard'}`;
    case 'extra-actions':
      return `${seatLabel(payload.seat)} gets ${payload.count} actions from ${cardName(payload.source)}`;
    case 'pile-swap':
      return `piles @${seatLabel(payload.a)} and @${seatLabel(payload.b)} swap places`;
    case 'pile-rotate':
      // Who gets whose pile, not only which way: "left" means little where the seats aren't drawn around a table.
      return `every pile passes ${payload.direction} (${payload.direction === 'left' ? 'on, in play order' : 'back, against play order'}): ${SEATS.map((s) => `${seatLabel(s)} gets pile@${seatLabel(rotatedFrom(s, payload.direction))}`).join(', ')}`;
    case 'pile-flip':
      return `pile@${seatLabel(payload.pile)} is flipped upside down`;
    case 'look':
      return `${seatLabel(payload.seat)} looks at ${payload.cards ? cardList(payload.cards) : 'cards'} (pile${payload.piles.length === 1 ? '' : 's'} ${payload.piles.map((p) => `@${seatLabel(p)}`).join(', ')})`;
    case 'take':
      return `${seatLabel(payload.seat)} takes ${payload.card ? cardName(payload.card) : 'a card'} from ${payload.from === 'discard' ? 'the discard' : `pile@${seatLabel(payload.from.pile)}`}`;
    case 'discard':
      return `${seatLabel(payload.seat)} discards ${cardList(payload.cards)} from ${payload.from}`;
    case 'keep-swap':
      return `swap ${keepRefLabel(payload.a)} ⇄ ${keepRefLabel(payload.b)}`;
    case 'pile-reorder':
      return `${seatLabel(payload.seat)} reorders pile@${seatLabel(payload.pile)}${payload.order ? ` (top first): ${cardList(payload.order)}` : ''}`;
    case 'place-on-pile':
      return `${seatLabel(payload.seat)} places ${cardName(payload.card)} face-up on pile@${seatLabel(payload.pile)}`;
    case 'no-effect':
      return `${cardName(payload.card)} has no effect: ${payload.reason}`;
    case 'steal':
      return `${seatLabel(payload.seat)} takes ${payload.cards ? cardList(payload.cards) : `${payload.count} card${payload.count === 1 ? '' : 's'}`} from ${seatLabel(payload.from)}'s hand`;
    case 'give':
      return `${seatLabel(payload.seat)} gives ${payload.card ? cardName(payload.card) : 'a card'} to ${seatLabel(payload.to)}`;
    case 'look-hands':
      return `${seatLabel(payload.seat)} sees ${payload.hands ? payload.hands.map((h) => `${seatLabel(h.seat)}: ${cardList(h.cards)}`).join('; ') : "the other players' hands"}`;
    case 'reveal-card':
      return `${seatLabel(payload.seat)} reveals ${cardName(payload.card)}`;
    case 'piles-to-center':
      return 'all piles are pushed to the center';
    case 'pile-claim':
      return payload.seat === payload.claimant
        ? `${seatLabel(payload.seat)} claims the pile from @${seatLabel(payload.from)}`
        : `${seatLabel(payload.seat)} places the pile from @${seatLabel(payload.from)} at ${seatLabel(payload.claimant)}`;
    case 'last-laugh':
      return `LAST LAUGH: ${seatLabel(payload.seat)} may take one action before scoring`;
    case 'place-face-down':
      return `${seatLabel(payload.seat)} places ${payload.card ? cardName(payload.card) : 'a card'} face down in keep(${seatLabel(payload.target)})`;
    case 'reveal':
      return `${seatLabel(payload.seat)} reveals the face-down card in keep(${seatLabel(payload.keep)}): ${cardName(payload.card)}`;
    case 'shackled':
      return `${seatLabel(payload.seat)} is Shackled: ${payload.remaining} action${payload.remaining === 1 ? '' : 's'} left this turn`;
    case 'triggers':
      return `after ${cardName(payload.card)}: triggers → [${payload.triggers.map((t) => `${t.kind}(${seatLabel(t.seat)})`).join(', ')}]`;
    case 'trigger':
      return payload.kind === 'retribution'
        ? `RETRIBUTION: ${seatLabel(payload.seat)} must take two actions now`
        : `${payload.kind === 'interest' ? 'INTEREST' : 'ROYAL FAVOR'}: ${seatLabel(payload.seat)} draws from their pile`;
    case 'round-end':
      return payload.reason === 'empty-pile'
        ? `ROUND END: ${seatLabel(payload.ender)} drew from an empty pile`
        : payload.reason === 'tokens'
          ? `ROUND END: token victory for ${seatLabel(payload.winner)}`
          : `ROUND END: ${seatLabel(payload.seat)} left; no one wins the round`;
    case 'left':
      return `${seatLabel(payload.seat)} leaves the game`;
    case 'score': {
      const scores = payload.scores
        .map((s, seat) => (s === null ? null : `${seatLabel(seat as Seat)}=${coinsLabel(s)}`))
        .filter((s) => s !== null)
        .join(' ');
      const tie = payload.tiedWith.length > 0 ? ` (tie-break over ${payload.tiedWith.map(seatLabel).join(',')})` : '';
      return `score: ${scores} → ${seatLabel(payload.winner)} wins${tie}`;
    }
    case 'mark':
      return `${seatLabel(payload.seat)} earns a victory mark (${payload.marks} total)`;
    case 'game-over':
      return `GAME OVER: ${seatLabel(payload.winner)} wins`;
    case 'note':
      return payload.text;
    default:
      return assertNever(payload);
  }
}

function visibilityTag(visibility: Visibility): string {
  if (visibility === 'all') return '';
  if (visibility.length === 0) return '  [server only]';
  return `  [private: ${visibility.map(seatLabel).join(',')}]`;
}

/**
 * Human-readable trace, one event per line, indented by depth:
 *   #12   R1 T3    S0 plays Royal Favor → keep(S2)   ← #11  [private: S0]
 */
export function formatTrace(events: readonly TraceEvent[]): string {
  return events
    .map((e) => {
      const head = `#${e.seq}`.padEnd(6) + `R${e.round} T${e.turn}`.padEnd(8);
      const body = '  '.repeat(e.depth) + describe(e.payload);
      const cause = e.cause !== null ? `  ← #${e.cause}` : '';
      const redacted = e.wasRedacted ? '  (redacted)' : '';
      return head + body + cause + visibilityTag(e.visibility) + redacted;
    })
    .join('\n');
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}
