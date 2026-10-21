import { CARDS, type CardId } from './cards.ts';
import { EngineFailure, type Answer } from './commands.ts';
import { push, type Ctx } from './context.ts';
import { cardEnteredHand, keepRefs, nonEmptyPiles, openPrompt } from './moves.ts';
import {
  leftOf,
  rightOf,
  SEATS,
  type ActionFrameOp,
  type GameState,
  type KeepRef,
  type OpMeta,
  type PerSeat,
  type PileId,
  type Prompt,
  type Seat,
} from './state.ts';
import { assertNever } from './trace.ts';

// Card effects. Each build step adds cards here and removes them from
// NOT_YET_IMPLEMENTED; playing a card that isn't implemented yet is rejected
// rather than silently doing the wrong thing.
//
// An effect runs when its card is played (after a non-Keep card is
// discarded). Effects that need decisions open prompts; the answers are
// handled by resolveEffectAnswer() below.

type Effect = (ctx: Ctx, seat: Seat, source: CardId) => void;

function look(ctx: Ctx, seat: Seat, piles: Seat[], cards: CardId[]): void {
  ctx.tracer.emit(
    { type: 'look', seat, piles, cards },
    { visibility: [seat], redacted: { type: 'look', seat, piles, cards: null } },
  );
}

function noEffect(ctx: Ctx, seat: Seat, card: CardId, reason: string): void {
  ctx.tracer.emit({ type: 'no-effect', seat, card, reason });
}

