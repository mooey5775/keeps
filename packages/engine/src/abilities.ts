import { isCoinCard, type CardId } from './cards.ts';
import type { AbilityChoice } from './commands.ts';
import { push, type Ctx } from './context.ts';
import { consecutiveActions } from './actions.ts';
import { hasFaceUp, openPrompt } from './moves.ts';
import { leftOf, rightOf, SEATS, type ActionFrameOp, type GameState, type Seat } from './state.ts';
import { assertNever } from './trace.ts';

// Keep-card abilities: actions a player takes using a card face-up in their
// own keep. Acquisition, Juggling and Sanction are once per turn, on your
// own turn, and never in restricted (Retribution / Last Laugh) frames.

const ONCE_PER_TURN = ['acquisition', 'juggling', 'sanction'] as const satisfies readonly CardId[];

/** Acquisition: the two piles it draws from, in order (`first` is the side drawn from first). */
export function acquisitionOrder(seat: Seat, first: 'left' | 'right'): [Seat, Seat] {
  return first === 'left' ? [leftOf(seat), rightOf(seat)] : [rightOf(seat), leftOf(seat)];
}

/** Actions an ability costs. Blunder costs two consecutive actions; the rest cost one. */
export function abilityCost(choice: AbilityChoice): number {
  return choice.card === 'blunder' ? 2 : 1;
}

export function legalAbilities(state: GameState, seat: Seat, frame: ActionFrameOp): AbilityChoice[] {
  const choices: AbilityChoice[] = [];
  const ownTurn = state.turn?.seat === seat && !frame.restricted;
  const available = (card: (typeof ONCE_PER_TURN)[number]) =>
    ownTurn && hasFaceUp(state, seat, card) && !state.turn!.usedOncePerTurn.includes(card);

  if (available('juggling')) {
    for (const a of SEATS) for (const b of SEATS) if (a < b) choices.push({ action: 'ability', card: 'juggling', piles: [a, b] });
  }
  if (available('sanction')) {
    for (const from of SEATS) choices.push({ action: 'ability', card: 'sanction', from });
  }
  if (available('acquisition')) {
    for (const discard of state.hands[seat]) {
      choices.push({ action: 'ability', card: 'acquisition', discard, first: 'left' });
      choices.push({ action: 'ability', card: 'acquisition', discard, first: 'right' });
    }
  }
  if (hasFaceUp(state, seat, 'shackles')) choices.push({ action: 'ability', card: 'shackles' });
  if (hasFaceUp(state, seat, 'tithes')) choices.push({ action: 'ability', card: 'tithes' });
  if (hasFaceUp(state, seat, 'blunder') && consecutiveActions(state, seat) >= 2) {
    for (const pile of SEATS) choices.push({ action: 'ability', card: 'blunder', pile });
  }
  return choices;
}

function removeFromOwnKeep(state: GameState, seat: Seat, card: CardId): void {
  const keep = state.keeps[seat];
  const index = keep.findIndex((c) => c.id === card && !c.faceDown);
  if (index < 0) throw new Error(`${card} is not face-up in seat ${seat}'s keep`);
  keep.splice(index, 1);
}

export function useAbility(ctx: Ctx, seat: Seat, choice: AbilityChoice): void {
  const { state, tracer } = ctx;
  if ((ONCE_PER_TURN as readonly string[]).includes(choice.card)) state.turn!.usedOncePerTurn.push(choice.card);

  switch (choice.card) {
    case 'juggling': {
      const [a, b] = choice.piles;
      [state.pileAt[a], state.pileAt[b]] = [state.pileAt[b], state.pileAt[a]];
      tracer.emit({ type: 'pile-swap', seat, a, b });
      return;
    }
    case 'sanction':
      push(ctx, { op: 'draw', seat, from: choice.from });
      return;
    case 'acquisition': {
      const hand = state.hands[seat];
      hand.splice(hand.indexOf(choice.discard), 1);
      state.discard.push(choice.discard);
      const seq = tracer.emit({ type: 'discard', seat, cards: [choice.discard], from: 'hand' });
      // Each draw finishes (including any HOT card it reveals) before the next,
      // and each pile is looked up when it is drawn from (ruling Q-08).
      const [first, second] = acquisitionOrder(seat, choice.first);
      tracer.within(seq, () => {
        push(ctx, { op: 'draw', seat, from: second });
        push(ctx, { op: 'draw', seat, from: first });
      });
      return;
    }
    case 'shackles':
      removeFromOwnKeep(state, seat, 'shackles');
      state.discard.push('shackles');
      tracer.emit({ type: 'discard', seat, cards: ['shackles'], from: 'keep' });
      return;
    case 'tithes': {
      // All face-up Coin cards, Tithes included (C-36). Never the face-down card (C-18).
      const keep = state.keeps[seat];
      const coins = keep.filter((c) => !c.faceDown && isCoinCard(c.id)).map((c) => c.id);
      state.keeps[seat] = keep.filter((c) => c.faceDown || !isCoinCard(c.id));
      state.discard.push(...coins);
      const seq = tracer.emit({ type: 'discard', seat, cards: coins, from: 'keep' });
      const pile = state.piles[state.pileAt[seat]].cards.map((c) => c.id);
      if (pile.length > 0) {
        tracer.within(seq, () => {
          tracer.emit(
            { type: 'look', seat, piles: [seat], cards: pile },
            { visibility: [seat], redacted: { type: 'look', seat, piles: [seat], cards: null } },
          );
          openPrompt(ctx, { seat, kind: 'order-pile', pile: seat, cards: pile });
        });
      }
      return;
    }
    case 'blunder': {
      removeFromOwnKeep(state, seat, 'blunder');
      state.piles[state.pileAt[choice.pile]].cards.unshift({ id: 'blunder', faceUp: true });
      tracer.emit({ type: 'place-on-pile', seat, card: 'blunder', pile: choice.pile });
      return;
    }
    default:
      assertNever(choice);
  }
}
