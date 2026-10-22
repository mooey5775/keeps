import { describe, expect, it } from 'vitest';
import { apply, buildPosition, legalCommands } from '../../src/index.ts';
import { actionsLeft, draw, ok, payloads, promptFor, types } from '../helpers.ts';

describe('turns', () => {
  it('R-03 a turn is exactly two actions, then play passes to the left', () => {
    const start = buildPosition({ piles: { 0: ['chalice', 'dagger', 'medallion'] }, turn: 0 });
    expect(actionsLeft(start)).toBe(2);

    const first = draw(start, 0);
    expect(first.state.hands[0]).toEqual(['chalice']);
    expect(first.state.turn?.seat).toBe(0);
    expect(actionsLeft(first.state)).toBe(1);
    expect(types(first.events)).toEqual(['action', 'draw', 'prompt']);

    const second = draw(first.state, 0);
    expect(second.state.hands[0]).toEqual(['chalice', 'dagger']);
    expect(second.state.turn).toEqual({ seat: 1, actionsTaken: 0, usedOncePerTurn: [] });
    expect(payloads(second.events, 'turn-end')).toEqual([{ type: 'turn-end', seat: 0 }]);
    expect(payloads(second.events, 'turn-start')).toEqual([{ type: 'turn-start', seat: 1, actions: 2 }]);
    promptFor(second.state, 1, 'action');
  });

  it('R-03 actions draw from your own pile, top card first', () => {
    const start = buildPosition({ piles: { 0: ['chalice', 'dagger'], 1: ['scepter'] }, turn: 0 });
    const { state } = draw(start, 0);
    expect(state.hands[0]).toEqual(['chalice']);
    expect(state.piles[state.pileAt[0]].cards).toEqual([{ id: 'dagger', faceUp: false }]);
    expect(state.piles[state.pileAt[1]].cards).toHaveLength(1);
  });

  it('R-03 there is no pass: the only commands are actions, and only for the active player', () => {
    const empty = buildPosition({ piles: { 0: ['chalice'] }, turn: 0 });
    expect(legalCommands(empty, 0).map((c) => c.type === 'answer' && c.answer)).toEqual([
      { kind: 'action', choice: { action: 'draw' } },
    ]);
    for (const seat of [1, 2, 3] as const) expect(legalCommands(empty, seat)).toEqual([]);

    const holding = buildPosition({ hands: { 0: ['hocus-pocus', 'dagger'] }, piles: { 0: ['chalice'] }, turn: 0 });
    const choices = legalCommands(holding, 0).map((c) => c.type === 'answer' && c.answer.kind === 'action' && c.answer.choice);
    expect(choices).toEqual([
      { action: 'draw' },
      { action: 'play', card: 'hocus-pocus' },
      { action: 'play', card: 'dagger', target: 0 },
      { action: 'play', card: 'dagger', target: 1 },
      { action: 'play', card: 'dagger', target: 2 },
      { action: 'play', card: 'dagger', target: 3 },
    ]);
  });

  it('R-04 two players: play alternates between the two opposite seats', () => {
    let state = buildPosition({
      seats: ['player', 'ghost', 'player', 'ghost'],
      piles: { 0: ['chalice', 'dagger', 'medallion'], 2: ['scepter', 'timepiece'] },
      turn: 0,
    });
    const order: number[] = [];
    for (let i = 0; i < 3; i++) {
      const seat = state.turn!.seat;
      order.push(seat);
      state = draw(draw(state, seat).state, seat).state;
    }
    expect(order).toEqual([0, 2, 0]);
  });

  it('R-04 three players: play continues left and skips the ghost', () => {
    let state = buildPosition({
      seats: ['player', 'ghost', 'player', 'player'],
      piles: { 0: ['chalice', 'dagger', 'medallion', 'scepter'], 2: ['timepiece', 'faberge-egg'], 3: ['count-token', 'fool-token'] },
      turn: 0,
    });
    const order: number[] = [];
    for (let i = 0; i < 4; i++) {
      const seat = state.turn!.seat;
      order.push(seat);
      state = draw(draw(state, seat).state, seat).state;
    }
    expect(order).toEqual([0, 2, 3, 0]);
  });

  it("R-04 the last round's winner plays first in the next round", () => {
    // S0 draws from an empty pile to end the round; S2 has the most coins.
    const start = buildPosition({ keeps: { 2: ['chalice'] }, turn: 0 });
    const ended = draw(start, 0).state;
    expect(ended.phase).toBe('round-over');
    expect(ended.lastRoundWinner).toBe(2);

    const next = ok(apply(ended, 1, { type: 'next-round' }));
    expect(next.state.round).toBe(2);
    expect(next.state.turn?.seat).toBe(2);
    expect(next.state.marks).toEqual([0, 0, 1, 0]);
    expect(next.state.box).toEqual([]);
    expect(next.state.piles[next.state.pileAt[0]].cards).toHaveLength(9);
    expect(types(next.events)).toEqual([
      'round-start', 'pile-dealt', 'pile-dealt', 'pile-dealt', 'pile-dealt', 'turn-start', 'prompt',
    ]);
  });
});

describe('turn order', () => {
  it('play passes left around four players and keeps going around', () => {
    let state = buildPosition({
      piles: { 0: ['chalice', 'dagger', 'scepter', 'medallion'], 1: ['timepiece', 'faberge-egg', 'joker', 'pluck'], 2: ['prayer', 'requisition', 'epiphany', 'offering'], 3: ['providence', 'resurrection', 'purity', 'interest'] },
      turn: 2,
    });
    const order: number[] = [];
    for (let i = 0; i < 6; i++) {
      const seat = state.turn!.seat;
      order.push(seat);
      state = draw(draw(state, seat).state, seat).state;
    }
    expect(order).toEqual([2, 3, 0, 1, 2, 3]);
  });

  it("three players with the ghost at seat 0 skip seat 0", () => {
    let state = buildPosition({
      seats: ['ghost', 'player', 'player', 'player'],
      piles: { 1: ['chalice', 'dagger'], 2: ['timepiece', 'faberge-egg'], 3: ['joker', 'pluck', 'prayer', 'epiphany'] },
      turn: 3,
    });
    const order: number[] = [];
    for (let i = 0; i < 4; i++) {
      const seat = state.turn!.seat;
      order.push(seat);
      state = draw(draw(state, seat).state, seat).state;
    }
    expect(order).toEqual([3, 1, 2, 3]);
  });
});
