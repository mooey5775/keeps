import type { CardId } from './cards.ts';
import type { Seat } from './state.ts';

export type ActionChoice =
  | { action: 'draw' }
  /** `target` is required for Keep cards and omitted for non-Keep cards. */
  | { action: 'play'; card: CardId; target?: Seat };

/** An answer to an open prompt; `kind` matches the prompt's kind. */
export type Answer =
  | { kind: 'action'; choice: ActionChoice }
  | { kind: 'hot-target'; target: Seat };

export type Command =
  | { type: 'answer'; promptId: string; answer: Answer }
  /** Any player may start the next round once the current one is scored. */
  | { type: 'next-round' };

export type EngineErrorCode =
  | 'unknown-prompt'
  | 'not-your-prompt'
  | 'illegal'
  | 'not-a-player'
  | 'not-implemented';

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
