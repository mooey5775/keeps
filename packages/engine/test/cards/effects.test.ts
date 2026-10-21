import { describe, expect, it } from 'vitest';
import { buildPosition, eventsFor, legalCommands } from '../../src/index.ts';
import {
  act,
  actionsLeft,
  allEvents,
  draw,
  payloads,
  pileIds,
  promptFor,
  respond,
  tryRespond,
  types,
} from '../helpers.ts';

describe('Requisition', () => {
  const position = () =>
    buildPosition({
      hands: { 0: ['requisition'] },
      piles: { 2: ['chalice', 'dagger', 'medallion'] },
      turn: 0,
    });

  it('looks through a chosen pile and takes any card, keeping the rest in order', () => {
    const played = act(position(), 0, { action: 'play', card: 'requisition' });
    expect(promptFor(played.state, 0, 'choose-pile').options).toEqual([2]);
    const looked = respond(played.state, 0, { kind: 'choose-pile', pile: 2 });
    expect(promptFor(looked.state, 0, 'choose-pile-card').cards).toEqual(['chalice', 'dagger', 'medallion']);
    const { state } = respond(looked.state, 0, { kind: 'choose-pile-card', index: 1 });
    expect(state.hands[0]).toEqual(['dagger']);
    expect(pileIds(state, 2)).toEqual(['chalice', 'medallion']);
    expect(state.discard).toEqual(['requisition']);
    expect(actionsLeft(state)).toBe(1);
  });

  it('keeps what was seen and taken private', () => {
    const played = act(position(), 0, { action: 'play', card: 'requisition' });
    const looked = respond(played.state, 0, { kind: 'choose-pile', pile: 2 });
    const taken = respond(looked.state, 0, { kind: 'choose-pile-card', index: 0 });
    const seenByOthers = JSON.stringify(eventsFor(allEvents(looked, taken), 1));
    expect(seenByOthers).not.toMatch(/chalice|dagger|medallion/);
    expect(payloads(eventsFor(taken.events, 1), 'take')).toEqual([
      { type: 'take', seat: 0, card: null, from: { pile: 2 } },
    ]);
  });

  it('plays a HOT card it takes immediately', () => {
    const start = buildPosition({ hands: { 0: ['requisition'] }, piles: { 1: ['chalice', 'blunder'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'requisition' });
    const looked = respond(played.state, 0, { kind: 'choose-pile', pile: 1 });
    const { state } = respond(looked.state, 0, { kind: 'choose-pile-card', index: 1 });
    expect(state.keeps[0]).toEqual([{ id: 'blunder' }]);
  });

  it('has no effect when every pile is empty', () => {
    const start = buildPosition({ hands: { 0: ['requisition'] }, turn: 0 });
    const { state, events } = act(start, 0, { action: 'play', card: 'requisition' });
    expect(payloads(events, 'no-effect')).toHaveLength(1);
    expect(actionsLeft(state)).toBe(1);
  });
});

describe('Epiphany', () => {
  it('looks at every non-empty pile top and takes one; the others stay', () => {
    const start = buildPosition({
      hands: { 0: ['epiphany'] },
      piles: { 1: ['chalice', 'dagger'], 3: ['medallion'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'epiphany' });
    expect(promptFor(played.state, 0, 'choose-top-card').options).toEqual([
      { pile: 1, card: 'chalice' },
      { pile: 3, card: 'medallion' },
    ]);
    const { state } = respond(played.state, 0, { kind: 'choose-top-card', pile: 1 });
    expect(state.hands[0]).toEqual(['chalice']);
    expect(pileIds(state, 1)).toEqual(['dagger']);
    expect(pileIds(state, 3)).toEqual(['medallion']);
  });
});

describe('Prayer', () => {
  const position = () =>
    buildPosition({ hands: { 0: ['prayer'] }, piles: { 2: ['chalice', 'dagger'] }, turn: 0 });

  it('can take the top card it looks at', () => {
    const played = act(position(), 0, { action: 'play', card: 'prayer' });
    const looked = respond(played.state, 0, { kind: 'choose-pile', pile: 2 });
    expect(promptFor(looked.state, 0, 'take-or-discard').card).toBe('chalice');
    const { state } = respond(looked.state, 0, { kind: 'take-or-discard', take: true });
    expect(state.hands[0]).toEqual(['chalice']);
    expect(pileIds(state, 2)).toEqual(['dagger']);
  });

  it('can discard it instead, then draws the next card of that pile', () => {
    const played = act(position(), 0, { action: 'play', card: 'prayer' });
    const looked = respond(played.state, 0, { kind: 'choose-pile', pile: 2 });
    const { state, events } = respond(looked.state, 0, { kind: 'take-or-discard', take: false });
    expect(state.discard).toEqual(['prayer', 'chalice']);
    expect(state.hands[0]).toEqual(['dagger']);
    expect(types(events)).toEqual(['discard', 'draw', 'prompt']);
  });

  it('discarding the last card of a pile ends the round with the follow-up draw (Resurrection 2)', () => {
    const start = buildPosition({ hands: { 0: ['prayer'] }, piles: { 3: ['chalice'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'prayer' });
    const looked = respond(played.state, 0, { kind: 'choose-pile', pile: 3 });
    const { state, events } = respond(looked.state, 0, { kind: 'take-or-discard', take: false });
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'empty-pile', ender: 0 }]);
    expect(state.phase).toBe('round-over');
  });
});

describe('Resurrection', () => {
  it('takes any card from the discard into your hand', () => {
    const start = buildPosition({ hands: { 0: ['resurrection'] }, discard: ['chalice', 'pluck'], turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'resurrection' });
    const { state } = respond(played.state, 0, { kind: 'choose-discard-card', card: 'chalice' });
    expect(state.hands[0]).toEqual(['chalice']);
    expect(state.discard).toEqual(['pluck', 'resurrection']);
  });

  it('C-32 can resurrect Resurrection itself', () => {
    const start = buildPosition({ hands: { 0: ['resurrection'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'resurrection' });
    const { state } = respond(played.state, 0, { kind: 'choose-discard-card', card: 'resurrection' });
    expect(state.hands[0]).toEqual(['resurrection']);
    expect(state.discard).toEqual([]);
  });

  it('plays a resurrected HOT card immediately, for free (Resurrection 1)', () => {
    const start = buildPosition({
      hands: { 0: ['resurrection'] },
      discard: ['pandemonium'],
      piles: { 3: ['chalice'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'resurrection' });
    const taken = respond(played.state, 0, { kind: 'choose-discard-card', card: 'pandemonium' });
    promptFor(taken.state, 0, 'choose-direction');
    const { state } = respond(taken.state, 0, { kind: 'choose-direction', direction: 'left' });
    expect(pileIds(state, 0)).toEqual(['chalice']);
    expect(actionsLeft(state)).toBe(1);
    expect(state.discard).toEqual(['resurrection', 'pandemonium']);
  });
});

describe('Providence', () => {
  it('swaps two played Keep cards between keeps', () => {
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 1: ['blunder'], 2: ['medallion'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const { state, events } = respond(played.state, 0, {
      kind: 'choose-keep-pair', a: { seat: 1, index: 0 }, b: { seat: 2, index: 0 },
    });
    expect(state.keeps[1]).toEqual([{ id: 'medallion' }]);
    expect(state.keeps[2]).toEqual([{ id: 'blunder' }]);
    expect(payloads(events, 'keep-swap')).toEqual([
      { type: 'keep-swap', seat: 0, a: { seat: 1, index: 0, card: 'blunder' }, b: { seat: 2, index: 0, card: 'medallion' } },
    ]);
  });

  it('accepts the two cards in either order', () => {
    const start = buildPosition({ hands: { 0: ['providence'] }, keeps: { 1: ['blunder'], 2: ['medallion'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const { state } = respond(played.state, 0, {
      kind: 'choose-keep-pair', a: { seat: 2, index: 0 }, b: { seat: 1, index: 0 },
    });
    expect(state.keeps[1]).toEqual([{ id: 'medallion' }]);
  });

  it('C-29 can swap two cards in the same keep', () => {
    const start = buildPosition({ hands: { 0: ['providence'] }, keeps: { 1: ['blunder', 'medallion'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const result = tryRespond(played.state, 0, {
      kind: 'choose-keep-pair', a: { seat: 1, index: 0 }, b: { seat: 1, index: 1 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state.keeps[1]).toEqual([{ id: 'medallion' }, { id: 'blunder' }]);
  });

  it('Q-05 can swap a face-down card, which stays face-down and hidden in the public trace', () => {
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 1: [{ id: 'chalice', faceDown: { placedBy: 2 } }], 3: ['dagger'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const { state, events } = respond(played.state, 0, {
      kind: 'choose-keep-pair', a: { seat: 1, index: 0 }, b: { seat: 3, index: 0 },
    });
    expect(state.keeps[3]).toEqual([{ id: 'chalice', faceDown: { placedBy: 2 } }]);
    expect(state.keeps[1]).toEqual([{ id: 'dagger' }]);
    expect(JSON.stringify(eventsFor(events, 0))).not.toContain('chalice');
  });

  it('can complete a token victory', () => {
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 0: ['count-token', 'fool-token', 'chalice'], 2: ['friar-token'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const { state, events } = respond(played.state, 0, {
      kind: 'choose-keep-pair', a: { seat: 0, index: 2 }, b: { seat: 2, index: 0 },
    });
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'tokens', winner: 0 }]);
    expect(state.marks).toEqual([1, 0, 0, 0]);
  });

  it('has no effect with fewer than two played Keep cards', () => {
    const start = buildPosition({ hands: { 0: ['providence'] }, keeps: { 1: ['dagger'] }, turn: 0 });
    const { events } = act(start, 0, { action: 'play', card: 'providence' });
    expect(payloads(events, 'no-effect')).toHaveLength(1);
  });
});

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
});

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
});
