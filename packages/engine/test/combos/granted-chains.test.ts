import { describe, expect, it } from 'vitest';
import { buildPosition, viewFor, type GameState } from '../../src/index.ts';
import { act, draw, frames, hotTarget, payloads, promptFor, respond } from '../helpers.ts';

// Ruling Q-17 in deeper chains, and trigger ordering across seats.


describe('Q-17 in deeper chains', () => {
  it('an invoked Legerdemain stealing Hocus Pocus: the Retribution still comes first', () => {
    const start = buildPosition({
      hands: { 1: ['hocus-pocus'] },
      keeps: { 1: ['retribution'] },
      piles: { 0: ['invocation'], 2: ['legerdemain'], 1: ['chalice', 'dagger'] },
      turn: 0,
    });
    const drawn = draw(start, 0);
    const invoked = respond(drawn.state, 0, { kind: 'choose-pile', pile: 2 });
    const stolen = respond(invoked.state, 0, { kind: 'choose-player', seat: 1 });
    expect(frames(stolen.state)).toEqual(['S0:turn:1', 'S0:hocus-pocus:2', 'S1:retribution:2!']);
    promptFor(stolen.state, 1, 'action');
  });

  it('Joker copying Legerdemain to steal Hocus Pocus behaves the same', () => {
    const start = buildPosition({
      hands: { 0: ['joker', 'legerdemain'], 1: ['hocus-pocus'] },
      keeps: { 1: ['retribution'] },
      piles: { 1: ['chalice', 'dagger'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'joker', copy: 'legerdemain' });
    const stolen = respond(played.state, 0, { kind: 'choose-player', seat: 1 });
    expect(frames(stolen.state)).toEqual(['S0:turn:1', 'S0:hocus-pocus:2', 'S1:retribution:2!']);
  });

  it('as the Last Laugh action: Retribution first, then the stolen actions, still restricted', () => {
    const start = buildPosition({
      keeps: { 0: ['last-laugh', 'sanction'], 1: ['retribution'] },
      hands: { 0: ['legerdemain'], 1: ['hocus-pocus'] },
      piles: { 1: ['chalice', 'dagger'] },
      turn: 0,
    });
    const ended = draw(start, 0).state;
    const stolen = respond(act(ended, 0, { action: 'play', card: 'legerdemain' }).state, 0, { kind: 'choose-player', seat: 1 });
    // The spent Last Laugh frame stays until it's popped, below the stolen actions.
    expect(frames(stolen.state)).toEqual(['S0:last-laugh:0!', 'S0:hocus-pocus:2!', 'S1:retribution:2!']);
    const retaliated = draw(draw(stolen.state, 1).state, 1).state;
    promptFor(retaliated, 0, 'action');
    expect(retaliated.phase).toBe('post-round');
  });

  it('if the Retribution actions end the round, the stolen actions are never taken', () => {
    const start = buildPosition({
      keeps: { 1: ['retribution', 'faberge-egg'] },
      hands: { 0: ['legerdemain'], 1: ['hocus-pocus'] },
      turn: 0,
    });
    const stolen = respond(act(start, 0, { action: 'play', card: 'legerdemain' }).state, 0, { kind: 'choose-player', seat: 1 });
    const { state, events } = draw(stolen.state, 1); // S1's pile is empty
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'empty-pile', ender: 1 }]);
    expect(state.phase).toBe('round-over');
    expect(state.stack).toEqual([]);
  });

  it('if the Retribution actions win by Tokens, the stolen actions are never taken', () => {
    // Legerdemain picks at random; find a seed where it steals Hocus Pocus rather than the Friar Token.
    let state: GameState | null = null;
    for (let seed = 0; seed < 50 && !state; seed++) {
      const candidate = buildPosition({
        keeps: { 1: ['retribution', 'count-token', 'fool-token'] },
        hands: { 0: ['legerdemain'], 1: ['hocus-pocus', 'friar-token'] },
        turn: 0,
        seed,
      });
      const stolen = respond(act(candidate, 0, { action: 'play', card: 'legerdemain' }).state, 0, { kind: 'choose-player', seat: 1 });
      if (payloads(stolen.events, 'steal')[0]?.cards?.[0] === 'hocus-pocus') state = stolen.state;
    }
    if (!state) throw new Error('no seed steals Hocus Pocus');
    expect(state.hands[1]).toEqual(['friar-token']);
    const won = act(state, 1, { action: 'play', card: 'friar-token', target: 1 });
    expect(payloads(won.events, 'round-end')).toEqual([{ type: 'round-end', reason: 'tokens', winner: 1 }]);
    expect(won.state.stack).toEqual([]);
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

describe('views of action frames', () => {
  it('everyone can see whose frame is active and what kind it is', () => {
    const start = buildPosition({ hands: { 0: ['chalice'] }, keeps: { 1: ['retribution'] }, piles: { 1: ['dagger'] }, turn: 0 });
    const { state } = act(start, 0, { action: 'play', card: 'chalice', target: 1 });
    for (const viewer of [0, 1, 2, 'spectator'] as const) {
      expect(viewFor(state, viewer).frame).toEqual({ seat: 1, kind: 'retribution', remaining: 2 });
    }
  });
});
