import { CARDS, type CardId } from './cards.ts';
import { EngineFailure } from './commands.ts';
import { push, type Ctx } from './context.ts';
import type { ActionFrameOp, OpMeta, Seat } from './state.ts';

// Card effects. Each build step adds cards here and removes them from
// NOT_YET_IMPLEMENTED; playing a card that isn't implemented yet is rejected
// rather than silently doing the wrong thing.

type Effect = (ctx: Ctx, seat: Seat) => void;

/** Effects of non-Keep cards, resolved after the card is discarded. */
const NON_KEEP_EFFECTS: Partial<Record<CardId, Effect>> = {
  // "Immediately take two actions." Costs one action to play, so a net +1.
  'hocus-pocus': (ctx, seat) => {
    const parent = ctx.state.stack.findLast((op): op is ActionFrameOp & OpMeta => op.op === 'action-frame');
    ctx.tracer.emit({ type: 'extra-actions', seat, count: 2, source: 'hocus-pocus' });
    push(ctx, {
      op: 'action-frame',
      seat,
      remaining: 2,
      kind: 'hocus-pocus',
      // Inside a Retribution or Last Laugh frame, the extra actions keep its restrictions.
      restricted: parent?.restricted ?? false,
    });
  },
};

/**
 * Keep cards whose rules aren't built yet: on-play effects (Duplicity, Fiat)
 * or triggers (Royal Favor, Interest, Retribution, Last Laugh).
 */
const KEEP_NOT_YET_IMPLEMENTED: ReadonlySet<CardId> = new Set<CardId>([
  'duplicity',
  'fiat',
  'royal-favor',
  'interest',
  'retribution',
  'last-laugh',
]);

export function isImplemented(card: CardId): boolean {
  return CARDS[card].keep ? !KEEP_NOT_YET_IMPLEMENTED.has(card) : card in NON_KEEP_EFFECTS;
}

export function assertImplemented(card: CardId): void {
  if (!isImplemented(card)) {
    throw new EngineFailure('not-implemented', `${CARDS[card].name} is not implemented yet`);
  }
}

export function resolveNonKeepEffect(ctx: Ctx, card: CardId, seat: Seat): void {
  const effect = NON_KEEP_EFFECTS[card];
  if (!effect) throw new EngineFailure('not-implemented', `${CARDS[card].name} is not implemented yet`);
  effect(ctx, seat);
}
