import type { GameState, OpBody, OpMeta } from './state.ts';
import type { Tracer } from './trace.ts';

/** The draft state being changed by one engine call, plus its tracer. */
export interface Ctx {
  state: GameState;
  tracer: Tracer;
}

/**
 * Pushes an op onto the resolution stack. It remembers the current trace
 * context, so events it emits later are linked to whatever pushed it.
 * Ops run last-pushed-first: to run A then B, push B then A.
 */
export function push(ctx: Ctx, op: OpBody, meta: OpMeta = ctx.tracer.context()): void {
  ctx.state.stack.push({ ...op, ...meta });
}

/** Deep copy of plain-data engine state. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
