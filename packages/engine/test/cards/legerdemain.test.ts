import { describe, expect, it } from 'vitest';
import { buildPosition, eventsFor } from '../../src/index.ts';
import {
  act,
  actionsLeft,
  allEvents,
  draw,
  hotTarget,
  payloads,
  promptFor,
  respond,
  stealing,
  types,
} from '../helpers.ts';

describe('Legerdemain', () => {
  it('K-02 the stolen card is played as if HOT, using no action beyond Legerdemain itself', () => {
    const start = buildPosition({ hands: { 0: ['legerdemain'], 1: ['chalice'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'legerdemain' });
    expect(promptFor(played.state, 0, 'choose-player').options).toEqual([0, 1, 2, 3]);
    const stolen = respond(played.state, 0, { kind: 'choose-player', seat: 1 });
    expect(payloads(stolen.events, 'steal')).toEqual([{ type: 'steal', seat: 0, from: 1, cards: ['chalice'], count: 1 }]);
    const placed = hotTarget(stolen.state, 0, 0);
    expect(placed.state.keeps[0]).toEqual([{ id: 'chalice' }]);
    expect(actionsLeft(placed.state)).toBe(1);
  });

  it('K-02 a stolen Hocus Pocus is free, so its two actions are a pure gain', () => {
    const start = buildPosition({ hands: { 0: ['legerdemain'], 1: ['hocus-pocus'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'legerdemain' });
    const { state } = respond(played.state, 0, { kind: 'choose-player', seat: 1 });
    // Turn frame: 1 left; Hocus Pocus: 2 more.
    expect(actionsLeft(state)).toBe(2);
    expect(state.stack.filter((op) => op.op === 'action-frame').map((op) => op.op === 'action-frame' && op.remaining)).toEqual([1, 2]);
  });

  it('C-25 may target yourself, but the card is still chosen at random', () => {
    const stolenCards = new Set<string>();
    for (let seed = 0; seed < 30; seed++) {
      const start = buildPosition({ hands: { 0: ['legerdemain', 'chalice', 'dagger', 'medallion'] }, turn: 0, seed });
      const played = act(start, 0, { action: 'play', card: 'legerdemain' });
      const stolen = respond(played.state, 0, { kind: 'choose-player', seat: 0 });
      // No prompt to pick the card: it goes straight to choosing a keep for it.
      promptFor(stolen.state, 0, 'hot-target');
      stolenCards.add(payloads(stolen.events, 'steal')[0]!.cards![0]!);
    }
    expect([...stolenCards].sort()).toEqual(['chalice', 'dagger', 'medallion']);
  });

  it('C-26 may target a ghost, which has no cards to steal', () => {
    const start = buildPosition({ seats: ['player', 'ghost', 'player', 'ghost'], hands: { 0: ['legerdemain'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'legerdemain' });
    expect(promptFor(played.state, 0, 'choose-player').options).toEqual([0, 1, 2, 3]);
    const { state, events } = respond(played.state, 0, { kind: 'choose-player', seat: 1 });
    expect(payloads(events, 'no-effect')).toHaveLength(1);
    expect(actionsLeft(state)).toBe(1);
  });

  it('C-27 stealing from a Retribution owner: the stolen card is played first, then Retribution', () => {
    const { stolen } = stealing(
      { hands: { 0: ['legerdemain'], 1: ['chalice', 'dagger'] }, keeps: { 1: ['retribution'] }, piles: { 1: ['scepter', 'medallion'] }, turn: 0 },
      1,
      'chalice',
    );
    const placed = hotTarget(stolen.state, 0, 0);
    // The stolen Chalice went into S0's own keep, so only the theft affected S1: one trigger,
    // which comes after the stolen card is played.
    const sequence = types(allEvents(stolen, placed));
    expect(sequence.indexOf('play')).toBeLessThan(sequence.indexOf('trigger'));
    expect(payloads(placed.events, 'trigger').map((t) => t.kind)).toEqual(['retribution']);
    expect(placed.state.stack.at(-1)).toMatchObject({ op: 'action-frame', seat: 1, kind: 'retribution', remaining: 2 });
  });

  it('C-27 if the stolen card also affects that player (Offering), Retribution triggers twice: four actions', () => {
    const { stolen } = stealing(
      {
        hands: { 0: ['legerdemain'], 1: ['offering', 'chalice'] },
        keeps: { 1: ['retribution'] },
        piles: { 1: ['scepter', 'medallion', 'timepiece', 'faberge-egg'] },
        turn: 0,
      },
      1,
      'offering',
    );
    // Offering (played as HOT by S0) makes S1 give a card.
    expect(payloads(stolen.events, 'play').map((p) => p.card)).toEqual(['offering']);
    const given = respond(stolen.state, 1, { kind: 'give-card', card: 'chalice' });
    expect(given.state.hands[0]).toEqual(['chalice']);
    expect(payloads(given.events, 'triggers').map((t) => t.card)).toEqual(['offering']);

    let state = given.state;
    const triggers: string[] = payloads(given.events, 'trigger').map((t) => t.kind);
    for (let i = 0; i < 4; i++) {
      expect(state.stack.at(-1)).toMatchObject({ op: 'action-frame', seat: 1, kind: 'retribution' });
      const step = draw(state, 1);
      triggers.push(...payloads(step.events, 'trigger').map((t) => t.kind));
      state = step.state;
    }
    expect(triggers).toEqual(['retribution', 'retribution']);
    expect(state.hands[1]).toEqual(['scepter', 'medallion', 'timepiece', 'faberge-egg']);
    // Back to S0's last action.
    expect(state.turn?.seat).toBe(0);
    expect(actionsLeft(state)).toBe(1);
  });

  it("C-01 Legerdemain's stolen card resolves before any Retribution or Interest", () => {
    const { stolen } = stealing(
      { hands: { 0: ['legerdemain'], 1: ['chalice', 'dagger'] }, keeps: { 1: ['retribution', 'interest'] }, piles: { 1: ['scepter', 'medallion', 'timepiece'] }, turn: 0 },
      1,
      'chalice',
    );
    // S0 plays the stolen Chalice back into S1's keep.
    const placed = hotTarget(stolen.state, 0, 1);
    const order = allEvents(stolen, placed)
      .map((e) => e.payload)
      .flatMap((p) => (p.type === 'play' ? [`play:${p.card}`] : p.type === 'triggers' ? [`after:${p.card}`] : []));
    // Legerdemain's own after-play (another Retribution) waits until S1's first two actions are done.
    expect(order).toEqual(['play:chalice', 'after:chalice']);
    expect(payloads(placed.events, 'triggers')[0]!.triggers).toEqual([
      { kind: 'retribution', seat: 1 },
      { kind: 'interest', seat: 1 },
    ]);
  });

  it('a stolen Keep card can be played into any keep, including the victim\'s', () => {
    const start = buildPosition({ hands: { 0: ['legerdemain'], 2: ['chalice'] }, turn: 0 });
    const stolen = respond(act(start, 0, { action: 'play', card: 'legerdemain' }).state, 0, { kind: 'choose-player', seat: 2 });
    expect(promptFor(stolen.state, 0, 'hot-target').card).toBe('chalice');
    const { state } = hotTarget(stolen.state, 0, 2);
    expect(state.keeps[2]).toEqual([{ id: 'chalice' }]);
  });

  it('the theft is public, since the card is then played face up', () => {
    const start = buildPosition({ hands: { 0: ['legerdemain'], 2: ['chalice'] }, turn: 0 });
    const stolen = respond(act(start, 0, { action: 'play', card: 'legerdemain' }).state, 0, { kind: 'choose-player', seat: 2 });
    expect(payloads(eventsFor(stolen.events, 3), 'steal')[0]!.cards).toEqual(['chalice']);
  });

  it('on an empty-handed player it does nothing', () => {
    const start = buildPosition({ hands: { 0: ['legerdemain'] }, turn: 0 });
    const { events } = respond(act(start, 0, { action: 'play', card: 'legerdemain' }).state, 0, { kind: 'choose-player', seat: 2 });
    expect(payloads(events, 'no-effect')).toHaveLength(1);
  });
});
