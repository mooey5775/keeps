import { describe, expect, it } from 'vitest';
import { buildPosition, eventsFor, keepValue, legalCommands } from '../../src/index.ts';
import { act, payloads, promptFor, respond, tryRespond } from '../helpers.ts';

describe('Providence', () => {
  it('swaps two played Keep cards between keeps', () => {
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 1: ['blunder'], 2: ['medallion'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const { state, events } = respond(played.state, 0, {
      kind: 'choose-keep-pair', a: { seat: 1, index: 0 }, b: { seat: 2, index: 0 },
    });
    expect(state.keeps[1]).toEqual([{ id: 'medallion' }]);
    expect(state.keeps[2]).toEqual([{ id: 'blunder' }]);
    expect(payloads(events, 'keep-swap')).toEqual([
      { type: 'keep-swap', seat: 0, a: { seat: 1, index: 0, card: 'blunder' }, b: { seat: 2, index: 0, card: 'medallion' } },
    ]);
  });

  it('accepts the two cards in either order', () => {
    const start = buildPosition({ hands: { 0: ['providence'] }, keeps: { 1: ['blunder'], 2: ['medallion'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const { state } = respond(played.state, 0, {
      kind: 'choose-keep-pair', a: { seat: 2, index: 0 }, b: { seat: 1, index: 0 },
    });
    expect(state.keeps[1]).toEqual([{ id: 'medallion' }]);
  });

  it('C-29 can swap two cards in the same keep', () => {
    const start = buildPosition({ hands: { 0: ['providence'] }, keeps: { 1: ['blunder', 'medallion'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const result = tryRespond(played.state, 0, {
      kind: 'choose-keep-pair', a: { seat: 1, index: 0 }, b: { seat: 1, index: 1 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state.keeps[1]).toEqual([{ id: 'medallion' }, { id: 'blunder' }]);
  });

  it('Q-05 can swap a face-down card, which stays face-down and hidden in the public trace', () => {
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 1: [{ id: 'chalice', faceDown: { placedBy: 2 } }], 3: ['dagger'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const { state, events } = respond(played.state, 0, {
      kind: 'choose-keep-pair', a: { seat: 1, index: 0 }, b: { seat: 3, index: 0 },
    });
    expect(state.keeps[3]).toEqual([{ id: 'chalice', faceDown: { placedBy: 2 } }]);
    expect(state.keeps[1]).toEqual([{ id: 'dagger' }]);
    expect(JSON.stringify(eventsFor(events, 0))).not.toContain('chalice');
  });

  it('can complete a token victory', () => {
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 0: ['count-token', 'fool-token', 'chalice'], 2: ['friar-token'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const { state, events } = respond(played.state, 0, {
      kind: 'choose-keep-pair', a: { seat: 0, index: 2 }, b: { seat: 2, index: 0 },
    });
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'tokens', winner: 0 }]);
    expect(state.marks).toEqual([1, 0, 0, 0]);
  });

  it('has no effect with fewer than two played Keep cards', () => {
    const start = buildPosition({ hands: { 0: ['providence'] }, keeps: { 1: ['dagger'] }, turn: 0 });
    const { events } = act(start, 0, { action: 'play', card: 'providence' });
    expect(payloads(events, 'no-effect')).toHaveLength(1);
  });

  it('can move Blunder onto a rival to put you ahead (Divine Intervention)', () => {
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 0: ['blunder', 'chalice'], 2: ['medallion', 'tithes'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const { state } = respond(played.state, 0, { kind: 'choose-keep-pair', a: { seat: 0, index: 0 }, b: { seat: 2, index: 0 } });
    expect(keepValue(state.keeps[0])).toBe(8);
    expect(keepValue(state.keeps[2])).toBeLessThan(0);
  });

  it('rejects swapping a card with itself', () => {
    const start = buildPosition({ hands: { 0: ['providence'] }, keeps: { 1: ['chalice', 'dagger'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const prompt = promptFor(played.state, 0, 'choose-keep-pair');
    const result = legalCommands(played.state, 0).some(
      (c) => c.type === 'answer' && c.answer.kind === 'choose-keep-pair' && c.answer.a.index === c.answer.b.index && c.answer.a.seat === c.answer.b.seat,
    );
    expect(result).toBe(false);
    expect(prompt).toBeTruthy();
  });
});
