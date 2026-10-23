import { CARDS, isCoinCard, type CardId } from './cards.ts';
import type { Answer } from './commands.ts';
import { push, pushAfterPlay, type Ctx } from './context.ts';
import { reveal } from './duplicity.ts';
import {
  cardEnteredHand,
  enterKeep,
  hasFaceUp,
  keepRefs,
  nonEmptyPiles,
  openPrompt,
  recordChange,
  recordEntry,
} from './moves.ts';
import { randomInt } from './rng.ts';
import {
  leftOf,
  playerSeats,
  rotatedTo,
  SEATS,
  type ActionFrameOp,
  type PileClaim,
  type GameState,
  type KeepRef,
  type OpMeta,
  type PerSeat,
  type PileId,
  type Prompt,
  type Seat,
} from './state.ts';
import { assertNever } from './trace.ts';

// Card effects.
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
    // The actions come after Hocus Pocus's play has fully resolved.
    pushAfterPlay(ctx, {
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

  // "Draw a card from any pile, then play it as if it were HOT!." Any pile,
  // including an empty one, which ends the round (Resurrection 3).
  invocation: (ctx, seat) => {
    openPrompt(ctx, { seat, kind: 'choose-pile', purpose: 'invocation', options: [...SEATS] });
  },

  // "Choose any player. Steal a random card from their hand, then play it as
  // if it were HOT!." Yourself (C-25, Q-11) and ghosts (C-26) included.
  legerdemain: (ctx, seat) => {
    openPrompt(ctx, { seat, kind: 'choose-player', purpose: 'legerdemain', options: [...SEATS] });
  },

  // "Choose any player. They must surrender all Coin cards from their hand
  // into yours." Yourself (Q-11) and ghosts (C-28) included.
  pickpocket: (ctx, seat) => {
    openPrompt(ctx, { seat, kind: 'choose-player', purpose: 'pickpocket', options: [...SEATS] });
  },

  // "All other players must reveal their hand to you. Choose one card from any
  // player's hand to take into yours."
  pluck: (ctx, seat, source) => {
    const { state } = ctx;
    const others = playerSeats(state).filter((s) => s !== seat);
    const hands = others.map((s) => ({ seat: s, cards: [...state.hands[s]] }));
    ctx.tracer.emit(
      { type: 'look-hands', seat, hands },
      { visibility: [seat], redacted: { type: 'look-hands', seat, hands: null } },
    );
    const options = hands.flatMap((h) => h.cards.map((card) => ({ seat: h.seat, card })));
    if (options.length === 0) return noEffect(ctx, seat, source, 'no other player has any cards');
    openPrompt(ctx, { seat, kind: 'choose-hand-card', options });
  },

  // "Discard your hand. Then, all other players must choose a card from their
  // hand to give to you." Everyone chooses at the same time.
  offering: (ctx, seat) => {
    const { state, tracer } = ctx;
    const hand = state.hands[seat];
    if (hand.length > 0) {
      state.discard.push(...hand);
      tracer.emit({ type: 'discard', seat, cards: [...hand], from: 'hand' });
      state.hands[seat] = [];
      recordChange(ctx, seat);
    }
    for (const giver of playerSeats(state)) {
      if (giver !== seat && state.hands[giver].length > 0) openPrompt(ctx, { seat: giver, kind: 'give-card', to: seat });
    }
  },

  // Played as HOT with no non-Keep card to reveal, Joker does nothing (Q-09).
  // Otherwise resolveNonKeepEffect() runs the copied card's effect.
  joker: (ctx, seat, source) => noEffect(ctx, seat, source, 'no non-Keep card to reveal'),
};

/** Keep cards that do something when played (beyond entering the keep). */
const KEEP_ON_PLAY: Partial<Record<CardId, Effect>> = {
  // "When playing this card, choose another Keep card from your hand to place
  // face down into any keep." With no other Keep card, nothing is placed (Q-16).
  duplicity: (ctx, seat, source) => {
    const options = [...new Set(ctx.state.hands[seat].filter((c) => CARDS[c].keep))];
    if (options.length === 0) return noEffect(ctx, seat, source, 'no other Keep card in hand to place face down');
    openPrompt(ctx, { seat, kind: 'duplicity-hide', options });
  },

  // "All players push their piles to the center. Then, in play order starting
  // with you, players claim a pile from the center." Only real players claim
  // (C-19); with two players, Fiat's player places the two ghost piles (C-20).
  // This happens when Fiat is played; afterward it sits in the keep (Q-01).
  fiat: (ctx, seat) => {
    const { state } = ctx;
    ctx.tracer.emit({ type: 'piles-to-center', seat });
    const players: Seat[] = [];
    for (let s = seat, i = 0; i < 4; s = leftOf(s), i++) if (state.config.seats[s] === 'player') players.push(s);
    const ghosts = SEATS.filter((s) => state.config.seats[s] === 'ghost');
    const queue: PileClaim[] = players.map((p) => ({ decider: p, claimant: p }));
    if (ghosts.length === 2) queue.push({ decider: seat, claimant: ghosts[0]! });
    nextPileClaim(ctx, queue, []);
  },
};

function nextPileClaim(ctx: Ctx, queue: PileClaim[], claims: { claimant: Seat; from: Seat }[]): void {
  const { state, tracer } = ctx;
  const unclaimedPiles = SEATS.filter((from) => !claims.some((c) => c.from === from));
  const [next, ...rest] = queue;
  if (next) {
    openPrompt(ctx, { seat: next.decider, kind: 'claim-pile', claimant: next.claimant, options: unclaimedPiles, claims, queue: rest });
    return;
  }
  // Any seats left (ghosts) get the remaining piles in seat order.
  const unfilled = SEATS.filter((s) => !claims.some((c) => c.claimant === s));
  const all = [...claims, ...unfilled.map((claimant, i) => ({ claimant, from: unclaimedPiles[i]! }))];
  for (const c of all.slice(claims.length)) {
    tracer.emit({ type: 'note', text: `the remaining pile from @S${c.from} goes to S${c.claimant}` });
  }
  const before = [...state.pileAt] as PerSeat<PileId>;
  for (const c of all) state.pileAt[c.claimant] = before[c.from];
}

/** Every non-Keep card has an effect; every Keep card works by entering a keep. */
export function hasRules(card: CardId): boolean {
  return CARDS[card].keep || card in NON_KEEP_EFFECTS;
}

/** Resolves a non-Keep card's effect. Joker with `copy` reveals that card and takes its effect. */
export function resolveNonKeepEffect(ctx: Ctx, card: CardId, seat: Seat, copy?: CardId): void {
  if (card === 'joker' && copy) {
    ctx.tracer.emit({ type: 'reveal-card', seat, card: copy });
    return resolveNonKeepEffect(ctx, copy, seat);
  }
  const effect = NON_KEEP_EFFECTS[card];
  if (!effect) throw new Error(`${CARDS[card].name} has no effect implementation`);
  effect(ctx, seat, card);
}

/** Runs a Keep card's on-play effect, if it has one (after it enters the keep). */
export function resolveKeepOnPlay(ctx: Ctx, card: CardId, seat: Seat): void {
  KEEP_ON_PLAY[card]?.(ctx, seat, card);
}

// ---------------------------------------------------------------------------
// Effect prompts: legal answers and resolution.

export type EffectPrompt = Exclude<Prompt, { kind: 'action' } | { kind: 'hot-target' }>;
export type EffectAnswer = Exclude<Answer, { kind: 'action' } | { kind: 'hot-target' }>;

function isKeepRef(value: unknown): value is KeepRef {
  if (typeof value !== 'object' || value === null) return false;
  const { seat, index } = value as Record<string, unknown>;
  return Number.isInteger(seat) && Number.isInteger(index);
}

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
    case 'choose-player':
      return prompt.options.map((seat) => ({ kind: 'choose-player', seat }));
    case 'choose-hand-card':
      return prompt.options.map(({ seat, card }) => ({ kind: 'choose-hand-card', seat, card }));
    case 'give-card':
      return state.hands[prompt.seat].map((card) => ({ kind: 'give-card', card }));
    case 'joker-copy':
      return prompt.options.map((card) => ({ kind: 'joker-copy', card }));
    case 'claim-pile':
      return prompt.options.map((from) => ({ kind: 'claim-pile', from }));
    case 'duplicity-hide':
      return prompt.options.flatMap((card) =>
        playerSeats(state).map((target) => ({ kind: 'duplicity-hide' as const, card, target })),
      );
    case 'reveal-window':
      return [
        { kind: 'reveal-window', reveal: true },
        { kind: 'reveal-window', reveal: false },
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
      Array.isArray(answer.order) &&
      answer.order.every((c) => typeof c === 'string') &&
      answer.order.length === prompt.cards.length &&
      [...answer.order].sort().join() === [...prompt.cards].sort().join()
    );
  }
  if (prompt.kind === 'choose-keep-pair' && answer.kind === 'choose-keep-pair') {
    // Either order of the two cards is fine.
    if (!isKeepRef(answer.a) || !isKeepRef(answer.b)) return false;
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
      const purpose = prompt.purpose;
      switch (purpose) {
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
        case 'invocation':
          push(ctx, { op: 'draw', seat, from: answer.pile, invoke: true });
          return;
        default:
          return assertNever(purpose);
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
      const after = [...before] as PerSeat<PileId>;
      for (const s of SEATS) after[rotatedTo(s, answer.direction)] = before[s];
      state.pileAt = after;
      tracer.emit({ type: 'pile-rotate', seat, direction: answer.direction });
      return;
    }
    case 'choose-player': {
      if (prompt.kind !== 'choose-player') break;
      return prompt.purpose === 'legerdemain'
        ? legerdemainSteal(ctx, seat, answer.seat)
        : pickpocket(ctx, seat, answer.seat);
    }
    case 'choose-hand-card': {
      const from = state.hands[answer.seat];
      from.splice(from.indexOf(answer.card), 1);
      state.hands[seat].push(answer.card);
      recordChange(ctx, answer.seat);
      recordChange(ctx, seat);
      tracer.emit(
        { type: 'steal', seat, from: answer.seat, cards: [answer.card], count: 1 },
        { visibility: [seat, answer.seat], redacted: { type: 'steal', seat, from: answer.seat, cards: null, count: 1 } },
      );
      return;
    }
    case 'give-card': {
      if (prompt.kind !== 'give-card') break;
      const hand = state.hands[seat];
      hand.splice(hand.indexOf(answer.card), 1);
      state.hands[prompt.to].push(answer.card);
      recordChange(ctx, seat);
      recordChange(ctx, prompt.to);
      tracer.emit(
        { type: 'give', seat, to: prompt.to, card: answer.card },
        { visibility: [seat, prompt.to], redacted: { type: 'give', seat, to: prompt.to, card: null } },
      );
      return;
    }
    case 'joker-copy':
      push(ctx, { op: 'play', seat, card: 'joker', target: null, hot: true, copy: answer.card });
      return;
    case 'claim-pile': {
      if (prompt.kind !== 'claim-pile') break;
      tracer.emit({ type: 'pile-claim', seat, claimant: prompt.claimant, from: answer.from });
      return nextPileClaim(ctx, prompt.queue, [...prompt.claims, { claimant: prompt.claimant, from: answer.from }]);
    }
    case 'duplicity-hide': {
      const hand = state.hands[seat];
      hand.splice(hand.indexOf(answer.card), 1);
      recordChange(ctx, seat);
      // Placing it face down never triggers Interest (C-17), but it can change a
      // Retribution owner's keep (C-16: Duplicity or the card, not both).
      enterKeep(ctx, answer.target, { id: answer.card, faceDown: { placedBy: seat } });
      tracer.emit(
        { type: 'place-face-down', seat, target: answer.target, card: answer.card },
        { visibility: [seat], redacted: { type: 'place-face-down', seat, target: answer.target, card: null } },
      );
      return;
    }
    case 'reveal-window':
      if (prompt.kind !== 'reveal-window') break;
      if (answer.reveal) reveal(ctx, seat, prompt.playId);
      return;
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

/**
 * Legerdemain: a random card from `victim`'s hand goes to `seat`, who then
 * plays it as if HOT. The steal is public, since the card is played face-up.
 */
function legerdemainSteal(ctx: Ctx, seat: Seat, victim: Seat): void {
  const { state, tracer } = ctx;
  const hand = state.hands[victim];
  if (hand.length === 0) return noEffect(ctx, seat, 'legerdemain', `S${victim} has no cards`);
  const [card] = hand.splice(randomInt(state.rng, hand.length), 1);
  state.hands[seat].push(card!);
  recordChange(ctx, victim);
  recordChange(ctx, seat);
  const seq = tracer.emit({ type: 'steal', seat, from: victim, cards: [card!], count: 1 });
  tracer.within(seq, () => push(ctx, { op: 'play-as-hot', seat, card: card! }));
}

/** Pickpocket: all Coin cards in `victim`'s hand move to `seat`'s. Only the two of them see which. */
function pickpocket(ctx: Ctx, seat: Seat, victim: Seat): void {
  const { state, tracer } = ctx;
  if (victim === seat) return noEffect(ctx, seat, 'pickpocket', 'chose yourself');
  const coins = state.hands[victim].filter(isCoinCard);
  if (coins.length === 0) return noEffect(ctx, seat, 'pickpocket', `S${victim} has no Coin cards in hand`);
  state.hands[victim] = state.hands[victim].filter((c) => !isCoinCard(c));
  state.hands[seat].push(...coins);
  recordChange(ctx, victim);
  recordChange(ctx, seat);
  tracer.emit(
    { type: 'steal', seat, from: victim, cards: coins, count: coins.length },
    { visibility: [seat, victim], redacted: { type: 'steal', seat, from: victim, cards: null, count: coins.length } },
  );
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

/**
 * Providence: the two cards trade places (a face-down card stays face-down;
 * ruling Q-05). A face-up card moving to another keep "enters" it: Royal
 * Favor triggers (Q-14), and so does Interest if it was in the receiving keep
 * before and after the swap, so swapping Interest itself for a Coin card
 * doesn't trigger it (C-21).
 */
function swapKeepCards(ctx: Ctx, seat: Seat, a: KeepRef, b: KeepRef): void {
  const { state } = ctx;
  const { keeps } = state;
  const cardA = keeps[a.seat][a.index]!;
  const cardB = keeps[b.seat][b.index]!;
  const interestBefore = { a: hasFaceUp(state, a.seat, 'interest'), b: hasFaceUp(state, b.seat, 'interest') };
  keeps[a.seat][a.index] = cardB;
  keeps[b.seat][b.index] = cardA;
  recordChange(ctx, a.seat);
  recordChange(ctx, b.seat);
  if (a.seat !== b.seat) {
    if (!cardA.faceDown) recordEntry(ctx, b.seat, cardA.id, interestBefore.b && hasFaceUp(state, b.seat, 'interest'));
    if (!cardB.faceDown) recordEntry(ctx, a.seat, cardB.id, interestBefore.a && hasFaceUp(state, a.seat, 'interest'));
  }
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
