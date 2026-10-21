import { isCoinCard, type CardId } from './cards.ts';
import type { Ctx } from './context.ts';
import { hasFaceUp, openPrompt } from './moves.ts';
import { SEATS, type GameState, type PlayRecord, type Seat, type WindowReason } from './state.ts';

// Duplicity: "If DUPLICITY is in your keep, you may reveal the face-down card
// at any time, but it does not take effect until then."
//
// Revealing is a free command whenever the engine is waiting for input. Some
// clarifications need a reveal *during* an automatic chain (C-13, C-15) or at
// round end (C-03, C-12, C-24), so the engine also opens reveal windows at
// those points. Windows depend only on public information, so their opening
// never hints at what the face-down card is.

/** The face-down card (there is at most one), if any. */
export function faceDownCard(state: GameState): { seat: Seat; index: number; card: CardId } | null {
  for (const seat of SEATS) {
    const index = state.keeps[seat].findIndex((c) => c.faceDown);
    if (index >= 0) return { seat, index, card: state.keeps[seat][index]!.id };
  }
  return null;
}

/** The seat that may reveal: whoever has Duplicity face-up, while a face-down card exists. */
export function duplicityHolder(state: GameState): Seat | null {
  if (!faceDownCard(state)) return null;
  return SEATS.find((s) => hasFaceUp(state, s, 'duplicity')) ?? null;
}

/** Whether `seat` may send `reveal-duplicity` now (outside a reveal window, which has its own answer). */
export function canReveal(state: GameState, seat: Seat): boolean {
  return (
    (state.phase === 'playing' || state.phase === 'post-round') &&
    state.prompts.length > 0 &&
    !state.prompts.some((p) => p.kind === 'reveal-window') &&
    duplicityHolder(state) === seat
  );
}

/**
 * A play gets a reveal window if the face-down card was already in place when
 * it started, and the play either moved a Coin card into that keep (so a hidden
 * Interest could respond) or changed that keep owner's hand or keep (so a
 * hidden Retribution could).
 */
export function needsPlayWindow(state: GameState, record: PlayRecord): boolean {
  const hidden = faceDownCard(state);
  if (!record.hidden || !hidden || duplicityHolder(state) === null) return false;
  const keep = hidden.seat;
  return (
    record.entries.some((e) => e.seat === keep && isCoinCard(e.card)) ||
    (keep !== record.actor && record.changed.includes(keep))
  );
}

export function runWindow(ctx: Ctx, reason: WindowReason, playId: number | null): void {
  const holder = duplicityHolder(ctx.state);
  if (holder !== null) openPrompt(ctx, { seat: holder, kind: 'reveal-window', reason, playId });
}

/**
 * Turns the face-down card face up. Revealing never triggers anything by
 * itself (C-16, C-17), except:
 * - in a play's window, a revealed Interest or Retribution responds to that
 *   play as if it had been face-up all along (C-13, C-15);
 * - a revealed Shackles during its owner's turn limits the turn to one action
 *   (C-14); extra actions already granted by Hocus Pocus remain (Q-07).
 * A revealed Royal Favor does not count as entering the keep (Q-06).
 */
export function reveal(ctx: Ctx, holder: Seat, playId: number | null): void {
  const { state, tracer } = ctx;
  const hidden = faceDownCard(state);
  if (!hidden) throw new Error('reveal: no face-down card');
  state.keeps[hidden.seat][hidden.index] = { id: hidden.card };
  tracer.emit({ type: 'reveal', seat: holder, keep: hidden.seat, card: hidden.card });

  // Respond to the play as the card would have, had it been face-up when the play started.
  const record = playId === null ? undefined : state.openPlays.find((p) => p.id === playId);
  const before = record?.hidden?.card === hidden.card ? record.hidden.seat : null;
  if (record && before !== null) {
    // Interest needs to have been in the keep before and after the coin arrived
    // (C-21), so only an Interest that didn't move responds.
    if (hidden.card === 'interest' && hidden.seat === before) {
      for (const entry of record.entries) if (entry.seat === before) entry.interest = true;
    }
    // Retribution answers for the keep it was in when the play started, even if
    // the play swapped it away (C-30), never for the keep that received it (Q-15).
    if (hidden.card === 'retribution' && !record.retribution.includes(before)) {
      record.retribution.push(before);
    }
  }
  if (hidden.card === 'shackles') shackle(ctx, hidden.seat);
}

function shackle(ctx: Ctx, seat: Seat): void {
  const { state, tracer } = ctx;
  if (state.phase !== 'playing' || state.turn?.seat !== seat) return;
  const frame = state.stack.findLast((op) => op.op === 'action-frame' && op.kind === 'turn' && op.seat === seat);
  if (frame?.op !== 'action-frame') return;
  const remaining = Math.max(0, Math.min(frame.remaining, 1 - state.turn.actionsTaken));
  if (remaining === frame.remaining) return;
  frame.remaining = remaining;
  tracer.emit({ type: 'shackled', seat, remaining });
  // If the player was choosing an action from that frame, that choice is gone.
  if (remaining === 0 && state.stack.at(-1) === frame) {
    state.prompts = state.prompts.filter((p) => !(p.kind === 'action' && p.seat === seat));
  }
}
