import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { nextUint32, pick, randomInt, seedRng, shuffle } from '../src/index.ts';

describe('rng', () => {
  it('is deterministic for a seed', () => {
    const a = seedRng('keeps');
    const b = seedRng('keeps');
    const seqA = Array.from({ length: 20 }, () => nextUint32(a));
    const seqB = Array.from({ length: 20 }, () => nextUint32(b));
    expect(seqA).toEqual(seqB);
  });

  it('diverges for different seeds, including adjacent numbers', () => {
    const first = (seed: string | number) => nextUint32(seedRng(seed));
    expect(first(1)).not.toBe(first(2));
    expect(first('a')).not.toBe(first('b'));
    expect(first(1)).not.toBe(first('1x'));
  });

  it('produces uint32 values', () => {
    const rng = seedRng(7);
    for (let i = 0; i < 1000; i++) {
      const x = nextUint32(rng);
      expect(Number.isInteger(x) && x >= 0 && x < 2 ** 32).toBe(true);
    }
  });

  it('randomInt stays in range and is roughly uniform', () => {
    const rng = seedRng('uniform');
    const counts = [0, 0, 0, 0, 0, 0];
    const n = 60_000;
    for (let i = 0; i < n; i++) counts[randomInt(rng, 6)]!++;
    for (const c of counts) expect(Math.abs(c - n / 6)).toBeLessThan(n / 6 * 0.05);
  });

  it('randomInt rejects invalid bounds', () => {
    const rng = seedRng(0);
    expect(() => randomInt(rng, 0)).toThrow(RangeError);
    expect(() => randomInt(rng, 2.5)).toThrow(RangeError);
  });

  it('shuffle always returns a permutation, in place', () => {
    fc.assert(
      fc.property(fc.array(fc.integer()), fc.string(), (items, seed) => {
        const copy = [...items];
        const result = shuffle(seedRng(seed), copy);
        expect(result).toBe(copy);
        expect([...result].sort((a, b) => a - b)).toEqual([...items].sort((a, b) => a - b));
      }),
    );
  });

  it('shuffle reaches every ordering of a small list', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 500; seed++) seen.add(shuffle(seedRng(seed), [1, 2, 3]).join());
    expect(seen.size).toBe(6);
  });

  it('pick rejects an empty list', () => {
    expect(() => pick(seedRng(0), [])).toThrow(RangeError);
  });
});
