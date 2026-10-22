import { describe, expect, it } from 'vitest';
import { buildPosition, keepValue, legalCommands } from '../../src/index.ts';
import {
  abilityNames,
  act,
  actionChoices,
  actionsLeft,
  draw,
  keepOf,
  payloads,
  pileIds,
  promptFor,
  respond,
} from '../helpers.ts';

describe('Blunder', () => {
  it('costs two actions to place it face-up onto any pile', () => {
    const start = buildPosition({ keeps: { 0: ['blunder'] }, piles: { 2: ['chalice'] }, turn: 0 });
    expect(abilityNames(start, 0)).toEqual(['blunder']);
    const { state, events } = act(start, 0, { action: 'ability', card: 'blunder', pile: 2 });
    expect(state.keeps[0]).toEqual([]);
    expect(state.piles[state.pileAt[2]].cards).toEqual([
      { id: 'blunder', faceUp: true },
      { id: 'chalice', faceUp: false },
    ]);
    expect(payloads(events, 'turn-end')).toEqual([{ type: 'turn-end', seat: 0 }]);
  });

  it('whoever draws the placed Blunder must play it into their own keep (Blunder 2)', () => {
    const start = buildPosition({ keeps: { 0: ['blunder'] }, piles: { 1: ['chalice'] }, turn: 0 });
    const placed = act(start, 0, { action: 'ability', card: 'blunder', pile: 1 });
    const { state, events } = draw(placed.state, 1);
    expect(state.keeps[1]).toEqual([{ id: 'blunder' }]);
    // A face-up card's draw is public.
    expect(events.find((e) => e.payload.type === 'draw')!.visibility).toBe('all');
  });

  it('is worth -10 coins', () => {
    expect(keepValue(keepOf('blunder'))).toBe(-20);
  });

  it('can never be played into another keep, even when invoked by someone else', () => {
    const start = buildPosition({ piles: { 0: ['invocation'], 2: ['blunder'] }, turn: 0 });
    const { state } = respond(draw(start, 0).state, 0, { kind: 'choose-pile', pile: 2 });
    // S0 invoked it, so it goes into S0's keep with no choice offered.
    expect(state.keeps[0]).toEqual([{ id: 'blunder' }]);
    expect(state.prompts.map((p) => p.kind)).toEqual(['action']);
  });

  it('removing it from your keep brings your score back up (Blunder 1)', () => {
    const start = buildPosition({
      keeps: { 0: ['blunder', 'medallion', 'royal-favor'] },
      hands: { 0: ['hocus-pocus'] },
      turn: 0,
    });
    const hocus = act(start, 0, { action: 'play', card: 'hocus-pocus' });
    const removed = act(hocus.state, 0, { action: 'ability', card: 'blunder', pile: 2 });
    expect(keepValue(removed.state.keeps[0])).toBe(5);
    const { events } = draw(removed.state, 0);
    expect(payloads(events, 'score')[0]).toMatchObject({ winner: 0 });
  });

  it('Blunder may be placed on your own pile', () => {
    const start = buildPosition({ keeps: { 0: ['blunder'] }, piles: { 0: ['chalice'] }, turn: 0 });
    expect(actionChoices(start, 0)).toContainEqual({ action: 'ability', card: 'blunder', pile: 0 });
  });
});

describe('removing Blunder takes any two consecutive actions (C-08)', () => {
  it("C-08 any two consecutive actions work: Hocus Pocus's last action plus a turn action", () => {
    const start = buildPosition({
      keeps: { 0: ['blunder'] },
      hands: { 0: ['hocus-pocus'] },
      piles: { 0: ['chalice'], 3: ['dagger'] },
      turn: 0,
    });
    const hocus = act(start, 0, { action: 'play', card: 'hocus-pocus' }); // turn: 1 left, Hocus Pocus: 2
    const drawn = draw(hocus.state, 0); // Hocus Pocus: 1 left
    expect(abilityNames(drawn.state, 0)).toEqual(['blunder']);
    const { state } = act(drawn.state, 0, { action: 'ability', card: 'blunder', pile: 3 });
    expect(pileIds(state, 3)).toEqual(['blunder', 'dagger']);
    expect(state.turn?.seat).toBe(1);
  });

  it('C-08 both Retribution actions can be used to remove Blunder', () => {
    const start = buildPosition({
      keeps: { 1: ['blunder'] },
      turn: 0,
      frames: [{ seat: 1, kind: 'retribution', remaining: 2 }],
    });
    expect(actionChoices(start, 1)).toContainEqual({ action: 'ability', card: 'blunder', pile: 0 });
  });

  it('Q-03 removing Blunder cannot span two turns, or a Shackled single action', () => {
    const start = buildPosition({ keeps: { 0: ['blunder'] }, piles: { 0: ['chalice'] }, turn: 0 });
    expect(abilityNames(draw(start, 0).state, 0)).toEqual([]);
    const shackled = buildPosition({ keeps: { 0: ['blunder', 'shackles'] }, turn: 0 });
    expect(abilityNames(shackled, 0)).toEqual(['shackles']);
  });

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

  it("a Retribution owner with one action left can't remove Blunder by borrowing the turn player's action", () => {
    const start = buildPosition({
      keeps: { 1: ['blunder', 'retribution'] },
      piles: { 1: ['chalice'] },
      turn: 0,
      frames: [{ seat: 1, kind: 'retribution', remaining: 1 }],
    });
    // S0's turn frame (2 actions) sits right under S1's last Retribution action.
    expect(start.stack.map((op) => (op.op === 'action-frame' ? `${op.seat}:${op.remaining}` : op.op))).toEqual(['0:2', '1:1']);
    expect(legalCommands(start, 1).some((c) => c.type === 'answer' && c.answer.kind === 'action' && c.answer.choice.action === 'ability')).toBe(false);
  });
});
