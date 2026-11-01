import { CARD_IDS, PILE_IDS, type CardId, type GameState, type Seat } from '@keeps/engine';
import { SEAT_OF_PLAYER } from '@keeps/bot';

// The true state of a heads-up round, for a training critic that may see
// everything (never for a policy: it shows what no player knows, such as the
// order of the piles). Positions and players are absolute: player 0 sits at seat
// 0, player 1 at seat 2, and pile position k is the pile at seat k.
//
//   cards  36 rows (CARD_IDS order)  where the card is, face down in a keep,
//                                    and in a pile: how deep (one-hot for the top
//                                    DEPTHS, and scaled), face up
//   piles  4 rows (positions 0..3)   the pile's character, its size

export const TRUTH_PLACES = ['hand-0', 'hand-1', 'keep-0', 'keep-1', 'discard', 'limbo', 'box',
  'pile-0', 'pile-1', 'pile-2', 'pile-3', 'other'] as const;
const DEPTHS = 5;
const SCALE = 12; // pile sizes and depths are divided by this

type Columns = Record<string, [start: number, width: number]>;
function columns(spec: [string, number][]): { width: number; columns: Columns } {
  const out: Columns = {};
  let at = 0;
  for (const [name, width] of spec) {
    out[name] = [at, width];
    at += width;
  }
  return { width: at, columns: out };
}

const CARD_COLUMNS = columns([['place', TRUTH_PLACES.length], ['face-down', 1], ['depth', DEPTHS], ['depth-scaled', 1], ['face-up', 1]]);
const PILE_COLUMNS = columns([['character', PILE_IDS.length], ['size', 1]]);
const CARD_ROWS = CARD_IDS.length;
const PILE_ROWS = 4;

export const TRUTH_LAYOUT = {
  size: CARD_ROWS * CARD_COLUMNS.width + PILE_ROWS * PILE_COLUMNS.width,
  blocks: {
    cards: { offset: 0, rows: CARD_ROWS, ...CARD_COLUMNS },
    piles: { offset: CARD_ROWS * CARD_COLUMNS.width, rows: PILE_ROWS, ...PILE_COLUMNS },
  },
  places: TRUTH_PLACES,
};
export const TRUTH_SIZE = TRUTH_LAYOUT.size;

const CARD_ROW = new Map<CardId, number>(CARD_IDS.map((id, i) => [id, i]));
const place = (name: (typeof TRUTH_PLACES)[number]) => TRUTH_PLACES.indexOf(name);
const PLAYER_OF_SEAT = new Map<Seat, number>(SEAT_OF_PLAYER.map((seat, player) => [seat, player]));

/** The true state, written into `out` at `start` (TRUTH_SIZE floats; every one is written). */
export function encodeTruth(state: GameState, out: Float32Array, start: number): void {
  out.fill(0, start, start + TRUTH_SIZE);
  const cards = TRUTH_LAYOUT.blocks.cards;
  const piles = TRUTH_LAYOUT.blocks.piles;
  const cardAt = (id: CardId, column: string, offset = 0): number => {
    const row = CARD_ROW.get(id);
    if (row === undefined) throw new Error(`unknown card ${id}`);
    return start + cards.offset + row * cards.width + cards.columns[column]![0] + offset;
  };
  const put = (id: CardId, where: number) => {
    out[cardAt(id, 'place', where)] = 1;
  };

  for (let seat = 0; seat < 4; seat++) {
    const player = PLAYER_OF_SEAT.get(seat as Seat);
    for (const id of state.hands[seat]!) put(id, player === undefined ? place('other') : place(player === 0 ? 'hand-0' : 'hand-1'));
    for (const card of state.keeps[seat]!) {
      put(card.id, player === undefined ? place('other') : place(player === 0 ? 'keep-0' : 'keep-1'));
      if (card.faceDown) out[cardAt(card.id, 'face-down')] = 1;
    }
    const pile = state.piles[state.pileAt[seat]!];
    for (let depth = 0; depth < pile.cards.length; depth++) {
      const card = pile.cards[depth]!;
      put(card.id, place(`pile-${seat}` as (typeof TRUTH_PLACES)[number]));
      if (depth < DEPTHS) out[cardAt(card.id, 'depth', depth)] = 1;
      out[cardAt(card.id, 'depth-scaled')] = depth / SCALE;
      if (card.faceUp) out[cardAt(card.id, 'face-up')] = 1;
    }
    const row = start + piles.offset + seat * piles.width;
    out[row + piles.columns['character']![0] + PILE_IDS.indexOf(pile.id)] = 1;
    out[row + piles.columns['size']![0]] = pile.cards.length / SCALE;
  }
  for (const id of state.discard) put(id, place('discard'));
  for (const card of state.limbo) put(card.id, place('limbo'));
  for (const id of state.box) put(id, place('box'));
}
