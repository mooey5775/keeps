import { CARD_IDS, CARDS, CHARACTERS, type CardId, type Character } from './cards.ts';
import { assertInvariants } from './invariants.ts';
import { pick, seedRng, shuffle, type RngState } from './rng.ts';
import {
  PILE_IDS,
  perSeat,
  playerSeats,
  type GameConfig,
  type GameState,
  type PerSeat,
  type PileId,
  type Seat,
  type SeatKind,
} from './state.ts';
import { Tracer, type TraceEvent } from './trace.ts';

export interface NewGameOptions {
  players: 2 | 3 | 4;
  seed: string | number;
  /** Victory marks needed to win the game. Default 3. */
  marksToWin?: number;
  /** Who starts round 1 (the "wisest player"). Default: a random player. */
  firstSeat?: Seat;
}

/** A state with empty zones. Callers fill in the cards. */
export function emptyState(config: GameConfig, rng: RngState): GameState {
  return {
    config,
    rng,
    phase: 'playing',
    round: 0,
    turnNumber: 0,
    marks: [0, 0, 0, 0],
    startingSeat: null,
    lastRoundWinner: null,
    piles: {
      count: { id: 'count', cards: [] },
      fool: { id: 'fool', cards: [] },
      friar: { id: 'friar', cards: [] },
      mask: { id: 'mask', cards: [] },
    },
    pileAt: ['count', 'fool', 'friar', 'mask'],
    hands: perSeat(() => []),
    keeps: perSeat(() => []),
    discard: [],
    limbo: [],
    box: [],
    turn: null,
    stack: [],
    prompts: [],
    openPlays: [],
    roundEnd: null,
    traceSeq: 0,
  };
}

/**
 * Seating: 2 players sit at opposite piles (clarification), so seats 0 and 2.
 * 3 players: the ghost seat is random.
 */
function seatKinds(players: 2 | 3 | 4, rng: RngState): PerSeat<SeatKind> {
  if (players === 4) return ['player', 'player', 'player', 'player'];
  if (players === 2) return ['player', 'ghost', 'player', 'ghost'];
  const ghost = pick(rng, [0, 1, 2, 3] as const);
  return perSeat((s) => (s === ghost ? 'ghost' : 'player'));
}

/** Seats players and deals round 1, without starting the first turn (see engine.ts newGame). */
export function dealGame(options: NewGameOptions): { state: GameState; events: TraceEvent[] } {
  const marksToWin = options.marksToWin ?? 3;
  if (!Number.isInteger(marksToWin) || marksToWin < 1) {
    throw new RangeError(`marksToWin must be a positive integer, got ${marksToWin}`);
  }
  const rng = seedRng(options.seed);
  const seats = seatKinds(options.players, rng);
  if (options.firstSeat !== undefined && seats[options.firstSeat] !== 'player') {
    throw new RangeError(`firstSeat ${options.firstSeat} is not a player seat`);
  }
  const state = emptyState({ seats, marksToWin, partialDeck: false }, rng);
  const tracer = new Tracer(state);
  tracer.emit({ type: 'game-start', seats: [...seats], marksToWin });
  startRound(state, tracer, options.firstSeat);
  return { state, events: tracer.events };
}

/**
 * Rules card, Setup:
 * 1. Separate the 36 cards into the 3 character piles; shuffle each.
 * 2. The top 3 cards of each form a new, shuffled pile: the Mask.
 * 3–4. Randomize pile positions; nobody knows which pile is which.
 * The previous round's winner starts; otherwise `firstSeat` or a random player.
 */
export function startRound(state: GameState, tracer: Tracer, firstSeat?: Seat): void {
  const { rng } = state;
  const byCharacter = Object.fromEntries(CHARACTERS.map((c) => [c, [] as CardId[]])) as Record<
    Character,
    CardId[]
  >;
  for (const id of CARD_IDS) byCharacter[CARDS[id].character].push(id);
  for (const character of CHARACTERS) shuffle(rng, byCharacter[character]);

  const mask = shuffle(
    rng,
    CHARACTERS.flatMap((c) => byCharacter[c].splice(0, 3)),
  );
  const contents: Record<PileId, CardId[]> = { ...byCharacter, mask };
  for (const pile of PILE_IDS) {
    state.piles[pile] = { id: pile, cards: contents[pile].map((id) => ({ id, faceUp: false })) };
  }
  state.pileAt = shuffle(rng, [...PILE_IDS]) as PerSeat<PileId>;

  state.hands = perSeat(() => []);
  state.keeps = perSeat(() => []);
  state.discard = [];
  state.limbo = [];
  state.box = [];
  state.stack = [];
  state.prompts = [];
  state.openPlays = [];
  state.turn = null;
  state.roundEnd = null;
  state.phase = 'playing';
  state.round += 1;
  state.turnNumber = 0;
  state.startingSeat = state.lastRoundWinner ?? firstSeat ?? pick(rng, playerSeats(state));

  tracer.emit({ type: 'round-start', round: state.round, startingSeat: state.startingSeat });
  state.pileAt.forEach((pile, position) => {
    const seat = position as Seat;
    const cards = state.piles[pile].cards.map((c) => c.id);
    tracer.emit(
      { type: 'pile-dealt', position: seat, pile, cards },
      { visibility: [], redacted: { type: 'pile-placed', position: seat, size: cards.length } },
    );
  });
  assertInvariants(state);
}
