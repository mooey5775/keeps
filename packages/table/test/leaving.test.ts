// What leaving says it gives up: the confirmation's words, on the website and the app alike.
import { apply, newGame, viewFor, type Seat } from '@keeps/engine';
import { describe, expect, it } from 'vitest';
import { leaving, makeNames } from '../src/index.ts';

const names = ['Ana', 'Ben', 'Cy', 'Dee'];
const at = (players: 2 | 3 | 4, viewer: Seat | 'spectator') => {
  const { state } = newGame({ players, seed: 'leaving', marksToWin: 1 });
  return { state, says: (s = state) => leaving(viewFor(s, viewer), makeNames(names, viewer)) };
};

describe('leaving a game', () => {
  it('says who wins in a game of two, and that the others play on in a bigger one', () => {
    expect(at(2, 0).says()).toBe('Cy wins the game.');
    expect(at(3, 1).says()).toBe('This round ends with no winner, and the game goes on without you.');
  });

  it('gives up nothing when watching, or once the game is over', () => {
    expect(at(2, 'spectator').says()).toBeNull();
    const { state, says } = at(2, 0);
    const over = apply(state, 2, { type: 'leave' });
    if (!over.ok) throw new Error(over.error.message);
    expect(says(over.state)).toBeNull();
  });
});
