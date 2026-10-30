// One request of observations for the network, in the inference protocol's binary form (inference.ts describes it):
// the GPU server (bot/keeps_bot/serve.py) reads it over a Unix socket, the iOS app's Core ML host over its URL scheme.
// Kept apart from inference.ts, which needs Node's sockets, so a browser can use it.

// Typed arrays are in the platform's byte order; the protocol is little-endian, as every machine this runs on is.
if (new Uint8Array(Uint16Array.of(1).buffer)[0] !== 1) throw new Error('request.ts assumes a little-endian machine');

// Scratch for one request's nonzeros, grown as needed (one scan of each observation fills it).
let values = new Float32Array(1 << 16);
let indices = new Uint16Array(1 << 16);

/** The observations as one request (the protocol in inference.ts). */
export function encodeRequest(rows: Float32Array[]): Uint8Array {
  const ends = new Uint32Array(rows.length);
  let k = 0;
  rows.forEach((obs, r) => {
    if (obs.length > 65536) throw new Error('observations too long for uint16 indices');
    if (values.length < k + obs.length) {
      const grown = Math.max(2 * values.length, k + obs.length);
      values = copyInto(new Float32Array(grown), values, k);
      indices = copyInto(new Uint16Array(grown), indices, k);
    }
    // Most entries are zero: read them two at a time as one 64-bit float, which is 0 (or -0) only if both are
    // zeros (a -0 in the pair's low half makes a nonzero double, and the pair is then checked one by one).
    const even = obs.byteOffset % 8 === 0 && obs.length % 2 === 0;
    const pairs = even ? new Float64Array(obs.buffer, obs.byteOffset, obs.length / 2) : null;
    for (let i = 0; i < obs.length; i += 2) {
      if (pairs && pairs[i >> 1] === 0) continue;
      const v = obs[i]!;
      if (v !== 0) {
        values[k] = v;
        indices[k++] = i;
      }
      const w = obs[i + 1];
      if (w !== undefined && w !== 0) {
        values[k] = w;
        indices[k++] = i + 1;
      }
    }
    ends[r] = k;
  });
  // Every part starts 4-byte aligned except the indices (2-byte), so each is written as its own typed array.
  const bytes = new Uint8Array(8 + 4 * rows.length + 6 * k);
  const head = new Uint32Array(bytes.buffer, 0, 2 + rows.length);
  head[0] = rows.length;
  head[1] = k;
  head.set(ends, 2);
  new Float32Array(bytes.buffer, 8 + 4 * rows.length, k).set(values.subarray(0, k));
  new Uint16Array(bytes.buffer, 8 + 4 * rows.length + 4 * k, k).set(indices.subarray(0, k));
  return bytes;
}

function copyInto<T extends Float32Array | Uint16Array>(to: T, from: T, n: number): T {
  to.set(from.subarray(0, n));
  return to;
}
