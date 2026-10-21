import { describe, expect, it } from 'vitest';
import {
  buildPosition,
  CARD_IDS,
  cardLocations,
  checkInvariants,
  type PositionSpec,
} from '../src/index.ts';

describe('buildPosition', () => {
  it('places named cards where the spec says', () => {
    const state = buildPosition({
      seats: ['player', 'ghost', 'player', 'ghost'],
      piles: { 0: ['dagger', { id: 'blunder', faceUp: true }], 3: ['chalice'] },
      hands: { 2: ['hocus-pocus', 'joker'] },
      keeps: { 0: ['juggling', { id: 'shackles', faceDown: { placedBy: 2 } }] },
      discard: ['prayer', 'pluck'],
      turn: 2,
    });
    expect(state.piles[state.pileAt[0]].cards).toEqual([
      { id: 'dagger', faceUp: false },
      { id: 'blunder', faceUp: true },
    ]);
    expect(state.piles[state.pileAt[3]].cards).toEqual([{ id: 'chalice', faceUp: false }]);
    expect(state.hands[2]).toEqual(['hocus-pocus', 'joker']);
    expect(state.keeps[0]).toEqual([{ id: 'juggling' }, { id: 'shackles', faceDown: { placedBy: 2 } }]);
    expect(state.discard).toEqual(['prayer', 'pluck']);
    expect(state.turn).toEqual({ seat: 2, actionsTaken: 0, usedOncePerTurn: [] });
    expect(state.box).toHaveLength(36 - 9);
    expect(checkInvariants(state)).toEqual([]);
  });

  it("fills '?' from unnamed cards, deterministically per seed", () => {
    const spec = (seed: number): PositionSpec => ({
      piles: { 1: ['?', '?', 'joker'] },
      hands: { 0: ['?'] },
      seed,
    });
    const a = buildPosition(spec(1));
    expect(buildPosition(spec(1))).toEqual(a);
    expect(buildPosition(spec(2))).not.toEqual(a);

    const filled = [...a.piles[a.pileAt[1]].cards.slice(0, 2).map((c) => c.id), ...a.hands[0]];
    expect(filled).not.toContain('joker');
    expect(new Set(filled).size).toBe(3);
    expect(a.box).toHaveLength(36 - 4);
  });

  it('puts every card somewhere exactly once', () => {
    const state = buildPosition({ piles: { 0: Array(30).fill('?') } });
    const locations = cardLocations(state);
    expect(locations.size).toBe(36);
    for (const id of CARD_IDS) expect(locations.get(id)).toHaveLength(1);
  });

  it('rejects duplicate cards', () => {
    expect(() => buildPosition({ hands: { 0: ['joker'] }, discard: ['joker'] })).toThrow(/duplicate cards: joker/);
  });

  it("rejects more '?' cards than there are unnamed cards", () => {
    expect(() => buildPosition({ piles: { 0: Array(37).fill('?') } })).toThrow(/more '\?' cards/);
  });

  it('rejects Keep cards whose rules are not implemented yet', () => {
    expect(() => buildPosition({ keeps: { 0: ['duplicity'] } })).toThrow(/not implemented yet.*duplicity/);
  });

  it('rejects invalid positions via the invariant checker', () => {
    expect(() =>
      buildPosition({ seats: ['player', 'ghost', 'player', 'ghost'], hands: { 1: ['joker'] } }),
    ).toThrow(/ghost seat 1 has a hand/);
  });
});
