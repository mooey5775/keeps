import { describe, expect, it } from 'vitest';
import { buildPosition, keepValue } from '../../src/index.ts';
import { act, actionsLeft, draw, hotTarget, keepOf, payloads, pileIds, promptFor, respond, types } from '../helpers.ts';

describe('Fiat', () => {
  it('C-19 only real players claim piles, in play order from the Fiat player; the ghost gets the last one', () => {
    const start = buildPosition({
      seats: ['player', 'ghost', 'player', 'player'],
      piles: { 0: ['chalice'], 1: ['dagger'], 2: ['fiat', 'scepter'], 3: ['medallion'] },
      turn: 2,
    });
    const placed = hotTarget(draw(start, 2).state, 2, 2);
    expect(payloads(placed.events, 'piles-to-center')).toHaveLength(1);
    let state = placed.state;
    const order: number[] = [];
    for (const [seat, from] of [[2, 0], [3, 2], [0, 1]] as const) {
      const prompt = promptFor(state, seat, 'claim-pile');
      order.push(prompt.claimant);
      state = respond(state, seat, { kind: 'claim-pile', from }).state;
    }
    expect(order).toEqual([2, 3, 0]);
    // Piles named by where they were: S2 took @S0's, S3 took @S2's, S0 took @S1's; ghost S1 gets @S3's.
    expect([0, 1, 2, 3].map((s) => pileIds(state, s as 0)[0])).toEqual(['dagger', 'medallion', 'chalice', 'scepter']);
    expect(actionsLeft(state)).toBe(1);
  });

  it("C-20 two players: after both claim, Fiat's player places the two remaining piles", () => {
    const start = buildPosition({
      seats: ['player', 'ghost', 'player', 'ghost'],
      piles: { 0: ['fiat', 'chalice'], 1: ['dagger'], 2: ['scepter'], 3: ['medallion'] },
      turn: 0,
    });
    let state = hotTarget(draw(start, 0).state, 0, 0).state;
    state = respond(state, 0, { kind: 'claim-pile', from: 2 }).state;
    state = respond(state, 2, { kind: 'claim-pile', from: 0 }).state;
    const placing = promptFor(state, 0, 'claim-pile');
    expect(placing.claimant).toBe(1);
    expect(placing.options).toEqual([1, 3]);
    state = respond(state, 0, { kind: 'claim-pile', from: 3 }).state;
    expect([0, 1, 2, 3].map((s) => pileIds(state, s as 0)[0])).toEqual(['scepter', 'medallion', 'chalice', 'dagger']);
  });

  it('Q-01 its effect happens when played; afterward it sits in the keep doing nothing', () => {
    const start = buildPosition({
      piles: { 0: ['fiat', 'chalice'] },
      hands: { 0: ['providence'] },
      keeps: { 2: ['dagger'] },
      turn: 0,
    });
    let state = hotTarget(draw(start, 0).state, 0, 1).state;
    for (const seat of [0, 1, 2, 3] as const) {
      const from = promptFor(state, seat, 'claim-pile').options[0]!;
      state = respond(state, seat, { kind: 'claim-pile', from }).state;
    }
    expect(state.keeps[1]).toEqual([{ id: 'fiat' }]);
    // Moving Fiat with Providence doesn't redistribute the piles again.
    const played = act(state, 0, { action: 'play', card: 'providence' });
    const swapped = respond(played.state, 0, { kind: 'choose-keep-pair', a: { seat: 1, index: 0 }, b: { seat: 2, index: 0 } });
    expect(types(swapped.events)).not.toContain('piles-to-center');
    expect(swapped.state.keeps[2]).toEqual([{ id: 'fiat' }]);
  });

  it('four players all claim, starting with whoever played it, even into another keep', () => {
    const start = buildPosition({
      piles: { 0: ['chalice'], 1: ['fiat', 'dagger'], 2: ['scepter'], 3: ['medallion'] },
      turn: 1,
    });
    let state = hotTarget(draw(start, 1).state, 1, 3).state;
    expect(state.keeps[3]).toEqual([{ id: 'fiat' }]);
    const order: number[] = [];
    for (const seat of [1, 2, 3, 0] as const) {
      const prompt = promptFor(state, seat, 'claim-pile');
      order.push(prompt.seat);
      state = respond(state, seat, { kind: 'claim-pile', from: prompt.options[0]! }).state;
    }
    expect(order).toEqual([1, 2, 3, 0]);
    // Each player took the lowest-numbered pile left: S1 took @S0's, S2 took @S1's,
    // S3 took @S2's, and S0 got @S3's.
    expect([0, 1, 2, 3].map((s) => pileIds(state, s as 0)[0] ?? null)).toEqual(['medallion', 'chalice', 'dagger', 'scepter']);
  });

  it('options shrink as piles are claimed', () => {
    const start = buildPosition({ piles: { 0: ['fiat', 'chalice'] }, turn: 0 });
    let state = hotTarget(draw(start, 0).state, 0, 0).state;
    expect(promptFor(state, 0, 'claim-pile').options).toEqual([0, 1, 2, 3]);
    state = respond(state, 0, { kind: 'claim-pile', from: 2 }).state;
    expect(promptFor(state, 1, 'claim-pile').options).toEqual([0, 1, 3]);
  });

  it('is worth no coins and changes no keep but its own', () => {
    expect(keepValue(keepOf('fiat'))).toBe(0);
  });
});
