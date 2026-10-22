import { describe, expect, it } from 'vitest';
import { buildPosition, viewFor, type GameState, type Viewer } from '../../src/index.ts';
import { act, actionsLeft, draw, frames, payloads, pileIds, promptFor, respond } from '../helpers.ts';

const VIEWERS: Viewer[] = [0, 1, 2, 3, 'spectator'];

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

  it('can flip any pile, including an empty one or a ghost’s', () => {
    const start = buildPosition({
      seats: ['player', 'ghost', 'player', 'player'],
      piles: { 0: ['revelation'], 1: ['chalice', 'dagger'] },
      turn: 0,
    });
    const drawn = draw(start, 0);
    expect(promptFor(drawn.state, 0, 'choose-pile').options).toEqual([0, 1, 2, 3]);
    const { state } = respond(drawn.state, 0, { kind: 'choose-pile', pile: 1 });
    expect(state.piles[state.pileAt[1]].cards).toEqual([
      { id: 'dagger', faceUp: true },
      { id: 'chalice', faceUp: true },
    ]);
  });

  it('shows the flipped pile’s top card to everyone, and the next one once that is drawn', () => {
    const start = buildPosition({ piles: { 0: ['revelation', 'chalice', 'dagger'] }, turn: 0 });
    const flipped = respond(draw(start, 0).state, 0, { kind: 'choose-pile', pile: 0 });
    const tops = (state: GameState) => VIEWERS.map((v) => viewFor(state, v).piles[0]!.top);
    expect(tops(start)).toEqual([null, null, null, null, null]);
    expect(tops(flipped.state)).toEqual(['dagger', 'dagger', 'dagger', 'dagger', 'dagger']);
    const { state } = draw(flipped.state, 0);
    expect(state.hands[0]).toEqual(['dagger']);
    expect(tops(state)).toEqual(['chalice', 'chalice', 'chalice', 'chalice', 'chalice']);
  });

  it('changes no hand or keep, so flipping a Retribution owner’s pile does not trigger it', () => {
    const start = buildPosition({ keeps: { 1: ['retribution'] }, piles: { 0: ['revelation'], 1: ['chalice'] }, turn: 0 });
    const { state, events } = respond(draw(start, 0).state, 0, { kind: 'choose-pile', pile: 1 });
    expect(payloads(events, 'trigger')).toEqual([]);
    expect(frames(state)).toEqual(['S0:turn:1']);
  });
});
