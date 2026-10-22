import { describe, expect, it } from 'vitest';
import { buildPosition, keepValue } from '../../src/index.ts';
import { abilityNames, act, actionsLeft, draw, keepOf, payloads } from '../helpers.ts';

describe('Shackles', () => {
  it('can be discarded from your own keep with one action', () => {
    const start = buildPosition({ keeps: { 0: ['shackles'] }, turn: 0, actions: 2 });
    const { state, events } = act(start, 0, { action: 'ability', card: 'shackles' });
    expect(state.keeps[0]).toEqual([]);
    expect(state.discard).toEqual(['shackles']);
    expect(payloads(events, 'discard')).toEqual([{ type: 'discard', seat: 0, cards: ['shackles'], from: 'keep' }]);
  });

  it('a Shackled player can spend their single action discarding it', () => {
    const start = buildPosition({ keeps: { 0: ['shackles'] }, turn: 0 });
    expect(actionsLeft(start)).toBe(1);
    const { state } = act(start, 0, { action: 'ability', card: 'shackles' });
    expect(state.turn?.seat).toBe(1);
  });

  it("can't be discarded from someone else's keep", () => {
    const start = buildPosition({ keeps: { 1: ['shackles'] }, turn: 0 });
    expect(abilityNames(start, 0)).toEqual([]);
  });

  it('is worth -3 coins', () => {
    expect(keepValue(keepOf('shackles'))).toBe(-6);
  });

  it('played into another player\'s keep, limits their next turn', () => {
    const start = buildPosition({ hands: { 0: ['shackles'] }, piles: { 0: ['chalice'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'shackles', target: 1 });
    const { events } = draw(played.state, 0);
    expect(payloads(events, 'turn-start')).toEqual([{ type: 'turn-start', seat: 1, actions: 1 }]);
  });

  it('can make your own keep total zero for Purity (Purity 2)', () => {
    expect(keepValue(keepOf('purity', 'shackles', 'chalice', 'royal-favor'))).toBe(-1);
    expect(keepValue(keepOf('purity', 'shackles', 'faberge-egg'))).toBe(20);
  });

  it('a Shackled player starts their turn with one action', () => {
    const start = buildPosition({
      keeps: { 1: ['shackles'] },
      piles: { 0: ['chalice', 'dagger'], 1: ['scepter', 'timepiece'] },
      turn: 0,
    });
    const s1Turn = draw(draw(start, 0).state, 0);
    expect(payloads(s1Turn.events, 'turn-start')).toEqual([{ type: 'turn-start', seat: 1, actions: 1 }]);
    const after = act(s1Turn.state, 1, { action: 'draw' });
    expect(after.state.turn?.seat).toBe(2);
  });
});

describe('Shackles and turns', () => {
  it('a Shackled player can turn their one action into two with Hocus Pocus', () => {
    const start = buildPosition({ keeps: { 0: ['shackles'] }, hands: { 0: ['hocus-pocus'] }, piles: { 0: ['chalice', 'dagger'] }, turn: 0 });
    expect(actionsLeft(start)).toBe(1);
    let state = act(start, 0, { action: 'play', card: 'hocus-pocus' }).state;
    expect(actionsLeft(state)).toBe(2);
    state = draw(draw(state, 0).state, 0).state;
    expect(state.turn?.seat).toBe(1);
  });

  it('playing Shackles into your own keep mid-turn does not cut the current turn', () => {
    const start = buildPosition({ hands: { 0: ['shackles'] }, piles: { 0: ['chalice'] }, turn: 0 });
    const { state } = act(start, 0, { action: 'play', card: 'shackles', target: 0 });
    expect(actionsLeft(state)).toBe(1);
  });

  it('discarding Shackles restores two actions from the next turn', () => {
    const start = buildPosition({
      seats: ['player', 'ghost', 'player', 'ghost'],
      keeps: { 0: ['shackles'] },
      piles: { 0: ['chalice'], 2: ['scepter', 'medallion'] },
      turn: 0,
    });
    expect(actionsLeft(start)).toBe(1);
    const freed = act(start, 0, { action: 'ability', card: 'shackles' });
    expect(freed.state.turn?.seat).toBe(2);
    const back = draw(draw(freed.state, 2).state, 2);
    expect(payloads(back.events, 'turn-start')).toEqual([{ type: 'turn-start', seat: 0, actions: 2 }]);
  });

  it("a face-down Shackles doesn't limit its owner's turn", () => {
    const start = buildPosition({ keeps: { 1: [{ id: 'shackles', faceDown: { placedBy: 0 } }], 0: ['duplicity'] }, piles: { 0: ['chalice', 'dagger'] }, turn: 0 });
    const s1 = draw(draw(start, 0).state, 0);
    expect(payloads(s1.events, 'turn-start')).toEqual([{ type: 'turn-start', seat: 1, actions: 2 }]);
  });
});
