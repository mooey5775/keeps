import { describe, expect, it } from 'vitest';
import { natoSpelling, natoWords } from '../src/game/nato.ts';

describe('NATO spelling of room codes', () => {
  it('spells a room code letter by letter', () => {
    expect(natoWords('MTUC')).toEqual(['Mike', 'Tango', 'Uniform', 'Charlie']);
    expect(natoSpelling('kgju')).toBe('Kilo · Golf · Juliett · Uniform');
  });

  it('covers every letter a room code can use', () => {
    const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // the server's alphabet (no I, O, L)
    for (const letter of CODE_LETTERS) expect(natoWords(letter)[0]).not.toBe(letter);
  });
});
