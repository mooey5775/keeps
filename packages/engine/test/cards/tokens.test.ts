import { describe, expect, it } from 'vitest';
import { apply, buildPosition, keepValue } from '../../src/index.ts';
import { act, hotTarget, keepOf, ok, payloads, respond, types } from '../helpers.ts';

// The Count, Fool, and Friar Tokens, and the token victory they win together.

describe('Count Token', () => {
  it('is worth -1 coin', () => {
    expect(keepValue(keepOf('count-token'))).toBe(-2);
  });

  it('two Tokens are not enough to win', () => {
    const start = buildPosition({ keeps: { 0: ['count-token'] }, hands: { 0: ['fool-token'] }, piles: { 0: ['chalice'] }, turn: 0 });
    const { state } = act(start, 0, { action: 'play', card: 'fool-token', target: 0 });
    expect(state.phase).toBe('playing');
  });

  it('Tokens spread across different keeps never win', () => {
    const start = buildPosition({
      keeps: { 0: ['count-token'], 1: ['fool-token'] },
      hands: { 0: ['friar-token'] },
      piles: { 0: ['chalice'] },
      turn: 0,
    });
    const { state } = act(start, 0, { action: 'play', card: 'friar-token', target: 2 });
    expect(state.phase).toBe('playing');
  });

  it('wins even when the keep has very negative coins', () => {
    const start = buildPosition({
      keeps: { 0: ['blunder', 'shackles', 'fool-token', 'friar-token'], 1: ['faberge-egg'] },
      hands: { 0: ['count-token'] },
      turn: 0,
    });
    expect(act(start, 0, { action: 'play', card: 'count-token', target: 0 }).state.marks).toEqual([1, 0, 0, 0]);
  });
});

describe('Fool Token', () => {
  it('is worth -1 coin, and completes the set wherever it lands', () => {
    expect(keepValue(keepOf('fool-token'))).toBe(-2);
    const start = buildPosition({ keeps: { 2: ['count-token', 'friar-token'] }, hands: { 0: ['fool-token'] }, turn: 0 });
    expect(act(start, 0, { action: 'play', card: 'fool-token', target: 2 }).state.marks).toEqual([0, 0, 1, 0]);
  });
});

describe('Friar Token', () => {
  it('is worth -1 coin, and can make an otherwise-pure keep impure (Purity 1)', () => {
    expect(keepValue(keepOf('purity', 'friar-token'))).toBe(-2);
  });
});

describe('token victory', () => {
  it('collecting all three Tokens in a keep wins the round instantly, with actions left', () => {
    const start = buildPosition({
      keeps: { 0: ['count-token', 'fool-token'], 1: ['faberge-egg'] },
      hands: { 0: ['friar-token'] },
      turn: 0,
    });
    const { state, events } = act(start, 0, { action: 'play', card: 'friar-token', target: 0 });
    expect(types(events)).toEqual(['action', 'play', 'round-end', 'mark']);
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'tokens', winner: 0 }]);
    expect(state.roundEnd).toEqual({ kind: 'tokens', winner: 0 });
    expect(state.marks).toEqual([1, 0, 0, 0]);
    expect(state.phase).toBe('round-over');
  });

  it("completing the set in another player's keep gives them the win", () => {
    const start = buildPosition({
      keeps: { 1: ['count-token', 'fool-token'] },
      hands: { 0: ['friar-token'] },
      turn: 0,
    });
    const { state } = act(start, 0, { action: 'play', card: 'friar-token', target: 1 });
    expect(state.marks).toEqual([0, 1, 0, 0]);
  });

  it('next round after a token victory starts with the token winner', () => {
    const start = buildPosition({ keeps: { 3: ['count-token', 'fool-token'] }, hands: { 0: ['friar-token'] }, turn: 0 });
    const won = act(start, 0, { action: 'play', card: 'friar-token', target: 3 }).state;
    expect(ok(apply(won, 0, { type: 'next-round' })).state.turn?.seat).toBe(3);
  });

  it('C-09 is instant and total: no Last Laugh, no Retribution, and the next round begins', () => {
    const start = buildPosition({
      keeps: { 1: ['count-token', 'fool-token', 'retribution', 'last-laugh'] },
      hands: { 0: ['friar-token'] },
      turn: 0,
    });
    const { state, events } = act(start, 0, { action: 'play', card: 'friar-token', target: 1 });
    expect(types(events)).toEqual(['action', 'play', 'round-end', 'mark']);
    expect(state.marks).toEqual([0, 1, 0, 0]);
    expect(state.phase).toBe('round-over');
  });

  it('C-22 Last Laugh does not trigger when the round ends by token victory', () => {
    const start = buildPosition({
      keeps: { 0: ['count-token', 'fool-token'], 2: ['last-laugh'] },
      hands: { 0: ['friar-token'], 2: ['faberge-egg'] },
      turn: 0,
    });
    const { state, events } = act(start, 0, { action: 'play', card: 'friar-token', target: 0 });
    expect(types(events)).not.toContain('last-laugh');
    expect(state.prompts).toEqual([]);
  });
});

describe('token victories in unusual places', () => {
  it('Legerdemain stealing the last Token and playing it as HOT wins at once', () => {
    const start = buildPosition({
      hands: { 0: ['legerdemain'], 2: ['count-token'] },
      keeps: { 0: ['fool-token', 'friar-token'] },
      turn: 0,
    });
    const stolen = respond(act(start, 0, { action: 'play', card: 'legerdemain' }).state, 0, { kind: 'choose-player', seat: 2 });
    const { state, events } = hotTarget(stolen.state, 0, 0);
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'tokens', winner: 0 }]);
    expect(state.marks).toEqual([1, 0, 0, 0]);
  });

  it('a token victory cancels pending triggers and Retribution', () => {
    // The third Token goes into S1's keep, which has Interest and Retribution.
    const start = buildPosition({
      hands: { 0: ['friar-token'] },
      keeps: { 1: ['count-token', 'fool-token', 'interest', 'retribution'] },
      piles: { 1: ['chalice'] },
      turn: 0,
    });
    const { state, events } = act(start, 0, { action: 'play', card: 'friar-token', target: 1 });
    expect(types(events)).not.toContain('trigger');
    expect(state.hands[1]).toEqual([]);
    expect(state.marks).toEqual([0, 1, 0, 0]);
  });

  it('a Token swapped away by Providence breaks a would-be set; swapping it back completes it', () => {
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 0: ['count-token', 'fool-token', 'chalice'], 3: ['friar-token'] },
      piles: { 0: ['dagger'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const { state } = respond(played.state, 0, { kind: 'choose-keep-pair', a: { seat: 0, index: 2 }, b: { seat: 3, index: 0 } });
    expect(state.roundEnd).toEqual({ kind: 'tokens', winner: 0 });
  });
});
