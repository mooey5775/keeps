import { cardName, type CardId } from './cards.ts';
import type { GameState, PileId, Seat, SeatKind } from './state.ts';

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
  private readonly causes: number[] = [];

  constructor(private readonly state: GameState) {}

  emit(payload: TracePayload, options: EmitOptions = {}): number {
    const seq = ++this.state.traceSeq;
    const event: TraceEvent = {
      seq,
      round: this.state.round,
      turn: this.state.turnNumber,
      depth: this.depth,
      cause: options.cause !== undefined ? options.cause : (this.causes.at(-1) ?? null),
      visibility: options.visibility ?? 'all',
      payload,
    };
    if (options.redacted) event.redacted = options.redacted;
    this.events.push(event);
    return seq;
  }

  /** Runs fn one level deeper, with `cause` as the default cause of its events. */
  within<T>(cause: number, fn: () => T): T {
    this.causes.push(cause);
    this.depth++;
    try {
      return fn();
    } finally {
      this.depth--;
      this.causes.pop();
    }
  }
}

export function canSee(event: TraceEvent, viewer: Seat | 'server'): boolean {
  return viewer === 'server' || event.visibility === 'all' || event.visibility.includes(viewer);
}

/**
 * The events a viewer may see. Hidden events are replaced by their redacted
 * payload, or dropped if they have none. The original payload never leaks.
 */
export function eventsFor(events: readonly TraceEvent[], viewer: Seat | 'server'): TraceEvent[] {
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
