import { describe, expect, it } from 'vitest';
import { buildPosition, type TracePayload } from '../../src/index.ts';
import {
  abilityNames,
  act,
  actionsLeft,
  allEvents,
  draw,
  hotTarget,
  payloads,
  promptFor,
  respond,
  types,
} from '../helpers.ts';

type Trigger = Extract<TracePayload, { type: 'trigger' }>;
const triggerOrder = (events: Parameters<typeof payloads>[0]) =>
  payloads(events, 'trigger').map((t: Trigger) => `${t.kind}(S${t.seat})`);

describe('Interest', () => {
  it("makes the keep's owner draw when a Coin card enters it", () => {
    const start = buildPosition({
      hands: { 0: ['chalice'] },
      keeps: { 1: ['interest'] },
      piles: { 1: ['dagger', 'scepter'] },
      turn: 0,
    });
    const { state, events } = act(start, 0, { action: 'play', card: 'chalice', target: 1 });
    expect(state.hands[1]).toEqual(['dagger']);
    expect(types(events)).toEqual(['action', 'play', 'triggers', 'trigger', 'draw', 'prompt']);
    expect(payloads(events, 'triggers')).toEqual([
      { type: 'triggers', card: 'chalice', triggers: [{ kind: 'interest', seat: 1 }] },
    ]);
    // S0's turn continues afterward.
    expect(actionsLeft(state)).toBe(1);
    promptFor(state, 0, 'action');
  });

  it('triggers on your own Coin cards too', () => {
    const start = buildPosition({ hands: { 0: ['chalice'] }, keeps: { 0: ['interest'] }, piles: { 0: ['dagger'] }, turn: 0 });
    expect(act(start, 0, { action: 'play', card: 'chalice', target: 0 }).state.hands[0]).toEqual(['dagger']);
  });

  it('ignores cards that are not Coin cards, including Purity', () => {
    const start = buildPosition({
      hands: { 0: ['purity', 'retribution'] },
      keeps: { 1: ['interest'] },
      piles: { 1: ['dagger'] },
      turn: 0,
    });
    const one = act(start, 0, { action: 'play', card: 'purity', target: 1 });
    const two = act(one.state, 0, { action: 'play', card: 'retribution', target: 1 });
    expect(types(allEvents(one, two))).not.toContain('trigger');
  });

  it('does not trigger for Coin cards already in the keep when Interest arrives', () => {
    const start = buildPosition({ hands: { 0: ['interest'] }, keeps: { 1: ['chalice'] }, piles: { 1: ['dagger'] }, turn: 0 });
    const { events } = act(start, 0, { action: 'play', card: 'interest', target: 1 });
    expect(types(events)).not.toContain('trigger');
  });

  it('ends the round if the owner must draw from an empty pile, making them the ender', () => {
    // This Looks Familiar: the opponent draws to end it, so a tie goes to S0.
    const start = buildPosition({
      hands: { 0: ['fool-token'] },
      keeps: { 0: ['chalice'], 2: ['interest', 'faberge-egg'] },
      turn: 0,
    });
    const { events } = act(start, 0, { action: 'play', card: 'fool-token', target: 2 });
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'empty-pile', ender: 2 }]);
    // S0 and S2 tie at 2 coins. S2 drew to end it, so the tie goes to the first
    // tied player left of S2 (checking S3, then S0).
    expect(payloads(events, 'score')[0]).toMatchObject({ scores: [4, 0, 4, 0], winner: 0 });
  });

  it('C-21 does not trigger when Providence swaps Interest itself with a Coin card', () => {
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 1: ['interest'], 2: ['chalice'] },
      piles: { 1: ['dagger'], 2: ['scepter'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const { state, events } = respond(played.state, 0, {
      kind: 'choose-keep-pair', a: { seat: 1, index: 0 }, b: { seat: 2, index: 0 },
    });
    expect(state.keeps[1]).toEqual([{ id: 'chalice' }]);
    expect(state.keeps[2]).toEqual([{ id: 'interest' }]);
    expect(types(events)).not.toContain('trigger');
  });

  it('C-21 does trigger when Providence swaps a Coin card into a keep that keeps its Interest (Tokens 3)', () => {
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 1: ['interest', 'juggling'], 0: ['scepter'] },
      piles: { 1: ['count-token'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const { state } = respond(played.state, 0, {
      kind: 'choose-keep-pair', a: { seat: 0, index: 0 }, b: { seat: 1, index: 1 },
    });
    expect(state.keeps[1]).toEqual([{ id: 'interest' }, { id: 'scepter' }]);
    expect(state.hands[1]).toEqual(['count-token']);
  });
});

