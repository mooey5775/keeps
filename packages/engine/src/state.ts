import type { CardId } from './cards.ts';
import type { RngState } from './rng.ts';

/** Table positions 0–3. Left of seat s is (s + 1) % 4, which is also play order. */
export type Seat = 0 | 1 | 2 | 3;
export const SEATS: readonly Seat[] = [0, 1, 2, 3];

export type PerSeat<T> = [T, T, T, T];

export function perSeat<T>(make: (seat: Seat) => T): PerSeat<T> {
  return [make(0), make(1), make(2), make(3)];
}

export function leftOf(seat: Seat): Seat {
  return ((seat + 1) % 4) as Seat;
}

export function rightOf(seat: Seat): Seat {
  return ((seat + 3) % 4) as Seat;
}

/** Ghosts have a pile but no hand, keep, or actions. */
export type SeatKind = 'player' | 'ghost';

/** A pile's hidden identity. Never sent to clients. */
export type PileId = 'count' | 'fool' | 'friar' | 'mask';
export const PILE_IDS: readonly PileId[] = ['count', 'fool', 'friar', 'mask'];

export interface PileCard {
  id: CardId;
  faceUp: boolean;
}

export interface Pile {
  id: PileId;
  /** cards[0] is the top of the pile. */
  cards: PileCard[];
}

export interface KeepCard {
  id: CardId;
  /** Present only for a card placed face-down by Duplicity. */
  faceDown?: { placedBy: Seat };
}

/** A card temporarily outside every zone: mid-play, or being looked at. */
export interface LimboCard {
  id: CardId;
  reason: 'resolving' | 'looking';
}

export interface GameConfig {
  seats: PerSeat<SeatKind>;
  marksToWin: number;
  /**
   * Allows cards to sit in `box` (out of play). Only puzzles and tests build
   * such positions; real games always use all 36 cards.
   */
  partialDeck: boolean;
}

/**
 * playing: turns are being taken.
 * post-round: an empty pile was drawn from; only Last Laugh (and what it
 *   triggers) and Duplicity reveals remain before scoring.
 * round-over: scored; waiting for a `next-round` command.
 */
export type Phase = 'playing' | 'post-round' | 'round-over' | 'game-over';

export interface TurnState {
  seat: Seat;
  actionsTaken: number;
  /** Keep cards whose once-per-turn ability was used this turn. */
  usedOncePerTurn: CardId[];
}

export type RoundEnd =
  | { kind: 'empty-pile'; enderSeat: Seat }
  | { kind: 'tokens'; winner: Seat };

/** Grants actions to a seat. See docs/ENGINE.md, "Turns and actions". */
export interface ActionFrameOp {
  op: 'action-frame';
  seat: Seat;
  remaining: number;
  kind: 'turn' | 'hocus-pocus' | 'retribution' | 'last-laugh';
  /** Acquisition, Sanction and Juggling are unusable in restricted frames. */
  restricted: boolean;
}

/** Resolution-stack operations. Grows with each build step. */
export type OpBody =
  | ActionFrameOp
  /** `seat` draws the top card of the pile at position `from` (looked up when the op runs). */
  | { op: 'draw'; seat: Seat; from: Seat }
  /** `seat` plays `card` from their hand. `target` is the receiving keep for Keep cards. */
  | { op: 'play'; seat: Seat; card: CardId; target: Seat | null; hot: boolean }
  /** Play any HOT card in `seat`'s hand, one at a time. */
  | { op: 'hot-check'; seat: Seat }
  | { op: 'score' };

/** Every op remembers the trace event that caused it, and its nesting depth. */
export interface OpMeta {
  cause: number | null;
  depth: number;
}

export type Op = OpBody & OpMeta;

interface PromptBase {
  id: string;
  seat: Seat;
  /** The trace event that opened this prompt; answers are traced as its consequences. */
  event: number;
  depth: number;
}

/** A card in a keep, by position (face-down cards can't be named by id). */
export interface KeepRef {
  seat: Seat;
  index: number;
}

export type PilePurpose = 'requisition' | 'prayer' | 'revelation';

export type Prompt =
  /** Choose an action for the top action frame. */
  | (PromptBase & { kind: 'action' })
  /** Choose which keep receives a HOT Keep card (the card stays in hand until then). */
  | (PromptBase & { kind: 'hot-target'; card: CardId })
  /** Choose a pile position for a card effect. */
  | (PromptBase & { kind: 'choose-pile'; purpose: PilePurpose; options: Seat[] })
  /** Requisition: pick any card from a pile you are looking through (top first). */
  | (PromptBase & { kind: 'choose-pile-card'; pile: Seat; cards: CardId[] })
  /** Epiphany: pick one of the top cards you are looking at. */
  | (PromptBase & { kind: 'choose-top-card'; options: { pile: Seat; card: CardId }[] })
  /** Prayer: take the top card you are looking at, or discard it and draw. */
  | (PromptBase & { kind: 'take-or-discard'; pile: Seat; card: CardId })
  /** Resurrection: pick a card from the discard. */
  | (PromptBase & { kind: 'choose-discard-card' })
  /** Providence: pick two played Keep cards to swap. */
  | (PromptBase & { kind: 'choose-keep-pair' })
  /** Pandemonium: rotate the piles left or right. */
  | (PromptBase & { kind: 'choose-direction' })
  /** Tithes: reorder your pile (top first). */
  | (PromptBase & { kind: 'order-pile'; pile: Seat; cards: CardId[] });

export type PromptKind = Prompt['kind'];

export interface GameState {
  config: GameConfig;
  rng: RngState;
  phase: Phase;
  /** 1-based; 0 before the first round starts. */
  round: number;
  /** Turns started this round (1-based once play begins). */
  turnNumber: number;
  marks: PerSeat<number>;
  startingSeat: Seat | null;
  lastRoundWinner: Seat | null;
  piles: Record<PileId, Pile>;
  /** Which pile sits at each seat position. Always a permutation of PILE_IDS. */
  pileAt: PerSeat<PileId>;
  hands: PerSeat<CardId[]>;
  keeps: PerSeat<KeepCard[]>;
  /** discard[0] is the bottom; the last element is the most recently discarded. */
  discard: CardId[];
  limbo: LimboCard[];
  /** Out-of-play cards. Must be empty unless config.partialDeck. */
  box: CardId[];
  turn: TurnState | null;
  /** Resolution stack; the last element is the top. */
  stack: Op[];
  /** Open decisions. Non-empty means the engine is waiting for input. */
  prompts: Prompt[];
  roundEnd: RoundEnd | null;
  /** Sequence number of the last emitted trace event. */
  traceSeq: number;
}

export function playerSeats(state: Pick<GameState, 'config'>): Seat[] {
  return SEATS.filter((s) => state.config.seats[s] === 'player');
}

export function pileAtSeat(state: GameState, seat: Seat): Pile {
  return state.piles[state.pileAt[seat]];
}
