import { describe, expect, it } from 'vitest';
import { buildPosition, legalCommands } from '../../src/index.ts';
import {
  abilityNames,
  act,
  actionChoices,
  actionsLeft,
  draw,
  frames,
  payloads,
  promptFor,
  respond,
  stealing,
  tryRespond,
} from '../helpers.ts';

describe('Joker', () => {
  it('reveals a non-Keep card from your hand and takes its effect; the revealed card stays', () => {
    const start = buildPosition({ hands: { 0: ['joker', 'hocus-pocus', 'chalice'] }, turn: 0 });
    expect(actionChoices(start, 0).filter((c) => c.action === 'play' && c.card === 'joker')).toEqual([
      { action: 'play', card: 'joker', copy: 'hocus-pocus' },
    ]);
    const { state, events } = act(start, 0, { action: 'play', card: 'joker', copy: 'hocus-pocus' });
    expect(state.hands[0]).toEqual(['hocus-pocus', 'chalice']);
    expect(state.discard).toEqual(['joker']);
    expect(payloads(events, 'reveal-card')).toEqual([{ type: 'reveal-card', seat: 0, card: 'hocus-pocus' }]);
    expect(actionsLeft(state)).toBe(2);
  });

  it("Q-09 can't be played from hand without a non-Keep card to reveal", () => {
    const start = buildPosition({ hands: { 0: ['joker', 'chalice'] }, turn: 0 });
    expect(actionChoices(start, 0).some((c) => c.action === 'play' && c.card === 'joker')).toBe(false);
  });

  it('Q-09 played as HOT with nothing to reveal, it has no effect', () => {
    const start = buildPosition({ hands: { 0: ['legerdemain', 'chalice'], 1: ['joker'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'legerdemain' });
    const { state, events } = respond(played.state, 0, { kind: 'choose-player', seat: 1 });
    expect(payloads(events, 'no-effect')).toHaveLength(1);
    expect(state.discard).toEqual(['legerdemain', 'joker']);
    expect(state.hands[0]).toEqual(['chalice']);
  });

  it('played as HOT with something to reveal, you choose what to copy', () => {
    const start = buildPosition({ hands: { 0: ['legerdemain', 'hocus-pocus'], 1: ['joker'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'legerdemain' });
    const stolen = respond(played.state, 0, { kind: 'choose-player', seat: 1 });
    expect(promptFor(stolen.state, 0, 'joker-copy').options).toEqual(['hocus-pocus']);
    const { state } = respond(stolen.state, 0, { kind: 'joker-copy', card: 'hocus-pocus' });
    expect(actionsLeft(state)).toBe(2);
  });

  it('can copy Prayer, Resurrection, Epiphany, or any other non-Keep card in hand', () => {
    const start = buildPosition({
      hands: { 0: ['joker', 'prayer', 'resurrection', 'epiphany', 'chalice'] },
      turn: 0,
    });
    const copies = actionChoices(start, 0).flatMap((c) => (c.action === 'play' && c.card === 'joker' ? [c.copy] : []));
    expect(copies).toEqual(['prayer', 'resurrection', 'epiphany']);
  });

  it('copying Prayer uses Prayer\'s prompts, and the copied card stays in hand', () => {
    const start = buildPosition({ hands: { 0: ['joker', 'prayer'] }, piles: { 2: ['chalice'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'joker', copy: 'prayer' });
    const looked = respond(played.state, 0, { kind: 'choose-pile', pile: 2 });
    const { state } = respond(looked.state, 0, { kind: 'take-or-discard', take: true });
    expect(state.hands[0]).toEqual(['prayer', 'chalice']);
    expect(state.discard).toEqual(['joker']);
  });

  it('copying Resurrection can bring Joker itself back', () => {
    const start = buildPosition({ hands: { 0: ['joker', 'resurrection'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'joker', copy: 'resurrection' });
    const { state } = respond(played.state, 0, { kind: 'choose-discard-card', card: 'joker' });
    expect(state.hands[0]).toEqual(['resurrection', 'joker']);
  });

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

  describe('played as HOT', () => {
    // S0 draws Invocation, which invokes the Joker on top of S2's pile.
    const invokedJoker = () => {
      const start = buildPosition({
        hands: { 0: ['requisition', 'chalice', 'hocus-pocus', 'shackles'] },
        piles: { 0: ['invocation'], 2: ['joker', 'dagger'] },
        turn: 0,
      });
      return respond(draw(start, 0).state, 0, { kind: 'choose-pile', pile: 2 }).state;
    };

    it('offers every non-Keep card in your hand to copy, and nothing else', () => {
      const state = invokedJoker();
      expect(promptFor(state, 0, 'joker-copy').options).toEqual(['requisition', 'hocus-pocus']);
      expect(legalCommands(state, 0).map((c) => c.type === 'answer' && c.answer)).toEqual([
        { kind: 'joker-copy', card: 'requisition' },
        { kind: 'joker-copy', card: 'hocus-pocus' },
      ]);
    });

    it('rejects copying a card it did not offer', () => {
      const state = invokedJoker();
      for (const card of ['chalice', 'shackles', 'joker', 'prayer'] as const) {
        expect(tryRespond(state, 0, { kind: 'joker-copy', card }).ok, card).toBe(false);
      }
    });

    it('copying Hocus Pocus: the invoked play is free and grants two actions; the copied card stays', () => {
      const { state, events } = respond(invokedJoker(), 0, { kind: 'joker-copy', card: 'hocus-pocus' });
      expect(frames(state)).toEqual(['S0:turn:1', 'S0:hocus-pocus:2']);
      expect(state.hands[0]).toEqual(['requisition', 'chalice', 'hocus-pocus', 'shackles']);
      expect(state.discard).toEqual(['invocation', 'joker']);
      expect(payloads(events, 'reveal-card')).toEqual([{ type: 'reveal-card', seat: 0, card: 'hocus-pocus' }]);
    });

    it('copying Requisition: you then make Requisition’s choices', () => {
      const copied = respond(invokedJoker(), 0, { kind: 'joker-copy', card: 'requisition' });
      expect(promptFor(copied.state, 0, 'choose-pile').options).toEqual([2]);
      const looked = respond(copied.state, 0, { kind: 'choose-pile', pile: 2 });
      const { state } = respond(looked.state, 0, { kind: 'choose-pile-card', index: 0 });
      expect(state.hands[0]).toEqual(['requisition', 'chalice', 'hocus-pocus', 'shackles', 'dagger']);
      expect(state.discard).toEqual(['invocation', 'joker']);
    });

    it('stolen with Legerdemain, it copies from the thief’s hand, not the victim’s', () => {
      const { stolen } = stealing({ hands: { 0: ['legerdemain', 'hocus-pocus'], 1: ['joker', 'prayer'] }, turn: 0 }, 1, 'joker');
      expect(promptFor(stolen.state, 0, 'joker-copy').options).toEqual(['hocus-pocus']);
    });
  });
});
