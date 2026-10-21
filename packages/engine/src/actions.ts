import type { GameState, PlayRecord, Seat } from './state.ts';

// Counting and spending a player's actions across stacked action frames.

/** Seats whose Retribution this play triggers: had it when the play started, not the actor, and changed. */
export function retributionSeats(record: PlayRecord): Seat[] {
  return record.retribution.filter((s) => s !== record.actor && record.changed.includes(s));
}

/**
 * Actions `seat` can spend consecutively (C-08: "any two consecutive player
 * actions"): the remaining actions of the same-seat action frames at the top
 * of the stack, with nothing between them. Granted actions are scheduled below
 * the outermost pending after-play (Q-17), so frames from one player's run of
 * actions are always adjacent.
 */
export function consecutiveActions(state: GameState, seat: Seat): number {
  let total = 0;
  for (let i = state.stack.length - 1; i >= 0; i--) {
    const op = state.stack[i]!;
    if (op.op !== 'action-frame' || op.seat !== seat) break;
    total += op.remaining;
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
    if (op.op !== 'action-frame') throw new Error('unreachable: checked by consecutiveActions');
    const spent = Math.min(op.remaining, left);
    op.remaining -= spent;
    left -= spent;
  }
}
