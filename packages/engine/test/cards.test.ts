import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CARD_IDS, CARDS, CHARACTERS, isCoinCard, type CardId } from '../src/index.ts';

const CARD_IMAGE_DIR = join(import.meta.dirname, '../../../cards');

const ids = (pred: (id: CardId) => boolean) => CARD_IDS.filter(pred);

describe('card data', () => {
  it('has 36 unique cards numbered 1–36 in order', () => {
    expect(CARD_IDS).toHaveLength(36);
    expect(new Set(CARD_IDS).size).toBe(36);
    CARD_IDS.forEach((id, i) => {
      expect(CARDS[id].id).toBe(id);
      expect(CARDS[id].number).toBe(i + 1);
    });
  });

  it('has 12 cards per character: Count 1–12, Fool 13–24, Friar 25–36', () => {
    for (const [i, character] of CHARACTERS.entries()) {
      const numbers = ids((id) => CARDS[id].character === character).map((id) => CARDS[id].number);
      expect(numbers).toEqual(Array.from({ length: 12 }, (_, k) => i * 12 + k + 1));
    }
  });

  it('points every card at an existing image whose number matches', () => {
    for (const id of CARD_IDS) {
      const { image, number } = CARDS[id];
      expect(image.startsWith(String(number).padStart(2, '0'))).toBe(true);
      expect(existsSync(join(CARD_IMAGE_DIR, image)), image).toBe(true);
    }
  });

  it('marks exactly the HOT cards printed with a flame', () => {
    expect(ids((id) => CARDS[id].hot)).toEqual([
      'acquisition', 'fiat', 'royal-favor', 'juggling', 'pandemonium', 'blunder',
      'sanction', 'invocation', 'revelation',
    ]);
  });

  it('marks exactly the Keep cards printed with a chest', () => {
    expect(ids((id) => !CARDS[id].keep)).toEqual([
      'requisition', 'pandemonium', 'joker', 'hocus-pocus', 'legerdemain', 'pickpocket', 'pluck',
      'invocation', 'revelation', 'epiphany', 'offering', 'prayer', 'providence', 'resurrection',
    ]);
  });

  it('has the printed coin values, in half-coins', () => {
    const coins = Object.fromEntries(ids(isCoinCard).map((id) => [id, CARDS[id].coins]));
    expect(coins).toEqual({
      'count-token': -2,
      'royal-favor': 1,
      chalice: 4,
      dagger: 4,
      medallion: 4,
      scepter: 4,
      timepiece: 4,
      'faberge-egg': 6,
      'fool-token': -2,
      blunder: -20,
      shackles: -6,
      'friar-token': -2,
      tithes: 'tithes',
    });
  });

  it('does not treat Purity as a Coin card', () => {
    expect(isCoinCard('purity')).toBe(false);
  });

  it('only gives coin values to Keep cards', () => {
    for (const id of ids(isCoinCard)) expect(CARDS[id].keep, id).toBe(true);
  });
});
