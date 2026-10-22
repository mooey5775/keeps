import { describe, expect, it } from 'vitest';
import { buildPosition, keepValue } from '../../src/index.ts';
import { act, actionsLeft, draw, hotTarget, keepOf, payloads, respond, triggerOrder, types } from '../helpers.ts';

describe('Royal Favor', () => {
  it("makes the receiving keep's owner draw", () => {
    const start = buildPosition({ piles: { 0: ['royal-favor'], 2: ['chalice'] }, turn: 0 });
    const placed = hotTarget(draw(start, 0).state, 0, 2);
    expect(placed.state.keeps[2]).toEqual([{ id: 'royal-favor' }]);
    expect(placed.state.hands[2]).toEqual(['chalice']);
    expect(triggerOrder(placed.events)).toEqual(['royal-favor(S2)']);
    expect(actionsLeft(placed.state)).toBe(1);
  });

  it("ends the round when the receiver's pile is empty (Royal Favor 1)", () => {
    const start = buildPosition({ piles: { 0: ['royal-favor'] }, keeps: { 0: ['chalice'] }, turn: 0 });
    const { state, events } = hotTarget(draw(start, 0).state, 0, 3);
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'empty-pile', ender: 3 }]);
    expect(state.marks).toEqual([1, 0, 0, 0]);
  });

  it('Q-14 triggers when it enters a keep through a Providence swap', () => {
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 1: ['royal-favor'], 3: ['chalice'] },
      piles: { 3: ['dagger'], 1: ['scepter'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const { state, events } = respond(played.state, 0, {
      kind: 'choose-keep-pair', a: { seat: 1, index: 0 }, b: { seat: 3, index: 0 },
    });
    expect(triggerOrder(events)).toEqual(['royal-favor(S3)']);
    expect(state.hands[3]).toEqual(['dagger']);
    expect(state.hands[1]).toEqual([]);
  });

  it('does not trigger when swapped within the same keep', () => {
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 1: ['royal-favor', 'chalice'] },
      piles: { 1: ['scepter'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const { events } = respond(played.state, 0, {
      kind: 'choose-keep-pair', a: { seat: 1, index: 0 }, b: { seat: 1, index: 1 },
    });
    expect(types(events)).not.toContain('trigger');
  });

  it('is worth half a coin', () => {
    expect(keepValue(keepOf('royal-favor', 'chalice'))).toBe(5);
  });

  it('played into your own keep makes you draw', () => {
    const start = buildPosition({ piles: { 0: ['royal-favor', 'chalice'] }, turn: 0 });
    const { state } = hotTarget(draw(start, 0).state, 0, 0);
    expect(state.hands[0]).toEqual(['chalice']);
    expect(actionsLeft(state)).toBe(1);
  });

  it('a HOT card it draws is played at once', () => {
    const start = buildPosition({ piles: { 0: ['royal-favor'], 2: ['blunder'] }, turn: 0 });
    const { state } = hotTarget(draw(start, 0).state, 0, 2);
    expect(state.keeps[2].map((c) => c.id)).toEqual(['royal-favor', 'blunder']);
  });
});
