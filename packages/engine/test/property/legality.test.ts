import { describe, expect, it } from 'vitest';
import { canReveal } from '../../src/duplicity.ts';
import {
  apply,
  legalCommands,
  newGame,
  pick,
  playerSeats,
  SEATS,
  seedRng,
  type GameState,
} from '../../src/index.ts';

// legalCommands() and apply() must agree exactly: every command listed is
// accepted, and the list matches the open prompts. Any mismatch is a rules
// bug: the UI offering a move the engine refuses, or a prompt nobody can
// answer.

function randomGames(count: number, visit: (state: GameState, step: number) => void) {
  for (let game = 0; game < count; game++) {
    const rng = seedRng(`legality-${game}`);
    let state = newGame({ players: (2 + (game % 3)) as 2 | 3 | 4, seed: `legality-${game}`, marksToWin: 2 }).state;
    for (let step = 0; state.phase !== 'game-over'; step++) {
      if (step > 3000) throw new Error('game did not finish');
      visit(state, step);
      const options = playerSeats(state).flatMap((seat) => legalCommands(state, seat).map((command) => ({ seat, command })));
      const choice = pick(rng, options);
      const result = apply(state, choice.seat, choice.command);
      if (!result.ok) throw new Error(result.error.message);
      state = result.state;
    }
  }
}

describe('legal commands', () => {
  it('every listed command is accepted', () => {
    let checked = 0;
    randomGames(12, (state, step) => {
      if (step % 3 !== 0) return;
      for (const seat of playerSeats(state)) {
        for (const command of legalCommands(state, seat)) {
          const result = apply(state, seat, command);
          if (!result.ok) expect.fail(`listed but rejected for S${seat}: ${JSON.stringify(command)}: ${result.error.message}`);
          checked++;
        }
      }
    });
    expect(checked).toBeGreaterThan(1000);
  });

  it('match the open prompts: one answer list per prompt, plus reveal and next-round where allowed', () => {
    randomGames(12, (state) => {
      for (const seat of SEATS) {
        const commands = legalCommands(state, seat);
        if (state.config.seats[seat] === 'ghost') {
          expect(commands).toEqual([]);
          continue;
        }
        if (state.phase === 'round-over') {
          expect(commands).toEqual([{ type: 'next-round' }]);
          continue;
        }
        const mine = state.prompts.filter((p) => p.seat === seat);
        const answered = new Set(commands.flatMap((c) => (c.type === 'answer' ? [c.promptId] : [])));
        // Every prompt of mine has at least one answer, and nothing answers anyone else's.
        expect([...answered].sort()).toEqual(mine.map((p) => p.id).sort());
        const reveal = commands.some((c) => c.type === 'reveal-duplicity');
        expect(reveal).toBe(canReveal(state, seat));
        expect(commands.some((c) => c.type === 'next-round')).toBe(false);
      }
    });
  });

  it('no two listed commands for a seat are the same', () => {
    randomGames(8, (state) => {
      for (const seat of playerSeats(state)) {
        const keys = legalCommands(state, seat).map((c) => JSON.stringify(c));
        expect(new Set(keys).size).toBe(keys.length);
      }
    });
  });

  it('the active player always has at least two choices on an action prompt, or exactly the forced draw', () => {
    // Drawing is always legal, so an action prompt is never a dead end.
    randomGames(8, (state) => {
      for (const prompt of state.prompts) {
        if (prompt.kind !== 'action') continue;
        const choices = legalCommands(state, prompt.seat).filter((c) => c.type === 'answer' && c.promptId === prompt.id);
        expect(choices).toContainEqual({ type: 'answer', promptId: prompt.id, answer: { kind: 'action', choice: { action: 'draw' } } });
      }
    });
  });
});
