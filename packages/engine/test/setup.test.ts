import { describe, expect, it } from 'vitest';
import {
  CARDS,
  PILE_IDS,
  SEATS,
  checkInvariants,
  eventsFor,
  formatTrace,
  newGame,
  startRound,
  Tracer,
  type GameState,
} from '../src/index.ts';

const SEEDS = Array.from({ length: 200 }, (_, i) => `setup-${i}`);

function characterCounts(state: GameState, pile: (typeof PILE_IDS)[number]) {
  const counts = { count: 0, fool: 0, friar: 0 };
  for (const c of state.piles[pile].cards) counts[CARDS[c.id].character]++;
  return counts;
}

describe('setup', () => {
  it('R-01 deals 4 face-down piles of 9: one per character plus the Mask (3 of each)', () => {
    for (const seed of SEEDS) {
      const { state } = newGame({ players: 4, seed });
      expect(checkInvariants(state)).toEqual([]);
      expect(characterCounts(state, 'count')).toEqual({ count: 9, fool: 0, friar: 0 });
      expect(characterCounts(state, 'fool')).toEqual({ count: 0, fool: 9, friar: 0 });
      expect(characterCounts(state, 'friar')).toEqual({ count: 0, fool: 0, friar: 9 });
      expect(characterCounts(state, 'mask')).toEqual({ count: 3, fool: 3, friar: 3 });
      for (const pile of PILE_IDS) {
        expect(state.piles[pile].cards.every((c) => !c.faceUp)).toBe(true);
      }
      expect(state.hands.flat()).toEqual([]);
      expect(state.keeps.flat()).toEqual([]);
      expect(state.discard).toEqual([]);
    }
  });

  it('R-01 randomizes pile positions and the Mask contents', () => {
    const positions = new Set<string>();
    const masks = new Set<string>();
    for (const seed of SEEDS) {
      const { state } = newGame({ players: 4, seed });
      positions.add(state.pileAt.join());
      masks.add(
        state.piles.mask.cards
          .map((c) => c.id)
          .sort()
          .join(),
      );
    }
    // 24 possible arrangements; 200 deals should hit nearly all of them.
    expect(positions.size).toBeGreaterThan(20);
    expect(masks.size).toBeGreaterThan(150);
  });

  it('R-02 three players: one random ghost seat, which still has a pile but no hand or keep', () => {
    const ghostSeats = new Set<number>();
    for (const seed of SEEDS) {
      const { state } = newGame({ players: 3, seed });
      const ghosts = SEATS.filter((s) => state.config.seats[s] === 'ghost');
      expect(ghosts).toHaveLength(1);
      ghostSeats.add(ghosts[0]!);
      expect(state.piles[state.pileAt[ghosts[0]!]].cards).toHaveLength(9);
      expect(checkInvariants(state)).toEqual([]);
    }
    expect(ghostSeats.size).toBe(4);
  });

  it('C-06 two players sit at opposing piles, with ghosts between them', () => {
    for (const seed of SEEDS.slice(0, 20)) {
      const { state } = newGame({ players: 2, seed });
      expect(state.config.seats).toEqual(['player', 'ghost', 'player', 'ghost']);
      for (const seat of SEATS) expect(state.piles[state.pileAt[seat]].cards).toHaveLength(9);
    }
  });

  it('Q-12 the first player of round 1 is the given seat, or a random player', () => {
    expect(newGame({ players: 4, seed: 1, firstSeat: 3 }).state.startingSeat).toBe(3);
    expect(() => newGame({ players: 2, seed: 1, firstSeat: 1 })).toThrow(/not a player seat/);

    const starters = new Set<number>();
    for (const seed of SEEDS) {
      const { state } = newGame({ players: 2, seed });
      expect(state.config.seats[state.startingSeat!]).toBe('player');
      starters.add(state.startingSeat!);
    }
    expect([...starters].sort()).toEqual([0, 2]);
  });

  it("starts later rounds with the previous round's winner and a fresh deal", () => {
    const { state } = newGame({ players: 4, seed: 'rounds', firstSeat: 0 });
    state.lastRoundWinner = 2;
    state.marks = [0, 0, 1, 0];
    startRound(state, new Tracer(state));
    expect(state.round).toBe(2);
    expect(state.startingSeat).toBe(2);
    expect(state.marks).toEqual([0, 0, 1, 0]);
    expect(checkInvariants(state)).toEqual([]);
  });

  it('is fully determined by its seed', () => {
    const a = newGame({ players: 3, seed: 'same' });
    const b = newGame({ players: 3, seed: 'same' });
    expect(a.state).toEqual(b.state);
    expect(a.events).toEqual(b.events);
    expect(newGame({ players: 3, seed: 'other' }).state).not.toEqual(a.state);
  });

  it('rejects an invalid marksToWin', () => {
    expect(() => newGame({ players: 4, seed: 1, marksToWin: 0 })).toThrow(RangeError);
  });

  it('keeps pile contents server-only in the trace', () => {
    const { state, events } = newGame({ players: 2, seed: 'trace', firstSeat: 0 });
    const dealt = events.filter((e) => e.payload.type === 'pile-dealt');
    expect(dealt).toHaveLength(4);
    for (const e of dealt) expect(e.visibility).toEqual([]);

    const seen = eventsFor(events, 0);
    expect(seen.map((e) => e.payload.type)).toEqual([
      'game-start', 'round-start', 'pile-placed', 'pile-placed', 'pile-placed', 'pile-placed',
    ]);
    const serialized = JSON.stringify(seen);
    for (const pile of PILE_IDS) {
      for (const c of state.piles[pile].cards) expect(serialized).not.toContain(`"${c.id}"`);
    }
    expect(formatTrace(seen)).toContain('a pile of 9 cards placed at S0');
  });
});
