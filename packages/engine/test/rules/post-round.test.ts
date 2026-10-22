import { describe, expect, it } from 'vitest';
import { buildPosition } from '../../src/index.ts';
import { abilityNames, act, draw, hotTarget, lastLaughAfterEnding, payloads, respond, types } from '../helpers.ts';

// What may still happen after a round ends, before it is scored (C-02 to C-05).

describe('after the round ends', () => {
  it('C-02 no more actions happen except Last Laugh and what it triggers', () => {
    // Royal Favor into S1's keep: Interest's draw ends the round, so Royal Favor's own draw never happens.
    const start = buildPosition({
      piles: { 0: ['royal-favor'] },
      keeps: { 1: ['interest'], 2: ['last-laugh', 'retribution'] },
      hands: { 0: ['chalice', 'dagger'], 2: ['scepter'] },
      turn: 0,
    });
    const ended = hotTarget(draw(start, 0).state, 0, 1);
    expect(payloads(ended.events, 'trigger').map((t) => t.kind)).toEqual(['interest']);
    expect(payloads(ended.events, 'round-end')).toEqual([{ type: 'round-end', reason: 'empty-pile', ender: 1 }]);
    // Only S2's Last Laugh can act now. S0 still holds cards but gets no action.
    expect(ended.state.prompts.map((p) => [p.seat, p.kind])).toEqual([[2, 'action']]);
    // Last Laugh's action triggers Interest in S1's keep... S1's pile is empty, so nothing is drawn.
    const laugh = act(ended.state, 2, { action: 'play', card: 'scepter', target: 1 });
    expect(payloads(laugh.events, 'trigger').map((t) => t.kind)).toEqual(['interest']);
    expect(payloads(laugh.events, 'empty-draw')).toEqual([{ type: 'empty-draw', seat: 1, from: 1, afterRoundEnd: true }]);
    expect(laugh.state.phase).toBe('round-over');
  });

  it("C-02 Retribution triggered by Last Laugh's action still happens before scoring", () => {
    const start = buildPosition({
      keeps: { 0: ['last-laugh'], 1: ['retribution'] },
      hands: { 0: ['chalice'], 1: ['dagger'] },
      turn: 0,
    });
    const ended = draw(start, 0).state;
    const laugh = act(ended, 0, { action: 'play', card: 'chalice', target: 1 });
    expect(payloads(laugh.events, 'trigger').map((t) => t.kind)).toEqual(['retribution']);
    const one = act(laugh.state, 1, { action: 'play', card: 'dagger', target: 1 });
    const two = draw(one.state, 1);
    expect(payloads(two.events, 'score')[0]).toMatchObject({ scores: [0, 8, 0, 0], winner: 1 });
  });

  it('C-05 any number of draws from an empty pile after round end are legal and change nothing', () => {
    const ended = lastLaughAfterEnding([], ['hocus-pocus']);
    const hocus = act(ended, 0, { action: 'play', card: 'hocus-pocus' });
    const one = draw(hocus.state, 0);
    expect(payloads(one.events, 'empty-draw')).toEqual([{ type: 'empty-draw', seat: 0, from: 0, afterRoundEnd: true }]);
    expect(types(one.events)).not.toContain('round-end');
    const two = draw(one.state, 0);
    expect(types(two.events)).toEqual(['action', 'empty-draw', 'score', 'mark']);
  });

  it('C-04 completing the three Tokens after round end is a token victory; only that player gets a mark', () => {
    const start = buildPosition({
      keeps: { 0: ['last-laugh', 'count-token', 'fool-token'], 1: ['faberge-egg'] },
      hands: { 0: ['friar-token'] },
      turn: 0,
    });
    const ended = draw(start, 0).state;
    const { state, events } = act(ended, 0, { action: 'play', card: 'friar-token', target: 0 });
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'tokens', winner: 0 }]);
    expect(types(events)).not.toContain('score');
    expect(state.marks).toEqual([1, 0, 0, 0]);
  });
});

describe('post-round actions', () => {
  it('Interest still draws from a non-empty pile after the round ends', () => {
    const start = buildPosition({
      keeps: { 0: ['last-laugh'], 2: ['interest'] },
      hands: { 0: ['chalice'] },
      piles: { 2: ['dagger'] },
      turn: 0,
    });
    const ended = draw(start, 0).state;
    const { state } = act(ended, 0, { action: 'play', card: 'chalice', target: 2 });
    expect(state.hands[2]).toEqual(['dagger']);
    expect(state.phase).toBe('round-over');
  });

  it('Legerdemain as the Last Laugh action steals and plays a card before scoring', () => {
    const start = buildPosition({
      keeps: { 0: ['last-laugh'], 1: ['faberge-egg'] },
      hands: { 0: ['legerdemain'], 1: ['chalice'] },
      turn: 0,
    });
    const ended = draw(start, 0).state;
    const stolen = respond(act(ended, 0, { action: 'play', card: 'legerdemain' }).state, 0, { kind: 'choose-player', seat: 1 });
    const { events } = hotTarget(stolen.state, 0, 0);
    // S0 has 2 coins, S1 has 3: S1 still wins, but the Chalice counted.
    expect(payloads(events, 'score')[0]).toMatchObject({ scores: [4, 6, 0, 0], winner: 1 });
  });

  it('a HOT card drawn during the Last Laugh action is played before scoring', () => {
    const start = buildPosition({ keeps: { 2: ['last-laugh', 'sanction'] }, piles: { 2: ['blunder'] }, turn: 0, seats: ['player', 'ghost', 'player', 'ghost'] });
    const ended = draw(start, 0).state;
    // Sanction is restricted during Last Laugh, so S2 draws normally.
    expect(abilityNames(ended, 2)).toEqual([]);
    const { state, events } = draw(ended, 2);
    expect(state.keeps[2].map((c) => c.id)).toEqual(['last-laugh', 'sanction', 'blunder']);
    expect(payloads(events, 'score')[0]).toMatchObject({ scores: [0, null, -20, null], winner: 0 });
  });

  it('revealing in the last window before scoring can change the winner', () => {
    const start = buildPosition({
      keeps: { 0: ['duplicity', { id: 'faberge-egg', faceDown: { placedBy: 0 } }], 1: ['chalice'] },
      turn: 0,
    });
    const ended = draw(start, 0);
    const first = respond(ended.state, 0, { kind: 'reveal-window', reveal: false });
    const { events } = respond(first.state, 0, { kind: 'reveal-window', reveal: true });
    expect(payloads(events, 'score')[0]).toMatchObject({ scores: [6, 4, 0, 0], winner: 0 });
  });
});
