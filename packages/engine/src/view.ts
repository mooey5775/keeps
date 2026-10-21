import type { CardId } from './cards.ts';
import type { Command } from './commands.ts';
import { clone } from './context.ts';
import { duplicityHolder } from './duplicity.ts';
import { legalCommands } from './engine.ts';
import { scores } from './scoring.ts';
import {
  SEATS,
  type GameState,
  type PerSeat,
  type Phase,
  type Prompt,
  type RoundEnd,
  type Seat,
  type SeatKind,
} from './state.ts';

// What one player (or a spectator) may see. The server sends only views,
// never GameState: pile identities, pile contents, other hands, and the RNG
// state must never leave the server.

export type Viewer = Seat | 'spectator';

export interface PileView {
  position: Seat;
  size: number;
  /** The top card, only if it lies face up (Revelation, a placed Blunder). */
  top: CardId | null;
}

export type KeepCardView =
  | { faceDown: false; id: CardId }
  /** `id` is present only for the player who placed it (ruling Q-04). */
  | { faceDown: true; id?: CardId };

type PromptBaseKeys = 'event' | 'depth' | 'play';
/** Your own prompts in full (minus engine bookkeeping); others' only by kind. */
export type PromptView =
  | (Prompt extends infer P ? (P extends Prompt ? Omit<P, PromptBaseKeys> & { mine: true } : never) : never)
  | { mine: false; id: string; seat: Seat; kind: Prompt['kind'] };

export interface PlayerView {
  viewer: Viewer;
  seats: SeatKind[];
  marksToWin: number;
  marks: PerSeat<number>;
  round: number;
  turnNumber: number;
  phase: Phase;
  turn: { seat: Seat; actionsTaken: number } | null;
  startingSeat: Seat | null;
  lastRoundWinner: Seat | null;
  roundEnd: RoundEnd | null;
  piles: PileView[];
  /** Every player's hand size; `cards` only for your own hand. */
  hands: { seat: Seat; count: number; cards?: CardId[] }[];
  keeps: { seat: Seat; cards: KeepCardView[] }[];
  /** Bottom first. */
  discard: CardId[];
  /** Current keep values in half-coins (public: every input is a public card). */
  scores: PerSeat<number | null>;
  prompts: PromptView[];
  /** Who may reveal Duplicity's face-down card, if there is one. */
  duplicityHolder: Seat | null;
  /** Commands you may send right now. */
  legal: Command[];
}

export function viewFor(state: GameState, viewer: Viewer): PlayerView {
  const me = viewer === 'spectator' ? null : viewer;
  return {
    viewer,
    seats: [...state.config.seats],
    marksToWin: state.config.marksToWin,
    marks: [...state.marks],
    round: state.round,
    turnNumber: state.turnNumber,
    phase: state.phase,
    turn: state.turn && { seat: state.turn.seat, actionsTaken: state.turn.actionsTaken },
    startingSeat: state.startingSeat,
    lastRoundWinner: state.lastRoundWinner,
    roundEnd: state.roundEnd,
    piles: SEATS.map((position) => {
      const cards = state.piles[state.pileAt[position]].cards;
      const top = cards[0];
      return { position, size: cards.length, top: top?.faceUp ? top.id : null };
    }),
    hands: SEATS.map((seat) => {
      const hand = state.hands[seat];
      return seat === me ? { seat, count: hand.length, cards: [...hand] } : { seat, count: hand.length };
    }),
    keeps: SEATS.map((seat) => ({
      seat,
      cards: state.keeps[seat].map((c): KeepCardView => {
        if (!c.faceDown) return { faceDown: false, id: c.id };
        return c.faceDown.placedBy === me ? { faceDown: true, id: c.id } : { faceDown: true };
      }),
    })),
    discard: [...state.discard],
    scores: scores(state),
    prompts: state.prompts.map((p): PromptView => {
      if (p.seat !== me) return { mine: false, id: p.id, seat: p.seat, kind: p.kind };
      const { event: _event, depth: _depth, play: _play, ...rest } = p;
      return { ...clone(rest), mine: true } as PromptView;
    }),
    duplicityHolder: duplicityHolder(state),
    legal: me === null ? [] : legalCommands(state, me),
  };
}
