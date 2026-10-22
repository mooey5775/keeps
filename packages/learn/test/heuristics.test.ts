import { describe, expect, it } from 'vitest';
import { heuristicPlayer, match, randomPlayer } from '../src/benchmark.ts';

// The benchmark players must be real yardsticks: legal on every prompt, and far
// better than random (at 1000 deals: greedy 0.90, timer 0.93, timer vs greedy 0.57).

describe('heuristic players', () => {
  it('greedy beats a random player', () => {
    expect(match(heuristicPlayer('greedy'), randomPlayer, 200, 'test-greedy').score).toBeGreaterThan(0.8);
  });

  it('timer beats a random player', () => {
    expect(match(heuristicPlayer('timer'), randomPlayer, 200, 'test-timer').score).toBeGreaterThan(0.8);
  });
});
