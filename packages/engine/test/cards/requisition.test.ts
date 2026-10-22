import { describe, expect, it } from 'vitest';
import { buildPosition, eventsFor } from '../../src/index.ts';
import { act, actionsLeft, allEvents, payloads, pileIds, promptFor, respond } from '../helpers.ts';

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

  it('can take the bottom card of a pile', () => {
    const start = buildPosition({ hands: { 0: ['requisition'] }, piles: { 3: ['chalice', 'dagger', 'scepter'] }, turn: 0 });
    const looked = respond(act(start, 0, { action: 'play', card: 'requisition' }).state, 0, { kind: 'choose-pile', pile: 3 });
    const { state } = respond(looked.state, 0, { kind: 'choose-pile-card', index: 2 });
    expect(state.hands[0]).toEqual(['scepter']);
    expect(pileIds(state, 3)).toEqual(['chalice', 'dagger']);
  });

  it('can look through your own pile', () => {
    const start = buildPosition({ hands: { 0: ['requisition'] }, piles: { 0: ['chalice'], 3: ['dagger'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'requisition' });
    expect(promptFor(played.state, 0, 'choose-pile').options).toEqual([0, 3]);
  });

  it('offers only non-empty piles', () => {
    const start = buildPosition({ hands: { 0: ['requisition'] }, piles: { 2: ['chalice'] }, turn: 0 });
    expect(promptFor(act(start, 0, { action: 'play', card: 'requisition' }).state, 0, 'choose-pile').options).toEqual([2]);
  });
});
