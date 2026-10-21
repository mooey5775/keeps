import { describe, expect, it } from 'vitest';
import { apply, buildPosition, legalCommands } from '../../src/index.ts';
import { act, actionCommand, actionsLeft, draw, hotTarget, payloads, promptFor, types } from '../helpers.ts';

describe('HOT cards', () => {
  it('R-05 a drawn HOT Keep card is played immediately, without using an action', () => {
    const start = buildPosition({ piles: { 0: ['juggling', 'chalice'] }, turn: 0 });
    const drawn = draw(start, 0);

    // The only decision now is where Juggling goes; no other action is possible.
    promptFor(drawn.state, 0, 'hot-target');
    expect(drawn.state.hands[0]).toEqual(['juggling']);
    expect(legalCommands(drawn.state, 0).map((c) => c.type === 'answer' && c.answer)).toEqual([
      { kind: 'hot-target', target: 0 },
      { kind: 'hot-target', target: 1 },
      { kind: 'hot-target', target: 2 },
      { kind: 'hot-target', target: 3 },
    ]);

    const played = hotTarget(drawn.state, 0, 2);
    expect(played.state.keeps[2]).toEqual([{ id: 'juggling' }]);
    expect(played.state.hands[0]).toEqual([]);
    expect(actionsLeft(played.state)).toBe(1);
    expect(payloads(played.events, 'play')).toEqual([
      { type: 'play', seat: 0, card: 'juggling', target: 2, hot: true },
    ]);
  });

  it('R-05 a drawn Blunder goes straight into the drawer\'s own keep', () => {
    const start = buildPosition({ piles: { 0: ['blunder'] }, turn: 0 });
    const { state, events } = draw(start, 0);
    expect(state.keeps[0]).toEqual([{ id: 'blunder' }]);
    expect(actionsLeft(state)).toBe(1);
    expect(types(events)).toEqual(['action', 'draw', 'play', 'prompt']);
  });

  it('R-05 a drawn HOT card on the last action is still played before the turn ends', () => {
    const start = buildPosition({ piles: { 0: ['chalice', 'blunder'] }, turn: 0 });
    const { state, events } = draw(draw(start, 0).state, 0);
    expect(state.keeps[0]).toEqual([{ id: 'blunder' }]);
    expect(types(events)).toEqual(['action', 'draw', 'play', 'turn-end', 'turn-start', 'prompt']);
  });

  it('R-05 HOT Keep cards cannot be played into a ghost\'s keep', () => {
    const start = buildPosition({
      seats: ['player', 'ghost', 'player', 'ghost'],
      piles: { 0: ['sanction'] },
      turn: 0,
    });
    const { state } = draw(start, 0);
    expect(legalCommands(state, 0).map((c) => c.type === 'answer' && c.answer)).toEqual([
      { kind: 'hot-target', target: 0 },
      { kind: 'hot-target', target: 2 },
    ]);
  });

  it('traces the HOT play as caused by the draw, which was caused by the action', () => {
    const start = buildPosition({ piles: { 0: ['acquisition'] }, turn: 0 });
    const drawn = draw(start, 0);
    const played = hotTarget(drawn.state, 0, 0);
    const all = [...drawn.events, ...played.events];
    const bySeq = new Map(all.map((e) => [e.seq, e]));
    const chain: string[] = [];
    for (let e = all.find((x) => x.payload.type === 'play'); e; e = e.cause ? bySeq.get(e.cause) : undefined) {
      chain.push(e.payload.type);
    }
    expect(chain).toEqual(['play', 'prompt', 'draw', 'action']);
  });

  it('hides a face-down draw from other players but not from the drawer', () => {
    const start = buildPosition({ piles: { 0: ['chalice'] }, turn: 0 });
    const { events } = draw(start, 0);
    const drawEvent = events.find((e) => e.payload.type === 'draw')!;
    expect(drawEvent.visibility).toEqual([0]);
    expect(drawEvent.redacted).toEqual({ type: 'draw', seat: 0, from: 0, card: null });
  });

  it('shows everyone a draw of a face-up card', () => {
    const start = buildPosition({ piles: { 0: [{ id: 'chalice', faceUp: true }] }, turn: 0 });
    const { events } = draw(start, 0);
    expect(events.find((e) => e.payload.type === 'draw')!.visibility).toBe('all');
  });
});

describe('playing cards', () => {
  it("R-06 Keep cards are played face-up into any player's keep", () => {
    const start = buildPosition({ hands: { 0: ['dagger', 'chalice'] }, turn: 0 });
    const one = act(start, 0, { action: 'play', card: 'dagger', target: 3 });
    const two = act(one.state, 0, { action: 'play', card: 'chalice', target: 0 });
    expect(two.state.keeps[3]).toEqual([{ id: 'dagger' }]);
    expect(two.state.keeps[0]).toEqual([{ id: 'chalice' }]);
    expect(two.state.hands[0]).toEqual([]);
  });

  it("R-06 Keep cards cannot be played into a ghost's keep", () => {
    const start = buildPosition({
      seats: ['player', 'ghost', 'player', 'ghost'],
      hands: { 0: ['dagger'] },
      turn: 0,
    });
    const result = apply(start, 0, actionCommand(start, 0, { action: 'play', card: 'dagger', target: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('illegal');
  });

  it('R-06 non-Keep cards are discarded face up when played', () => {
    const start = buildPosition({ hands: { 0: ['hocus-pocus'] }, discard: ['pluck'], turn: 0 });
    const { state } = act(start, 0, { action: 'play', card: 'hocus-pocus' });
    expect(state.discard).toEqual(['pluck', 'hocus-pocus']);
    expect(state.hands[0]).toEqual([]);
  });

  it('Hocus Pocus costs one action and grants two (three actions this turn)', () => {
    const start = buildPosition({
      hands: { 0: ['hocus-pocus'] },
      piles: { 0: ['chalice', 'dagger', 'medallion', 'scepter'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'hocus-pocus' });
    expect(payloads(played.events, 'extra-actions')).toEqual([
      { type: 'extra-actions', seat: 0, count: 2, source: 'hocus-pocus' },
    ]);
    expect(actionsLeft(played.state)).toBe(2);

    let state = played.state;
    for (let i = 0; i < 3; i++) {
      expect(state.turn?.seat).toBe(0);
      state = draw(state, 0).state;
    }
    expect(state.hands[0]).toEqual(['chalice', 'dagger', 'medallion']);
    expect(state.turn?.seat).toBe(1);
  });
});
