import { describe, expect, it } from 'vitest';
import { buildPosition } from '../../src/index.ts';
import { act, actionsLeft, allEvents, draw, payloads, promptFor, respond, types } from '../helpers.ts';

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

  it('Tithes entering the keep counts as a Coin card (Purity 3)', () => {
    const start = buildPosition({ hands: { 0: ['tithes'] }, keeps: { 0: ['interest'] }, piles: { 0: ['chalice'] }, turn: 0 });
    expect(act(start, 0, { action: 'play', card: 'tithes', target: 0 }).state.hands[0]).toEqual(['chalice']);
  });

  it('a Blunder drawn into an Interest keep triggers another draw (Royal Favor 3)', () => {
    const start = buildPosition({ keeps: { 0: ['interest'] }, piles: { 0: ['blunder', 'chalice'] }, turn: 0 });
    const { state } = draw(start, 0);
    expect(state.hands[0]).toEqual(['chalice']);
    expect(actionsLeft(state)).toBe(1);
  });

  it('negative Coin cards (Shackles, Tokens) trigger it too', () => {
    const start = buildPosition({ hands: { 0: ['shackles'] }, keeps: { 1: ['interest'] }, piles: { 1: ['chalice'] }, turn: 0 });
    expect(act(start, 0, { action: 'play', card: 'shackles', target: 1 }).state.hands[1]).toEqual(['chalice']);
  });

  it('C-21 Interest as the second card, swapped for a Coin card, does not trigger', () => {
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 1: ['chalice'], 2: ['interest'] },
      piles: { 1: ['dagger'], 2: ['scepter'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const { state, events } = respond(played.state, 0, { kind: 'choose-keep-pair', a: { seat: 1, index: 0 }, b: { seat: 2, index: 0 } });
    expect(state.keeps[2]).toEqual([{ id: 'chalice' }]);
    expect(types(events)).not.toContain('trigger');
  });

  it.each([
    ['first', { a: { seat: 2, index: 0 }, b: { seat: 1, index: 1 } }],
    ['second', { a: { seat: 1, index: 1 }, b: { seat: 2, index: 0 } }],
  ] as const)('a face-down Coin card swapped into an Interest keep (as the %s card) does not trigger Interest', (_order, pair) => {
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 1: ['interest', 'juggling'], 2: [{ id: 'chalice', faceDown: { placedBy: 0 } }] },
      piles: { 1: ['dagger'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const { state, events } = respond(played.state, 0, { kind: 'choose-keep-pair', ...pair });
    expect(state.keeps[1].some((c) => c.id === 'chalice' && c.faceDown)).toBe(true);
    expect(types(events)).not.toContain('trigger');
  });
});
