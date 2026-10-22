import { describe, expect, it } from 'vitest';
import { buildPosition } from '../../src/index.ts';
import { act, actionsLeft, draw, pileIds, respond } from '../helpers.ts';

describe('Revelation', () => {
  it('is HOT: drawn, it flips any pile upside down so the next card is visible', () => {
    const start = buildPosition({ piles: { 0: ['revelation'], 2: ['chalice', 'dagger', 'medallion'] }, turn: 0 });
    const drawn = draw(start, 0);
    const { state } = respond(drawn.state, 0, { kind: 'choose-pile', pile: 2 });
    expect(state.piles[state.pileAt[2]].cards).toEqual([
      { id: 'medallion', faceUp: true },
      { id: 'dagger', faceUp: true },
      { id: 'chalice', faceUp: true },
    ]);
    expect(actionsLeft(state)).toBe(1);
  });

  it('Q-10 flipping an already-flipped pile flips it back', () => {
    const start = buildPosition({
      hands: { 0: ['resurrection'] },
      piles: { 0: ['revelation'], 2: ['chalice', 'dagger'] },
      turn: 0,
    });
    let state = respond(draw(start, 0).state, 0, { kind: 'choose-pile', pile: 2 }).state;
    // Bring Revelation back with Resurrection and flip the same pile again.
    state = act(state, 0, { action: 'play', card: 'resurrection' }).state;
    state = respond(state, 0, { kind: 'choose-discard-card', card: 'revelation' }).state;
    state = respond(state, 0, { kind: 'choose-pile', pile: 2 }).state;
    expect(state.piles[state.pileAt[2]].cards).toEqual([
      { id: 'chalice', faceUp: false },
      { id: 'dagger', faceUp: false },
    ]);
  });

  it('turns a face-up Blunder in the pile face-down', () => {
    const start = buildPosition({
      piles: { 0: ['revelation'], 2: [{ id: 'blunder', faceUp: true }, 'chalice'] },
      turn: 0,
    });
    const { state } = respond(draw(start, 0).state, 0, { kind: 'choose-pile', pile: 2 });
    expect(state.piles[state.pileAt[2]].cards).toEqual([
      { id: 'chalice', faceUp: true },
      { id: 'blunder', faceUp: false },
    ]);
  });

  it('makes drawing the visible card public', () => {
    const start = buildPosition({ piles: { 0: ['revelation', 'chalice'] }, turn: 0 });
    const flipped = respond(draw(start, 0).state, 0, { kind: 'choose-pile', pile: 0 });
    const { events } = draw(flipped.state, 0);
    expect(events.find((e) => e.payload.type === 'draw')!.visibility).toBe('all');
  });

  it('flipping an empty pile changes nothing', () => {
    const start = buildPosition({ piles: { 0: ['revelation'] }, turn: 0 });
    const { state } = respond(draw(start, 0).state, 0, { kind: 'choose-pile', pile: 2 });
    expect(pileIds(state, 2)).toEqual([]);
  });
});
