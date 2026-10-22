import { describe, expect, it } from 'vitest';
import { buildPosition, eventsFor, legalCommands } from '../../src/index.ts';
import { act, actionsLeft, payloads, respond } from '../helpers.ts';

describe('Offering', () => {
  it('discards your hand, then every other player with cards gives you one, all at once', () => {
    const start = buildPosition({
      hands: { 0: ['offering', 'scepter'], 1: ['chalice', 'dagger'], 3: ['medallion'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'offering' });
    expect(played.state.discard).toEqual(['offering', 'scepter']);
    expect(played.state.prompts.map((p) => [p.seat, p.kind])).toEqual([
      [1, 'give-card'],
      [3, 'give-card'],
    ]);
    // Answer out of order; the turn only continues once everyone has given.
    const s3 = respond(played.state, 3, { kind: 'give-card', card: 'medallion' });
    expect(s3.state.prompts.map((p) => p.seat)).toEqual([1]);
    const s1 = respond(s3.state, 1, { kind: 'give-card', card: 'dagger' });
    expect(s1.state.hands[0]).toEqual(['medallion', 'dagger']);
    expect(s1.state.hands[1]).toEqual(['chalice']);
    expect(actionsLeft(s1.state)).toBe(1);
    // Only giver and receiver see the card.
    expect(payloads(eventsFor(s1.events, 3), 'give')).toEqual([{ type: 'give', seat: 1, to: 0, card: null }]);
  });

  it('with nobody else holding cards, just discards your hand', () => {
    const start = buildPosition({ hands: { 0: ['offering', 'chalice'] }, turn: 0 });
    const { state } = act(start, 0, { action: 'play', card: 'offering' });
    expect(state.discard).toEqual(['offering', 'chalice']);
    expect(state.prompts.map((p) => p.kind)).toEqual(['action']);
  });

  it('works with an empty hand of your own', () => {
    const start = buildPosition({ hands: { 0: ['offering'], 2: ['chalice'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'offering' });
    expect(respond(played.state, 2, { kind: 'give-card', card: 'chalice' }).state.hands[0]).toEqual(['chalice']);
  });

  it('a giver can only give a card they hold', () => {
    const start = buildPosition({ hands: { 0: ['offering'], 2: ['chalice'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'offering' });
    const answers = legalCommands(played.state, 2).map((c) => c.type === 'answer' && c.answer);
    expect(answers).toEqual([{ kind: 'give-card', card: 'chalice' }]);
  });
});
