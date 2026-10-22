import { describe, expect, it } from 'vitest';
import { buildPosition, eventsFor } from '../../src/index.ts';
import { act, payloads, pileIds, promptFor, respond } from '../helpers.ts';

describe('Epiphany', () => {
  it('looks at every non-empty pile top and takes one; the others stay', () => {
    const start = buildPosition({
      hands: { 0: ['epiphany'] },
      piles: { 1: ['chalice', 'dagger'], 3: ['medallion'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'epiphany' });
    expect(promptFor(played.state, 0, 'choose-top-card').options).toEqual([
      { pile: 1, card: 'chalice' },
      { pile: 3, card: 'medallion' },
    ]);
    const { state } = respond(played.state, 0, { kind: 'choose-top-card', pile: 1 });
    expect(state.hands[0]).toEqual(['chalice']);
    expect(pileIds(state, 1)).toEqual(['dagger']);
    expect(pileIds(state, 3)).toEqual(['medallion']);
  });

  it('a HOT card taken this way is played immediately', () => {
    const start = buildPosition({ hands: { 0: ['epiphany'] }, piles: { 1: ['blunder'], 2: ['chalice'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'epiphany' });
    const { state } = respond(played.state, 0, { kind: 'choose-top-card', pile: 1 });
    expect(state.keeps[0]).toEqual([{ id: 'blunder' }]);
  });

  it('has no effect when every pile is empty', () => {
    const start = buildPosition({ hands: { 0: ['epiphany'] }, turn: 0 });
    expect(payloads(act(start, 0, { action: 'play', card: 'epiphany' }).events, 'no-effect')).toHaveLength(1);
  });

  it('only you see the tops', () => {
    const start = buildPosition({ hands: { 0: ['epiphany'] }, piles: { 1: ['chalice'] }, turn: 0 });
    expect(JSON.stringify(eventsFor(act(start, 0, { action: 'play', card: 'epiphany' }).events, 1))).not.toContain('chalice');
  });

  it('Epiphany looks at ghost piles too', () => {
    const start = buildPosition({
      seats: ['player', 'ghost', 'player', 'ghost'],
      hands: { 0: ['epiphany'] },
      piles: { 1: ['chalice'], 3: ['dagger'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'epiphany' });
    expect(promptFor(played.state, 0, 'choose-top-card').options.map((o) => o.pile)).toEqual([1, 3]);
  });
});
