import { describe, expect, it } from 'vitest';
import { buildPosition, legalCommands, newGame, viewFor } from '../../src/index.ts';
import { act, draw, payloads, promptFor, respond, types } from '../helpers.ts';

// Gaps found by mutation testing: rule details whose code could be broken
// without any other test noticing.

describe('Providence: both sides of the swap', () => {
  it("Retribution triggers when its owner's card is the second card of the pair", () => {
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 1: ['dagger'], 2: ['retribution', 'chalice'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const { events } = respond(played.state, 0, { kind: 'choose-keep-pair', a: { seat: 1, index: 0 }, b: { seat: 2, index: 1 } });
    expect(payloads(events, 'trigger').map((t) => `${t.kind}:${t.seat}`)).toEqual(['retribution:2']);
  });

  it('C-21 Interest as the second card, swapped for a Coin card, does not trigger', () => {
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 1: ['chalice'], 2: ['interest'] },
      piles: { 1: ['dagger'], 2: ['scepter'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const { state, events } = respond(played.state, 0, { kind: 'choose-keep-pair', a: { seat: 1, index: 0 }, b: { seat: 2, index: 0 } });
    expect(state.keeps[2]).toEqual([{ id: 'chalice' }]);
    expect(types(events)).not.toContain('trigger');
  });
});

describe('game options', () => {
  it('a game to a single mark is allowed, and ends after one round', () => {
    const { state } = newGame({ players: 2, seed: 'one-mark', marksToWin: 1, firstSeat: 0 });
    expect(state.config.marksToWin).toBe(1);
    expect(() => newGame({ players: 2, seed: 1, marksToWin: 0 })).toThrow(RangeError);
    expect(() => newGame({ players: 2, seed: 1, marksToWin: 1.5 })).toThrow(RangeError);
  });
});

describe('the active frame in views', () => {
  it('no frame is active while a HOT card from the last action awaits its keep', () => {
    const start = buildPosition({ piles: { 0: ['chalice', 'juggling'] }, turn: 0 });
    const last = draw(draw(start, 0).state, 0);
    promptFor(last.state, 0, 'hot-target');
    expect(viewFor(last.state, 1).frame).toBeNull();
  });

  it('with Hocus Pocus actions spent, the turn frame underneath is the active one', () => {
    const start = buildPosition({ hands: { 0: ['hocus-pocus'] }, piles: { 0: ['chalice', 'dagger', 'juggling'] }, turn: 0 });
    let state = act(start, 0, { action: 'play', card: 'hocus-pocus' }).state;
    state = draw(state, 0).state;
    state = draw(state, 0).state; // last Hocus Pocus action
    expect(viewFor(state, 1).frame).toEqual({ seat: 0, kind: 'turn', remaining: 1 });
    // And the last turn action draws Juggling: HOT, so it waits for a keep with no frame active.
    const final = draw(state, 0);
    promptFor(final.state, 0, 'hot-target');
    expect(viewFor(final.state, 1).frame).toBeNull();
  });
});

describe('consecutive actions belong to one player', () => {
  it("a Retribution owner with one action left can't remove Blunder by borrowing the turn player's action", () => {
    const start = buildPosition({
      keeps: { 1: ['blunder', 'retribution'] },
      piles: { 1: ['chalice'] },
      turn: 0,
      frames: [{ seat: 1, kind: 'retribution', remaining: 1 }],
    });
    // S0's turn frame (2 actions) sits right under S1's last Retribution action.
    expect(start.stack.map((op) => (op.op === 'action-frame' ? `${op.seat}:${op.remaining}` : op.op))).toEqual(['0:2', '1:1']);
    expect(legalCommands(start, 1).some((c) => c.type === 'answer' && c.answer.kind === 'action' && c.answer.choice.action === 'ability')).toBe(false);
  });
});

describe('Tithes reorder options', () => {
  it('a two-card pile is offered in both orders', () => {
    const start = buildPosition({ keeps: { 0: ['tithes'] }, piles: { 0: ['chalice', 'dagger'] }, turn: 0 });
    const used = act(start, 0, { action: 'ability', card: 'tithes' });
    const orders = legalCommands(used.state, 0).flatMap((c) => (c.type === 'answer' && c.answer.kind === 'order-pile' ? [c.answer.order.join(',')] : []));
    expect(orders).toEqual(['chalice,dagger', 'dagger,chalice']);
  });
});
