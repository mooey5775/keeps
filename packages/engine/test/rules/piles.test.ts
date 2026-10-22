import { describe, expect, it } from 'vitest';
import { buildPosition } from '../../src/index.ts';
import { act, draw, promptFor, respond, types } from '../helpers.ts';

// Piles that move or are flipped face up.

describe('piles that move', () => {
  it('after Pandemonium, "your pile" is whichever pile now sits in front of you', () => {
    const start = buildPosition({
      piles: { 0: ['pandemonium', 'chalice'], 1: ['dagger'] },
      turn: 0,
    });
    const rotated = respond(draw(start, 0).state, 0, { kind: 'choose-direction', direction: 'right' });
    const { state } = draw(rotated.state, 0);
    expect(state.hands[0]).toEqual(['dagger']);
  });

  it('after Juggling, drawing takes from the swapped-in pile', () => {
    const start = buildPosition({ keeps: { 0: ['juggling'] }, piles: { 0: ['chalice'], 2: ['dagger'] }, turn: 0 });
    const swapped = act(start, 0, { action: 'ability', card: 'juggling', piles: [0, 2] });
    expect(draw(swapped.state, 0).state.hands[0]).toEqual(['dagger']);
  });

  it('Juggling an empty pile to yourself and drawing ends the round', () => {
    const start = buildPosition({ keeps: { 0: ['juggling', 'chalice'] }, piles: { 0: ['dagger'] }, turn: 0 });
    const swapped = act(start, 0, { action: 'ability', card: 'juggling', piles: [0, 1] });
    expect(types(draw(swapped.state, 0).events)).toContain('round-end');
  });

  it('a pile keeps its contents when it moves: Revelation flips travel with it', () => {
    const start = buildPosition({
      keeps: { 0: ['juggling'] },
      piles: { 0: ['revelation'], 2: ['chalice', 'dagger'] },
      turn: 0,
    });
    const flipped = respond(draw(start, 0).state, 0, { kind: 'choose-pile', pile: 2 });
    const { state } = act(flipped.state, 0, { action: 'ability', card: 'juggling', piles: [2, 3] });
    expect(state.piles[state.pileAt[3]].cards).toEqual([
      { id: 'dagger', faceUp: true },
      { id: 'chalice', faceUp: true },
    ]);
  });
});

describe('face-up pile cards', () => {
  it('Requisition can take a face-up Blunder from deep in a pile, and it lands in your keep', () => {
    const start = buildPosition({
      hands: { 0: ['requisition'] },
      piles: { 2: ['chalice', { id: 'blunder', faceUp: true }] },
      turn: 0,
    });
    const looked = respond(act(start, 0, { action: 'play', card: 'requisition' }).state, 0, { kind: 'choose-pile', pile: 2 });
    const { state } = respond(looked.state, 0, { kind: 'choose-pile-card', index: 1 });
    expect(state.keeps[0]).toEqual([{ id: 'blunder' }]);
    expect(state.piles[state.pileAt[2]].cards).toEqual([{ id: 'chalice', faceUp: false }]);
  });

  it('Blunder placed on a flipped pile sits face up on top of the face-up cards', () => {
    const start = buildPosition({
      keeps: { 0: ['blunder'] },
      piles: { 2: [{ id: 'chalice', faceUp: true }] },
      turn: 0,
    });
    const { state } = act(start, 0, { action: 'ability', card: 'blunder', pile: 2 });
    expect(state.piles[state.pileAt[2]].cards).toEqual([
      { id: 'blunder', faceUp: true },
      { id: 'chalice', faceUp: true },
    ]);
  });

  it('Tithes keeps each card face up or down as it was when reordering', () => {
    const start = buildPosition({
      keeps: { 0: ['tithes'] },
      piles: { 0: [{ id: 'chalice', faceUp: true }, 'dagger'] },
      turn: 0,
    });
    const used = act(start, 0, { action: 'ability', card: 'tithes' });
    const { state } = respond(used.state, 0, { kind: 'order-pile', order: ['dagger', 'chalice'] });
    expect(state.piles[state.pileAt[0]].cards).toEqual([
      { id: 'dagger', faceUp: false },
      { id: 'chalice', faceUp: true },
    ]);
  });

  it('Epiphany sees a face-up top card like any other', () => {
    const start = buildPosition({ hands: { 0: ['epiphany'] }, piles: { 1: [{ id: 'chalice', faceUp: true }] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'epiphany' });
    expect(promptFor(played.state, 0, 'choose-top-card').options).toEqual([{ pile: 1, card: 'chalice' }]);
  });

  it('Prayer: discarding the top card then drawing a HOT card plays it', () => {
    const start = buildPosition({ hands: { 0: ['prayer'] }, piles: { 2: ['chalice', 'blunder'] }, turn: 0 });
    const looked = respond(act(start, 0, { action: 'play', card: 'prayer' }).state, 0, { kind: 'choose-pile', pile: 2 });
    const { state } = respond(looked.state, 0, { kind: 'take-or-discard', take: false });
    expect(state.keeps[0]).toEqual([{ id: 'blunder' }]);
    expect(state.discard).toEqual(['prayer', 'chalice']);
  });
});
