import { CARD_IDS, CARDS, type CardId } from './cards.ts';
import { PILE_IDS, SEATS, type GameState, type LimboCard, type PileId, type Seat } from './state.ts';

export type Zone =
  | { kind: 'pile'; pile: PileId; index: number }
  | { kind: 'hand'; seat: Seat; index: number }
  | { kind: 'keep'; seat: Seat; index: number; faceDown: boolean }
  | { kind: 'discard'; index: number }
  | { kind: 'limbo'; reason: LimboCard['reason'] }
  | { kind: 'box' };

/** Every zone each card id appears in. Valid states have exactly one per card. */
export function cardLocations(state: GameState): Map<CardId, Zone[]> {
  const found = new Map<CardId, Zone[]>();
  const add = (id: CardId, zone: Zone) => {
    const zones = found.get(id);
    if (zones) zones.push(zone);
    else found.set(id, [zone]);
  };
  for (const pile of PILE_IDS) {
    state.piles[pile].cards.forEach((c, index) => add(c.id, { kind: 'pile', pile, index }));
  }
  for (const seat of SEATS) {
    state.hands[seat].forEach((id, index) => add(id, { kind: 'hand', seat, index }));
    state.keeps[seat].forEach((c, index) =>
      add(c.id, { kind: 'keep', seat, index, faceDown: c.faceDown !== undefined }),
    );
  }
  state.discard.forEach((id, index) => add(id, { kind: 'discard', index }));
  state.limbo.forEach((c) => add(c.id, { kind: 'limbo', reason: c.reason }));
  state.box.forEach((id) => add(id, { kind: 'box' }));
  return found;
}

/** The single zone holding a card. Throws if the card is missing or duplicated. */
export function locate(state: GameState, id: CardId): Zone {
  const zones = cardLocations(state).get(id) ?? [];
  if (zones.length !== 1) {
    throw new Error(`Card ${id} is in ${zones.length} zones: ${JSON.stringify(zones)}`);
  }
  return zones[0]!;
}

/** Returns a description of every violated invariant (empty = valid). */
export function checkInvariants(state: GameState): string[] {
  const problems: string[] = [];
  const known = new Set<string>(CARD_IDS);

  // Card conservation: all 36 cards, each in exactly one zone.
  const locations = cardLocations(state);
  for (const [id, zones] of locations) {
    if (!known.has(id)) problems.push(`unknown card id "${id}"`);
    else if (zones.length > 1) problems.push(`${id} is in ${zones.length} zones: ${JSON.stringify(zones)}`);
  }
  for (const id of CARD_IDS) {
    if (!locations.has(id)) problems.push(`${id} is missing from every zone`);
  }
  if (state.box.length > 0 && !state.config.partialDeck) {
    problems.push(`box holds ${state.box.length} cards but config.partialDeck is false`);
  }

  // Piles: pileAt is a permutation, and each pile knows its own id.
  const placed = [...state.pileAt].sort();
  if (placed.join() !== [...PILE_IDS].sort().join()) {
    problems.push(`pileAt is not a permutation of the four piles: ${state.pileAt.join(', ')}`);
  }
  for (const pile of PILE_IDS) {
    if (state.piles[pile].id !== pile) problems.push(`piles.${pile} has id ${state.piles[pile].id}`);
  }

  // Seats: ghosts hold nothing; keeps hold only Keep cards.
  for (const seat of SEATS) {
    const ghost = state.config.seats[seat] === 'ghost';
    if (ghost && state.hands[seat].length > 0) problems.push(`ghost seat ${seat} has a hand`);
    if (ghost && state.keeps[seat].length > 0) problems.push(`ghost seat ${seat} has a keep`);
    for (const card of state.keeps[seat]) {
      if (!CARDS[card.id]?.keep) problems.push(`non-Keep card ${card.id} is in seat ${seat}'s keep`);
      if (card.faceDown && state.config.seats[card.faceDown.placedBy] !== 'player') {
        problems.push(`face-down ${card.id} was placed by non-player seat ${card.faceDown.placedBy}`);
      }
    }
  }
  if (state.keeps.flat().filter((c) => c.faceDown).length > 1) {
    problems.push('more than one face-down keep card (only Duplicity places them)');
  }

  // Turn and score bookkeeping.
  if (state.turn && state.config.seats[state.turn.seat] !== 'player') {
    problems.push(`it is ghost seat ${state.turn.seat}'s turn`);
  }
  if (state.marks.some((m) => m < 0 || !Number.isInteger(m))) {
    problems.push(`invalid marks: ${state.marks.join(', ')}`);
  }
  return problems;
}

export function assertInvariants(state: GameState): void {
  const problems = checkInvariants(state);
  if (problems.length > 0) {
    throw new Error(`Invariant violation:\n  - ${problems.join('\n  - ')}`);
  }
}
