import type { GameState, OpBody, OpMeta } from './state.ts';
import type { Tracer } from './trace.ts';

/** The draft state being changed by one engine call, plus its tracer. */
export interface Ctx {
  state: GameState;
  tracer: Tracer;
  /** The play whose resolution is running now (see OpMeta.play). */
  play: number | null;
}

export function newCtx(state: GameState, tracer: Tracer): Ctx {
  return { state, tracer, play: null };
}

/** Runs fn as part of the given play's resolution (or of none). */
export function withPlay<T>(ctx: Ctx, play: number | null, fn: () => T): T {
  const saved = ctx.play;
  ctx.play = play;
  try {
    return fn();
  } finally {
    ctx.play = saved;
  }
}

/**
 * Pushes an op onto the resolution stack. It remembers the current trace
 * context, so events it emits later are linked to whatever pushed it.
 * Ops run last-pushed-first: to run A then B, push B then A.
 */
export function push(ctx: Ctx, op: OpBody, meta: OpMeta = { ...ctx.tracer.context(), play: ctx.play }): void {
  ctx.state.stack.push({ ...op, ...meta });
}

/**
 * Schedules an op to run right after the current play finishes resolving
 * (just below its after-play op), outside that play. Used for things a card
 * grants rather than does, like Hocus Pocus's two extra actions.
 */
export function pushAfterPlay(ctx: Ctx, op: OpBody): void {
  const { stack } = ctx.state;
  const index = stack.findLastIndex((o) => o.op === 'after-play' && o.playId === ctx.play);
  if (index < 0) throw new Error(`no after-play op for play ${ctx.play}`);
  stack.splice(index, 0, { ...op, ...ctx.tracer.context(), play: null });
}

/** Deep copy of plain-data engine state. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
