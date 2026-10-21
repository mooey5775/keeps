import { describe, expect, it } from 'vitest';
import {
  assertInvariants,
  buildPosition,
  checkInvariants,
  locate,
  newGame,
  type GameState,
} from '../src/index.ts';

const fresh = (): GameState => newGame({ players: 4, seed: 'invariants', firstSeat: 0 }).state;

describe('invariants', () => {
  it('accepts a freshly dealt game', () => {
    expect(checkInvariants(fresh())).toEqual([]);
  });

  it('detects a duplicated card', () => {
    const state = fresh();
    state.discard.push(state.piles.count.cards[0]!.id);
    expect(checkInvariants(state)).toEqual([expect.stringMatching(/is in 2 zones/)]);
    expect(() => assertInvariants(state)).toThrow(/Invariant violation/);
  });

  it('detects a missing card', () => {
    const state = fresh();
    const lost = state.piles.fool.cards.pop()!;
    expect(checkInvariants(state)).toEqual([`${lost.id} is missing from every zone`]);
  });

  it('detects an unknown card id', () => {
    const state = fresh();
    (state.discard as string[]).push('banana');
    expect(checkInvariants(state)).toContainEqual('unknown card id "banana"');
  });

  it('detects box cards in a full-deck game', () => {
    const state = fresh();
    state.box.push(state.piles.friar.cards.pop()!.id);
    expect(checkInvariants(state)).toEqual([expect.stringMatching(/partialDeck is false/)]);
  });

  it('detects a pile layout that is not a permutation', () => {
    const state = fresh();
    state.pileAt = ['count', 'count', 'friar', 'mask'];
    expect(checkInvariants(state)).toEqual([expect.stringMatching(/not a permutation/)]);
  });

  it('detects ghosts holding cards', () => {
    const state = newGame({ players: 2, seed: 'ghost' }).state;
    state.hands[1].push(state.piles[state.pileAt[0]].cards.pop()!.id);
    expect(checkInvariants(state)).toEqual(['ghost seat 1 has a hand']);
  });

  it('detects a non-Keep card in a keep', () => {
    const state = fresh();
    // Move Joker out of its pile so card conservation stays clean.
    const joker = locate(state, 'joker');
    if (joker.kind !== 'pile') throw new Error('expected joker in a pile');
    state.piles[joker.pile].cards.splice(joker.index, 1);
    state.keeps[0].push({ id: 'joker' });
    expect(checkInvariants(state)).toEqual(["non-Keep card joker is in seat 0's keep"]);
    expect(() => buildPosition({ keeps: { 0: ['joker'] } })).toThrow(/non-Keep card joker/);
  });

  it('detects a turn belonging to a ghost', () => {
    const state = newGame({ players: 2, seed: 'ghost-turn' }).state;
    state.turn = { seat: 1, actionsTaken: 0, usedOncePerTurn: [] };
    expect(checkInvariants(state)).toEqual(["it is ghost seat 1's turn"]);
  });

  it('locate finds the single zone of a card', () => {
    const state = buildPosition({ hands: { 2: ['joker'] }, keeps: { 1: ['dagger'] } });
    expect(locate(state, 'joker')).toEqual({ kind: 'hand', seat: 2, index: 0 });
    expect(locate(state, 'dagger')).toEqual({ kind: 'keep', seat: 1, index: 0, faceDown: false });
    expect(locate(state, 'chalice')).toEqual({ kind: 'box' });
  });
});
