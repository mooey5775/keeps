import { describe, expect, it } from 'vitest';
import { buildPosition, eventsFor } from '../../src/index.ts';
import {
  act,
  actionChoices,
  actionsLeft,
  allEvents,
  draw,
  hotTarget,
  payloads,
  pileIds,
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
});

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
});

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
});

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
});

describe('Invocation', () => {
  it('K-01 drawing Invocation, and the card it then draws and plays, cost no actions', () => {
    const start = buildPosition({ piles: { 0: ['invocation'], 2: ['chalice'] }, turn: 0 });
    const drawn = draw(start, 0);
    expect(promptFor(drawn.state, 0, 'choose-pile').options).toEqual([0, 1, 2, 3]);
    const invoked = respond(drawn.state, 0, { kind: 'choose-pile', pile: 2 });
    const placed = hotTarget(invoked.state, 0, 0);
    expect(placed.state.keeps[0]).toEqual([{ id: 'chalice' }]);
    expect(actionsLeft(placed.state)).toBe(1);
  });

  it('K-01 the whole Resurrection 3 chain is free: Joker-as-Resurrection takes Invocation, which invokes Hocus Pocus', () => {
    const start = buildPosition({
      hands: { 0: ['joker', 'resurrection'] },
      discard: ['invocation'],
      piles: { 2: ['hocus-pocus'] },
      turn: 0,
    });
    const joker = act(start, 0, { action: 'play', card: 'joker', copy: 'resurrection' });
    expect(joker.state.hands[0]).toEqual(['resurrection']);
    const taken = respond(joker.state, 0, { kind: 'choose-discard-card', card: 'invocation' });
    const invoked = respond(taken.state, 0, { kind: 'choose-pile', pile: 2 });
    // Joker cost one action; Invocation and Hocus Pocus cost none; Hocus Pocus gave two.
    const frames = invoked.state.stack.flatMap((op) => (op.op === 'action-frame' ? [op.remaining] : []));
    expect(frames).toEqual([1, 2]);
    expect(invoked.state.discard).toEqual(['joker', 'invocation', 'hocus-pocus']);
  });

  it('invoking from an empty pile ends the round (Resurrection 3)', () => {
    const start = buildPosition({ piles: { 0: ['invocation'] }, turn: 0 });
    const { events } = respond(draw(start, 0).state, 0, { kind: 'choose-pile', pile: 3 });
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'empty-pile', ender: 0 }]);
  });
});

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
});

describe('Fiat', () => {
  it('C-19 only real players claim piles, in play order from the Fiat player; the ghost gets the last one', () => {
    const start = buildPosition({
      seats: ['player', 'ghost', 'player', 'player'],
      piles: { 0: ['chalice'], 1: ['dagger'], 2: ['fiat', 'scepter'], 3: ['medallion'] },
      turn: 2,
    });
    const placed = hotTarget(draw(start, 2).state, 2, 2);
    expect(payloads(placed.events, 'piles-to-center')).toHaveLength(1);
    let state = placed.state;
    const order: number[] = [];
    for (const [seat, from] of [[2, 0], [3, 2], [0, 1]] as const) {
      const prompt = promptFor(state, seat, 'claim-pile');
      order.push(prompt.claimant);
      state = respond(state, seat, { kind: 'claim-pile', from }).state;
    }
    expect(order).toEqual([2, 3, 0]);
    // Piles named by where they were: S2 took @S0's, S3 took @S2's, S0 took @S1's; ghost S1 gets @S3's.
    expect([0, 1, 2, 3].map((s) => pileIds(state, s as 0)[0])).toEqual(['dagger', 'medallion', 'chalice', 'scepter']);
    expect(actionsLeft(state)).toBe(1);
  });

  it("C-20 two players: after both claim, Fiat's player places the two remaining piles", () => {
    const start = buildPosition({
      seats: ['player', 'ghost', 'player', 'ghost'],
      piles: { 0: ['fiat', 'chalice'], 1: ['dagger'], 2: ['scepter'], 3: ['medallion'] },
      turn: 0,
    });
    let state = hotTarget(draw(start, 0).state, 0, 0).state;
    state = respond(state, 0, { kind: 'claim-pile', from: 2 }).state;
    state = respond(state, 2, { kind: 'claim-pile', from: 0 }).state;
    const placing = promptFor(state, 0, 'claim-pile');
    expect(placing.claimant).toBe(1);
    expect(placing.options).toEqual([1, 3]);
    state = respond(state, 0, { kind: 'claim-pile', from: 3 }).state;
    expect([0, 1, 2, 3].map((s) => pileIds(state, s as 0)[0])).toEqual(['scepter', 'medallion', 'chalice', 'dagger']);
  });

  it('Q-01 its effect happens when played; afterward it sits in the keep doing nothing', () => {
    const start = buildPosition({
      piles: { 0: ['fiat', 'chalice'] },
      hands: { 0: ['providence'] },
      keeps: { 2: ['dagger'] },
      turn: 0,
    });
    let state = hotTarget(draw(start, 0).state, 0, 1).state;
    for (const seat of [0, 1, 2, 3] as const) {
      const from = promptFor(state, seat, 'claim-pile').options[0]!;
      state = respond(state, seat, { kind: 'claim-pile', from }).state;
    }
    expect(state.keeps[1]).toEqual([{ id: 'fiat' }]);
    // Moving Fiat with Providence doesn't redistribute the piles again.
    const played = act(state, 0, { action: 'play', card: 'providence' });
    const swapped = respond(played.state, 0, { kind: 'choose-keep-pair', a: { seat: 1, index: 0 }, b: { seat: 2, index: 0 } });
    expect(types(swapped.events)).not.toContain('piles-to-center');
    expect(swapped.state.keeps[2]).toEqual([{ id: 'fiat' }]);
  });
});
