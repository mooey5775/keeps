import { describe, expect, it } from 'vitest';
import { buildPosition } from '../../src/index.ts';
import { abilityNames, act, actionsLeft, draw, hotTarget, payloads, promptFor, respond, types } from '../helpers.ts';

// Interactions between mechanics that the per-card tests don't combine:
// triggers inside other players' actions, HOT cards mid-chain, piles moving
// between a pile lookup and its use, token wins in odd places.

describe('Retribution actions', () => {
  it('a HOT card drawn during Retribution actions is played before the actions continue', () => {
    const start = buildPosition({
      hands: { 0: ['chalice'] },
      keeps: { 1: ['retribution'] },
      piles: { 1: ['blunder', 'dagger'] },
      turn: 0,
    });
    const struck = act(start, 0, { action: 'play', card: 'chalice', target: 1 });
    const first = draw(struck.state, 1);
    expect(first.state.keeps[1].map((c) => c.id)).toEqual(['retribution', 'chalice', 'blunder']);
    expect(actionsLeft(first.state)).toBe(1);
    promptFor(first.state, 1, 'action');
  });

  it('ending the round during Retribution actions makes the Retribution owner the ender', () => {
    const start = buildPosition({
      hands: { 0: ['chalice'] },
      keeps: { 1: ['retribution'], 2: ['dagger'], 3: ['scepter'] },
      turn: 0,
    });
    const struck = act(start, 0, { action: 'play', card: 'chalice', target: 1 });
    const { events } = draw(struck.state, 1);
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'empty-pile', ender: 1 }]);
    // S1, S2, S3 tie at 2 coins; left of the ender S1 is S2.
    expect(payloads(events, 'score')[0]).toMatchObject({ winner: 2, tiedWith: [3, 1] });
  });

  it('the Retribution owner can win by Tokens during their Retribution actions', () => {
    const start = buildPosition({
      hands: { 0: ['chalice'], 1: ['friar-token'] },
      keeps: { 1: ['retribution', 'count-token', 'fool-token'] },
      turn: 0,
    });
    const struck = act(start, 0, { action: 'play', card: 'chalice', target: 1 });
    const { state, events } = act(struck.state, 1, { action: 'play', card: 'friar-token', target: 1 });
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'tokens', winner: 1 }]);
    expect(state.marks).toEqual([0, 1, 0, 0]);
  });

  it("the owner's Retribution plays can trigger the original player's Interest", () => {
    const start = buildPosition({
      hands: { 0: ['chalice'], 1: ['dagger'] },
      keeps: { 0: ['interest'], 1: ['retribution'] },
      piles: { 0: ['scepter', 'medallion'] },
      turn: 0,
    });
    const struck = act(start, 0, { action: 'play', card: 'chalice', target: 1 });
    const back = act(struck.state, 1, { action: 'play', card: 'dagger', target: 0 });
    expect(payloads(back.events, 'trigger').map((t) => `${t.kind}:${t.seat}`)).toEqual(['interest:0']);
    expect(back.state.hands[0]).toEqual(['scepter']);
    // Still S1's second Retribution action.
    expect(back.state.stack.at(-1)).toMatchObject({ seat: 1, kind: 'retribution', remaining: 1 });
  });

  it('after the Retribution actions, the interrupted turn resumes with the same frame', () => {
    const start = buildPosition({
      hands: { 0: ['hocus-pocus', 'chalice'] },
      keeps: { 1: ['retribution'] },
      piles: { 0: ['dagger', 'scepter', 'medallion'], 1: ['timepiece', 'faberge-egg'] },
      turn: 0,
    });
    // Hocus Pocus: turn frame 1 left + 2 extra. Spend one extra on Chalice into S1.
    let state = act(start, 0, { action: 'play', card: 'hocus-pocus' }).state;
    state = act(state, 0, { action: 'play', card: 'chalice', target: 1 }).state;
    state = draw(draw(state, 1).state, 1).state;
    expect(state.stack.flatMap((op) => (op.op === 'action-frame' ? [[op.kind, op.remaining]] : []))).toEqual([
      ['turn', 1],
      ['hocus-pocus', 1],
    ]);
    state = draw(draw(state, 0).state, 0).state;
    expect(state.turn?.seat).toBe(1);
  });
});

