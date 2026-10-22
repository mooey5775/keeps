import { actionName, NUM_ACTIONS } from './actions.ts';
import { observationSize, RoundEnv, type ObservationVersion } from './env.ts';

// A fingerprint of what the network sees: a hash of the observations and legal
// actions along a few fixed rounds. Any change to the encoding, the beliefs or
// the action ids changes it, so trained weights can record the fingerprint they
// were trained with and refuse to run against a different one (they would
// silently play nonsense).

export function encoderFingerprint(version: ObservationVersion = 1): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  const mix = (bytes: Uint8Array) => {
    for (let i = 0; i < bytes.length; i++) {
      a = Math.imul(a ^ bytes[i]!, 0x01000193) >>> 0;
      b = Math.imul(b ^ bytes[i]!, 0x5bd1e995) >>> 0;
    }
  };
  const text = new TextEncoder();
  mix(text.encode(`${version === 1 ? '' : `v${version}:`}${observationSize(version)}:${NUM_ACTIONS}:${Array.from({ length: NUM_ACTIONS }, (_, i) => actionName(i)).join(',')}`));
  let x = 1;
  const choose = (n: number) => {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    return x % n;
  };
  for (let round = 0; round < 3; round++) {
    const env = RoundEnv.start(`fingerprint-${round}`, { observation: version });
    while (!env.terminal) {
      for (const player of [0, 1]) {
        const obs = env.observation(player);
        mix(new Uint8Array(obs.buffer, obs.byteOffset, obs.byteLength));
      }
      const legal = env.legalActions();
      mix(Uint8Array.from(legal));
      env.step(legal[choose(legal.length)]!);
    }
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
