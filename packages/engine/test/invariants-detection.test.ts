import { describe, expect, it } from 'vitest';
import {
  assertRestInvariants,
  buildPosition,
  checkInvariants,
  checkRestInvariants,
  locate,
  newGame,
  type GameState,
} from '../src/index.ts';

// The invariant checkers are the safety net under every other test: apply()
// runs them after each command. Each check here breaks one rule on purpose
// and expects exactly that problem to be reported.

const fresh = (): GameState => newGame({ players: 4, seed: 'detect', firstSeat: 0 }).state;
const resting = (): GameState => buildPosition({ piles: { 0: ['chalice', 'dagger'] }, hands: { 1: ['joker'] }, turn: 0 });

/** Moves a card out of wherever it is, so conservation stays intact. */
function take(state: GameState, id: Parameters<typeof locate>[1]) {
  const zone = locate(state, id);
  if (zone.kind === 'pile') state.piles[zone.pile].cards.splice(zone.index, 1);
  else if (zone.kind === 'box') state.box.splice(state.box.indexOf(id), 1);
  else if (zone.kind === 'hand') state.hands[zone.seat].splice(zone.index, 1);
  else throw new Error(`unexpected zone ${zone.kind}`);
}

describe('state invariants', () => {
  it('counts a card in limbo as a zone (and limbo cards as present)', () => {
    const state = fresh();
    take(state, 'joker');
    state.limbo.push({ id: 'joker', reason: 'resolving' });
    expect(checkInvariants(state)).toEqual([]);
    expect(locate(state, 'joker')).toEqual({ kind: 'limbo', reason: 'resolving' });
  });

  it('locate throws for a card in two places', () => {
    const state = fresh();
    state.discard.push(state.piles.count.cards[0]!.id);
    expect(() => locate(state, state.discard[0]!)).toThrow(/2 zones/);
  });

  it('detects a pile filed under the wrong id', () => {
    const state = fresh();
    state.piles.fool = { ...state.piles.fool, id: 'mask' };
    expect(checkInvariants(state)).toEqual(['piles.fool has id mask']);
  });

  it('detects a ghost with a keep', () => {
    const state = newGame({ players: 2, seed: 'ghost-keep' }).state;
    take(state, 'chalice');
    state.keeps[1].push({ id: 'chalice' });
    expect(checkInvariants(state)).toEqual(['ghost seat 1 has a keep']);
  });

  it('detects a face-down card placed by a ghost', () => {
    const state = newGame({ players: 2, seed: 'ghost-face-down' }).state;
    take(state, 'chalice');
    state.keeps[0].push({ id: 'chalice', faceDown: { placedBy: 1 } });
    expect(checkInvariants(state)).toEqual(['face-down chalice was placed by non-player seat 1']);
  });

  it('detects two face-down cards', () => {
    const state = buildPosition({
      keeps: { 0: [{ id: 'chalice', faceDown: { placedBy: 1 } }], 1: ['dagger'] },
    });
    take(state, 'scepter');
    state.keeps[2].push({ id: 'scepter', faceDown: { placedBy: 0 } });
    expect(checkInvariants(state)).toEqual(['more than one face-down keep card (only Duplicity places them)']);
  });

  it('detects negative or fractional marks', () => {
    const state = fresh();
    state.marks = [0, -1, 0.5, 0];
    expect(checkInvariants(state)).toEqual(['invalid marks: 0, -1, 0.5, 0']);
  });
});

describe('rest invariants (the engine waiting for a command)', () => {
  it('accept a normal waiting state', () => {
    expect(checkRestInvariants(resting())).toEqual([]);
    expect(() => assertRestInvariants(resting())).not.toThrow();
  });

  it('detect a card left in limbo', () => {
    const state = resting();
    take(state, 'scepter');
    state.limbo.push({ id: 'scepter', reason: 'looking' });
    expect(checkRestInvariants(state)).toEqual(['limbo is not empty: scepter']);
  });

  it('detect a HOT card held in a hand', () => {
    const state = resting();
    take(state, 'pandemonium');
    state.hands[1].push('pandemonium');
    expect(checkRestInvariants(state)).toEqual(["HOT card pandemonium is being held in seat 1's hand"]);
  });

  it('detect a deadlock: playing with nothing to answer', () => {
    const state = resting();
    state.prompts = [];
    expect(checkRestInvariants(state)).toContain('phase playing but no open prompts (deadlock)');
    expect(() => assertRestInvariants(state)).toThrow(/deadlock/);
  });

  it('detect leftover prompts or stack after the round is scored', () => {
    const state = resting();
    state.phase = 'round-over';
    expect(checkRestInvariants(state)).toEqual(['phase round-over but the stack or prompts are not empty']);
  });

  it('detect a prompt for a ghost seat', () => {
    const state = buildPosition({ seats: ['player', 'ghost', 'player', 'ghost'], turn: 0 });
    state.prompts = [{ ...state.prompts[0]!, seat: 1, kind: 'choose-direction' }];
    expect(checkRestInvariants(state)).toEqual([`prompt ${state.prompts[0]!.id} is for a ghost`]);
  });

  it('detect an action prompt with no matching action frame', () => {
    const state = resting();
    state.prompts = [{ ...state.prompts[0]!, seat: 2 }];
    expect(checkRestInvariants(state)).toEqual([`action prompt ${state.prompts[0]!.id} has no matching action frame on top of the stack`]);
  });

  it('detect an open play without its after-play op', () => {
    const state = resting();
    state.openPlays.push({ id: 99, actor: 0, card: 'chalice', retribution: [], changed: [], entries: [], hidden: null } as never);
    expect(checkRestInvariants(state)).toEqual(["open plays [99] don't match after-play ops []"]);
  });

  it('detect duplicate prompt ids', () => {
    const state = buildPosition({ hands: { 0: ['offering'], 1: ['chalice'], 2: ['dagger'] }, turn: 0 });
    state.prompts = [
      { ...state.prompts[0]!, seat: 1, kind: 'give-card', to: 0 } as never,
      { ...state.prompts[0]!, seat: 2, kind: 'give-card', to: 0 } as never,
    ];
    state.stack = [];
    expect(checkRestInvariants(state)).toEqual([`duplicate prompt ids: ${state.prompts[0]!.id}, ${state.prompts[0]!.id}`]);
  });
});