describe('piles that move', () => {
  it('after Pandemonium, "your pile" is whichever pile now sits in front of you', () => {
    const start = buildPosition({
      piles: { 0: ['pandemonium', 'chalice'], 1: ['dagger'] },
      turn: 0,
    });
    const rotated = respond(draw(start, 0).state, 0, { kind: 'choose-direction', direction: 'right' });
    const { state } = draw(rotated.state, 0);
    expect(state.hands[0]).toEqual(['dagger']);
  });

  it('after Juggling, drawing takes from the swapped-in pile', () => {
    const start = buildPosition({ keeps: { 0: ['juggling'] }, piles: { 0: ['chalice'], 2: ['dagger'] }, turn: 0 });
    const swapped = act(start, 0, { action: 'ability', card: 'juggling', piles: [0, 2] });
    expect(draw(swapped.state, 0).state.hands[0]).toEqual(['dagger']);
  });

  it('Juggling an empty pile to yourself and drawing ends the round', () => {
    const start = buildPosition({ keeps: { 0: ['juggling', 'chalice'] }, piles: { 0: ['dagger'] }, turn: 0 });
    const swapped = act(start, 0, { action: 'ability', card: 'juggling', piles: [0, 1] });
    expect(types(draw(swapped.state, 0).events)).toContain('round-end');
  });

  it('a pile keeps its contents when it moves: Revelation flips travel with it', () => {
    const start = buildPosition({
      keeps: { 0: ['juggling'] },
      piles: { 0: ['revelation'], 2: ['chalice', 'dagger'] },
      turn: 0,
    });
    const flipped = respond(draw(start, 0).state, 0, { kind: 'choose-pile', pile: 2 });
    const { state } = act(flipped.state, 0, { action: 'ability', card: 'juggling', piles: [2, 3] });
    expect(state.piles[state.pileAt[3]].cards).toEqual([
      { id: 'dagger', faceUp: true },
      { id: 'chalice', faceUp: true },
    ]);
  });
});

