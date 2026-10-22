import { describe, expect, it } from 'vitest';
import { buildPosition } from '../../src/index.ts';
import {
  act,
  actionsLeft,
  allEvents,
  draw,
  hotTarget,
  payloads,
  promptFor,
  respond,
  triggerOrder,
  types,
} from '../helpers.ts';

describe('Retribution', () => {
  it("makes its owner take two actions right after another player's play changes their keep", () => {
    const start = buildPosition({
      hands: { 0: ['chalice'] },
      keeps: { 1: ['retribution'] },
      piles: { 0: ['medallion'], 1: ['dagger', 'scepter'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'chalice', target: 1 });
    expect(triggerOrder(played.events)).toEqual(['retribution(S1)']);
    expect(played.state.stack.at(-1)).toMatchObject({ op: 'action-frame', seat: 1, kind: 'retribution', remaining: 2, restricted: true });
    promptFor(played.state, 1, 'action');

    const retaliated = draw(draw(played.state, 1).state, 1);
    expect(retaliated.state.hands[1]).toEqual(['dagger', 'scepter']);
    // Then S0's turn resumes with its last action.
    expect(retaliated.state.turn?.seat).toBe(0);
    expect(actionsLeft(retaliated.state)).toBe(1);
  });

  it("does not trigger on its owner's own plays, or on plays that don't touch the owner", () => {
    const own = buildPosition({ hands: { 1: ['chalice'] }, keeps: { 1: ['retribution'] }, turn: 1 });
    expect(types(act(own, 1, { action: 'play', card: 'chalice', target: 1 }).events)).not.toContain('trigger');
    const elsewhere = buildPosition({ hands: { 0: ['chalice'] }, keeps: { 1: ['retribution'] }, turn: 0 });
    expect(types(act(elsewhere, 0, { action: 'play', card: 'chalice', target: 2 }).events)).not.toContain('trigger');
  });

  it('triggers when a played card takes a card out of the owner\'s keep (Providence)', () => {
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 1: ['retribution', 'chalice'], 2: ['dagger'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const { events } = respond(played.state, 0, {
      kind: 'choose-keep-pair', a: { seat: 1, index: 1 }, b: { seat: 2, index: 0 },
    });
    expect(triggerOrder(events)).toEqual(['retribution(S1)']);
  });

  it('C-30 swapping Retribution out of a keep still triggers it for that player', () => {
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 1: ['retribution'], 2: ['dagger'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const { state, events } = respond(played.state, 0, {
      kind: 'choose-keep-pair', a: { seat: 1, index: 0 }, b: { seat: 2, index: 0 },
    });
    expect(state.keeps[1]).toEqual([{ id: 'dagger' }]);
    expect(triggerOrder(events)).toEqual(['retribution(S1)']);
  });

  it('Q-15 the player who receives Retribution in that same swap does not trigger', () => {
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 1: ['retribution'], 2: ['dagger'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const { state, events } = respond(played.state, 0, {
      kind: 'choose-keep-pair', a: { seat: 1, index: 0 }, b: { seat: 2, index: 0 },
    });
    expect(state.keeps[2]).toEqual([{ id: 'retribution' }]);
    expect(triggerOrder(events)).not.toContain('retribution(S2)');
  });

  it('Q-15 having Retribution played into your keep does not trigger it', () => {
    const start = buildPosition({ hands: { 0: ['retribution'] }, turn: 0 });
    const { events } = act(start, 0, { action: 'play', card: 'retribution', target: 1 });
    expect(types(events)).not.toContain('trigger');
  });

  it('Q-13 does not trigger from abilities: Juggling a pile or placing Blunder on it', () => {
    const start = buildPosition({
      keeps: { 0: ['juggling', 'blunder'], 1: ['retribution'] },
      hands: { 0: ['hocus-pocus'] },
      piles: { 1: ['chalice'] },
      turn: 0,
    });
    let state = act(start, 0, { action: 'play', card: 'hocus-pocus' }).state;
    const juggled = act(state, 0, { action: 'ability', card: 'juggling', piles: [1, 2] });
    state = juggled.state;
    const placed = act(state, 0, { action: 'ability', card: 'blunder', pile: 1 });
    expect(types(allEvents(juggled, placed))).not.toContain('trigger');
  });

  it('does trigger for a HOT card drawn by an ability, since that HOT card is played', () => {
    const start = buildPosition({
      keeps: { 0: ['sanction'], 1: ['retribution'] },
      piles: { 2: ['juggling'] },
      turn: 0,
    });
    const drawn = act(start, 0, { action: 'ability', card: 'sanction', from: 2 });
    const { events } = hotTarget(drawn.state, 0, 1);
    expect(triggerOrder(events)).toEqual(['retribution(S1)']);
  });

  it("the owner's actions can end the round", () => {
    const start = buildPosition({ hands: { 0: ['chalice'] }, keeps: { 1: ['retribution'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'chalice', target: 1 });
    const { events } = draw(played.state, 1);
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'empty-pile', ender: 1 }]);
  });

  it('Offering makes every holder-giver retaliate', () => {
    const start = buildPosition({
      hands: { 0: ['offering'], 1: ['chalice'] },
      keeps: { 1: ['retribution'] },
      piles: { 1: ['dagger', 'scepter'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'offering' });
    const { events } = respond(played.state, 1, { kind: 'give-card', card: 'chalice' });
    expect(payloads(events, 'trigger').map((t) => `${t.kind}:${t.seat}`)).toEqual(['retribution:1']);
  });

  it('Pluck taking from its owner triggers it; just looking does not', () => {
    const start = buildPosition({ hands: { 0: ['pluck'], 1: ['chalice'], 2: ['dagger'] }, keeps: { 1: ['retribution'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'pluck' });
    expect(types(respond(played.state, 0, { kind: 'choose-hand-card', seat: 2, card: 'dagger' }).events)).not.toContain('trigger');
    expect(types(respond(played.state, 0, { kind: 'choose-hand-card', seat: 1, card: 'chalice' }).events)).toContain('trigger');
  });

  it("Retribution triggers when its owner's card is the second card of the pair", () => {
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 1: ['dagger'], 2: ['retribution', 'chalice'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const { events } = respond(played.state, 0, { kind: 'choose-keep-pair', a: { seat: 1, index: 0 }, b: { seat: 2, index: 1 } });
    expect(payloads(events, 'trigger').map((t) => `${t.kind}:${t.seat}`)).toEqual(['retribution:2']);
  });
});

describe('what changes a Retribution owner’s hand or keep', () => {
  it('Legerdemain on an empty-handed owner takes nothing: no trigger', () => {
    const start = buildPosition({ hands: { 0: ['legerdemain'] }, keeps: { 1: ['retribution'] }, turn: 0 });
    const { events } = respond(act(start, 0, { action: 'play', card: 'legerdemain' }).state, 0, { kind: 'choose-player', seat: 1 });
    expect(types(events)).not.toContain('trigger');
  });

  it('Pickpocket on an owner with no Coin cards in hand takes nothing: no trigger', () => {
    const start = buildPosition({ hands: { 0: ['pickpocket'], 1: ['joker'] }, keeps: { 1: ['retribution'] }, turn: 0 });
    const { events } = respond(act(start, 0, { action: 'play', card: 'pickpocket' }).state, 0, { kind: 'choose-player', seat: 1 });
    expect(types(events)).not.toContain('trigger');
  });

  it("drawing from the owner's pile (Invocation, Sanction) is not their hand or keep", () => {
    const start = buildPosition({
      keeps: { 0: ['sanction'], 1: ['retribution'] },
      piles: { 1: ['chalice'] },
      turn: 0,
    });
    const { events } = act(start, 0, { action: 'ability', card: 'sanction', from: 1 });
    expect(types(events)).not.toContain('trigger');
  });

  it('Requisition taking from the owner’s pile is not their hand or keep', () => {
    const start = buildPosition({ hands: { 0: ['requisition'] }, keeps: { 1: ['retribution'] }, piles: { 1: ['chalice'] }, turn: 0 });
    const looked = respond(act(start, 0, { action: 'play', card: 'requisition' }).state, 0, { kind: 'choose-pile', pile: 1 });
    expect(types(respond(looked.state, 0, { kind: 'choose-pile-card', index: 0 }).events)).not.toContain('trigger');
  });

  it("Fiat played into the owner's keep triggers it once the claims are done", () => {
    const start = buildPosition({ keeps: { 1: ['retribution'] }, piles: { 0: ['fiat', 'chalice'], 1: ['dagger', 'scepter'] }, turn: 0 });
    let state = hotTarget(draw(start, 0).state, 0, 1).state;
    for (const seat of [0, 1, 2, 3] as const) {
      expect(state.stack.some((op) => op.op === 'action-frame' && op.kind === 'retribution')).toBe(false);
      state = respond(state, seat, { kind: 'claim-pile', from: promptFor(state, seat, 'claim-pile').options[0]! }).state;
    }
    expect(state.stack.at(-1)).toMatchObject({ op: 'action-frame', seat: 1, kind: 'retribution', remaining: 2 });
  });

  it('Joker copying Offering makes a giving owner retaliate', () => {
    const start = buildPosition({ hands: { 0: ['joker', 'offering'], 1: ['chalice'] }, keeps: { 1: ['retribution'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'joker', copy: 'offering' });
    // Offering discards S0's hand (including the revealed Offering) first.
    expect(played.state.discard).toEqual(['joker', 'offering']);
    const { events } = respond(played.state, 1, { kind: 'give-card', card: 'chalice' });
    expect(payloads(events, 'trigger').map((t) => t.kind)).toEqual(['retribution']);
  });

  it("Offering played by the Retribution owner doesn't trigger their own Retribution", () => {
    const start = buildPosition({ hands: { 0: ['offering'], 2: ['chalice'] }, keeps: { 0: ['retribution'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'offering' });
    expect(types(respond(played.state, 2, { kind: 'give-card', card: 'chalice' }).events)).not.toContain('trigger');
  });
});

describe('Retribution actions', () => {
  it('a Shackled owner still gets both Retribution actions (Shackles only limits their turn)', () => {
    const start = buildPosition({ hands: { 0: ['chalice'] }, keeps: { 1: ['retribution', 'shackles'] }, piles: { 1: ['dagger', 'scepter'] }, turn: 0 });
    const { state } = act(start, 0, { action: 'play', card: 'chalice', target: 1 });
    expect(state.stack.at(-1)).toMatchObject({ seat: 1, kind: 'retribution', remaining: 2 });
  });

  it('a HOT card drawn during Retribution actions is played before the actions continue', () => {
    const start = buildPosition({
      hands: { 0: ['chalice'] },
      keeps: { 1: ['retribution'] },
      piles: { 1: ['blunder', 'dagger'] },
      turn: 0,
    });
    const struck = act(start, 0, { action: 'play', card: 'chalice', target: 1 });
    const first = draw(struck.state, 1);
    expect(first.state.keeps[1].map((c) => c.id)).toEqual(['retribution', 'chalice', 'blunder']);
    expect(actionsLeft(first.state)).toBe(1);
    promptFor(first.state, 1, 'action');
  });

  it('ending the round during Retribution actions makes the Retribution owner the ender', () => {
    const start = buildPosition({
      hands: { 0: ['chalice'] },
      keeps: { 1: ['retribution'], 2: ['dagger'], 3: ['scepter'] },
      turn: 0,
    });
    const struck = act(start, 0, { action: 'play', card: 'chalice', target: 1 });
    const { events } = draw(struck.state, 1);
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'empty-pile', ender: 1 }]);
    // S1, S2, S3 tie at 2 coins; left of the ender S1 is S2.
    expect(payloads(events, 'score')[0]).toMatchObject({ winner: 2, tiedWith: [3, 1] });
  });

  it('the Retribution owner can win by Tokens during their Retribution actions', () => {
    const start = buildPosition({
      hands: { 0: ['chalice'], 1: ['friar-token'] },
      keeps: { 1: ['retribution', 'count-token', 'fool-token'] },
      turn: 0,
    });
    const struck = act(start, 0, { action: 'play', card: 'chalice', target: 1 });
    const { state, events } = act(struck.state, 1, { action: 'play', card: 'friar-token', target: 1 });
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'tokens', winner: 1 }]);
    expect(state.marks).toEqual([0, 1, 0, 0]);
  });

  it("the owner's Retribution plays can trigger the original player's Interest", () => {
    const start = buildPosition({
      hands: { 0: ['chalice'], 1: ['dagger'] },
      keeps: { 0: ['interest'], 1: ['retribution'] },
      piles: { 0: ['scepter', 'medallion'] },
      turn: 0,
    });
    const struck = act(start, 0, { action: 'play', card: 'chalice', target: 1 });
    const back = act(struck.state, 1, { action: 'play', card: 'dagger', target: 0 });
    expect(payloads(back.events, 'trigger').map((t) => `${t.kind}:${t.seat}`)).toEqual(['interest:0']);
    expect(back.state.hands[0]).toEqual(['scepter']);
    // Still S1's second Retribution action.
    expect(back.state.stack.at(-1)).toMatchObject({ seat: 1, kind: 'retribution', remaining: 1 });
  });

  it('after the Retribution actions, the interrupted turn resumes with the same frame', () => {
    const start = buildPosition({
      hands: { 0: ['hocus-pocus', 'chalice'] },
      keeps: { 1: ['retribution'] },
      piles: { 0: ['dagger', 'scepter', 'medallion'], 1: ['timepiece', 'faberge-egg'] },
      turn: 0,
    });
    // Hocus Pocus: turn frame 1 left + 2 extra. Spend one extra on Chalice into S1.
    let state = act(start, 0, { action: 'play', card: 'hocus-pocus' }).state;
    state = act(state, 0, { action: 'play', card: 'chalice', target: 1 }).state;
    state = draw(draw(state, 1).state, 1).state;
    expect(state.stack.flatMap((op) => (op.op === 'action-frame' ? [[op.kind, op.remaining]] : []))).toEqual([
      ['turn', 1],
      ['hocus-pocus', 1],
    ]);
    state = draw(draw(state, 0).state, 0).state;
    expect(state.turn?.seat).toBe(1);
  });
});
