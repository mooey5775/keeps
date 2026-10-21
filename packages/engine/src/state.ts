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

export type Phase = 'playing' | 'post-round' | 'game-over';

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
export type Op = ActionFrameOp;

export interface Prompt {
  id: string;
  seat: Seat;
  kind: 'action';
}

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
