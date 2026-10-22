import { CARD_IDS, type CardId, type Seat } from '@keeps/engine';
import { describe, expect, it } from 'vitest';
import { FACE_DOWN, NUM_ACTIONS, POS } from '../src/actions.ts';
import { PLACES, type Belief } from '../src/belief.ts';
import { RoundEnv, SEAT_OF_PLAYER } from '../src/env.ts';
import { LAYOUT2, OBSERVATION2_SIZE } from '../src/observation2.ts';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const column = (obs: Float32Array, block: string, row: number, name: string, index = 0) => {
  const b = LAYOUT2.blocks[block]!;
  return obs[b.offset + row * b.width + b.columns[name]![0] + index]!;
};

describe('observation v2', () => {
  it('has contiguous blocks whose columns fill their rows', () => {
    let offset = 0;
    for (const b of Object.values(LAYOUT2.blocks)) {
      expect(b.offset).toBe(offset);
      const widths = Object.values(b.columns).sort((x, y) => x[0] - y[0]);
      let at = 0;
      for (const [start, width] of widths) {
        expect(start).toBe(at);
        at += width;
      }
      expect(at).toBe(b.width);
      offset += b.rows * b.width;
    }
    expect(offset).toBe(OBSERVATION2_SIZE);
  });

  it('is bounded, flags exactly the legal and chosen ids, and survives cloning, in 150 random rounds', () => {
    let checked = 0;
    for (let g = 0; g < 150; g++) {
      const random = rng(g + 1);
      const env = RoundEnv.start(`obs2-${g}`, { checked: false, observation: 2 });
      while (!env.terminal) {
        const p = env.currentPlayer;
        const obs = env.observation(p);
        expect(obs).toHaveLength(OBSERVATION2_SIZE);
        for (const v of obs) expect(Number.isFinite(v) && v >= -1.5 && v <= 1.5).toBe(true);
        const legal = new Set(env.legalActions());
        const chosen = new Set(env.prefix);
        CARD_IDS.forEach((_, c) => {
          expect(column(obs, 'cards', c, 'legal')).toBe(legal.has(c) ? 1 : 0);
          expect(column(obs, 'cards', c, 'chosen')).toBe(chosen.has(c) ? 1 : 0);
        });
        for (let r = 0; r < 4; r++) {
          expect(column(obs, 'piles', r, 'legal')).toBe(legal.has(POS(r)) ? 1 : 0);
          expect(column(obs, 'piles', r, 'chosen')).toBe(chosen.has(POS(r)) ? 1 : 0);
        }
        for (let id = FACE_DOWN; id < NUM_ACTIONS; id++) {
          expect(column(obs, 'decision', 0, 'special_legal', id - FACE_DOWN)).toBe(legal.has(id) ? 1 : 0);
        }
        if (g % 10 === 0) expect(env.clone().observation(p)).toEqual(obs);
        checked++;
        const ids = [...legal];
        env.step(ids[Math.floor(random() * ids.length)]!);
      }
    }
    expect(checked).toBeGreaterThan(5000);
  });

  it("uses a sound belief: real distributions, and every recorded pile of origin is true (300 rounds, both players)", () => {
    for (let g = 0; g < 300; g++) {
      const random = rng(1000 + g);
      const env = RoundEnv.start(`sound-${g}`, { checked: false, observation: 2 });
      const dealt = new Map<CardId, number>();
      for (const e of env.events) if (e.payload.type === 'pile-dealt') for (const c of e.payload.cards) dealt.set(c, e.payload.position);
      while (!env.terminal) {
        const p = env.currentPlayer;
        env.observation(p);
        const belief = (env as unknown as { beliefs: Belief[] }).beliefs[p]!;
        expect(belief.sound).toBe(true);
        const table = belief.locationTable(env.view(p));
        for (let c = 0; c < CARD_IDS.length; c++) {
          let sum = 0;
          for (let i = 0; i < PLACES.length; i++) {
            const v = table[c * PLACES.length + i]!;
            expect(v).toBeGreaterThanOrEqual(-1e-6);
            expect(v).toBeLessThanOrEqual(1 + 1e-6);
            sum += v;
          }
          expect(sum).toBeCloseTo(1, 4);
        }
        for (const [card, pile] of belief.origin) expect(pile, `round ${g}: ${card} (seat ${SEAT_OF_PLAYER[p] as Seat})`).toBe(dealt.get(card));
        const ids = env.legalActions();
        env.step(ids[Math.floor(random() * ids.length)]!);
      }
    }
  });
});
