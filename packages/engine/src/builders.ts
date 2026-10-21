import { CARD_IDS, type CardId } from './cards.ts';
import { newCtx } from './context.ts';
import { advance, beginTurn } from './engine.ts';
import { assertInvariants, assertRestInvariants } from './invariants.ts';
import { Tracer } from './trace.ts';
import { seedRng, shuffle } from './rng.ts';
import { emptyState } from './setup.ts';
import {
  PILE_IDS,
  SEATS,
  type GameState,
  type KeepCard,
  type PerSeat,
  type PileCard,
  type PileId,
  type Seat,
  type SeatKind,
} from './state.ts';

// Builds an arbitrary position directly, for tests and puzzles.
//
// '?' stands for "some card nobody specified": it is filled from the cards
// not named anywhere in the spec, in a seeded random order. Cards that are
// neither named nor used for '?' go to the box (out of play).

export type CardSpec = CardId | '?';
export type PileCardSpec = CardSpec | { id: CardSpec; faceUp: true };

export interface PositionSpec {
  /** Default: four players. */
  seats?: PerSeat<SeatKind>;
  /** Pile contents by seat position, top first. Unlisted positions are empty. */
  piles?: Partial<Record<Seat, readonly PileCardSpec[]>>;
  /** Hidden pile identity at each position. Default: count, fool, friar, mask. */
  pileAt?: PerSeat<PileId>;
  hands?: Partial<Record<Seat, readonly CardSpec[]>>;
  /** Keeps are public, so every card must be named. */
  keeps?: Partial<Record<Seat, readonly (CardId | KeepCard)[]>>;
  /** Bottom first; the last card is the most recent discard. */
  discard?: readonly CardId[];
  /**
   * Starts this seat's turn, so the state is waiting on its first action.
   * Default: nobody's turn (a static position, not ready for commands).
   */
  turn?: Seat;
  /** Overrides the number of actions the turn starts with (default: 2, or 1 if Shackled). */
  actions?: number;
  /**
   * Extra action frames stacked above the turn frame, bottom first, as if
   * granted mid-turn (e.g. a Retribution owner's two actions). Requires `turn`.
   */
  frames?: { seat: Seat; kind: 'hocus-pocus' | 'retribution'; remaining: number }[];
  marks?: PerSeat<number>;
  round?: number;
  marksToWin?: number;
  /** Seeds both the '?' fill order and the game's RNG. Default 'position'. */
  seed?: string | number;
}

export function buildPosition(spec: PositionSpec): GameState {
  const rng = seedRng(spec.seed ?? 'position');
  const seats = spec.seats ?? ['player', 'player', 'player', 'player'];
  const state = emptyState({ seats, marksToWin: spec.marksToWin ?? 3, partialDeck: true }, rng);

  // Every explicitly named card, to find duplicates and the '?' pool.
  const named: CardId[] = [];
  const name = (id: CardSpec) => {
    if (id !== '?') named.push(id);
  };
  for (const cards of Object.values(spec.piles ?? {})) {
    for (const c of cards) name(typeof c === 'string' ? c : c.id);
  }
  for (const cards of Object.values(spec.hands ?? {})) cards.forEach(name);
  for (const cards of Object.values(spec.keeps ?? {})) {
    for (const c of cards) name(typeof c === 'string' ? c : c.id);
  }
  (spec.discard ?? []).forEach(name);

  const duplicates = named.filter((id, i) => named.indexOf(id) !== i);
  if (duplicates.length > 0) throw new Error(`buildPosition: duplicate cards: ${duplicates.join(', ')}`);

  const pool = shuffle(rng, CARD_IDS.filter((id) => !named.includes(id)));
  const fill = (id: CardSpec): CardId => {
    if (id !== '?') return id;
    const next = pool.pop();
    if (!next) throw new Error("buildPosition: more '?' cards than unnamed cards");
    return next;
  };

  state.pileAt = spec.pileAt ?? [...PILE_IDS] as PerSeat<PileId>;
  for (const seat of SEATS) {
    const cards: PileCard[] = (spec.piles?.[seat] ?? []).map((c) =>
      typeof c === 'string' ? { id: fill(c), faceUp: false } : { id: fill(c.id), faceUp: true },
    );
    const pile = state.pileAt[seat];
    state.piles[pile] = { id: pile, cards };
    state.hands[seat] = (spec.hands?.[seat] ?? []).map(fill);
    state.keeps[seat] = (spec.keeps?.[seat] ?? []).map((c) => (typeof c === 'string' ? { id: c } : { ...c }));
  }
  state.discard = [...(spec.discard ?? [])];
  state.box = pool.sort((a, b) => CARD_IDS.indexOf(a) - CARD_IDS.indexOf(b));

  state.round = spec.round ?? 1;
  state.marks = spec.marks ?? [0, 0, 0, 0];
  assertInvariants(state);
  if (spec.frames && spec.turn === undefined) throw new Error('buildPosition: frames require turn');
  if (spec.turn !== undefined) {
    state.startingSeat = spec.turn;
    const ctx = newCtx(state, new Tracer(state));
    beginTurn(ctx, spec.turn);
    const frame = state.stack.at(-1);
    if (spec.actions !== undefined && frame?.op === 'action-frame') frame.remaining = spec.actions;
    let restricted = false;
    for (const extra of spec.frames ?? []) {
      restricted ||= extra.kind === 'retribution';
      state.stack.push({ op: 'action-frame', ...extra, restricted, cause: null, depth: 0, play: null });
    }
    advance(ctx);
    assertInvariants(state);
    assertRestInvariants(state);
  }
  return state;
}
