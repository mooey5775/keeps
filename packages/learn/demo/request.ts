// One request of observations for the network, in the inference protocol's binary form (inference.ts describes it):
// the GPU server (bot/keeps_bot/serve.py) reads it over a Unix socket, the iOS app's Core ML host over its URL scheme.
// Kept apart from inference.ts, which needs Node's sockets, so a browser can use it.

/** The observations as one request (the protocol in inference.ts). */
export function encodeRequest(rows: Float32Array[]): Uint8Array {
  let nonzeros = 0;
  for (const obs of rows) for (let i = 0; i < obs.length; i++) if (obs[i] !== 0) nonzeros++;
  const bytes = new Uint8Array(8 + 4 * rows.length + 6 * nonzeros);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, rows.length, true);
  view.setUint32(4, nonzeros, true);
  const values = 8 + 4 * rows.length;
  const indices = values + 4 * nonzeros;
  let k = 0;
  rows.forEach((obs, r) => {
    if (obs.length > 65536) throw new Error('observations too long for uint16 indices');
    for (let i = 0; i < obs.length; i++) {
      if (obs[i] === 0) continue;
      view.setFloat32(values + 4 * k, obs[i]!, true);
      view.setUint16(indices + 2 * k, i, true);
      k++;
    }
    view.setUint32(8 + 4 * r, k, true);
  });
  return bytes;
}
