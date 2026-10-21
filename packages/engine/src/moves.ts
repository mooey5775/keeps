import { CARDS, type CardId } from './cards.ts';
import { push, type Ctx } from './context.ts';
import {
  playerSeats,
  SEATS,
  type GameState,
  type KeepCard,
  type KeepRef,
  type PlayRecord,
  type Prompt,
  type Seat,
} from './state.ts';

// Small building blocks shared by the engine loop, abilities, and card effects.

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewPrompt = DistributiveOmit<Prompt, 'id' | 'event' | 'depth' | 'play'>;

/** Opens a prompt; the engine stops and waits for its answer. */
export function openPrompt(ctx: Ctx, prompt: NewPrompt): void {
  const card = prompt.kind === 'hot-target' ? prompt.card : undefined;
  const event = ctx.tracer.emit({ type: 'prompt', seat: prompt.seat, kind: prompt.kind, ...(card ? { card } : {}) });
  const { depth } = ctx.tracer.context();
  ctx.state.prompts.push({ ...prompt, id: `p${event}`, event, depth, play: ctx.play } as Prompt);
}

function currentPlay(ctx: Ctx): PlayRecord | null {
  if (ctx.play === null) return null;
  const record = ctx.state.openPlays.find((p) => p.id === ctx.play);
  if (!record) throw new Error(`play ${ctx.play} is not open`);
  return record;
}

/** Notes that `seat`'s hand or keep changed, crediting the play now resolving (if any). */
export function recordChange(ctx: Ctx, seat: Seat): void {
  const record = currentPlay(ctx);
  if (record && !record.changed.includes(seat)) record.changed.push(seat);
}

/**
 * Puts a card into a keep. A face-up card "enters" the keep, which Interest
 * (if it was already there) and Royal Favor react to after the play resolves.
 */
export function enterKeep(ctx: Ctx, seat: Seat, card: KeepCard): void {
  const interest = hasFaceUp(ctx.state, seat, 'interest');
  ctx.state.keeps[seat].push(card);
  recordChange(ctx, seat);
  if (!card.faceDown) currentPlay(ctx)?.entries.push({ seat, card: card.id, interest });
}

/** Records a face-up card arriving in a keep by other means (Providence swaps). */
export function recordEntry(ctx: Ctx, seat: Seat, card: CardId, interest: boolean): void {
  currentPlay(ctx)?.entries.push({ seat, card, interest });
}

export function seatsWithFaceUp(state: GameState, card: CardId): Seat[] {
  return SEATS.filter((s) => hasFaceUp(state, s, card));
}

/**
 * Call after a card enters `seat`'s hand (`event` = the trace event that moved it).
 * HOT cards must then be played immediately.
 */
export function cardEnteredHand(ctx: Ctx, seat: Seat, card: CardId, event: number): void {
  recordChange(ctx, seat);
  if (CARDS[card].hot) ctx.tracer.within(event, () => push(ctx, { op: 'hot-check', seat }));
}

/** Keep cards go into any player's keep (never a ghost's); Blunder only into your own. */
export function keepTargets(state: GameState, seat: Seat, card: CardId): Seat[] {
  return card === 'blunder' ? [seat] : playerSeats(state);
}

/** Every played Keep card, face-up or face-down. */
export function keepRefs(state: GameState): KeepRef[] {
  return SEATS.flatMap((seat) => state.keeps[seat].map((_, index) => ({ seat, index })));
}

export function nonEmptyPiles(state: GameState): Seat[] {
  return SEATS.filter((s) => state.piles[state.pileAt[s]].cards.length > 0);
}

export function hasFaceUp(state: GameState, seat: Seat, card: CardId): boolean {
  return state.keeps[seat].some((c) => c.id === card && !c.faceDown);
}

/**
 * Actions `seat` can spend consecutively: the remaining actions of the
 * same-seat action frames at the top of the stack, with nothing between them.
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
