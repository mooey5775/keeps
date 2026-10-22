import { describe, expect, it } from 'vitest';
import { buildPosition } from '../../src/index.ts';
import {
  abilityNames,
  act,
  actionsLeft,
  draw,
  hotTarget,
  payloads,
  pileIds,
  promptFor,
  respond,
  types,
} from '../helpers.ts';

describe('Acquisition', () => {
  const position = () =>
    buildPosition({
      keeps: { 0: ['acquisition'] },
      hands: { 0: ['chalice'] },
      piles: { 1: ['dagger', 'scepter'], 3: ['medallion'] },
      turn: 0,
    });

  it('discards a card, then draws from the left and right piles in the chosen order', () => {
    const { state, events } = act(position(), 0, { action: 'ability', card: 'acquisition', discard: 'chalice', first: 'right' });
    expect(state.discard).toEqual(['chalice']);
    expect(state.hands[0]).toEqual(['medallion', 'dagger']);
    expect(payloads(events, 'draw').map((d) => d.from)).toEqual([3, 1]);
    expect(actionsLeft(state)).toBe(1);
  });

  it('needs a non-empty hand, and is once per turn', () => {
    const empty = buildPosition({ keeps: { 0: ['acquisition'] }, turn: 0 });
    expect(abilityNames(empty, 0)).toEqual([]);
    const used = act(position(), 0, { action: 'ability', card: 'acquisition', discard: 'chalice', first: 'left' });
    expect(abilityNames(used.state, 0)).toEqual([]);
  });

  it('Q-08 the second pile is the one at that position after the first draw resolves', () => {
    // Drawing left reveals Pandemonium, which rotates the piles before the right draw.
    const start = buildPosition({
      keeps: { 0: ['acquisition'] },
      hands: { 0: ['chalice'] },
      piles: { 1: ['pandemonium'], 2: ['scepter'], 3: ['medallion'] },
      turn: 0,
    });
    const drawn = act(start, 0, { action: 'ability', card: 'acquisition', discard: 'chalice', first: 'left' });
    promptFor(drawn.state, 0, 'choose-direction');
    // Rotating left moves the pile at S2 (Scepter) to S3, the right-hand position of S0.
    const { state } = respond(drawn.state, 0, { kind: 'choose-direction', direction: 'left' });
    expect(state.hands[0]).toEqual(['scepter']);
    expect(pileIds(state, 0)).toEqual(['medallion']);
  });

  it('ends the round if the first pile is empty, skipping the second draw', () => {
    const start = buildPosition({
      keeps: { 0: ['acquisition'] },
      hands: { 0: ['chalice'] },
      piles: { 3: ['medallion'] },
      turn: 0,
    });
    const { state, events } = act(start, 0, { action: 'ability', card: 'acquisition', discard: 'chalice', first: 'left' });
    expect(types(events)).toContain('round-end');
    expect(payloads(events, 'draw')).toEqual([]);
    expect(pileIds(state, 3)).toEqual(['medallion']);
  });

  it('drawn as a HOT card into your own keep, it can be used on the same turn', () => {
    const start = buildPosition({
      piles: { 0: ['acquisition'], 1: ['chalice'], 3: ['dagger'] },
      hands: { 0: ['scepter'] },
      turn: 0,
    });
    const placed = hotTarget(draw(start, 0).state, 0, 0);
    expect(abilityNames(placed.state, 0)).toEqual(['acquisition']);
    const used = act(placed.state, 0, { action: 'ability', card: 'acquisition', discard: 'scepter', first: 'left' });
    expect(used.state.hands[0]).toEqual(['chalice', 'dagger']);
  });

  it('can discard your last card', () => {
    const start = buildPosition({ keeps: { 0: ['acquisition'] }, hands: { 0: ['scepter'] }, piles: { 1: ['chalice'], 3: ['dagger'] }, turn: 0 });
    const { state } = act(start, 0, { action: 'ability', card: 'acquisition', discard: 'scepter', first: 'right' });
    expect(state.hands[0]).toEqual(['dagger', 'chalice']);
  });

  it('plays a HOT card from the second draw too', () => {
    const start = buildPosition({
      keeps: { 0: ['acquisition'] },
      hands: { 0: ['scepter'] },
      piles: { 1: ['chalice'], 3: ['blunder'] },
      turn: 0,
    });
    const { state } = act(start, 0, { action: 'ability', card: 'acquisition', discard: 'scepter', first: 'left' });
    expect(state.hands[0]).toEqual(['chalice']);
    expect(state.keeps[0].map((c) => c.id)).toEqual(['acquisition', 'blunder']);
  });

  it('in a ghost-seat game, draws from the ghost piles beside you', () => {
    const start = buildPosition({
      seats: ['player', 'ghost', 'player', 'ghost'],
      keeps: { 0: ['acquisition'] },
      hands: { 0: ['scepter'] },
      piles: { 1: ['chalice'], 3: ['dagger'] },
      turn: 0,
    });
    const { state } = act(start, 0, { action: 'ability', card: 'acquisition', discard: 'scepter', first: 'left' });
    expect(state.hands[0]).toEqual(['chalice', 'dagger']);
  });

  it('stays once per turn across Hocus Pocus actions', () => {
    const start = buildPosition({
      keeps: { 0: ['acquisition'] },
      hands: { 0: ['hocus-pocus', 'scepter', 'timepiece'] },
      piles: { 1: ['chalice'], 3: ['dagger'] },
      turn: 0,
    });
    const used = act(start, 0, { action: 'ability', card: 'acquisition', discard: 'scepter', first: 'left' });
    const hocus = act(used.state, 0, { action: 'play', card: 'hocus-pocus' });
    expect(abilityNames(hocus.state, 0)).toEqual([]);
  });
});
