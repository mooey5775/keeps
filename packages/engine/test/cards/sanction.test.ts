import { describe, expect, it } from 'vitest';
import { buildPosition } from '../../src/index.ts';
import { abilityNames, act, payloads, pileIds, promptFor } from '../helpers.ts';

describe('Sanction', () => {
  it('draws from any pile, once per turn', () => {
    const start = buildPosition({ keeps: { 0: ['sanction'] }, piles: { 2: ['chalice', 'dagger'] }, turn: 0 });
    const { state } = act(start, 0, { action: 'ability', card: 'sanction', from: 2 });
    expect(state.hands[0]).toEqual(['chalice']);
    expect(pileIds(state, 2)).toEqual(['dagger']);
    expect(abilityNames(state, 0)).toEqual([]);
  });

  it('ends the round when drawing from an empty pile (Rags to Riches)', () => {
    const start = buildPosition({
      keeps: { 0: ['sanction'], 1: ['chalice'] },
      hands: { 0: ['purity'] },
      piles: { 0: ['dagger'] },
      turn: 0,
    });
    const pure = act(start, 0, { action: 'play', card: 'purity', target: 0 });
    const { state, events } = act(pure.state, 0, { action: 'ability', card: 'sanction', from: 3 });
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'empty-pile', ender: 0 }]);
    expect(payloads(events, 'score')[0]).toMatchObject({ winner: 0, scores: [20, 4, 0, 0] });
    expect(state.marks).toEqual([1, 0, 0, 0]);
  });

  it('can draw from your own pile like a normal draw', () => {
    const start = buildPosition({ keeps: { 0: ['sanction'] }, piles: { 0: ['chalice'] }, turn: 0 });
    expect(act(start, 0, { action: 'ability', card: 'sanction', from: 0 }).state.hands[0]).toEqual(['chalice']);
  });

  it('a HOT card it draws is played immediately', () => {
    const start = buildPosition({ keeps: { 0: ['sanction'] }, piles: { 2: ['pandemonium'] }, turn: 0 });
    promptFor(act(start, 0, { action: 'ability', card: 'sanction', from: 2 }).state, 0, 'choose-direction');
  });
});
