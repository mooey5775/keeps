import { describe, expect, it } from 'vitest';
import {
  apply,
  buildPosition,
  legalCommands,
  newGame,
  pick,
  playerSeats,
  seedRng,
  type Answer,
  type Command,
  type GameState,
  type Seat,
} from '../../src/index.ts';
import { act, actionCommand, draw, promptFor } from '../helpers.ts';

// apply() must reject anything that isn't exactly a legal command, report
// why, and leave the given state untouched. Commands arrive from browsers,
// so they can be stale, malformed, or deliberately wrong. It must never
// throw on bad input: a thrown exception would take down the server's
// message handler.

function neverThrows(state: GameState, seat: number, command: unknown): string | null {
  try {
    const result = apply(state, seat as never, command as Command);
    return result.ok ? null : result.error.code;
  } catch (error) {
    return `THROWS: ${(error as Error).message}`;
  }
}

/** Every legal answer with one field replaced (or removed), for every junk value. */
function mutations(command: Command): unknown[] {
  if (command.type !== 'answer') return [];
  const out: unknown[] = [];
  const answer = command.answer as Record<string, unknown>;
  for (const key of Object.keys(answer)) {
    if (key === 'kind') continue;
    for (const junk of JUNK) {
      const copy = structuredClone(command) as { answer: Record<string, unknown> };
      if (junk === undefined) delete copy.answer[key];
      else copy.answer[key] = junk;
      out.push(copy);
    }
  }
  if (command.answer.kind === 'action') {
    for (const key of Object.keys(command.answer.choice)) {
      for (const junk of JUNK) {
        const copy = structuredClone(command) as { answer: { choice: Record<string, unknown> } };
        if (junk === undefined) delete copy.answer.choice[key];
        else copy.answer.choice[key] = junk;
        out.push(copy);
      }
    }
  }
  return out;
}

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

const JUNK: unknown[] = [undefined, null, 0, -1, 99, 'x', true, [], {}, [0, 0], { seat: 0 }, { seat: 1, index: 0 }];

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

