// Seeded random streams for the batched search: sfc32 (128 bits of state), seeded through splitmix32 from a
// search's seed and a stream number, so streams with different numbers don't overlap the way LCG streams
// seeded from one another do (each would be the same sequence, shifted).

function splitmix32(x: number): () => number {
  return () => {
    x = (x + 0x9e3779b9) | 0;
    let z = x;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/** Uniform numbers in [0, 1): stream `stream` of `seed`. */
export function seeded(seed: number, stream: number): () => number {
  const mix = splitmix32((seed ^ Math.imul(stream, 0x27d4eb2f)) | 0);
  let a = mix() ^ stream;
  let b = mix();
  let c = mix();
  let d = mix();
  const next = () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();
  return next;
}
