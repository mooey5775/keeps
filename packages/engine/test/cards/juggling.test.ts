import { describe, expect, it } from 'vitest';
import { buildPosition } from '../../src/index.ts';
import { abilityNames, act, actionsLeft, draw, hotTarget, payloads, pileIds } from '../helpers.ts';

describe('Juggling', () => {
  it('swaps any two piles, using one action', () => {
    const start = buildPosition({ keeps: { 0: ['juggling'] }, piles: { 1: ['chalice'], 3: ['dagger'] }, turn: 0 });
    const { state, events } = act(start, 0, { action: 'ability', card: 'juggling', piles: [1, 3] });
    expect(pileIds(state, 1)).toEqual(['dagger']);
    expect(pileIds(state, 3)).toEqual(['chalice']);
    expect(actionsLeft(state)).toBe(1);
    expect(payloads(events, 'pile-swap')).toEqual([{ type: 'pile-swap', seat: 0, a: 1, b: 3 }]);
  });

  it('can be used once per turn, and again on your next turn', () => {
    const start = buildPosition({
      keeps: { 0: ['juggling'] },
      piles: { 0: ['chalice', 'dagger'], 1: ['medallion', 'scepter'], 2: ['timepiece', 'faberge-egg'], 3: ['count-token', 'fool-token'] },
      turn: 0,
    });
    expect(abilityNames(start, 0)).toEqual(['juggling']);
    let state = act(start, 0, { action: 'ability', card: 'juggling', piles: [0, 1] }).state;
    expect(abilityNames(state, 0)).toEqual([]);
    state = draw(state, 0).state;
    for (const seat of [1, 2, 3] as const) state = draw(draw(state, seat).state, seat).state;
    expect(state.turn?.seat).toBe(0);
    expect(abilityNames(state, 0)).toEqual(['juggling']);
  });

  it("can't be used from another player's keep", () => {
    const start = buildPosition({ keeps: { 1: ['juggling'] }, turn: 0 });
    expect(abilityNames(start, 0)).toEqual([]);
  });

  it('is usable the same turn it is drawn and played into your keep', () => {
    const start = buildPosition({ piles: { 0: ['juggling', 'chalice'] }, turn: 0 });
    const placed = hotTarget(draw(start, 0).state, 0, 0);
    expect(abilityNames(placed.state, 0)).toEqual(['juggling']);
  });

  it('can swap your own pile with a ghost\'s', () => {
    const start = buildPosition({
      seats: ['player', 'ghost', 'player', 'ghost'],
      keeps: { 0: ['juggling'] },
      piles: { 0: ['chalice'], 1: ['dagger'] },
      turn: 0,
    });
    const { state } = act(start, 0, { action: 'ability', card: 'juggling', piles: [0, 1] });
    expect(pileIds(state, 0)).toEqual(['dagger']);
  });

  it('can move an empty pile to set up a round end (This Looks Familiar)', () => {
    const start = buildPosition({ keeps: { 0: ['juggling'] }, piles: { 1: ['chalice'] }, turn: 0 });
    const { state } = act(start, 0, { action: 'ability', card: 'juggling', piles: [1, 2] });
    expect(pileIds(state, 1)).toEqual([]);
    expect(pileIds(state, 2)).toEqual(['chalice']);
  });
});
