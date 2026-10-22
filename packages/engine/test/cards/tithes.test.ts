import { describe, expect, it } from 'vitest';
import { buildPosition, keepValue, legalCommands } from '../../src/index.ts';
import { abilityNames, act, keepOf, promptFor, respond, tryRespond } from '../helpers.ts';

describe('Tithes', () => {
  it('C-36 discards every Coin card in your keep, Tithes included', () => {
    const start = buildPosition({
      keeps: { 0: ['tithes', 'chalice', 'purity', 'juggling', 'count-token'] },
      turn: 0,
    });
    const { state } = act(start, 0, { action: 'ability', card: 'tithes' });
    expect(state.keeps[0]).toEqual([{ id: 'purity' }, { id: 'juggling' }]);
    expect(state.discard).toEqual(['tithes', 'chalice', 'count-token']);
  });

  it('C-18 the face-down card counts for Tithes, but Tithes never discards it', () => {
    const start = buildPosition({
      keeps: { 0: ['tithes', { id: 'faberge-egg', faceDown: { placedBy: 1 } }] },
      turn: 0,
    });
    expect(keepValue(start.keeps[0])).toBe(4); // two cards → 2 coins
    const { state } = act(start, 0, { action: 'ability', card: 'tithes' });
    expect(state.keeps[0]).toEqual([{ id: 'faberge-egg', faceDown: { placedBy: 1 } }]);
    expect(state.discard).toEqual(['tithes']);
  });

  it('then lets you look through and reorder your own pile, privately', () => {
    const start = buildPosition({
      keeps: { 0: ['tithes'] },
      piles: { 0: ['chalice', { id: 'blunder', faceUp: true }, 'dagger'] },
      turn: 0,
    });
    const used = act(start, 0, { action: 'ability', card: 'tithes' });
    const prompt = promptFor(used.state, 0, 'order-pile');
    expect(prompt.cards).toEqual(['chalice', 'blunder', 'dagger']);
    const look = used.events.find((e) => e.payload.type === 'look')!;
    expect(look.visibility).toEqual([0]);

    const { state, events } = respond(used.state, 0, { kind: 'order-pile', order: ['dagger', 'chalice', 'blunder'] });
    expect(state.piles[state.pileAt[0]].cards).toEqual([
      { id: 'dagger', faceUp: false },
      { id: 'chalice', faceUp: false },
      { id: 'blunder', faceUp: true },
    ]);
    expect(events.find((e) => e.payload.type === 'pile-reorder')!.redacted).toEqual({
      type: 'pile-reorder', seat: 0, pile: 0, order: null,
    });
  });

  it('rejects an order that is not a permutation of the pile', () => {
    const start = buildPosition({ keeps: { 0: ['tithes'] }, piles: { 0: ['chalice', 'dagger'] }, turn: 0 });
    const used = act(start, 0, { action: 'ability', card: 'tithes' }).state;
    for (const order of [['chalice'], ['chalice', 'chalice'], ['chalice', 'scepter']] as const) {
      const result = tryRespond(used, 0, { kind: 'order-pile', order: [...order] });
      expect(result.ok).toBe(false);
    }
  });

  it('skips the reorder when your pile is empty', () => {
    const start = buildPosition({ keeps: { 0: ['tithes'] }, turn: 0 });
    const { state } = act(start, 0, { action: 'ability', card: 'tithes' });
    promptFor(state, 0, 'action');
  });

  it('is usable during Retribution actions', () => {
    const start = buildPosition({
      keeps: { 1: ['tithes'] },
      turn: 0,
      frames: [{ seat: 1, kind: 'retribution', remaining: 2 }],
    });
    expect(abilityNames(start, 1)).toEqual(['tithes']);
  });

  it('counts every card in its keep, so it grows as cards arrive', () => {
    expect(keepValue(keepOf('tithes'))).toBe(2);
    expect(keepValue(keepOf('tithes', 'interest', 'retribution', 'last-laugh'))).toBe(8);
  });

  it('in another player\'s keep, cannot be used by you', () => {
    const start = buildPosition({ keeps: { 1: ['tithes'] }, turn: 0 });
    expect(abilityNames(start, 0)).toEqual([]);
  });

  it('a two-card pile is offered in both orders', () => {
    const start = buildPosition({ keeps: { 0: ['tithes'] }, piles: { 0: ['chalice', 'dagger'] }, turn: 0 });
    const used = act(start, 0, { action: 'ability', card: 'tithes' });
    const orders = legalCommands(used.state, 0).flatMap((c) => (c.type === 'answer' && c.answer.kind === 'order-pile' ? [c.answer.order.join(',')] : []));
    expect(orders).toEqual(['chalice,dagger', 'dagger,chalice']);
  });
});
