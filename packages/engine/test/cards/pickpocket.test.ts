import { describe, expect, it } from 'vitest';
import { buildPosition, eventsFor } from '../../src/index.ts';
import { act, payloads, promptFor, respond } from '../helpers.ts';

describe('Pickpocket', () => {
  it("moves every Coin card from the target's hand into yours, privately", () => {
    const start = buildPosition({ hands: { 0: ['pickpocket'], 2: ['chalice', 'joker', 'count-token'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'pickpocket' });
    const { state, events } = respond(played.state, 0, { kind: 'choose-player', seat: 2 });
    expect(state.hands[0]).toEqual(['chalice', 'count-token']);
    expect(state.hands[2]).toEqual(['joker']);
    expect(payloads(eventsFor(events, 1), 'steal')).toEqual([{ type: 'steal', seat: 0, from: 2, cards: null, count: 2 }]);
    expect(payloads(eventsFor(events, 2), 'steal')[0]!.cards).toEqual(['chalice', 'count-token']);
  });

  it('C-28 may target a ghost, which has no cards', () => {
    const start = buildPosition({ seats: ['player', 'ghost', 'player', 'ghost'], hands: { 0: ['pickpocket'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'pickpocket' });
    expect(promptFor(played.state, 0, 'choose-player').options).toContain(3);
    const { events } = respond(played.state, 0, { kind: 'choose-player', seat: 3 });
    expect(payloads(events, 'no-effect')).toHaveLength(1);
  });

  it('Q-11 Legerdemain and Pickpocket may target yourself; Pickpocket then does nothing', () => {
    const start = buildPosition({ hands: { 0: ['pickpocket', 'chalice'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'pickpocket' });
    expect(promptFor(played.state, 0, 'choose-player').options).toContain(0);
    const { state, events } = respond(played.state, 0, { kind: 'choose-player', seat: 0 });
    expect(payloads(events, 'no-effect')).toHaveLength(1);
    expect(state.hands[0]).toEqual(['chalice']);

    const self = buildPosition({ hands: { 0: ['legerdemain', 'dagger'] }, turn: 0 });
    const ledger = respond(act(self, 0, { action: 'play', card: 'legerdemain' }).state, 0, { kind: 'choose-player', seat: 0 });
    expect(payloads(ledger.events, 'steal')).toEqual([{ type: 'steal', seat: 0, from: 0, cards: ['dagger'], count: 1 }]);
  });

  it("triggers the target's Retribution when it takes something", () => {
    const start = buildPosition({ hands: { 0: ['pickpocket'], 1: ['chalice'] }, keeps: { 1: ['retribution'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'pickpocket' });
    const { events } = respond(played.state, 0, { kind: 'choose-player', seat: 1 });
    expect(payloads(events, 'trigger').map((t) => t.kind)).toEqual(['retribution']);
  });

  it('takes Tokens and Tithes too, since they are Coin cards', () => {
    const start = buildPosition({ hands: { 0: ['pickpocket'], 1: ['friar-token', 'tithes', 'purity'] }, turn: 0 });
    const { state } = respond(act(start, 0, { action: 'play', card: 'pickpocket' }).state, 0, { kind: 'choose-player', seat: 1 });
    expect(state.hands[0]).toEqual(['friar-token', 'tithes']);
    expect(state.hands[1]).toEqual(['purity']);
  });

  it('takes nothing from a hand with no Coin cards', () => {
    const start = buildPosition({ hands: { 0: ['pickpocket'], 1: ['purity', 'joker'] }, turn: 0 });
    const { state, events } = respond(act(start, 0, { action: 'play', card: 'pickpocket' }).state, 0, { kind: 'choose-player', seat: 1 });
    expect(payloads(events, 'no-effect')).toHaveLength(1);
    expect(state.hands[1]).toEqual(['purity', 'joker']);
  });

  it('takes Tithes and Tokens from a Retribution owner and triggers it', () => {
    const start = buildPosition({ hands: { 0: ['pickpocket'], 1: ['tithes', 'fool-token', 'prayer'] }, keeps: { 1: ['retribution'] }, turn: 0 });
    const { state, events } = respond(act(start, 0, { action: 'play', card: 'pickpocket' }).state, 0, { kind: 'choose-player', seat: 1 });
    expect(state.hands[0]).toEqual(['tithes', 'fool-token']);
    expect(state.hands[1]).toEqual(['prayer']);
    expect(payloads(events, 'trigger').map((t) => t.kind)).toEqual(['retribution']);
  });
});
