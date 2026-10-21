import { describe, expect, it } from 'vitest';
import { buildPosition } from '../../src/index.ts';
import {
  abilityNames,
  act,
  actionChoices,
  actionsLeft,
  draw,
  hotTarget,
  payloads,
  promptFor,
  respond,
  types,
} from '../helpers.ts';

// Rules-correctness checks from a line-by-line read of the card texts and
// the rules card: who decides, what counts as "changing your hand or keep",
// and how nested plays (Legerdemain, Invocation, Joker) behave.

describe('who decides', () => {
  it("a HOT Keep card drawn by another player's trigger is placed by that player", () => {
    // S0 plays Chalice into S1's keep; S1's Interest draws Juggling, so S1 chooses its keep.
    const start = buildPosition({
      hands: { 0: ['chalice'] },
      keeps: { 1: ['interest'] },
      piles: { 1: ['juggling'] },
      turn: 0,
    });
    const { state } = act(start, 0, { action: 'play', card: 'chalice', target: 1 });
    expect(state.prompts.map((p) => [p.seat, p.kind])).toEqual([[1, 'hot-target']]);
    const placed = hotTarget(state, 1, 3);
    expect(placed.state.keeps[3]).toEqual([{ id: 'juggling' }]);
    // Back to S0's turn.
    promptFor(placed.state, 0, 'action');
  });

  it('a Keep card stolen with Legerdemain is placed by the thief, into any keep', () => {
    const start = buildPosition({ hands: { 0: ['legerdemain'], 3: ['duplicity'], }, turn: 0 });
    const stolen = respond(act(start, 0, { action: 'play', card: 'legerdemain' }).state, 0, { kind: 'choose-player', seat: 3 });
    expect(promptFor(stolen.state, 0, 'hot-target').card).toBe('duplicity');
  });

  it('a stolen Duplicity, played as HOT, still makes its player hide a Keep card', () => {
    const start = buildPosition({ hands: { 0: ['legerdemain', 'chalice'], 3: ['duplicity'] }, turn: 0 });
    const stolen = respond(act(start, 0, { action: 'play', card: 'legerdemain' }).state, 0, { kind: 'choose-player', seat: 3 });
    const placed = hotTarget(stolen.state, 0, 0);
    expect(promptFor(placed.state, 0, 'duplicity-hide').options).toEqual(['chalice']);
  });

  it('an invoked Fiat starts the pile claims with the player who invoked it', () => {
    const start = buildPosition({ piles: { 0: ['invocation'], 2: ['fiat'] }, turn: 0 });
    const invoked = respond(draw(start, 0).state, 0, { kind: 'choose-pile', pile: 2 });
    const placed = hotTarget(invoked.state, 0, 3);
    expect(placed.state.keeps[3]).toEqual([{ id: 'fiat' }]);
    expect(promptFor(placed.state, 0, 'claim-pile').claimant).toBe(0);
  });

  it('extra actions reached through a trigger belong to the trigger’s owner, not the turn player', () => {
    // S0's Chalice → S1's Interest draws Invocation (HOT) → S1 invokes Hocus Pocus: S1 gets two actions.
    const start = buildPosition({
      hands: { 0: ['chalice'] },
      keeps: { 1: ['interest', 'sanction'] },
      piles: { 1: ['invocation'], 2: ['hocus-pocus'], 3: ['dagger'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'chalice', target: 1 });
    const invoked = respond(played.state, 1, { kind: 'choose-pile', pile: 2 });
    expect(invoked.state.stack.at(-1)).toMatchObject({ op: 'action-frame', seat: 1, kind: 'hocus-pocus', remaining: 2 });
    // It's still S0's turn, so S1's Sanction ("on your turn") can't be used.
    expect(abilityNames(invoked.state, 1)).toEqual([]);
  });
});

describe('what changes a Retribution owner’s hand or keep', () => {
  it('Legerdemain on an empty-handed owner takes nothing: no trigger', () => {
    const start = buildPosition({ hands: { 0: ['legerdemain'] }, keeps: { 1: ['retribution'] }, turn: 0 });
    const { events } = respond(act(start, 0, { action: 'play', card: 'legerdemain' }).state, 0, { kind: 'choose-player', seat: 1 });
    expect(types(events)).not.toContain('trigger');
  });

  it('Pickpocket on an owner with no Coin cards in hand takes nothing: no trigger', () => {
    const start = buildPosition({ hands: { 0: ['pickpocket'], 1: ['joker'] }, keeps: { 1: ['retribution'] }, turn: 0 });
    const { events } = respond(act(start, 0, { action: 'play', card: 'pickpocket' }).state, 0, { kind: 'choose-player', seat: 1 });
    expect(types(events)).not.toContain('trigger');
  });

  it("drawing from the owner's pile (Invocation, Sanction) is not their hand or keep", () => {
    const start = buildPosition({
      keeps: { 0: ['sanction'], 1: ['retribution'] },
      piles: { 1: ['chalice'] },
      turn: 0,
    });
    const { events } = act(start, 0, { action: 'ability', card: 'sanction', from: 1 });
    expect(types(events)).not.toContain('trigger');
  });

  it('Requisition taking from the owner’s pile is not their hand or keep', () => {
    const start = buildPosition({ hands: { 0: ['requisition'] }, keeps: { 1: ['retribution'] }, piles: { 1: ['chalice'] }, turn: 0 });
    const looked = respond(act(start, 0, { action: 'play', card: 'requisition' }).state, 0, { kind: 'choose-pile', pile: 1 });
    expect(types(respond(looked.state, 0, { kind: 'choose-pile-card', index: 0 }).events)).not.toContain('trigger');
  });

  it("Fiat played into the owner's keep triggers it once the claims are done", () => {
    const start = buildPosition({ keeps: { 1: ['retribution'] }, piles: { 0: ['fiat', 'chalice'], 1: ['dagger', 'scepter'] }, turn: 0 });
    let state = hotTarget(draw(start, 0).state, 0, 1).state;
    for (const seat of [0, 1, 2, 3] as const) {
      expect(state.stack.some((op) => op.op === 'action-frame' && op.kind === 'retribution')).toBe(false);
      state = respond(state, seat, { kind: 'claim-pile', from: promptFor(state, seat, 'claim-pile').options[0]! }).state;
    }
    expect(state.stack.at(-1)).toMatchObject({ op: 'action-frame', seat: 1, kind: 'retribution', remaining: 2 });
  });

  it('Joker copying Offering makes a giving owner retaliate', () => {
    const start = buildPosition({ hands: { 0: ['joker', 'offering'], 1: ['chalice'] }, keeps: { 1: ['retribution'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'joker', copy: 'offering' });
    // Offering discards S0's hand (including the revealed Offering) first.
    expect(played.state.discard).toEqual(['joker', 'offering']);
    const { events } = respond(played.state, 1, { kind: 'give-card', card: 'chalice' });
    expect(payloads(events, 'trigger').map((t) => t.kind)).toEqual(['retribution']);
  });

  it("Offering played by the Retribution owner doesn't trigger their own Retribution", () => {
    const start = buildPosition({ hands: { 0: ['offering'], 2: ['chalice'] }, keeps: { 0: ['retribution'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'offering' });
    expect(types(respond(played.state, 2, { kind: 'give-card', card: 'chalice' }).events)).not.toContain('trigger');
  });
});

describe('Retribution actions', () => {
  it('a Shackled owner still gets both Retribution actions (Shackles only limits their turn)', () => {
    const start = buildPosition({ hands: { 0: ['chalice'] }, keeps: { 1: ['retribution', 'shackles'] }, piles: { 1: ['dagger', 'scepter'] }, turn: 0 });
    const { state } = act(start, 0, { action: 'play', card: 'chalice', target: 1 });
    expect(state.stack.at(-1)).toMatchObject({ seat: 1, kind: 'retribution', remaining: 2 });
  });

  it('Hocus Pocus during Retribution: two actions become three', () => {
    const start = buildPosition({
      hands: { 0: ['chalice'], 1: ['hocus-pocus'] },
      keeps: { 1: ['retribution'] },
      piles: { 1: ['dagger', 'scepter', 'medallion'] },
      turn: 0,
    });
    let state = act(start, 0, { action: 'play', card: 'chalice', target: 1 }).state;
    state = act(state, 1, { action: 'play', card: 'hocus-pocus' }).state;
    for (let i = 0; i < 3; i++) {
      promptFor(state, 1, 'action');
      state = draw(state, 1).state;
    }
    promptFor(state, 0, 'action');
  });
});

describe('Blunder: any two consecutive actions (C-08)', () => {
  it("C-08 a stolen Hocus Pocus's last action plus the next turn action can remove Blunder", () => {
    // Nothing happens between the Hocus Pocus actions and S0's remaining turn
    // action, so they are consecutive, just as with a Hocus Pocus played from hand.
    const start = buildPosition({
      keeps: { 0: ['blunder'] },
      hands: { 0: ['legerdemain'], 1: ['hocus-pocus'] },
      piles: { 0: ['chalice'] },
      turn: 0,
    });
    const stolen = respond(act(start, 0, { action: 'play', card: 'legerdemain' }).state, 0, { kind: 'choose-player', seat: 1 });
    const drawn = draw(stolen.state, 0);
    expect(actionsLeft(drawn.state)).toBe(1);
    expect(actionChoices(drawn.state, 0)).toContainEqual({ action: 'ability', card: 'blunder', pile: 2 });
  });

  it('Q-17 stealing Hocus Pocus from a Retribution owner: their actions come first, then all of yours are consecutive', () => {
    const start = buildPosition({
      keeps: { 0: ['blunder'], 1: ['retribution'] },
      hands: { 0: ['legerdemain'], 1: ['hocus-pocus'] },
      piles: { 0: ['chalice', 'dagger'], 1: ['scepter', 'medallion'] },
      turn: 0,
    });
    const stolen = respond(act(start, 0, { action: 'play', card: 'legerdemain' }).state, 0, { kind: 'choose-player', seat: 1 });
    // S1 retaliates before S0 gets the stolen card's two actions.
    promptFor(stolen.state, 1, 'action');
    const state = draw(draw(stolen.state, 1).state, 1).state;
    // S0: 2 Hocus Pocus actions + 1 turn action, nothing between them.
    expect(state.stack.flatMap((op) => (op.op === 'action-frame' ? [[op.seat, op.kind, op.remaining]] : []))).toEqual([
      [0, 'turn', 1],
      [0, 'hocus-pocus', 2],
    ]);
    const afterOne = draw(state, 0).state;
    expect(abilityNames(afterOne, 0)).toEqual(['blunder']);
  });
});

describe('piles', () => {
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

  it('Blunder may be placed on your own pile', () => {
    const start = buildPosition({ keeps: { 0: ['blunder'] }, piles: { 0: ['chalice'] }, turn: 0 });
    expect(actionChoices(start, 0)).toContainEqual({ action: 'ability', card: 'blunder', pile: 0 });
  });

  it('drawing your last card does not end the round; the next draw from that pile does', () => {
    const start = buildPosition({ piles: { 0: ['chalice'] }, turn: 0 });
    const last = draw(start, 0);
    expect(last.state.phase).toBe('playing');
    expect(types(draw(last.state, 0).events)).toContain('round-end');
  });
});
