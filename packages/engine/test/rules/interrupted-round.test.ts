import { describe, expect, it } from 'vitest';
import { apply, buildPosition } from '../../src/index.ts';
import { draw, ok, payloads, promptFor } from '../helpers.ts';

// A round can end in the middle of someone else's decision: Duplicity's
// reveal is allowed at any time, and revealing the last Token wins at once.
// Whatever was pending is simply abandoned; the next round redeals everything.

describe('a round that ends mid-decision', () => {
  it('a token win revealed while a drawn HOT card awaits its keep ends the round cleanly', () => {
    // S1 holds Duplicity; the face-down Friar Token completes S0's Tokens.
    const start = buildPosition({
      keeps: { 0: ['fool-token', 'count-token', { id: 'friar-token', faceDown: { placedBy: 0 } }], 1: ['duplicity'] },
      piles: { 1: ['sanction', 'shackles'] },
      turn: 1,
    });
    const drawn = draw(start, 1);
    expect(promptFor(drawn.state, 1, 'hot-target').card).toBe('sanction');

    const result = apply(drawn.state, 1, { type: 'reveal-duplicity' });
    const { state, events } = ok(result);
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'tokens', winner: 0 }]);
    expect(state.phase).toBe('round-over');
    expect(state.prompts).toEqual([]);
    // The abandoned HOT card is still in S1's hand; it's redealt next round.
    expect(state.hands[1]).toEqual(['sanction']);
    const next = ok(apply(state, 0, { type: 'next-round' })).state;
    expect(next.hands.flat()).toEqual([]);
  });

  it('a token win revealed during Offering gives leaves the gifts ungiven', () => {
    const start = buildPosition({
      hands: { 0: ['offering'], 1: ['chalice'], 2: ['dagger'] },
      keeps: { 0: ['fool-token', 'count-token', { id: 'friar-token', faceDown: { placedBy: 0 } }], 3: ['duplicity'] },
      turn: 0,
    });
    const played = ok(apply(start, 0, { type: 'answer', promptId: promptFor(start, 0, 'action').id, answer: { kind: 'action', choice: { action: 'play', card: 'offering' } } }));
    const { state } = ok(apply(played.state, 3, { type: 'reveal-duplicity' }));
    expect(state.roundEnd).toEqual({ kind: 'tokens', winner: 0 });
    expect(state.hands[1]).toEqual(['chalice']);
    expect(state.hands[2]).toEqual(['dagger']);
  });
});
