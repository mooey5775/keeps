import { describe, expect, it } from 'vitest';
import { buildPosition } from '../../src/index.ts';
import { abilityNames, act, draw, hotTarget, payloads, promptFor, respond, types } from '../helpers.ts';

// Smaller rule points from the card texts that no other file pins down.

describe('the Last Laugh action can be anything that is not restricted', () => {
  it('discarding Shackles ("you may use one action to discard Shackles")', () => {
    const start = buildPosition({ keeps: { 0: ['last-laugh', 'shackles'], 1: ['chalice'] }, turn: 0, actions: 2 });
    const ended = draw(start, 0).state;
    expect(abilityNames(ended, 0)).toEqual(['shackles']);
    const { events } = act(ended, 0, { action: 'ability', card: 'shackles' });
    // Shackles' -3 is gone from S0's keep before scoring.
    expect(payloads(events, 'score')[0]).toMatchObject({ scores: [0, 4, 0, 0] });
  });

  it('a plain draw from a pile that still has cards', () => {
    const start = buildPosition({ keeps: { 2: ['last-laugh'] }, piles: { 2: ['chalice'] }, turn: 0 });
    const ended = draw(start, 0).state;
    const { state } = draw(ended, 2);
    expect(state.hands[2]).toEqual(['chalice']);
    expect(state.phase).toBe('round-over');
  });

  it('Resurrection taking Fiat: the pile claims happen before scoring', () => {
    const start = buildPosition({ keeps: { 0: ['last-laugh'] }, hands: { 0: ['resurrection'] }, discard: ['fiat'], turn: 0 });
    const ended = draw(start, 0).state;
    const taken = respond(act(ended, 0, { action: 'play', card: 'resurrection' }).state, 0, { kind: 'choose-discard-card', card: 'fiat' });
    let state = hotTarget(taken.state, 0, 0).state;
    for (const seat of [0, 1, 2, 3] as const) {
      expect(state.phase).toBe('post-round');
      state = respond(state, seat, { kind: 'claim-pile', from: promptFor(state, seat, 'claim-pile').options[0]! }).state;
    }
    expect(state.phase).toBe('round-over');
  });

  it("playing a Coin card into your own Interest keep with an empty pile draws nothing and doesn't end anything twice", () => {
    const start = buildPosition({ keeps: { 0: ['last-laugh', 'interest'] }, hands: { 0: ['chalice'] }, turn: 0 });
    const ended = draw(start, 0).state;
    const { events } = act(ended, 0, { action: 'play', card: 'chalice', target: 0 });
    expect(payloads(events, 'empty-draw')).toEqual([{ type: 'empty-draw', seat: 0, from: 0, afterRoundEnd: true }]);
    expect(types(events).filter((t) => t === 'round-end')).toEqual([]);
  });
});

describe('HOT cards reached through other cards', () => {
  it('Requisition taking Invocation: it is played at once and invokes', () => {
    const start = buildPosition({ hands: { 0: ['requisition'] }, piles: { 2: ['chalice', 'invocation'], 3: ['dagger'] }, turn: 0 });
    const looked = respond(act(start, 0, { action: 'play', card: 'requisition' }).state, 0, { kind: 'choose-pile', pile: 2 });
    const taken = respond(looked.state, 0, { kind: 'choose-pile-card', index: 1 });
    const invoked = respond(taken.state, 0, { kind: 'choose-pile', pile: 3 });
    expect(promptFor(invoked.state, 0, 'hot-target').card).toBe('dagger');
  });

  it('Epiphany taking Revelation from a pile top: it is played at once', () => {
    const start = buildPosition({ hands: { 0: ['epiphany'] }, piles: { 1: ['revelation', 'chalice'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'epiphany' });
    const taken = respond(played.state, 0, { kind: 'choose-top-card', pile: 1 });
    expect(promptFor(taken.state, 0, 'choose-pile').purpose).toBe('revelation');
  });
});

describe('Joker', () => {
  it('copying Requisition follows Requisition’s two steps, and Requisition stays in hand', () => {
    const start = buildPosition({ hands: { 0: ['joker', 'requisition'] }, piles: { 1: ['chalice', 'dagger'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'joker', copy: 'requisition' });
    const looked = respond(played.state, 0, { kind: 'choose-pile', pile: 1 });
    const { state } = respond(looked.state, 0, { kind: 'choose-pile-card', index: 1 });
    expect(state.hands[0]).toEqual(['requisition', 'dagger']);
    expect(state.discard).toEqual(['joker']);
  });

  it('copying Hocus Pocus during Last Laugh gives two more restricted actions', () => {
    const start = buildPosition({ keeps: { 0: ['last-laugh', 'sanction'] }, hands: { 0: ['joker', 'hocus-pocus'] }, turn: 0 });
    const ended = draw(start, 0).state;
    const { state } = act(ended, 0, { action: 'play', card: 'joker', copy: 'hocus-pocus' });
    expect(state.stack.at(-1)).toMatchObject({ kind: 'hocus-pocus', remaining: 2, restricted: true });
    expect(abilityNames(state, 0)).toEqual([]);
  });
});

describe('Pickpocket', () => {
  it('takes Tithes and Tokens from a Retribution owner and triggers it', () => {
    const start = buildPosition({ hands: { 0: ['pickpocket'], 1: ['tithes', 'fool-token', 'prayer'] }, keeps: { 1: ['retribution'] }, turn: 0 });
    const { state, events } = respond(act(start, 0, { action: 'play', card: 'pickpocket' }).state, 0, { kind: 'choose-player', seat: 1 });
    expect(state.hands[0]).toEqual(['tithes', 'fool-token']);
    expect(state.hands[1]).toEqual(['prayer']);
    expect(payloads(events, 'trigger').map((t) => t.kind)).toEqual(['retribution']);
  });
});
