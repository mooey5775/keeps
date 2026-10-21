import { describe, expect, it } from 'vitest';
import {
  apply,
  buildPosition,
  checkRestInvariants,
  legalCommands,
  newGame,
  type Command,
} from '../src/index.ts';
import { actionCommand, draw, promptFor } from './helpers.ts';

function rejection(result: ReturnType<typeof apply>) {
  if (result.ok) throw new Error('expected the command to be rejected');
  return result.error.code;
}

describe('apply', () => {
  it('never modifies the state it is given', () => {
    const start = buildPosition({ piles: { 0: ['blunder', 'chalice'] }, turn: 0 });
    const before = JSON.stringify(start);
    const result = apply(start, 0, actionCommand(start, 0, { action: 'draw' }));
    expect(result.ok).toBe(true);
    expect(JSON.stringify(start)).toBe(before);
  });

  it('is deterministic', () => {
    const start = newGame({ players: 3, seed: 'deterministic' }).state;
    const seat = start.turn!.seat;
    const command = actionCommand(start, seat, { action: 'draw' });
    expect(apply(start, seat, command)).toEqual(apply(start, seat, command));
  });

  it('rejects an unknown prompt id', () => {
    const start = buildPosition({ piles: { 0: ['chalice'] }, turn: 0 });
    const command: Command = { type: 'answer', promptId: 'p999', answer: { kind: 'action', choice: { action: 'draw' } } };
    expect(rejection(apply(start, 0, command))).toBe('unknown-prompt');
  });

  it("rejects answering another player's prompt", () => {
    const start = buildPosition({ piles: { 0: ['chalice'] }, turn: 0 });
    expect(rejection(apply(start, 1, actionCommand(start, 0, { action: 'draw' })))).toBe('not-your-prompt');
  });

  it('rejects reusing a prompt that was already answered', () => {
    const start = buildPosition({ piles: { 0: ['chalice', 'dagger'] }, turn: 0 });
    const stale = actionCommand(start, 0, { action: 'draw' });
    const next = draw(start, 0).state;
    expect(rejection(apply(next, 0, stale))).toBe('unknown-prompt');
  });

  it('rejects playing a card you do not hold', () => {
    const start = buildPosition({ hands: { 1: ['dagger'] }, turn: 0 });
    expect(rejection(apply(start, 0, actionCommand(start, 0, { action: 'play', card: 'dagger', target: 0 })))).toBe('illegal');
  });

  it('rejects a Keep card without a target, or a non-Keep card with one', () => {
    const start = buildPosition({ hands: { 0: ['dagger', 'hocus-pocus'] }, turn: 0 });
    expect(rejection(apply(start, 0, actionCommand(start, 0, { action: 'play', card: 'dagger' })))).toBe('illegal');
    expect(
      rejection(apply(start, 0, actionCommand(start, 0, { action: 'play', card: 'hocus-pocus', target: 0 }))),
    ).toBe('illegal');
  });

  it('rejects commands from ghost seats', () => {
    const start = buildPosition({ seats: ['player', 'ghost', 'player', 'ghost'], turn: 0 });
    expect(rejection(apply(start, 1, { type: 'next-round' }))).toBe('not-a-player');
    expect(legalCommands(start, 1)).toEqual([]);
  });

  it('rejects next-round while a round is in progress', () => {
    const start = buildPosition({ piles: { 0: ['chalice'] }, turn: 0 });
    expect(rejection(apply(start, 0, { type: 'next-round' }))).toBe('illegal');
  });

  it('rejects cards whose rules are not implemented yet instead of misplaying them', () => {
    const start = buildPosition({ hands: { 0: ['duplicity', 'chalice'] }, turn: 0 });
    const result = apply(start, 0, actionCommand(start, 0, { action: 'play', card: 'duplicity', target: 0 }));
    expect(rejection(result)).toBe('not-implemented');
  });
});

describe('newGame', () => {
  it('starts round 1 waiting on the first player', () => {
    const { state, events } = newGame({ players: 4, seed: 'start', firstSeat: 2 });
    expect(state.turn?.seat).toBe(2);
    expect(promptFor(state, 2, 'action').kind).toBe('action');
    expect(checkRestInvariants(state)).toEqual([]);
    expect(events.at(-2)?.payload).toEqual({ type: 'turn-start', seat: 2, actions: 2 });
  });
});
