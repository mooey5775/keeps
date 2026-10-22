import { describe, expect, it } from 'vitest';
import { buildPosition } from '../../src/index.ts';
import { act, actionsLeft, draw, payloads, promptFor } from '../helpers.ts';

describe('Hocus Pocus', () => {
  it('as the last action of a turn, gives two more before the turn ends', () => {
    const start = buildPosition({ hands: { 0: ['hocus-pocus'] }, piles: { 0: ['chalice', 'dagger', 'scepter'] }, turn: 0 });
    let state = draw(start, 0).state;
    state = act(state, 0, { action: 'play', card: 'hocus-pocus' }).state;
    expect(state.turn?.seat).toBe(0);
    state = draw(draw(state, 0).state, 0).state;
    expect(state.turn?.seat).toBe(1);
  });

  it('during Retribution actions, extends them', () => {
    const start = buildPosition({
      hands: { 1: ['hocus-pocus'] },
      piles: { 1: ['chalice', 'dagger', 'scepter'] },
      turn: 0,
      frames: [{ seat: 1, kind: 'retribution', remaining: 2 }],
    });
    let state = act(start, 1, { action: 'play', card: 'hocus-pocus' }).state;
    for (let i = 0; i < 3; i++) state = draw(state, 1).state;
    expect(state.hands[1]).toEqual(['chalice', 'dagger', 'scepter']);
    promptFor(state, 0, 'action');
  });

  it('Hocus Pocus costs one action and grants two (three actions this turn)', () => {
    const start = buildPosition({
      hands: { 0: ['hocus-pocus'] },
      piles: { 0: ['chalice', 'dagger', 'medallion', 'scepter'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'hocus-pocus' });
    expect(payloads(played.events, 'extra-actions')).toEqual([
      { type: 'extra-actions', seat: 0, count: 2, source: 'hocus-pocus' },
    ]);
    expect(actionsLeft(played.state)).toBe(2);

    let state = played.state;
    for (let i = 0; i < 3; i++) {
      expect(state.turn?.seat).toBe(0);
      state = draw(state, 0).state;
    }
    expect(state.hands[0]).toEqual(['chalice', 'dagger', 'medallion']);
    expect(state.turn?.seat).toBe(1);
  });

  it('Hocus Pocus during Retribution: two actions become three', () => {
    const start = buildPosition({
      hands: { 0: ['chalice'], 1: ['hocus-pocus'] },
      keeps: { 1: ['retribution'] },
      piles: { 1: ['dagger', 'scepter', 'medallion'] },
      turn: 0,
    });
    let state = act(start, 0, { action: 'play', card: 'chalice', target: 1 }).state;
    state = act(state, 1, { action: 'play', card: 'hocus-pocus' }).state;
    for (let i = 0; i < 3; i++) {
      promptFor(state, 1, 'action');
      state = draw(state, 1).state;
    }
    promptFor(state, 0, 'action');
  });
});
