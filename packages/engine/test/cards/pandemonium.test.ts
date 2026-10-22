import { describe, expect, it } from 'vitest';
import {
  buildPosition,
  leftOf,
  legalCommands,
  rightOf,
  rotatedFrom,
  rotatedTo,
  SEATS,
  type GameState,
  type Seat,
} from '../../src/index.ts';
import { act, actionsLeft, draw, payloads, pileIds, respond } from '../helpers.ts';

describe('Pandemonium', () => {
  it('is HOT: drawn, it rotates the piles at no action cost', () => {
    const start = buildPosition({
      piles: { 0: ['pandemonium'], 1: ['chalice'], 2: ['dagger'], 3: ['medallion'] },
      turn: 0,
    });
    const drawn = draw(start, 0);
    expect(legalCommands(drawn.state, 0)).toHaveLength(2);
    const right = respond(drawn.state, 0, { kind: 'choose-direction', direction: 'right' });
    expect(actionsLeft(right.state)).toBe(1);
    // Rotating right: the pile at S1 moves to S0, S2 to S1, and so on.
    expect([0, 1, 2, 3].map((s) => pileIds(right.state, s as 0)[0] ?? null)).toEqual(['chalice', 'dagger', 'medallion', null]);
    const left = respond(drawn.state, 0, { kind: 'choose-direction', direction: 'left' });
    expect([0, 1, 2, 3].map((s) => pileIds(left.state, s as 0)[0] ?? null)).toEqual(['medallion', null, 'chalice', 'dagger']);
    expect(payloads(left.events, 'pile-rotate')).toEqual([{ type: 'pile-rotate', seat: 0, direction: 'left' }]);
  });

  it('rotates ghost piles along with everyone else\'s', () => {
    const start = buildPosition({
      seats: ['player', 'ghost', 'player', 'ghost'],
      piles: { 0: ['pandemonium'], 1: ['chalice'], 2: ['dagger'], 3: ['scepter'] },
      turn: 0,
    });
    const { state } = respond(draw(start, 0).state, 0, { kind: 'choose-direction', direction: 'left' });
    expect([0, 1, 2, 3].map((s) => pileIds(state, s as 0)[0] ?? null)).toEqual(['scepter', null, 'chalice', 'dagger']);
  });

  it('resurrected or invoked, it still costs no action', () => {
    const start = buildPosition({ hands: { 0: ['resurrection'] }, discard: ['pandemonium'], turn: 0 });
    const taken = respond(act(start, 0, { action: 'play', card: 'resurrection' }).state, 0, { kind: 'choose-discard-card', card: 'pandemonium' });
    const { state } = respond(taken.state, 0, { kind: 'choose-direction', direction: 'right' });
    expect(actionsLeft(state)).toBe(1);
  });

  it('moves each pile to rotatedTo(seat), so each seat gets the pile from rotatedFrom(seat)', () => {
    const start = buildPosition({
      piles: { 0: ['pandemonium', 'timepiece'], 1: ['chalice'], 2: ['dagger'], 3: ['medallion'] },
      turn: 0,
    });
    const drawn = draw(start, 0).state;
    const top = (state: GameState, seat: Seat) => pileIds(state, seat)[0];
    for (const direction of ['left', 'right'] as const) {
      const { state } = respond(drawn, 0, { kind: 'choose-direction', direction });
      for (const seat of SEATS) {
        expect(top(state, rotatedTo(seat, direction)), `${direction} S${seat}`).toBe(top(drawn, seat));
        expect(top(state, seat), `${direction} S${seat}`).toBe(top(drawn, rotatedFrom(seat, direction)));
        expect(rotatedFrom(rotatedTo(seat, direction), direction)).toBe(seat);
      }
    }
    expect(SEATS.map((s) => rotatedTo(s, 'left'))).toEqual(SEATS.map(leftOf));
    expect(SEATS.map((s) => rotatedTo(s, 'right'))).toEqual(SEATS.map(rightOf));
  });
});