describe('face-up pile cards', () => {
  it('Requisition can take a face-up Blunder from deep in a pile, and it lands in your keep', () => {
    const start = buildPosition({
      hands: { 0: ['requisition'] },
      piles: { 2: ['chalice', { id: 'blunder', faceUp: true }] },
      turn: 0,
    });
    const looked = respond(act(start, 0, { action: 'play', card: 'requisition' }).state, 0, { kind: 'choose-pile', pile: 2 });
    const { state } = respond(looked.state, 0, { kind: 'choose-pile-card', index: 1 });
    expect(state.keeps[0]).toEqual([{ id: 'blunder' }]);
    expect(state.piles[state.pileAt[2]].cards).toEqual([{ id: 'chalice', faceUp: false }]);
  });

  it('Blunder placed on a flipped pile sits face up on top of the face-up cards', () => {
    const start = buildPosition({
      keeps: { 0: ['blunder'] },
      piles: { 2: [{ id: 'chalice', faceUp: true }] },
      turn: 0,
    });
    const { state } = act(start, 0, { action: 'ability', card: 'blunder', pile: 2 });
    expect(state.piles[state.pileAt[2]].cards).toEqual([
      { id: 'blunder', faceUp: true },
      { id: 'chalice', faceUp: true },
    ]);
  });

  it('Tithes keeps each card face up or down as it was when reordering', () => {
    const start = buildPosition({
      keeps: { 0: ['tithes'] },
      piles: { 0: [{ id: 'chalice', faceUp: true }, 'dagger'] },
      turn: 0,
    });
    const used = act(start, 0, { action: 'ability', card: 'tithes' });
    const { state } = respond(used.state, 0, { kind: 'order-pile', order: ['dagger', 'chalice'] });
    expect(state.piles[state.pileAt[0]].cards).toEqual([
      { id: 'dagger', faceUp: false },
      { id: 'chalice', faceUp: true },
    ]);
  });

  it('Epiphany sees a face-up top card like any other', () => {
    const start = buildPosition({ hands: { 0: ['epiphany'] }, piles: { 1: [{ id: 'chalice', faceUp: true }] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'epiphany' });
    expect(promptFor(played.state, 0, 'choose-top-card').options).toEqual([{ pile: 1, card: 'chalice' }]);
  });

  it('Prayer: discarding the top card then drawing a HOT card plays it', () => {
    const start = buildPosition({ hands: { 0: ['prayer'] }, piles: { 2: ['chalice', 'blunder'] }, turn: 0 });
    const looked = respond(act(start, 0, { action: 'play', card: 'prayer' }).state, 0, { kind: 'choose-pile', pile: 2 });
    const { state } = respond(looked.state, 0, { kind: 'take-or-discard', take: false });
    expect(state.keeps[0]).toEqual([{ id: 'blunder' }]);
    expect(state.discard).toEqual(['prayer', 'chalice']);
  });
});

describe('Shackles and turns', () => {
  it('a Shackled player can turn their one action into two with Hocus Pocus', () => {
    const start = buildPosition({ keeps: { 0: ['shackles'] }, hands: { 0: ['hocus-pocus'] }, piles: { 0: ['chalice', 'dagger'] }, turn: 0 });
    expect(actionsLeft(start)).toBe(1);
    let state = act(start, 0, { action: 'play', card: 'hocus-pocus' }).state;
    expect(actionsLeft(state)).toBe(2);
    state = draw(draw(state, 0).state, 0).state;
    expect(state.turn?.seat).toBe(1);
  });

  it('playing Shackles into your own keep mid-turn does not cut the current turn', () => {
    const start = buildPosition({ hands: { 0: ['shackles'] }, piles: { 0: ['chalice'] }, turn: 0 });
    const { state } = act(start, 0, { action: 'play', card: 'shackles', target: 0 });
    expect(actionsLeft(state)).toBe(1);
  });

  it('discarding Shackles restores two actions from the next turn', () => {
    const start = buildPosition({
      seats: ['player', 'ghost', 'player', 'ghost'],
      keeps: { 0: ['shackles'] },
      piles: { 0: ['chalice'], 2: ['scepter', 'medallion'] },
      turn: 0,
    });
    expect(actionsLeft(start)).toBe(1);
    const freed = act(start, 0, { action: 'ability', card: 'shackles' });
    expect(freed.state.turn?.seat).toBe(2);
    const back = draw(draw(freed.state, 2).state, 2);
    expect(payloads(back.events, 'turn-start')).toEqual([{ type: 'turn-start', seat: 0, actions: 2 }]);
  });

  it("a face-down Shackles doesn't limit its owner's turn", () => {
    const start = buildPosition({ keeps: { 1: [{ id: 'shackles', faceDown: { placedBy: 0 } }], 0: ['duplicity'] }, piles: { 0: ['chalice', 'dagger'] }, turn: 0 });
    const s1 = draw(draw(start, 0).state, 0);
    expect(payloads(s1.events, 'turn-start')).toEqual([{ type: 'turn-start', seat: 1, actions: 2 }]);
  });
});

describe('face-down cards have no effect', () => {
  it('a face-down Juggling, Sanction, Tithes or Blunder gives no ability', () => {
    const fd = (id: 'juggling' | 'sanction' | 'tithes' | 'blunder') => ({ id, faceDown: { placedBy: 1 as const } });
    for (const card of ['juggling', 'sanction', 'tithes', 'blunder'] as const) {
      const start = buildPosition({ keeps: { 0: [fd(card)], 1: ['duplicity'] }, hands: { 0: ['chalice'] }, turn: 0 });
      expect(abilityNames(start, 0)).toEqual([]);
    }
  });

  it('a face-down Interest does not draw when a Coin card enters', () => {
    const start = buildPosition({
      hands: { 0: ['chalice'] },
      keeps: { 1: [{ id: 'interest', faceDown: { placedBy: 0 } }] },
      piles: { 1: ['dagger'] },
      turn: 0,
    });
    // No Duplicity holder, so no reveal window either.
    const { state, events } = act(start, 0, { action: 'play', card: 'chalice', target: 1 });
    expect(types(events)).not.toContain('trigger');
    expect(state.hands[1]).toEqual([]);
  });

  it('a face-down Retribution does not trigger', () => {
    const start = buildPosition({
      hands: { 0: ['chalice'] },
      keeps: { 1: [{ id: 'retribution', faceDown: { placedBy: 0 } }] },
      turn: 0,
    });
    expect(types(act(start, 0, { action: 'play', card: 'chalice', target: 1 }).events)).not.toContain('trigger');
  });

  it('a face-down Last Laugh that stays hidden gives no action at round end', () => {
    const start = buildPosition({ keeps: { 0: ['duplicity', { id: 'last-laugh', faceDown: { placedBy: 0 } }] }, hands: { 0: ['chalice'] }, turn: 0 });
    const ended = draw(start, 0);
    const passed = respond(ended.state, 0, { kind: 'reveal-window', reveal: false });
    expect(types(passed.events)).not.toContain('last-laugh');
    // Straight to the second window (the face-down card can still be revealed for scoring).
    expect(promptFor(passed.state, 0, 'reveal-window').reason).toBe('before-scoring');
  });

  it('a revealed Last Laugh after its window has passed gives no action', () => {
    const start = buildPosition({ keeps: { 0: ['duplicity', { id: 'last-laugh', faceDown: { placedBy: 0 } }] }, hands: { 0: ['chalice'] }, turn: 0 });
    const ended = draw(start, 0);
    const passed = respond(ended.state, 0, { kind: 'reveal-window', reveal: false });
    const { state, events } = respond(passed.state, 0, { kind: 'reveal-window', reveal: true });
    expect(types(events)).toEqual(['reveal', 'score', 'mark']);
    expect(state.phase).toBe('round-over');
  });
});

describe('token victories in unusual places', () => {
  it('Legerdemain stealing the last Token and playing it as HOT wins at once', () => {
    const start = buildPosition({
      hands: { 0: ['legerdemain'], 2: ['count-token'] },
      keeps: { 0: ['fool-token', 'friar-token'] },
      turn: 0,
    });
    const stolen = respond(act(start, 0, { action: 'play', card: 'legerdemain' }).state, 0, { kind: 'choose-player', seat: 2 });
    const { state, events } = hotTarget(stolen.state, 0, 0);
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'tokens', winner: 0 }]);
    expect(state.marks).toEqual([1, 0, 0, 0]);
  });

  it('a token victory cancels pending triggers and Retribution', () => {
    // The third Token goes into S1's keep, which has Interest and Retribution.
    const start = buildPosition({
      hands: { 0: ['friar-token'] },
      keeps: { 1: ['count-token', 'fool-token', 'interest', 'retribution'] },
      piles: { 1: ['chalice'] },
      turn: 0,
    });
    const { state, events } = act(start, 0, { action: 'play', card: 'friar-token', target: 1 });
    expect(types(events)).not.toContain('trigger');
    expect(state.hands[1]).toEqual([]);
    expect(state.marks).toEqual([0, 1, 0, 0]);
  });

  it('a Token swapped away by Providence breaks a would-be set; swapping it back completes it', () => {
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 0: ['count-token', 'fool-token', 'chalice'], 3: ['friar-token'] },
      piles: { 0: ['dagger'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const { state } = respond(played.state, 0, { kind: 'choose-keep-pair', a: { seat: 0, index: 2 }, b: { seat: 3, index: 0 } });
    expect(state.roundEnd).toEqual({ kind: 'tokens', winner: 0 });
  });
});

