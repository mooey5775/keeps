import { describe, expect, it } from 'vitest';
import { buildPosition, legalCommands } from '../../src/index.ts';
import { act, actionsLeft, pileIds, promptFor, respond } from '../helpers.ts';

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

  it('offers every card in the discard', () => {
    const start = buildPosition({ hands: { 0: ['resurrection'] }, discard: ['chalice', 'pluck'], turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'resurrection' });
    expect(legalCommands(played.state, 0).map((c) => c.type === 'answer' && c.answer)).toEqual([
      { kind: 'choose-discard-card', card: 'chalice' },
      { kind: 'choose-discard-card', card: 'pluck' },
      { kind: 'choose-discard-card', card: 'resurrection' },
    ]);
  });

  it('a resurrected card is public', () => {
    const start = buildPosition({ hands: { 0: ['resurrection'] }, discard: ['chalice'], turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'resurrection' });
    const { events } = respond(played.state, 0, { kind: 'choose-discard-card', card: 'chalice' });
    expect(events.find((e) => e.payload.type === 'take')!.visibility).toBe('all');
  });
});
