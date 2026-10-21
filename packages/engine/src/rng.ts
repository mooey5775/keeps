// Seeded PRNG (sfc32). Its state lives in GameState so that a game is fully
// reproducible from its seed and command log, and so undo restores it.
// Functions mutate the RngState they are given; the engine only ever passes
// the RngState of a draft state it owns.

export interface RngState {
  a: number;
  b: number;
  c: number;
  d: number;
}

/** Hashes a seed into four 32-bit words (cyrb128). */
export function seedRng(seed: string | number): RngState {
  const str = String(seed);
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  const rng = {
    a: (h1 ^ h2 ^ h3 ^ h4) >>> 0,
    b: (h2 ^ h1) >>> 0,
    c: (h3 ^ h1) >>> 0,
    d: (h4 ^ h1) >>> 0,
  };
  // Discard early outputs, which are weakly mixed for similar seeds.
  for (let i = 0; i < 15; i++) nextUint32(rng);
  return rng;
}

export function nextUint32(rng: RngState): number {
  const t = (((rng.a + rng.b) | 0) + rng.d) | 0;
  rng.d = (rng.d + 1) | 0;
  rng.a = rng.b ^ (rng.b >>> 9);
  rng.b = (rng.c + (rng.c << 3)) | 0;
  rng.c = (rng.c << 21) | (rng.c >>> 11);
  rng.c = (rng.c + t) | 0;
  return t >>> 0;
}

/** Uniform integer in [0, n). Uses rejection sampling to avoid modulo bias. */
export function randomInt(rng: RngState, n: number): number {
  if (!Number.isInteger(n) || n <= 0 || n > 2 ** 32) {
    throw new RangeError(`randomInt: n must be an integer in [1, 2^32], got ${n}`);
  }
  const limit = 2 ** 32 - (2 ** 32 % n);
  let x: number;
  do {
    x = nextUint32(rng);
  } while (x >= limit);
  return x % n;
}

/** Fisher–Yates shuffle, in place. Returns the same array. */
export function shuffle<T>(rng: RngState, items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = randomInt(rng, i + 1);
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
  return items;
}

export function pick<T>(rng: RngState, items: readonly T[]): T {
  if (items.length === 0) throw new RangeError('pick: empty list');
  return items[randomInt(rng, items.length)]!;
}
