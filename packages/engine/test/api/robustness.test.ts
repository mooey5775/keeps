import { describe, expect, it } from 'vitest';
import { apply, buildPosition, legalCommands, newGame, type Answer, type Command, type GameState, type Seat } from '../../src/index.ts';
import { act, actionCommand, draw, promptFor } from '../helpers.ts';

// apply() must reject anything that isn't exactly a legal command, report
// why, and leave the given state untouched. Commands arrive from browsers,
// so they can be stale, malformed, or deliberately wrong.

function rejected(state: GameState, seat: Seat, command: Command): string {
  const before = JSON.stringify(state);
  const result = apply(state, seat, command);
  expect(JSON.stringify(state)).toBe(before);
  if (result.ok) throw new Error(`accepted: ${JSON.stringify(command)}`);
  return result.error.code;
}

/** An answer to `seat`'s open prompt of the given kind, with arbitrary content. */
function answer(state: GameState, seat: Seat, kind: Answer['kind'], body: object): Command {
  const prompt = promptFor(state, seat, kind);
  return { type: 'answer', promptId: prompt.id, answer: { kind, ...body } as Answer };
}

describe('malformed action choices', () => {
  const start = () =>
    buildPosition({
      hands: { 0: ['chalice', 'joker', 'hocus-pocus'] },
      keeps: { 0: ['juggling', 'sanction', 'acquisition'] },
      piles: { 0: ['dagger'] },
      turn: 0,
    });

  it.each([
    ['an unknown action', { action: 'dance' }],
    ['a card id that does not exist', { action: 'play', card: 'banana', target: 0 }],
    ['a Keep card into seat 7', { action: 'play', card: 'chalice', target: 7 }],
    ['Joker copying a Keep card', { action: 'play', card: 'joker', copy: 'chalice' }],
    ['Joker copying itself', { action: 'play', card: 'joker', copy: 'joker' }],
    ['Joker copying a card not in hand', { action: 'play', card: 'joker', copy: 'prayer' }],
    ['Joker with no copy', { action: 'play', card: 'joker' }],
    ['Juggling a pile with itself', { action: 'ability', card: 'juggling', piles: [1, 1] }],
    ['Juggling pile 4', { action: 'ability', card: 'juggling', piles: [0, 4] }],
    ['Sanction from pile -1', { action: 'ability', card: 'sanction', from: -1 }],
    ['Acquisition discarding a card not in hand', { action: 'ability', card: 'acquisition', discard: 'prayer', first: 'left' }],
    ['Acquisition with a bad side', { action: 'ability', card: 'acquisition', discard: 'chalice', first: 'up' }],
    ['an ability whose card is not in your keep', { action: 'ability', card: 'tithes' }],
    ['Blunder removal without Blunder', { action: 'ability', card: 'blunder', pile: 1 }],
    ['passing outside Last Laugh', { action: 'pass' }],
  ])('rejects %s', (_label, choice) => {
    const state = start();
    expect(rejected(state, 0, answer(state, 0, 'action', { choice }))).toBe('illegal');
  });

  it('rejects an answer of the wrong kind for the prompt', () => {
    const state = start();
    const prompt = promptFor(state, 0, 'action');
    const command: Command = { type: 'answer', promptId: prompt.id, answer: { kind: 'choose-pile', pile: 0 } };
    expect(rejected(state, 0, command)).toBe('illegal');
  });

  it('rejects an unknown command type and an invalid seat', () => {
    const state = start();
    expect(rejected(state, 0, { type: 'shuffle' } as unknown as Command)).toBe('illegal');
    expect(rejected(state, 9 as Seat, { type: 'next-round' })).toBe('not-a-player');
  });

  it('extra fields on a command make it a different, illegal command', () => {
    const state = start();
    const command = answer(state, 0, 'action', { choice: { action: 'draw', from: 2 } });
    expect(rejected(state, 0, command)).toBe('illegal');
  });
});

