import type { CardId } from './cards.ts';
import type { KeepRef, Seat } from './state.ts';

/** Using a Keep card's ability from your own keep. */
export type AbilityChoice =
  /** Once per turn, own turn: swap any two piles. */
  | { action: 'ability'; card: 'juggling'; piles: [Seat, Seat] }
  /** Once per turn, own turn: draw from any pile. */
  | { action: 'ability'; card: 'sanction'; from: Seat }
  /** Once per turn, own turn: discard a card, then draw from the left and right piles. */
  | { action: 'ability'; card: 'acquisition'; discard: CardId; first: 'left' | 'right' }
  /** Discard Shackles from your keep. */
  | { action: 'ability'; card: 'shackles' }
  /** Discard all Coin cards in your keep, then reorder your pile. */
  | { action: 'ability'; card: 'tithes' }
  /** Costs TWO actions: place Blunder face-up onto any pile. */
  | { action: 'ability'; card: 'blunder'; pile: Seat };

export type AbilityCard = AbilityChoice['card'];

export type ActionChoice =
  | { action: 'draw' }
  /**
   * `target` is required for Keep cards and omitted for non-Keep cards.
   * `copy` is required for Joker: the non-Keep card it reveals and copies.
   */
  | { action: 'play'; card: CardId; target?: Seat; copy?: CardId }
  | AbilityChoice
  /** Only for Last Laugh's optional action: decline it. */
  | { action: 'pass' };

/** An answer to an open prompt; `kind` matches the prompt's kind. */
export type Answer =
  | { kind: 'action'; choice: ActionChoice }
  | { kind: 'hot-target'; target: Seat }
  | { kind: 'choose-pile'; pile: Seat }
  | { kind: 'choose-pile-card'; index: number }
  | { kind: 'choose-top-card'; pile: Seat }
  | { kind: 'take-or-discard'; take: boolean }
  | { kind: 'choose-discard-card'; card: CardId }
  | { kind: 'choose-keep-pair'; a: KeepRef; b: KeepRef }
  | { kind: 'choose-direction'; direction: 'left' | 'right' }
  /** The pile's cards in their new order, top first. */
  | { kind: 'order-pile'; order: CardId[] }
  | { kind: 'choose-player'; seat: Seat }
  | { kind: 'choose-hand-card'; seat: Seat; card: CardId }
  | { kind: 'give-card'; card: CardId }
  | { kind: 'joker-copy'; card: CardId }
  | { kind: 'claim-pile'; from: Seat }
  | { kind: 'duplicity-hide'; card: CardId; target: Seat }
  | { kind: 'reveal-window'; reveal: boolean };

export type Command =
  | { type: 'answer'; promptId: string; answer: Answer }
  /** Any player may start the next round once the current one is scored. */
  | { type: 'next-round' }
  /** Whoever has Duplicity face-up reveals the face-down card. Free, at any time. */
  | { type: 'reveal-duplicity' };

export type EngineErrorCode =
  | 'unknown-prompt'
  | 'not-your-prompt'
  | 'illegal'
  | 'not-a-player';

export interface EngineError {
  code: EngineErrorCode;
  message: string;
}

/** Thrown inside the engine to reject a command; apply() turns it into a result. */
export class EngineFailure extends Error {
  constructor(
    readonly code: EngineErrorCode,
    message: string,
  ) {
    super(message);
  }
}
