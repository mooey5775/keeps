import { describe, expect, it } from 'vitest';
import { buildPosition, eventsFor } from '../../src/index.ts';
import { act, payloads, promptFor, respond } from '../helpers.ts';

describe('Pluck', () => {
  it("reveals the other players' hands to you alone, and you take one card", () => {
    const start = buildPosition({
      seats: ['player', 'player', 'ghost', 'player'],
      hands: { 0: ['pluck', 'scepter'], 1: ['chalice'], 3: ['dagger', 'joker'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'pluck' });
    expect(promptFor(played.state, 0, 'choose-hand-card').options).toEqual([
      { seat: 1, card: 'chalice' },
      { seat: 3, card: 'dagger' },
      { seat: 3, card: 'joker' },
    ]);
    expect(JSON.stringify(eventsFor(played.events, 1))).not.toMatch(/dagger|joker/);
    const { state, events } = respond(played.state, 0, { kind: 'choose-hand-card', seat: 3, card: 'joker' });
    expect(state.hands[0]).toEqual(['scepter', 'joker']);
    expect(state.hands[3]).toEqual(['dagger']);
    expect(payloads(eventsFor(events, 1), 'steal')[0]!.cards).toBeNull();
  });

  it('has no effect when nobody else has cards', () => {
    const start = buildPosition({ hands: { 0: ['pluck'] }, turn: 0 });
    expect(payloads(act(start, 0, { action: 'play', card: 'pluck' }).events, 'no-effect')).toHaveLength(1);
  });

  it('can take a Keep card or a non-Keep card', () => {
    const start = buildPosition({ hands: { 0: ['pluck'], 1: ['chalice', 'prayer'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'pluck' });
    const { state } = respond(played.state, 0, { kind: 'choose-hand-card', seat: 1, card: 'prayer' });
    expect(state.hands[0]).toEqual(['prayer']);
  });

  it('does not look at your own hand', () => {
    const start = buildPosition({ hands: { 0: ['pluck', 'chalice'], 2: ['dagger'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'pluck' });
    expect(promptFor(played.state, 0, 'choose-hand-card').options).toEqual([{ seat: 2, card: 'dagger' }]);
  });
});
