import { describe, expect, it } from 'vitest';
import {
  apply,
  legalCommands,
  newGame,
  pick,
  playerSeats,
  seedRng,
  type Command,
  type GameState,
} from '../../src/index.ts';

// Commands come from browsers as JSON, so apply() must never throw on bad
// input: every malformed command is rejected with an error result. A thrown
// exception would take down the server's message handler.

const JUNK: unknown[] = [undefined, null, 0, -1, 99, 'x', true, [], {}, [0, 0], { seat: 0 }, { seat: 1, index: 0 }];

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