/** Effects of non-Keep cards, resolved after the card is discarded. */
const NON_KEEP_EFFECTS: Partial<Record<CardId, Effect>> = {
  // "Immediately take two actions." Costs one action to play, so a net +1.
  'hocus-pocus': (ctx, seat, source) => {
    const parent = ctx.state.stack.findLast((op): op is ActionFrameOp & OpMeta => op.op === 'action-frame');
    ctx.tracer.emit({ type: 'extra-actions', seat, count: 2, source });
    push(ctx, {
      op: 'action-frame',
      seat,
      remaining: 2,
      kind: 'hocus-pocus',
      // Inside a Retribution or Last Laugh frame, the extra actions keep its restrictions.
      restricted: parent?.restricted ?? false,
    });
  },

  // "Choose any pile. Without disturbing its order, look through that pile and
  // choose one card to put into your hand."
  requisition: (ctx, seat, source) => {
    const options = nonEmptyPiles(ctx.state);
    if (options.length === 0) return noEffect(ctx, seat, source, 'every pile is empty');
    openPrompt(ctx, { seat, kind: 'choose-pile', purpose: 'requisition', options });
  },

  // "Pick up and look at the top card of all non-empty piles. Choose one to put in your hand."
  epiphany: (ctx, seat, source) => {
    const { state } = ctx;
    const piles = nonEmptyPiles(state);
    if (piles.length === 0) return noEffect(ctx, seat, source, 'every pile is empty');
    const options = piles.map((pile) => ({ pile, card: state.piles[state.pileAt[pile]].cards[0]!.id }));
    look(ctx, seat, piles, options.map((o) => o.card));
    openPrompt(ctx, { seat, kind: 'choose-top-card', options });
  },

  // "Pick up and look at the top card of any non-empty pile; you may take or
  // discard it. If you discard it, draw from that pile afterward."
  prayer: (ctx, seat, source) => {
    const options = nonEmptyPiles(ctx.state);
    if (options.length === 0) return noEffect(ctx, seat, source, 'every pile is empty');
    openPrompt(ctx, { seat, kind: 'choose-pile', purpose: 'prayer', options });
  },

  // "Choose one card from the discard to put into your hand." Resurrection is
  // already in the discard, so it can choose itself (C-32).
  resurrection: (ctx, seat) => {
    openPrompt(ctx, { seat, kind: 'choose-discard-card' });
  },

  // "Swap any two played Keep cards."
  providence: (ctx, seat, source) => {
    if (keepRefs(ctx.state).length < 2) return noEffect(ctx, seat, source, 'fewer than two played Keep cards');
    openPrompt(ctx, { seat, kind: 'choose-keep-pair' });
  },

  // "Rotate all piles by one position to either the left or the right, your choice."
  pandemonium: (ctx, seat) => {
    openPrompt(ctx, { seat, kind: 'choose-direction' });
  },

  // "Choose any pile and flip it entirely upside down."
  revelation: (ctx, seat) => {
    openPrompt(ctx, { seat, kind: 'choose-pile', purpose: 'revelation', options: [...SEATS] });
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
  effect(ctx, seat, card);
}

// ---------------------------------------------------------------------------
// Effect prompts: legal answers and resolution.

export type EffectPrompt = Exclude<Prompt, { kind: 'action' } | { kind: 'hot-target' }>;
export type EffectAnswer = Exclude<Answer, { kind: 'action' } | { kind: 'hot-target' }>;

function sameRef(a: KeepRef, b: KeepRef): boolean {
  return a.seat === b.seat && a.index === b.index;
}

/**
 * Every legal answer. For order-pile, whose answers are all permutations of
 * the pile, this lists two representative orders; isLegalEffectAnswer()
 * accepts any permutation.
 */
export function legalEffectAnswers(state: GameState, prompt: EffectPrompt): EffectAnswer[] {
  switch (prompt.kind) {
    case 'choose-pile':
      return prompt.options.map((pile) => ({ kind: 'choose-pile', pile }));
    case 'choose-pile-card':
      return prompt.cards.map((_, index) => ({ kind: 'choose-pile-card', index }));
    case 'choose-top-card':
      return prompt.options.map(({ pile }) => ({ kind: 'choose-top-card', pile }));
    case 'take-or-discard':
      return [
        { kind: 'take-or-discard', take: true },
        { kind: 'take-or-discard', take: false },
      ];
    case 'choose-discard-card':
      return state.discard.map((card) => ({ kind: 'choose-discard-card', card }));
    case 'choose-keep-pair': {
      const refs = keepRefs(state);
      return refs.flatMap((a, i) => refs.slice(i + 1).map((b) => ({ kind: 'choose-keep-pair' as const, a, b })));
    }
    case 'choose-direction':
      return [
        { kind: 'choose-direction', direction: 'left' },
        { kind: 'choose-direction', direction: 'right' },
      ];
    case 'order-pile': {
      const reversed = [...prompt.cards].reverse();
      return prompt.cards.length < 2
        ? [{ kind: 'order-pile', order: [...prompt.cards] }]
        : [
            { kind: 'order-pile', order: [...prompt.cards] },
            { kind: 'order-pile', order: reversed },
          ];
    }
    default:
      return assertNever(prompt);
  }
}

/** Validates answers that legalEffectAnswers() can't enumerate exhaustively. */
export function isLegalEffectAnswer(state: GameState, prompt: EffectPrompt, answer: EffectAnswer): boolean | null {
  if (prompt.kind === 'order-pile' && answer.kind === 'order-pile') {
    return (
      answer.order.length === prompt.cards.length &&
      [...answer.order].sort().join() === [...prompt.cards].sort().join()
    );
  }
  if (prompt.kind === 'choose-keep-pair' && answer.kind === 'choose-keep-pair') {
    // Either order of the two cards is fine.
    const refs = keepRefs(state);
    return refs.some((r) => sameRef(r, answer.a)) && refs.some((r) => sameRef(r, answer.b)) && !sameRef(answer.a, answer.b);
  }
  return null; // Not special: compare against legalEffectAnswers().
}

function pileCards(state: GameState, position: Seat) {
  return state.piles[state.pileAt[position]].cards;
}

export function resolveEffectAnswer(ctx: Ctx, prompt: EffectPrompt, answer: EffectAnswer): void {
  const { state, tracer } = ctx;
  const seat = prompt.seat;
  switch (answer.kind) {
    case 'choose-pile': {
      if (prompt.kind !== 'choose-pile') break;
      const cards = pileCards(state, answer.pile);
      switch (prompt.purpose) {
        case 'requisition': {
          const ids = cards.map((c) => c.id);
          look(ctx, seat, [answer.pile], ids);
          openPrompt(ctx, { seat, kind: 'choose-pile-card', pile: answer.pile, cards: ids });
          return;
        }
        case 'prayer': {
          const top = cards[0]!.id;
          look(ctx, seat, [answer.pile], [top]);
          openPrompt(ctx, { seat, kind: 'take-or-discard', pile: answer.pile, card: top });
          return;
        }
        case 'revelation': {
          const pile = state.piles[state.pileAt[answer.pile]];
          pile.cards = pile.cards.reverse().map((c) => ({ id: c.id, faceUp: !c.faceUp }));
          tracer.emit({ type: 'pile-flip', seat, pile: answer.pile });
          return;
        }
        default:
          return assertNever(prompt.purpose);
      }
    }
    case 'choose-pile-card': {
      if (prompt.kind !== 'choose-pile-card') break;
      const [taken] = pileCards(state, prompt.pile).splice(answer.index, 1);
      return takeIntoHand(ctx, seat, taken!.id, prompt.pile);
    }
    case 'choose-top-card': {
      const taken = pileCards(state, answer.pile).shift();
      return takeIntoHand(ctx, seat, taken!.id, answer.pile);
    }
    case 'take-or-discard': {
      if (prompt.kind !== 'take-or-discard') break;
      const top = pileCards(state, prompt.pile).shift()!;
      if (answer.take) return takeIntoHand(ctx, seat, top.id, prompt.pile);
      state.discard.push(top.id);
      const seq = tracer.emit({ type: 'discard', seat, cards: [top.id], from: 'pile' });
      // Drawing from a pile that is now empty ends the round (Resurrection 2 puzzle).
      tracer.within(seq, () => push(ctx, { op: 'draw', seat, from: prompt.pile }));
      return;
    }
    case 'choose-discard-card': {
      state.discard.splice(state.discard.lastIndexOf(answer.card), 1);
      state.hands[seat].push(answer.card);
      const seq = tracer.emit({ type: 'take', seat, card: answer.card, from: 'discard' });
      return cardEnteredHand(ctx, seat, answer.card, seq);
    }
    case 'choose-keep-pair':
      return swapKeepCards(ctx, seat, answer.a, answer.b);
    case 'choose-direction': {
      const before = state.pileAt;
      const move = answer.direction === 'left' ? leftOf : rightOf;
      const after = [...before] as PerSeat<PileId>;
      for (const s of SEATS) after[move(s)] = before[s];
      state.pileAt = after;
      tracer.emit({ type: 'pile-rotate', seat, direction: answer.direction });
      return;
    }
    case 'order-pile': {
      if (prompt.kind !== 'order-pile') break;
      const pile = state.piles[state.pileAt[prompt.pile]];
      const faceUp = new Map(pile.cards.map((c) => [c.id, c.faceUp]));
      pile.cards = answer.order.map((id) => ({ id, faceUp: faceUp.get(id)! }));
      tracer.emit(
        { type: 'pile-reorder', seat, pile: prompt.pile, order: answer.order },
        { visibility: [seat], redacted: { type: 'pile-reorder', seat, pile: prompt.pile, order: null } },
      );
      return;
    }
    default:
      return assertNever(answer);
  }
  throw new Error(`answer ${answer.kind} does not match prompt ${prompt.kind}`);
}

/** A card taken from a pile into a hand. Only the taker learns what it is. */
function takeIntoHand(ctx: Ctx, seat: Seat, card: CardId, pile: Seat): void {
  ctx.state.hands[seat].push(card);
  const seq = ctx.tracer.emit(
    { type: 'take', seat, card, from: { pile } },
    { visibility: [seat], redacted: { type: 'take', seat, card: null, from: { pile } } },
  );
  cardEnteredHand(ctx, seat, card, seq);
}

/** Providence: the two cards trade places (a face-down card stays face-down; ruling Q-05). */
function swapKeepCards(ctx: Ctx, seat: Seat, a: KeepRef, b: KeepRef): void {
  const { keeps } = ctx.state;
  const cardA = keeps[a.seat][a.index]!;
  const cardB = keeps[b.seat][b.index]!;
  keeps[a.seat][a.index] = cardB;
  keeps[b.seat][b.index] = cardA;
  const full = { type: 'keep-swap' as const, seat, a: { ...a, card: cardA.id }, b: { ...b, card: cardB.id } };
  if (cardA.faceDown || cardB.faceDown) {
    const hide = (ref: KeepRef, card: typeof cardA) => ({ ...ref, card: card.faceDown ? null : card.id });
    ctx.tracer.emit(full, {
      visibility: [],
      redacted: { type: 'keep-swap', seat, a: hide(a, cardA), b: hide(b, cardB) },
    });
  } else {
    ctx.tracer.emit(full);
  }
}
