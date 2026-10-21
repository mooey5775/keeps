import { describe, expect, it } from 'vitest';
import { apply, formatTrace, legalCommands, newGame, pick, playerSeats, seedRng, type TraceEvent } from '../../src/index.ts';

// Golden traces: three complete seeded games, played by a seeded random
// player, saved as readable play-by-play snapshots. Any change in engine
// behavior (rules, trigger order, legal-move order, trace wording) shows up
// here as a diff. If the change is intended, review the diff and update with
// `pnpm --filter @keeps/engine test -- -u`.

function goldenGame(players: 2 | 3 | 4): string {
  const rng = seedRng(`golden-${players}`);
  const start = newGame({ players, seed: `golden-${players}`, marksToWin: 2 });
  let state = start.state;
  const events: TraceEvent[] = [...start.events];
  while (state.phase !== 'game-over') {
    const options = playerSeats(state).flatMap((seat) => legalCommands(state, seat).map((command) => ({ seat, command })));
    const choice = pick(rng, options);
    const result = apply(state, choice.seat, choice.command);
    if (!result.ok) throw new Error(result.error.message);
    state = result.state;
    events.push(...result.events);
  }
  return formatTrace(events);
}

describe('golden games', () => {
  for (const players of [2, 3, 4] as const) {
    it(`${players} players`, () => {
      expect(goldenGame(players)).toMatchSnapshot();
    });
  }
});
