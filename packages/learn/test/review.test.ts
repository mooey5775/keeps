import { describe, expect, it } from 'vitest';
import { verdictOf } from '../demo/review.ts';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A decision whose options win with the given chances, played out in `worlds` shared worlds (and `truth` playouts each with every card known). */
function decision(chances: number[], played: number, { worlds = 128, truth = chances, n = 64, chosen = null as number | null, seed = 1 } = {}) {
  const random = rng(seed);
  // Shared worlds: one draw per world, so options' results are correlated as the same worlds make them.
  const rows = Array.from({ length: worlds }, () => {
    const u = random();
    return chances.map((p) => (u < p ? 1 : 0));
  });
  return {
    commands: chances.map(() => ({ type: 'next-round' as const })),
    rows,
    truth: truth.map((p) => ({ wins: Math.round(p * n), n })),
    played,
    chosen,
    rechecked: false,
  };
}

describe('round review verdicts', () => {
  it("calls the bot's own pick the best, whatever the worlds say", () => {
    expect(verdictOf(decision([0.6, 0.62], 0, { chosen: 0 })).verdict).toBe('best');
  });

  it('flags a clear gap as a mistake, a big one as a blunder, and a mistake that the real cards forgave as worked out', () => {
    expect(verdictOf(decision([0.8, 0.65], 1, { truth: [0.8, 0.6] })).verdict).toBe('mistake');
    expect(verdictOf(decision([0.8, 0.5], 1)).verdict).toBe('blunder');
    expect(verdictOf(decision([0.8, 0.65], 1, { truth: [0.7, 0.72] })).verdict).toBe('mistake-worked-out');
  });

  it("doesn't call noise a mistake: a 10-point gap in a few worlds is only worth a recheck", () => {
    // Independent results (no shared worlds): the same averages, but far noisier differences.
    const random = rng(7);
    const rows = Array.from({ length: 24 }, () => [random() < 0.7 ? 1 : 0, random() < 0.58 ? 1 : 0]);
    // This draw makes the gap 33 points (it's 12): far past 10 points, still not clear in 24 worlds.
    expect(rows.reduce((a, r) => a + r[0]! - r[1]!, 0) / rows.length).toBeCloseTo(1 / 3, 5);
    const v = verdictOf({ commands: rows[0]!.map(() => ({ type: 'next-round' as const })), rows, truth: [{ wins: 40, n: 64 }, { wins: 38, n: 64 }], played: 1, chosen: null, rechecked: false });
    expect(v).toMatchObject({ verdict: null, unclear: true });
    // Once rechecked, an unclear gap stays unlabelled.
    expect(verdictOf({ commands: rows[0]!.map(() => ({ type: 'next-round' as const })), rows, truth: [{ wins: 40, n: 64 }, { wins: 38, n: 64 }], played: 1, chosen: null, rechecked: true }).unclear).toBe(false);
  });

  it('calls the right move unlucky when, with every card known, another was clearly better', () => {
    expect(verdictOf(decision([0.7, 0.6], 0, { truth: [0.2, 0.8] })).verdict).toBe('unlucky');
    expect(verdictOf(decision([0.7, 0.6], 0, { truth: [0.45, 0.55] })).verdict).toBe('best');
    // Not the bot's pick, but as good from what you knew (89% against 88%): the hidden cards made it costly.
    expect(verdictOf(decision([0.88, 0.89], 1, { chosen: 0, truth: [0.88, 0.47] })).verdict).toBe('unlucky');
    expect(verdictOf(decision([0.88, 0.89], 1, { chosen: 0, truth: [0.88, 0.85] })).verdict).toBeNull();
  });
});
