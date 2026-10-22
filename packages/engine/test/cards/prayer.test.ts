import { describe, expect, it } from 'vitest';
import { buildPosition } from '../../src/index.ts';
import { act, payloads, pileIds, promptFor, respond, types } from '../helpers.ts';

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

  it('only offers non-empty piles', () => {
    const start = buildPosition({ hands: { 0: ['prayer'] }, piles: { 3: ['chalice'] }, turn: 0 });
    expect(promptFor(act(start, 0, { action: 'play', card: 'prayer' }).state, 0, 'choose-pile').options).toEqual([3]);
  });

  it('a HOT top card it takes is played immediately', () => {
    const start = buildPosition({ hands: { 0: ['prayer'] }, piles: { 3: ['pandemonium'] }, turn: 0 });
    const looked = respond(act(start, 0, { action: 'play', card: 'prayer' }).state, 0, { kind: 'choose-pile', pile: 3 });
    promptFor(respond(looked.state, 0, { kind: 'take-or-discard', take: true }).state, 0, 'choose-direction');
  });

  it('discarding a HOT top card does not play it', () => {
    const start = buildPosition({ hands: { 0: ['prayer'] }, piles: { 3: ['pandemonium', 'chalice'] }, turn: 0 });
    const looked = respond(act(start, 0, { action: 'play', card: 'prayer' }).state, 0, { kind: 'choose-pile', pile: 3 });
    const { state } = respond(looked.state, 0, { kind: 'take-or-discard', take: false });
    expect(state.discard).toEqual(['prayer', 'pandemonium']);
    expect(state.hands[0]).toEqual(['chalice']);
  });

  it('Prayer with every pile empty has no effect', () => {
    const start = buildPosition({ hands: { 0: ['prayer'] }, turn: 0 });
    const { state, events } = act(start, 0, { action: 'play', card: 'prayer' });
    expect(payloads(events, 'no-effect')).toEqual([{ type: 'no-effect', seat: 0, card: 'prayer', reason: 'every pile is empty' }]);
    expect(state.prompts.map((p) => p.kind)).toEqual(['action']);
  });
});