describe('post-round actions', () => {
  it('Interest still draws from a non-empty pile after the round ends', () => {
    const start = buildPosition({
      keeps: { 0: ['last-laugh'], 2: ['interest'] },
      hands: { 0: ['chalice'] },
      piles: { 2: ['dagger'] },
      turn: 0,
    });
    const ended = draw(start, 0).state;
    const { state } = act(ended, 0, { action: 'play', card: 'chalice', target: 2 });
    expect(state.hands[2]).toEqual(['dagger']);
    expect(state.phase).toBe('round-over');
  });

  it('Legerdemain as the Last Laugh action steals and plays a card before scoring', () => {
    const start = buildPosition({
      keeps: { 0: ['last-laugh'], 1: ['faberge-egg'] },
      hands: { 0: ['legerdemain'], 1: ['chalice'] },
      turn: 0,
    });
    const ended = draw(start, 0).state;
    const stolen = respond(act(ended, 0, { action: 'play', card: 'legerdemain' }).state, 0, { kind: 'choose-player', seat: 1 });
    const { events } = hotTarget(stolen.state, 0, 0);
    // S0 has 2 coins, S1 has 3: S1 still wins, but the Chalice counted.
    expect(payloads(events, 'score')[0]).toMatchObject({ scores: [4, 6, 0, 0], winner: 1 });
  });

  it('a HOT card drawn during the Last Laugh action is played before scoring', () => {
    const start = buildPosition({ keeps: { 2: ['last-laugh', 'sanction'] }, piles: { 2: ['blunder'] }, turn: 0, seats: ['player', 'ghost', 'player', 'ghost'] });
    const ended = draw(start, 0).state;
    // Sanction is restricted during Last Laugh, so S2 draws normally.
    expect(abilityNames(ended, 2)).toEqual([]);
    const { state, events } = draw(ended, 2);
    expect(state.keeps[2].map((c) => c.id)).toEqual(['last-laugh', 'sanction', 'blunder']);
    expect(payloads(events, 'score')[0]).toMatchObject({ scores: [0, null, -20, null], winner: 0 });
  });

  it('revealing in the last window before scoring can change the winner', () => {
    const start = buildPosition({
      keeps: { 0: ['duplicity', { id: 'faberge-egg', faceDown: { placedBy: 0 } }], 1: ['chalice'] },
      turn: 0,
    });
    const ended = draw(start, 0);
    const first = respond(ended.state, 0, { kind: 'reveal-window', reveal: false });
    const { events } = respond(first.state, 0, { kind: 'reveal-window', reveal: true });
    expect(payloads(events, 'score')[0]).toMatchObject({ scores: [6, 4, 0, 0], winner: 0 });
  });
});