describe('Royal Favor', () => {
  it("makes the receiving keep's owner draw", () => {
    const start = buildPosition({ piles: { 0: ['royal-favor'], 2: ['chalice'] }, turn: 0 });
    const placed = hotTarget(draw(start, 0).state, 0, 2);
    expect(placed.state.keeps[2]).toEqual([{ id: 'royal-favor' }]);
    expect(placed.state.hands[2]).toEqual(['chalice']);
    expect(triggerOrder(placed.events)).toEqual(['royal-favor(S2)']);
    expect(actionsLeft(placed.state)).toBe(1);
  });

  it("ends the round when the receiver's pile is empty (Royal Favor 1)", () => {
    const start = buildPosition({ piles: { 0: ['royal-favor'] }, keeps: { 0: ['chalice'] }, turn: 0 });
    const { state, events } = hotTarget(draw(start, 0).state, 0, 3);
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'empty-pile', ender: 3 }]);
    expect(state.marks).toEqual([1, 0, 0, 0]);
  });

  it('Q-14 triggers when it enters a keep through a Providence swap', () => {
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 1: ['royal-favor'], 3: ['chalice'] },
      piles: { 3: ['dagger'], 1: ['scepter'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const { state, events } = respond(played.state, 0, {
      kind: 'choose-keep-pair', a: { seat: 1, index: 0 }, b: { seat: 3, index: 0 },
    });
    expect(triggerOrder(events)).toEqual(['royal-favor(S3)']);
    expect(state.hands[3]).toEqual(['dagger']);
    expect(state.hands[1]).toEqual([]);
  });

  it('does not trigger when swapped within the same keep', () => {
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 1: ['royal-favor', 'chalice'] },
      piles: { 1: ['scepter'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const { events } = respond(played.state, 0, {
      kind: 'choose-keep-pair', a: { seat: 1, index: 0 }, b: { seat: 1, index: 1 },
    });
    expect(types(events)).not.toContain('trigger');
  });
});

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

  it("C-33 the owner's Retribution actions can't use Acquisition, Sanction, or Juggling", () => {
    const start = buildPosition({
      hands: { 0: ['chalice'], 1: ['dagger'] },
      keeps: { 1: ['retribution', 'sanction', 'juggling', 'acquisition', 'tithes'] },
      turn: 0,
    });
    const { state } = act(start, 0, { action: 'play', card: 'chalice', target: 1 });
    promptFor(state, 1, 'action');
    expect(abilityNames(state, 1)).toEqual(['tithes']);
  });

  it("the owner's actions can end the round", () => {
    const start = buildPosition({ hands: { 0: ['chalice'] }, keeps: { 1: ['retribution'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'chalice', target: 1 });
    const { events } = draw(played.state, 1);
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'empty-pile', ender: 1 }]);
  });
});

describe('trigger order', () => {
  it('C-01 simultaneous triggers resolve as Retribution, then Interest, then Royal Favor', () => {
    const start = buildPosition({
      piles: { 0: ['royal-favor'], 1: ['dagger', 'scepter', 'medallion', 'timepiece'] },
      keeps: { 1: ['interest', 'retribution'] },
      turn: 0,
    });
    const placed = hotTarget(draw(start, 0).state, 0, 1);
    expect(payloads(placed.events, 'triggers')).toEqual([
      {
        type: 'triggers',
        card: 'royal-favor',
        triggers: [
          { kind: 'retribution', seat: 1 },
          { kind: 'interest', seat: 1 },
          { kind: 'royal-favor', seat: 1 },
        ],
      },
    ]);
    // Retribution first: S1 must act before Interest's draw happens.
    expect(triggerOrder(placed.events)).toEqual(['retribution(S1)']);
    expect(placed.state.hands[1]).toEqual([]);

    const first = draw(placed.state, 1);
    const second = draw(first.state, 1);
    expect(triggerOrder(second.events)).toEqual(['interest(S1)', 'royal-favor(S1)']);
    expect(second.state.hands[1]).toEqual(['dagger', 'scepter', 'medallion', 'timepiece']);
    expect(second.state.turn?.seat).toBe(0);
  });

  it('Q-02 triggers caused while resolving a trigger come before its remaining siblings', () => {
    // Royal Favor into S1 (Interest): Interest draws Blunder, Blunder's Interest
    // draws Chalice, and only then does Royal Favor's own draw happen.
    const start = buildPosition({
      piles: { 0: ['royal-favor'], 1: ['blunder', 'chalice', 'dagger'] },
      keeps: { 1: ['interest'] },
      turn: 0,
    });
    const { state, events } = hotTarget(draw(start, 0).state, 0, 1);
    expect(triggerOrder(events)).toEqual(['interest(S1)', 'interest(S1)', 'royal-favor(S1)']);
    expect(state.keeps[1]).toEqual([{ id: 'interest' }, { id: 'royal-favor' }, { id: 'blunder' }]);
    expect(state.hands[1]).toEqual(['chalice', 'dagger']);
  });

  it('a round end during the chain cancels the remaining triggers (Royal Favor 3)', () => {
    const start = buildPosition({
      piles: { 0: ['royal-favor'], 1: ['blunder'] },
      keeps: { 1: ['interest'], 0: ['chalice'] },
      turn: 0,
    });
    const { state, events } = hotTarget(draw(start, 0).state, 0, 1);
    expect(triggerOrder(events)).toEqual(['interest(S1)', 'interest(S1)']);
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'empty-pile', ender: 1 }]);
    expect(state.phase).toBe('round-over');
  });
});
