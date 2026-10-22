import { describe, expect, it } from 'vitest';
import { buildPosition, eventsFor } from '../../src/index.ts';
import { act, actionsLeft, draw, hotTarget, payloads, promptFor, respond } from '../helpers.ts';

describe('Invocation', () => {
  it('K-01 drawing Invocation, and the card it then draws and plays, cost no actions', () => {
    const start = buildPosition({ piles: { 0: ['invocation'], 2: ['chalice'] }, turn: 0 });
    const drawn = draw(start, 0);
    expect(promptFor(drawn.state, 0, 'choose-pile').options).toEqual([0, 1, 2, 3]);
    const invoked = respond(drawn.state, 0, { kind: 'choose-pile', pile: 2 });
    const placed = hotTarget(invoked.state, 0, 0);
    expect(placed.state.keeps[0]).toEqual([{ id: 'chalice' }]);
    expect(actionsLeft(placed.state)).toBe(1);
  });

  it('K-01 the whole Resurrection 3 chain is free: Joker-as-Resurrection takes Invocation, which invokes Hocus Pocus', () => {
    const start = buildPosition({
      hands: { 0: ['joker', 'resurrection'] },
      discard: ['invocation'],
      piles: { 2: ['hocus-pocus'] },
      turn: 0,
    });
    const joker = act(start, 0, { action: 'play', card: 'joker', copy: 'resurrection' });
    expect(joker.state.hands[0]).toEqual(['resurrection']);
    const taken = respond(joker.state, 0, { kind: 'choose-discard-card', card: 'invocation' });
    const invoked = respond(taken.state, 0, { kind: 'choose-pile', pile: 2 });
    // Joker cost one action; Invocation and Hocus Pocus cost none; Hocus Pocus gave two.
    const frames = invoked.state.stack.flatMap((op) => (op.op === 'action-frame' ? [op.remaining] : []));
    expect(frames).toEqual([1, 2]);
    expect(invoked.state.discard).toEqual(['joker', 'invocation', 'hocus-pocus']);
  });

  it('invoking from an empty pile ends the round (Resurrection 3)', () => {
    const start = buildPosition({ piles: { 0: ['invocation'] }, turn: 0 });
    const { events } = respond(draw(start, 0).state, 0, { kind: 'choose-pile', pile: 3 });
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'empty-pile', ender: 0 }]);
  });

  it('invoking a HOT card plays it as normal', () => {
    const start = buildPosition({ piles: { 0: ['invocation'], 1: ['revelation', 'chalice'] }, turn: 0 });
    const invoked = respond(draw(start, 0).state, 0, { kind: 'choose-pile', pile: 1 });
    promptFor(invoked.state, 0, 'choose-pile');
    expect(invoked.state.discard).toEqual(['invocation', 'revelation']);
  });

  it('the invoked card is drawn privately, then revealed by being played', () => {
    const start = buildPosition({ piles: { 0: ['invocation'], 2: ['chalice'] }, turn: 0 });
    const invoked = respond(draw(start, 0).state, 0, { kind: 'choose-pile', pile: 2 });
    const placed = hotTarget(invoked.state, 0, 1);
    expect(payloads(eventsFor([...invoked.events, ...placed.events], 3), 'play').map((p) => p.card)).toEqual(['chalice']);
  });
});
