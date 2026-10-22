import { describe, expect, it } from 'vitest';
import { apply, buildPosition, legalCommands, type KeepCard, type PerSeat, type Seat } from '../../src/index.ts';
import { draw, ok, payloads, promptFor, types } from '../helpers.ts';

// Ending a round, scoring it, and rounds cut short in the middle of a decision.

/** `ender` draws from their (empty) pile, ending the round with the given keeps. */
function endRound(ender: Seat, keeps: Partial<Record<Seat, readonly KeepCard['id'][]>>, seats?: PerSeat<'player' | 'ghost'>) {
  const start = buildPosition({ keeps, turn: ender, ...(seats ? { seats } : {}) });
  return draw(start, ender);
}

describe('round end', () => {
  it('R-07 drawing from an empty pile ends the round at once, even with actions left', () => {
    const start = buildPosition({ keeps: { 1: ['chalice'] }, piles: { 1: ['dagger'] }, turn: 0 });
    const { state, events } = draw(start, 0);
    expect(types(events)).toEqual(['action', 'empty-draw', 'round-end', 'score', 'mark']);
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'empty-pile', ender: 0 }]);
    expect(state.phase).toBe('round-over');
    expect(state.roundEnd).toEqual({ kind: 'empty-pile', enderSeat: 0 });
    expect(state.turn).toBeNull();
    expect(state.stack).toEqual([]);
    expect(state.prompts).toEqual([]);
  });

  it('R-07 after the round ends, the only command is starting the next round', () => {
    const { state } = endRound(0, {});
    for (const seat of [0, 1, 2, 3] as const) expect(legalCommands(state, seat)).toEqual([{ type: 'next-round' }]);
  });

  it('R-07 the round does not end while the drawn-from pile still has cards', () => {
    const start = buildPosition({ piles: { 0: ['chalice'] }, turn: 0 });
    const { state } = draw(start, 0);
    expect(state.phase).toBe('playing');
  });

  it('R-08 the player with the most coins wins the round', () => {
    const { state, events } = endRound(0, { 1: ['chalice'], 2: ['faberge-egg'], 3: ['dagger', 'count-token'] });
    expect(payloads(events, 'score')).toEqual([
      { type: 'score', scores: [0, 4, 6, 2], winner: 2, tiedWith: [] },
    ]);
    expect(state.marks).toEqual([0, 0, 1, 0]);
  });

  it('R-08 a tie goes to the tied player most directly left of whoever ended the round', () => {
    const tied = { 1: ['chalice'], 3: ['dagger'] } as const;
    // Left of S0 is S1; left of S2 is S3.
    expect(payloads(endRound(0, { ...tied }).events, 'score')[0]).toMatchObject({ winner: 1, tiedWith: [3] });
    expect(payloads(endRound(2, { ...tied }).events, 'score')[0]).toMatchObject({ winner: 3, tiedWith: [1] });
  });

  it('R-08 the player who ends the round loses ties', () => {
    const { events } = endRound(0, { 0: ['chalice'], 2: ['dagger'] });
    expect(payloads(events, 'score')[0]).toMatchObject({ winner: 2, tiedWith: [0] });
  });

  it('R-08 ties skip ghosts and compare even when everyone is negative', () => {
    const seats: PerSeat<'player' | 'ghost'> = ['player', 'ghost', 'player', 'player'];
    const { events } = endRound(3, { 0: ['count-token'], 2: ['fool-token'], 3: ['shackles'] }, seats);
    expect(payloads(events, 'score')).toEqual([
      { type: 'score', scores: [-2, null, -2, -6], winner: 0, tiedWith: [2] },
    ]);
  });

  it('R-09 the round winner earns a Victory Mark', () => {
    const { state, events } = endRound(0, { 2: ['chalice'] });
    expect(payloads(events, 'mark')).toEqual([{ type: 'mark', seat: 2, marks: 1 }]);
    expect(state.marks).toEqual([0, 0, 1, 0]);
    expect(state.phase).toBe('round-over');
  });

  it('R-09 the first player to three marks wins the game', () => {
    const start = buildPosition({ keeps: { 2: ['chalice'] }, marks: [0, 1, 2, 0], turn: 0 });
    const { state, events } = draw(start, 0);
    expect(state.marks).toEqual([0, 1, 3, 0]);
    expect(state.phase).toBe('game-over');
    expect(payloads(events, 'game-over')).toEqual([{ type: 'game-over', winner: 2 }]);
    for (const seat of [0, 1, 2, 3] as const) expect(legalCommands(state, seat)).toEqual([]);
    const after = apply(state, 0, { type: 'next-round' });
    expect(after.ok).toBe(false);
  });

  it('R-09 the number of marks to win is configurable', () => {
    const start = buildPosition({ keeps: { 1: ['chalice'] }, marksToWin: 1, turn: 0 });
    expect(draw(start, 0).state.phase).toBe('game-over');
  });

  it('a tie with a ghost seat between: the ghost is skipped when looking left of the ender', () => {
    const start = buildPosition({
      seats: ['player', 'ghost', 'player', 'player'],
      keeps: { 0: ['chalice'], 2: ['dagger'], 3: ['scepter'] },
      turn: 0,
    });
    // Left of S0: S1 (ghost, skipped), S2. S2 wins over S3 and S0.
    expect(payloads(draw(start, 0).events, 'score')[0]).toMatchObject({ winner: 2, tiedWith: [3, 0] });
  });

  it('a half-coin settles what would otherwise be a tie', () => {
    const start = buildPosition({ keeps: { 1: ['chalice'], 2: ['dagger', 'royal-favor'] }, turn: 0 });
    expect(payloads(draw(start, 0).events, 'score')[0]).toMatchObject({ scores: [0, 4, 5, 0], winner: 2, tiedWith: [] });
  });

  it('drawing your last card does not end the round; the next draw from that pile does', () => {
    const start = buildPosition({ piles: { 0: ['chalice'] }, turn: 0 });
    const last = draw(start, 0);
    expect(last.state.phase).toBe('playing');
    expect(types(draw(last.state, 0).events)).toContain('round-end');
  });
});

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
