import { describe, expect, it } from 'vitest';
import { OBSERVATION_SIZE } from '../src/observation.ts';
import { RoundEnv } from '../src/env.ts';

// The observation is a fixed-length, finite vector in a small range, the same
// for the same history, and different for the two players.

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('observations', () => {
  it('are fixed-length, finite and small, every step of 100 random rounds, for both players', () => {
    let checks = 0;
    for (let g = 0; g < 100; g++) {
      const random = rng(g + 3);
      const env = RoundEnv.start(`obs-${g}`);
      while (!env.terminal) {
        for (let player = 0; player < 2; player++) {
          const obs = env.observation(player);
          expect(obs).toHaveLength(OBSERVATION_SIZE);
          for (let i = 0; i < obs.length; i++) {
            const v = obs[i]!;
            if (!Number.isFinite(v) || v < -2 || v > 2) expect.fail(`round ${g}: feature ${i} = ${v}`);
          }
          checks++;
        }
        const actions = env.legalActions();
        env.step(actions[Math.floor(random() * actions.length)]!);
      }
    }
    expect(checks).toBeGreaterThan(5000);
    console.log(`observation size: ${OBSERVATION_SIZE}`);
  });

  it('depend only on the history: a copy of the round observes the same, and the two players differ', () => {
    const env = RoundEnv.start('obs-same');
    const random = rng(1);
    for (let i = 0; i < 40 && !env.terminal; i++) {
      const actions = env.legalActions();
      env.step(actions[Math.floor(random() * actions.length)]!);
    }
    const copy = env.clone();
    expect(copy.observation(0)).toEqual(env.observation(0));
    expect(copy.observation(1)).toEqual(env.observation(1));
    expect(env.observation(0)).not.toEqual(env.observation(1));
  });
});
