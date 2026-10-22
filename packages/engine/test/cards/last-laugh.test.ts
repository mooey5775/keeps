import { describe, expect, it } from 'vitest';
import { buildPosition } from '../../src/index.ts';
import {
  abilityNames,
  act,
  actionChoices,
  draw,
  hotTarget,
  lastLaughAfterEnding,
  payloads,
  promptFor,
  respond,
  types,
} from '../helpers.ts';

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

  it('in the keep of a player who is behind, can still turn the round (Last Laugh 2)', () => {
    const start = buildPosition({
      keeps: { 0: ['last-laugh', 'chalice'], 1: ['purity'] },
      hands: { 0: ['medallion'] },
      piles: { 0: ['dagger'] },
      turn: 0,
    });
    let state = draw(start, 0).state;
    state = draw(state, 0).state; // empty: round ends
    const { events } = act(state, 0, { action: 'play', card: 'medallion', target: 1 });
    expect(payloads(events, 'score')[0]).toMatchObject({ scores: [4, 4, 0, 0], winner: 1 });
  });
});

describe('the Last Laugh action can be anything that is not restricted', () => {
  it('discarding Shackles ("you may use one action to discard Shackles")', () => {
    const start = buildPosition({ keeps: { 0: ['last-laugh', 'shackles'], 1: ['chalice'] }, turn: 0, actions: 2 });
    const ended = draw(start, 0).state;
    expect(abilityNames(ended, 0)).toEqual(['shackles']);
    const { events } = act(ended, 0, { action: 'ability', card: 'shackles' });
    // Shackles' -3 is gone from S0's keep before scoring.
    expect(payloads(events, 'score')[0]).toMatchObject({ scores: [0, 4, 0, 0] });
  });

  it('a plain draw from a pile that still has cards', () => {
    const start = buildPosition({ keeps: { 2: ['last-laugh'] }, piles: { 2: ['chalice'] }, turn: 0 });
    const ended = draw(start, 0).state;
    const { state } = draw(ended, 2);
    expect(state.hands[2]).toEqual(['chalice']);
    expect(state.phase).toBe('round-over');
  });

  it('Resurrection taking Fiat: the pile claims happen before scoring', () => {
    const start = buildPosition({ keeps: { 0: ['last-laugh'] }, hands: { 0: ['resurrection'] }, discard: ['fiat'], turn: 0 });
    const ended = draw(start, 0).state;
    const taken = respond(act(ended, 0, { action: 'play', card: 'resurrection' }).state, 0, { kind: 'choose-discard-card', card: 'fiat' });
    let state = hotTarget(taken.state, 0, 0).state;
    for (const seat of [0, 1, 2, 3] as const) {
      expect(state.phase).toBe('post-round');
      state = respond(state, seat, { kind: 'claim-pile', from: promptFor(state, seat, 'claim-pile').options[0]! }).state;
    }
    expect(state.phase).toBe('round-over');
  });

  it("playing a Coin card into your own Interest keep with an empty pile draws nothing and doesn't end anything twice", () => {
    const start = buildPosition({ keeps: { 0: ['last-laugh', 'interest'] }, hands: { 0: ['chalice'] }, turn: 0 });
    const ended = draw(start, 0).state;
    const { events } = act(ended, 0, { action: 'play', card: 'chalice', target: 0 });
    expect(payloads(events, 'empty-draw')).toEqual([{ type: 'empty-draw', seat: 0, from: 0, afterRoundEnd: true }]);
    expect(types(events).filter((t) => t === 'round-end')).toEqual([]);
  });
});
