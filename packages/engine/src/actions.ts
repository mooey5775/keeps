import { needsPlayWindow } from './duplicity.ts';
import type { GameState, Op, PlayRecord, Seat } from './state.ts';

// Counting and spending a player's actions across stacked action frames.

/** Seats whose Retribution this play triggers: had it when the play started, not the actor, and changed. */
export function retributionSeats(record: PlayRecord): Seat[] {
  return record.retribution.filter((s) => s !== record.actor && record.changed.includes(s));
}

/**
 * Whether a pending op can sit between two of a player's actions without
 * breaking their run: an after-play that will give nobody actions (no
 * Retribution, no Duplicity window). Its Interest or Royal Favor draws, and
 * any HOT cards those turn up, are not actions.
 */
function passable(state: GameState, op: Op): boolean {
  if (op.op !== 'after-play') return false;
  const record = state.openPlays.find((p) => p.id === op.playId);
  if (!record) return false;
  return retributionSeats(record).length === 0 && (op.windowed === true || !needsPlayWindow(state, record));
}

/**
 * Actions `seat` can spend consecutively (C-08: "any two consecutive player
 * actions"): the remaining actions of the same-seat action frames at the top
 * of the stack, with nothing between them that would let anyone else act.
 */
export function consecutiveActions(state: GameState, seat: Seat): number {
  let total = 0;
  for (let i = state.stack.length - 1; i >= 0; i--) {
    const op = state.stack[i]!;
    if (op.op === 'action-frame' && op.seat === seat) total += op.remaining;
    else if (!passable(state, op)) break;
  }
  return total;
}

/** Spends `count` consecutive actions, top frame first. */
export function spendActions(state: GameState, seat: Seat, count: number): void {
  if (consecutiveActions(state, seat) < count) {
    throw new Error(`seat ${seat} cannot spend ${count} consecutive actions`);
  }
  let left = count;
  for (let i = state.stack.length - 1; left > 0; i--) {
    const op = state.stack[i]!;
    if (op.op !== 'action-frame') continue;
    const spent = Math.min(op.remaining, left);
    op.remaining -= spent;
    left -= spent;
  }
}
