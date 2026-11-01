import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NUM_ACTIONS } from '../src/actions.ts';
import { OBSERVATION_SIZE } from '../src/observation.ts';
import { Policy, readTensors, sample } from '../src/policy.ts';

// The shipped weights, run in TypeScript, must give the probabilities JAX gives
// them: test/fixtures/bot-parity.bin holds decision points from self-play with
// JAX's raw and post-processed probabilities (training/keeps_bot/export.py writes
// both files together).

const weights = readFileSync(new URL('../weights/bot.bin', import.meta.url));
const fixture = readTensors(readFileSync(new URL('./fixtures/bot-parity.bin', import.meta.url)));

describe('policy', () => {
  const policy = Policy.load(weights);

  it('is the policy the fixture was made from, for the current encoder', () => {
    expect(fixture.header.run).toBe(policy.info.run);
    expect(fixture.header.step).toBe(policy.info.step);
    expect(policy.info.observationSize).toBe(OBSERVATION_SIZE);
  });

  it('gives the same probabilities as JAX', () => {
    const obs = fixture.tensors.get('obs')!;
    const legal = fixture.tensors.get('legal')!;
    const raw = fixture.tensors.get('raw')!;
    const probs = fixture.tensors.get('probs')!;
    const rows = obs.shape[0]!;
    expect(rows).toBeGreaterThanOrEqual(50);
    let worstRaw = 0;
    for (let r = 0; r < rows; r++) {
      const o = obs.data.subarray(r * OBSERVATION_SIZE, (r + 1) * OBSERVATION_SIZE);
      const l = legal.data.subarray(r * NUM_ACTIONS, (r + 1) * NUM_ACTIONS);
      const mine = policy.raw(o, l);
      const played = policy.probabilities(o, l);
      for (let a = 0; a < NUM_ACTIONS; a++) {
        worstRaw = Math.max(worstRaw, Math.abs(mine[a]! - raw.data[r * NUM_ACTIONS + a]!));
        expect(played[a], `row ${r}, action ${a}`).toBeCloseTo(probs.data[r * NUM_ACTIONS + a]!, 6);
        if (!l[a]) expect(played[a]).toBe(0);
      }
    }
    expect(worstRaw).toBeLessThan(1e-4);
  });

  it('refuses weights trained with a different encoder', () => {
    expect(() => Policy.load(weights, 'not-this-encoder')).toThrow(/trained with encoder/);
  });

  it('samples in proportion', () => {
    let x = 0;
    const random = () => (x = (x * 9301 + 49297) % 233280) / 233280;
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 20_000; i++) counts[sample([0, 0.25, 0, 0.75], random)]!++;
    expect(counts[0]).toBe(0);
    expect(counts[2]).toBe(0);
    expect(counts[1]! / 20_000).toBeCloseTo(0.25, 1);
  });
});
