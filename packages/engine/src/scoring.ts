import { CARDS, TOKENS } from './cards.ts';
import { leftOf, playerSeats, type GameState, type KeepCard, type PerSeat, type Seat } from './state.ts';

/**
 * A keep's value in half-coins.
 * - Face-down cards (Duplicity) have no effect, so no coin value, but they
 *   still count as cards for Tithes.
 * - Tithes is worth one coin per card in its keep, including itself.
 * - Purity is worth 10 coins if the rest of the keep sums to exactly 0. It is
 *   not a Coin card, so it never counts toward that sum.
 */
export function keepValue(keep: readonly KeepCard[]): number {
  let sum = 0;
  for (const card of keep) {
    if (card.faceDown) continue;
    const coins = CARDS[card.id].coins;
    if (coins === 'tithes') sum += 2 * keep.length;
    else if (coins !== undefined) sum += coins;
  }
  const purity = keep.some((c) => c.id === 'purity' && !c.faceDown);
  return purity && sum === 0 ? 20 : sum;
}

/** Each seat's keep value in half-coins; null for ghosts. */
export function scores(state: GameState): PerSeat<number | null> {
  return state.keeps.map((keep, seat) =>
    state.config.seats[seat] === 'player' ? keepValue(keep) : null,
  ) as PerSeat<number | null>;
}

export interface RoundResult {
  winner: Seat;
  scores: PerSeat<number | null>;
  /** Other players tied with the winner on coins (empty if no tie). */
  tiedWith: Seat[];
}

/**
 * Most coins wins. A tie goes to the tied player most directly left of whoever
 * drew to end the round, so the ender is checked last and loses ties.
 */
export function roundWinner(state: GameState, ender: Seat): RoundResult {
  const values = scores(state);
  const players = playerSeats(state);
  const best = Math.max(...players.map((s) => values[s]!));
  const order: Seat[] = [];
  for (let s = leftOf(ender); order.length < 4; s = leftOf(s)) order.push(s);
  const tied = order.filter((s) => values[s] === best);
  const [winner, ...tiedWith] = tied;
  return { winner: winner!, scores: values, tiedWith };
}

/** The seat whose keep holds all three Tokens face-up, if any. */
export function tokenWinner(state: GameState): Seat | null {
  for (const seat of playerSeats(state)) {
    const faceUp = state.keeps[seat].filter((c) => !c.faceDown).map((c) => c.id);
    if (TOKENS.every((t) => faceUp.includes(t))) return seat;
  }
  return null;
}
