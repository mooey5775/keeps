import { describe, expect, it } from 'vitest';
import { CARD_IDS, CARDS, keepValue } from '../../src/index.ts';
import { keepOf } from '../helpers.ts';

// The plain Coin cards: worth coins, with no other effect.

describe('Chalice', () => {
  it('is worth 2 coins and has no other effect', () => {
    expect(keepValue(keepOf('chalice'))).toBe(4);
    expect(CARDS.chalice.text).toBe('');
  });
});

describe('Dagger', () => {
  it('is worth 2 coins', () => {
    expect(keepValue(keepOf('dagger'))).toBe(4);
  });
});

describe('Medallion', () => {
  it('is worth 2 coins, and can bring a Purity keep down (Last Laugh 2)', () => {
    expect(keepValue(keepOf('purity'))).toBe(20);
    expect(keepValue(keepOf('purity', 'medallion'))).toBe(4);
  });
});

describe('Scepter', () => {
  it('is worth 2 coins', () => {
    expect(keepValue(keepOf('scepter'))).toBe(4);
  });
});

describe('Timepiece', () => {
  it('is worth 2 coins', () => {
    expect(keepValue(keepOf('timepiece'))).toBe(4);
  });
});

describe('Fabergé Egg', () => {
  it('is worth 3 coins, the most of any single card', () => {
    expect(keepValue(keepOf('faberge-egg'))).toBe(6);
    const values = CARD_IDS.map((id) => CARDS[id].coins).filter((c): c is number => typeof c === 'number');
    expect(Math.max(...values)).toBe(6);
  });
});
