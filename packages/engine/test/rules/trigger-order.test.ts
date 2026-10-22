import { describe, expect, it } from 'vitest';
import { buildPosition } from '../../src/index.ts';
import { act, draw, hotTarget, payloads, promptFor, respond, triggerOrder } from '../helpers.ts';

// The order simultaneous triggers resolve in (C-01, Q-02).

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

describe('trigger order across seats', () => {
  it('one Providence swap: Retribution (one seat), then Interest and Royal Favor (another)', () => {
    // Royal Favor leaves S1's keep (S1 has Retribution) for S2's keep (S2 has Interest).
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 1: ['retribution', 'royal-favor'], 2: ['interest', 'chalice'] },
      piles: { 1: ['dagger', 'scepter'], 2: ['medallion', 'timepiece'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const { state, events } = respond(played.state, 0, { kind: 'choose-keep-pair', a: { seat: 1, index: 1 }, b: { seat: 2, index: 1 } });
    // Chalice enters S1's keep (no Interest there); Royal Favor enters S2's keep (Interest).
    expect(payloads(events, 'triggers')[0]!.triggers).toEqual([
      { kind: 'retribution', seat: 1 },
      { kind: 'interest', seat: 2 },
      { kind: 'royal-favor', seat: 2 },
    ]);
    // S1 retaliates before S2 draws anything.
    promptFor(state, 1, 'action');
    expect(state.hands[2]).toEqual([]);
  });

  it("depth-first: triggers caused during Retribution actions resolve before the original play's remaining triggers", () => {
    // Royal Favor into S1's keep (Interest + Retribution) queues retribution, interest, royal-favor for S1.
    // During its Retribution, S1 plays Timepiece into its own keep: that new Interest draw happens at
    // once, before the Interest and Royal Favor draws still waiting from the original play.
    const start = buildPosition({
      piles: { 0: ['royal-favor'], 1: ['dagger', 'scepter', 'medallion', 'faberge-egg'] },
      hands: { 1: ['timepiece'] },
      keeps: { 1: ['retribution', 'interest'] },
      turn: 0,
    });
    const placed = hotTarget(draw(start, 0).state, 0, 1);
    expect(payloads(placed.events, 'triggers')[0]!.triggers.map((t) => `${t.kind}:${t.seat}`)).toEqual([
      'retribution:1',
      'interest:1',
      'royal-favor:1',
    ]);
    const own = act(placed.state, 1, { action: 'play', card: 'timepiece', target: 1 });
    expect(own.state.hands[1]).toEqual(['dagger']);
    // Second Retribution action, then the original Interest and Royal Favor draws, in that order.
    const done = draw(own.state, 1);
    expect(done.state.hands[1]).toEqual(['dagger', 'scepter', 'medallion', 'faberge-egg']);
    expect(payloads(done.events, 'trigger').map((t) => `${t.kind}:${t.seat}`)).toEqual(['interest:1', 'royal-favor:1']);
  });
});
