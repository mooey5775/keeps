import { describe, expect, it } from 'vitest';
import {
  apply,
  legalCommands,
  newGame,
  pick,
  playerSeats,
  seedRng,
  viewFor,
  type PlayerView,
} from '../../src/index.ts';

// R-10 as a property: at every step of many random games, every seat and a
// spectator agree on all public information, and each player's private part
// matches the real state.

function publicPart(view: PlayerView) {
  return {
    seats: view.seats,
    marks: view.marks,
    marksToWin: view.marksToWin,
    round: view.round,
    turnNumber: view.turnNumber,
    phase: view.phase,
    turn: view.turn,
    frame: view.frame,
    roundEnd: view.roundEnd,
    lastRoundWinner: view.lastRoundWinner,
    piles: view.piles,
    hands: view.hands.map((h) => ({ seat: h.seat, count: h.count })),
    keeps: view.keeps.map((k) => ({ seat: k.seat, cards: k.cards.map((c) => (c.faceDown ? 'face-down' : c.id)) })),
    discard: view.discard,
    scores: view.scores,
    duplicityHolder: view.duplicityHolder,
    prompts: view.prompts.map((p) => ({ id: p.id, seat: p.seat, kind: p.kind })),
  };
}

describe('views agree on public information', () => {
  it('R-10 every seat and a spectator see the same public facts, every step', () => {
    let steps = 0;
    for (let game = 0; game < 15; game++) {
      const rng = seedRng(`views-${game}`);
      let state = newGame({ players: (2 + (game % 3)) as 2 | 3 | 4, seed: `views-${game}`, marksToWin: 2 }).state;
      while (state.phase !== 'game-over') {
        const reference = publicPart(viewFor(state, 'spectator'));
        for (const seat of playerSeats(state)) {
          const view = viewFor(state, seat);
          expect(publicPart(view)).toEqual(reference);
          // Private part: your own hand, exactly; nobody else's.
          for (const h of view.hands) {
            if (h.seat === seat) expect(h.cards).toEqual(state.hands[seat]);
            else expect(h.cards).toBeUndefined();
          }
        }
        // Public facts match the real state.
        expect(reference.hands.map((h) => h.count)).toEqual(state.hands.map((h) => h.length));
        expect(reference.piles.map((p) => p.size)).toEqual(state.pileAt.map((id) => state.piles[id].cards.length));
        expect(reference.discard).toEqual(state.discard);
        const options = playerSeats(state).flatMap((s) => legalCommands(state, s).map((command) => ({ seat: s, command })));
        const choice = pick(rng, options);
        const result = apply(state, choice.seat, choice.command);
        if (!result.ok) throw new Error(result.error.message);
        state = result.state;
        steps++;
      }
    }
    expect(steps).toBeGreaterThan(1000);
  });
});