describe('malformed effect answers', () => {
  it('Requisition: index past the end of the pile', () => {
    const start = buildPosition({ hands: { 0: ['requisition'] }, piles: { 2: ['chalice'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'requisition' }).state;
    expect(rejected(played, 0, answer(played, 0, 'choose-pile', { pile: 3 }))).toBe('illegal');
    const looking = apply(played, 0, answer(played, 0, 'choose-pile', { pile: 2 }));
    if (!looking.ok) throw new Error('setup');
    for (const index of [1, -1, 0.5]) {
      expect(rejected(looking.state, 0, answer(looking.state, 0, 'choose-pile-card', { index }))).toBe('illegal');
    }
  });

  it('Providence: missing refs, the same card twice, or a card that is not there', () => {
    const start = buildPosition({ hands: { 0: ['providence'] }, keeps: { 1: ['chalice'], 2: ['dagger'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'providence' }).state;
    const bad = [
      { a: { seat: 1, index: 0 }, b: { seat: 1, index: 0 } },
      { a: { seat: 1, index: 0 }, b: { seat: 2, index: 1 } },
      { a: { seat: 3, index: 0 }, b: { seat: 2, index: 0 } },
      // A missing card is covered by malformed.test.ts (it currently throws).
    ];
    for (const body of bad) expect(rejected(played, 0, answer(played, 0, 'choose-keep-pair', body))).toBe('illegal');
  });

  it('Resurrection: a card that is not in the discard', () => {
    const start = buildPosition({ hands: { 0: ['resurrection'] }, discard: ['chalice'], turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'resurrection' }).state;
    expect(rejected(played, 0, answer(played, 0, 'choose-discard-card', { card: 'dagger' }))).toBe('illegal');
  });

  it('Legerdemain: seat 4', () => {
    const start = buildPosition({ hands: { 0: ['legerdemain'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'legerdemain' }).state;
    expect(rejected(played, 0, answer(played, 0, 'choose-player', { seat: 4 }))).toBe('illegal');
  });

  it('Pluck: a card that player does not hold', () => {
    const start = buildPosition({ hands: { 0: ['pluck'], 1: ['chalice'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'pluck' }).state;
    expect(rejected(played, 0, answer(played, 0, 'choose-hand-card', { seat: 1, card: 'dagger' }))).toBe('illegal');
    expect(rejected(played, 0, answer(played, 0, 'choose-hand-card', { seat: 2, card: 'chalice' }))).toBe('illegal');
  });

  it('Offering: giving a card you do not hold, or answering for someone else', () => {
    const start = buildPosition({ hands: { 0: ['offering'], 1: ['chalice'], 2: ['dagger'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'offering' }).state;
    expect(rejected(played, 1, answer(played, 1, 'give-card', { card: 'dagger' }))).toBe('illegal');
    expect(rejected(played, 2, answer(played, 1, 'give-card', { card: 'chalice' }))).toBe('not-your-prompt');
  });

  it('Fiat: claiming a pile that was already claimed', () => {
    const start = buildPosition({ piles: { 0: ['fiat', 'chalice'] }, turn: 0 });
    const drawn = draw(start, 0).state;
    const placed = apply(drawn, 0, answer(drawn, 0, 'hot-target', { target: 0 }));
    if (!placed.ok) throw new Error('setup');
    const claimed = apply(placed.state, 0, answer(placed.state, 0, 'claim-pile', { from: 2 }));
    if (!claimed.ok) throw new Error('setup');
    expect(rejected(claimed.state, 1, answer(claimed.state, 1, 'claim-pile', { from: 2 }))).toBe('illegal');
  });

  it('Duplicity: hiding into a ghost keep, or a non-Keep card', () => {
    const start = buildPosition({
      seats: ['player', 'ghost', 'player', 'ghost'],
      hands: { 0: ['duplicity', 'chalice', 'prayer'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'duplicity', target: 0 }).state;
    expect(rejected(played, 0, answer(played, 0, 'duplicity-hide', { card: 'chalice', target: 1 }))).toBe('illegal');
    expect(rejected(played, 0, answer(played, 0, 'duplicity-hide', { card: 'prayer', target: 0 }))).toBe('illegal');
  });

  it('HOT target: a ghost keep', () => {
    const start = buildPosition({ seats: ['player', 'ghost', 'player', 'ghost'], piles: { 0: ['juggling'] }, turn: 0 });
    const drawn = draw(start, 0).state;
    expect(rejected(drawn, 0, answer(drawn, 0, 'hot-target', { target: 3 }))).toBe('illegal');
  });

  it('Pandemonium: a direction that is not left or right', () => {
    const start = buildPosition({ piles: { 0: ['pandemonium'] }, turn: 0 });
    const drawn = draw(start, 0).state;
    expect(rejected(drawn, 0, answer(drawn, 0, 'choose-direction', { direction: 'up' }))).toBe('illegal');
  });

  it('a reveal from someone who does not hold Duplicity', () => {
    const start = buildPosition({ keeps: { 1: ['duplicity', { id: 'chalice', faceDown: { placedBy: 1 } }] }, piles: { 0: ['dagger'] }, turn: 0 });
    expect(rejected(start, 0, { type: 'reveal-duplicity' })).toBe('illegal');
    expect(apply(start, 1, { type: 'reveal-duplicity' }).ok).toBe(true);
  });
});

describe('serialization', () => {
  it('a state survives a JSON round trip: the copy plays out exactly like the original', () => {
    let state = newGame({ players: 4, seed: 'json', marksToWin: 2 }).state;
    for (let i = 0; i < 60 && state.phase !== 'game-over'; i++) {
      const seat = state.prompts[0]?.seat ?? 0;
      const command = legalCommands(state, seat)[0] ?? { type: 'next-round' as const };
      const copy = JSON.parse(JSON.stringify(state)) as GameState;
      const a = apply(state, seat, command);
      const b = apply(copy, seat, command);
      expect(b).toEqual(a);
      if (!a.ok) throw new Error(a.error.message);
      state = a.state;
    }
  });

  it('legal commands survive a JSON round trip and are still accepted', () => {
    const start = buildPosition({ hands: { 0: ['providence', 'chalice'] }, keeps: { 1: ['dagger'], 2: ['scepter'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'providence' }).state;
    for (const command of legalCommands(played, 0)) {
      const sent = JSON.parse(JSON.stringify(command)) as Command;
      expect(apply(played, 0, sent).ok).toBe(true);
    }
  });

  it('a command for an old state is rejected against the new one', () => {
    const start = buildPosition({ piles: { 0: ['chalice', 'dagger'] }, turn: 0 });
    const stale = actionCommand(start, 0, { action: 'draw' });
    const moved = draw(start, 0).state;
    expect(rejected(moved, 0, stale)).toBe('unknown-prompt');
  });
});