describe('malformed commands never throw', () => {
  it('top-level shapes: null, primitives, and missing or null answers', () => {
    const { state } = newGame({ players: 2, seed: 'shapes', firstSeat: 0 });
    const id = state.prompts[0]!.id;
    const shapes: unknown[] = [
      null,
      undefined,
      5,
      'draw',
      [],
      {},
      { type: 'answer' },
      { type: 'answer', promptId: id },
      { type: 'answer', promptId: id, answer: null },
      { type: 'answer', promptId: id, answer: 7 },
      { type: 'answer', promptId: id, answer: { kind: 'action' } },
      { type: 'answer', promptId: id, answer: { kind: 'action', choice: null } },
      { type: 'answer', promptId: { id }, answer: {} },
      { type: 'answer', promptId: id, answer: { kind: 'order-pile' } },
      { type: 'answer', promptId: id, answer: { kind: 'choose-keep-pair' } },
    ];
    const results = shapes.map((shape) => neverThrows(state, 0, shape));
    expect(results.filter((r) => r?.startsWith('THROWS'))).toEqual([]);
    expect(results.every((r) => r !== null)).toBe(true);
  });

  it('every field of every legal answer, replaced with junk, across random games', () => {
    const crashes = new Set<string>();
    for (let game = 0; game < 25; game++) {
      const rng = seedRng(`malformed-${game}`);
      let state = newGame({ players: 4, seed: `malformed-${game}`, marksToWin: 2 }).state;
      for (let step = 0; step < 250 && state.phase !== 'game-over'; step++) {
        for (const prompt of state.prompts) {
          const sample = legalCommands(state, prompt.seat).find((c) => c.type === 'answer' && c.promptId === prompt.id);
          if (!sample) continue;
          for (const bad of mutations(sample)) {
            const outcome = neverThrows(state, prompt.seat, bad);
            if (outcome?.startsWith('THROWS')) {
              const kind = sample.type === 'answer' ? sample.answer.kind : sample.type;
              crashes.add(`${kind}: ${outcome}`);
            }
          }
        }
        const options = playerSeats(state).flatMap((seat) => legalCommands(state, seat).map((command) => ({ seat, command })));
        const choice = pick(rng, options);
        const result = apply(state, choice.seat, choice.command);
        if (!result.ok) throw new Error(result.error.message);
        state = result.state;
      }
    }
    expect([...crashes].sort()).toEqual([]);
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

  it('accepts a legal command whatever order its keys arrive in', () => {
    const start = buildPosition({ keeps: { 0: ['juggling'] }, hands: { 0: ['chalice'] }, piles: { 1: ['dagger'] }, turn: 0 });
    const promptId = promptFor(start, 0, 'action').id;
    // Keys reversed at every level, as a browser might serialize them.
    const reordered = JSON.parse(
      `{"answer":{"choice":{"target":2,"card":"chalice","action":"play"},"kind":"action"},"promptId":"${promptId}","type":"answer"}`,
    ) as Command;
    expect(apply(start, 0, reordered).ok).toBe(true);
    const juggle = JSON.parse(
      `{"answer":{"choice":{"piles":[1,3],"card":"juggling","action":"ability"},"kind":"action"},"promptId":"${promptId}","type":"answer"}`,
    ) as Command;
    expect(apply(start, 0, juggle).ok).toBe(true);
    // Order inside arrays still matters where it means something: [3, 1] is not a listed pair.
    const swapped = JSON.parse(
      `{"type":"answer","promptId":"${promptId}","answer":{"kind":"action","choice":{"action":"ability","card":"juggling","piles":[3,1]}}}`,
    ) as Command;
    expect(apply(start, 0, swapped).ok).toBe(false);
  });

  it('writes every command it takes as the engine would, whoever sent it and however: its log and events the same', () => {
    const ok = (result: ReturnType<typeof apply>) => {
      if (!result.ok) throw new Error(result.error.message);
      return result;
    };
    // A listed command, keys reversed: the listed one.
    const start = buildPosition({ keeps: { 0: ['juggling'] }, hands: { 0: ['chalice'] }, piles: { 1: ['dagger'] }, turn: 0 });
    const promptId = promptFor(start, 0, 'action').id;
    const reordered = JSON.parse(`{"answer":{"choice":{"target":2,"card":"chalice","action":"play"},"kind":"action"},"promptId":"${promptId}","type":"answer"}`) as Command;
    const listed = legalCommands(start, 0).find((c) => JSON.stringify(c) === JSON.stringify({ type: 'answer', promptId, answer: { kind: 'action', choice: { action: 'play', card: 'chalice', target: 2 } } }))!;
    expect(JSON.stringify(ok(apply(start, 0, reordered)).command)).toBe(JSON.stringify(listed));

    // Leaving, with a field it doesn't have: as written, without it.
    expect(JSON.stringify(ok(apply(start, 1, { type: 'leave', why: 'tired' } as unknown as Command)).command)).toBe('{"type":"leave"}');

    // Tithes' order (too many to list), keys reversed and a field more.
    const tithes = act(buildPosition({ keeps: { 0: ['tithes'] }, piles: { 0: ['chalice', 'blunder', 'dagger'] }, turn: 0 }), 0, { action: 'ability', card: 'tithes' }).state;
    const order = promptFor(tithes, 0, 'order-pile').id;
    const sent = JSON.parse(`{"answer":{"order":["dagger","chalice","blunder"],"kind":"order-pile","extra":1},"promptId":"${order}","type":"answer"}`) as Command;
    const clean: Command = { type: 'answer', promptId: order, answer: { kind: 'order-pile', order: ['dagger', 'chalice', 'blunder'] } };
    const a = ok(apply(tithes, 0, sent));
    const b = ok(apply(tithes, 0, clean));
    expect(JSON.stringify(a.command)).toBe(JSON.stringify(clean));
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));

    // Providence's pair (either order is legal: the one sent kept), references with their keys reversed and more.
    const providence = act(buildPosition({ hands: { 0: ['providence'] }, keeps: { 1: ['chalice'], 2: ['dagger'] }, turn: 0 }), 0, { action: 'play', card: 'providence' }).state;
    const pair = promptFor(providence, 0, 'choose-keep-pair').id;
    const messy = JSON.parse(`{"type":"answer","promptId":"${pair}","answer":{"b":{"index":0,"seat":1,"card":"chalice"},"kind":"choose-keep-pair","a":{"index":0,"seat":2}}}`) as Command;
    const tidy: Command = { type: 'answer', promptId: pair, answer: { kind: 'choose-keep-pair', a: { seat: 2, index: 0 }, b: { seat: 1, index: 0 } } };
    const c = ok(apply(providence, 0, messy));
    const d = ok(apply(providence, 0, tidy));
    expect(JSON.stringify(c.command)).toBe(JSON.stringify(tidy));
    expect(JSON.stringify(c.events)).toBe(JSON.stringify(d.events));
  });

  it('refuses to hand back a broken state: apply checks every invariant after a command', () => {
    const start = buildPosition({ piles: { 0: ['chalice', 'dagger'] }, turn: 0 });
    // Corrupt the input: a card in two places at once.
    const corrupted = structuredClone(start);
    corrupted.discard.push('chalice');
    expect(() => apply(corrupted, 0, actionCommand(corrupted, 0, { action: 'draw' }))).toThrow(/Invariant violation/);
  });

  it('a command for an old state is rejected against the new one', () => {
    const start = buildPosition({ piles: { 0: ['chalice', 'dagger'] }, turn: 0 });
    const stale = actionCommand(start, 0, { action: 'draw' });
    const moved = draw(start, 0).state;
    expect(rejected(moved, 0, stale)).toBe('unknown-prompt');
  });
});
