import { describe, expect, it } from 'vitest';
import { buildPosition, type CardId, type GameState } from '../../src/index.ts';
import { abilityNames, act, actionChoices, draw, hotTarget, payloads, promptFor, types } from '../helpers.ts';

/** S0 (Last Laugh, plus `keep`) ends the round on their first action; returns the post-round state. */
function lastLaughAfterEnding(keep: CardId[], hand: CardId[] = []): GameState {
  const start = buildPosition({ keeps: { 0: ['last-laugh', ...keep] }, hands: { 0: hand }, turn: 0 });
  const { state } = draw(start, 0);
  expect(state.phase).toBe('post-round');
  return state;
}

describe('Last Laugh', () => {
  it('gives its owner one action after the round ends, right before scoring (Last Laugh 1)', () => {
    const start = buildPosition({
      keeps: { 0: ['last-laugh'], 1: ['faberge-egg'] },
      hands: { 0: ['chalice', 'dagger'] },
      turn: 0,
    });
    const one = act(start, 0, { action: 'play', card: 'chalice', target: 0 });
    const ended = draw(one.state, 0);
    expect(types(ended.events)).toEqual(['action', 'empty-draw', 'round-end', 'last-laugh', 'prompt']);
    expect(ended.state.stack.at(-1)).toMatchObject({ op: 'action-frame', seat: 0, kind: 'last-laugh', remaining: 1, restricted: true });

    const { state, events } = act(ended.state, 0, { action: 'play', card: 'dagger', target: 0 });
    expect(payloads(events, 'score')).toEqual([{ type: 'score', scores: [8, 6, 0, 0], winner: 0, tiedWith: [] }]);
    expect(state.phase).toBe('round-over');
  });

  it('is optional: its owner may pass', () => {
    const ended = lastLaughAfterEnding([]);
    expect(actionChoices(ended, 0)).toContainEqual({ action: 'pass' });
    const { state, events } = act(ended, 0, { action: 'pass' });
    expect(types(events)).toEqual(['action', 'score', 'mark']);
    expect(state.phase).toBe('round-over');
  });

  it('works for whoever owns it, not just the player who ended the round', () => {
    const start = buildPosition({ keeps: { 2: ['last-laugh'] }, hands: { 2: ['chalice'] }, turn: 0 });
    const { state } = draw(start, 0);
    promptFor(state, 2, 'action');
    expect(act(state, 2, { action: 'play', card: 'chalice', target: 2 }).state.marks).toEqual([0, 0, 1, 0]);
  });

  it("C-23 Last Laugh's action can't use Acquisition, Sanction, or Juggling", () => {
    const ended = lastLaughAfterEnding(['acquisition', 'sanction', 'juggling', 'tithes'], ['chalice']);
    // It is still S0's turn, so only the restriction stops these.
    expect(ended.turn?.seat).toBe(0);
    expect(abilityNames(ended, 0)).toEqual(['tithes']);
  });

  it('can use Tithes, whose discard can make Purity count (Purity 3)', () => {
    const ended = lastLaughAfterEnding(['purity', 'tithes', 'chalice']);
    const { events } = act(ended, 0, { action: 'ability', card: 'tithes' });
    expect(payloads(events, 'score')[0]).toMatchObject({ winner: 0, scores: [20, 0, 0, 0] });
  });

  it('Hocus Pocus during Last Laugh grants two more restricted actions (Last Laugh 3)', () => {
    const ended = lastLaughAfterEnding(['sanction'], ['hocus-pocus', 'chalice', 'dagger']);
    const hocus = act(ended, 0, { action: 'play', card: 'hocus-pocus' });
    expect(hocus.state.stack.at(-1)).toMatchObject({ kind: 'hocus-pocus', remaining: 2, restricted: true });
    expect(abilityNames(hocus.state, 0)).toEqual([]);
    const one = act(hocus.state, 0, { action: 'play', card: 'chalice', target: 0 });
    const two = act(one.state, 0, { action: 'play', card: 'dagger', target: 0 });
    expect(payloads(two.events, 'score')[0]).toMatchObject({ scores: [8, 0, 0, 0] });
  });
});

describe('restricted actions (Retribution and Last Laugh)', () => {
  const ability = (card: 'acquisition' | 'sanction' | 'juggling') => {
    // Before the round ends, on S0's own turn, the ability is available.
    const live = buildPosition({ keeps: { 0: ['last-laugh', card] }, hands: { 0: ['chalice'] }, turn: 0 });
    expect(abilityNames(live, 0)).toContain(card);
    // During Last Laugh's action it is not.
    const ended = lastLaughAfterEnding([card], ['chalice']);
    expect(abilityNames(ended, 0)).not.toContain(card);
    // Nor during Retribution's actions.
    const struck = buildPosition({ keeps: { 1: ['retribution', card] }, hands: { 0: ['dagger'], 1: ['chalice'] }, turn: 0 });
    const { state } = act(struck, 0, { action: 'play', card: 'dagger', target: 1 });
    promptFor(state, 1, 'action');
    expect(abilityNames(state, 1)).not.toContain(card);
  };

  it("C-07 Acquisition can't be used with Retribution or Last Laugh actions", () => ability('acquisition'));
  it("C-34 Sanction can't be used with Retribution or Last Laugh actions", () => ability('sanction'));
  it("C-35 Juggling can't be used with Retribution or Last Laugh actions", () => ability('juggling'));
});

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

describe('token victory', () => {
  it('C-09 is instant and total: no Last Laugh, no Retribution, and the next round begins', () => {
    const start = buildPosition({
      keeps: { 1: ['count-token', 'fool-token', 'retribution', 'last-laugh'] },
      hands: { 0: ['friar-token'] },
      turn: 0,
    });
    const { state, events } = act(start, 0, { action: 'play', card: 'friar-token', target: 1 });
    expect(types(events)).toEqual(['action', 'play', 'round-end', 'mark']);
    expect(state.marks).toEqual([0, 1, 0, 0]);
    expect(state.phase).toBe('round-over');
  });

  it('C-22 Last Laugh does not trigger when the round ends by token victory', () => {
    const start = buildPosition({
      keeps: { 0: ['count-token', 'fool-token'], 2: ['last-laugh'] },
      hands: { 0: ['friar-token'], 2: ['faberge-egg'] },
      turn: 0,
    });
    const { state, events } = act(start, 0, { action: 'play', card: 'friar-token', target: 0 });
    expect(types(events)).not.toContain('last-laugh');
    expect(state.prompts).toEqual([]);
  });
});
