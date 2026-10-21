import { describe, expect, it } from 'vitest';
import { buildPosition, coinsLabel, keepValue, scores, tokenWinner, type KeepCard } from '../src/index.ts';

const keep = (...ids: KeepCard['id'][]): KeepCard[] => ids.map((id) => ({ id }));

describe('keep value (half-coins)', () => {
  it('is zero for an empty keep', () => {
    expect(keepValue([])).toBe(0);
  });

  it('sums printed coin values, including half coins and negatives', () => {
    expect(keepValue(keep('chalice', 'faberge-egg'))).toBe(10);
    expect(keepValue(keep('royal-favor'))).toBe(1);
    expect(coinsLabel(keepValue(keep('royal-favor', 'chalice')))).toBe('2.5');
    expect(keepValue(keep('blunder', 'shackles', 'count-token'))).toBe(-28);
  });

  it('ignores cards without a coin value', () => {
    expect(keepValue(keep('interest', 'juggling', 'last-laugh'))).toBe(0);
  });

  it('counts Tithes as one coin per card in its keep, including itself', () => {
    expect(keepValue(keep('tithes'))).toBe(2);
    expect(keepValue(keep('tithes', 'interest', 'juggling'))).toBe(6);
    expect(keepValue(keep('tithes', 'chalice'))).toBe(4 + 4);
  });

  it('counts a face-down card toward Tithes but gives it no coin value', () => {
    const cards: KeepCard[] = [{ id: 'tithes' }, { id: 'faberge-egg', faceDown: { placedBy: 0 } }];
    expect(keepValue(cards)).toBe(4);
  });

  it('values Purity at 10 coins when it is alone', () => {
    expect(keepValue(keep('purity'))).toBe(20);
    expect(keepValue(keep('purity', 'interest'))).toBe(20);
  });

  it('C-31 Purity is worth 10 when the other Coin cards total zero (Dagger and two Tokens)', () => {
    expect(keepValue(keep('purity', 'dagger', 'count-token', 'fool-token'))).toBe(20);
  });

  it('values Purity at nothing when the rest of the keep is not exactly zero', () => {
    expect(keepValue(keep('purity', 'chalice'))).toBe(4);
    expect(keepValue(keep('purity', 'count-token'))).toBe(-2);
    // Tithes counts Purity as a card, so the keep is worth 2 coins and Purity is off.
    expect(keepValue(keep('purity', 'tithes'))).toBe(4);
  });

  it('ignores face-down coin cards when checking Purity', () => {
    const cards: KeepCard[] = [{ id: 'purity' }, { id: 'chalice', faceDown: { placedBy: 1 } }];
    expect(keepValue(cards)).toBe(20);
  });
});

describe('scores', () => {
  it('reports null for ghost seats', () => {
    const state = buildPosition({ seats: ['player', 'ghost', 'player', 'ghost'], keeps: { 0: ['chalice'] } });
    expect(scores(state)).toEqual([4, null, 0, null]);
  });
});

describe('tokenWinner', () => {
  it('requires all three Tokens face-up in one keep', () => {
    expect(tokenWinner(buildPosition({ keeps: { 2: ['count-token', 'fool-token', 'friar-token'] } }))).toBe(2);
    expect(tokenWinner(buildPosition({ keeps: { 2: ['count-token', 'fool-token'], 3: ['friar-token'] } }))).toBeNull();
    const faceDown = buildPosition({
      keeps: { 2: ['count-token', 'fool-token', { id: 'friar-token', faceDown: { placedBy: 0 } }] },
    });
    expect(tokenWinner(faceDown)).toBeNull();
  });
});
