import { describe, expect, it } from 'vitest';
import { buildPosition, keepValue } from '../../src/index.ts';
import { act, draw, payloads, types } from '../helpers.ts';

describe('Purity', () => {
  it('is worth 10 in an empty-otherwise keep and is not a Coin card for Interest', () => {
    const start = buildPosition({ hands: { 0: ['purity'] }, keeps: { 0: ['interest'] }, piles: { 0: ['chalice'] }, turn: 0 });
    const { state, events } = act(start, 0, { action: 'play', card: 'purity', target: 0 });
    expect(types(events)).not.toContain('trigger');
    expect(keepValue(state.keeps[0])).toBe(20);
  });

  it('a pure 10 beats Fabergé Egg plus Chalice', () => {
    const start = buildPosition({ keeps: { 0: ['purity'], 1: ['faberge-egg', 'chalice'] }, turn: 0 });
    expect(payloads(draw(start, 0).events, 'score')[0]).toMatchObject({ winner: 0 });
  });
});
