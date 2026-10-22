import {
  apply,
  eventsFor,
  legalCommands,
  newGame,
  viewFor,
  type Command,
  type GameState,
  type PlayerView,
  type Seat,
  type TraceEvent,
} from '@keeps/engine';
import { Decision } from './actions.ts';

// One heads-up round as a two-player, zero-sum, turn-based game: the shape
// OpenSpiel expects. Player 0 sits at seat 0 and player 1 at seat 2 (two players
// sit opposite; the ghost piles are at seats 1 and 3). The round winner gets +1,
// the loser -1. Chance (the deal, Legerdemain's random steal) comes from the
// engine's seeded generator, so a round is "sampled stochastic".
//
// The player to move is whoever the engine is waiting on (in a two-player round
// that's always one seat). Duplicity's free reveal (C-11, "at any time") is
// offered to its holder at their own decisions and in the engine's reveal
// windows, not while the opponent decides: a deliberate simplification.

export const SEAT_OF_PLAYER: readonly Seat[] = [0, 2];
export const playerOfSeat = (seat: Seat): number => {
  const player = SEAT_OF_PLAYER.indexOf(seat);
  if (player < 0) throw new Error(`seat ${seat} is not a player seat`);
  return player;
};

export const TERMINAL = -4;

export class RoundEnv {
  state: GameState;
  /** Every event of the round, unfiltered; players see them through eventsFor. */
  events: TraceEvent[];
  /** The ids chosen so far for the current move. */
  prefix: number[] = [];
  private decision: Decision | null = null;

  private constructor(state: GameState, events: TraceEvent[]) {
    this.state = state;
    this.events = events;
  }

  /** A fresh round, dealt from `seed`. */
  static start(seed: string): RoundEnv {
    const { state, events } = newGame({ players: 2, seed, marksToWin: 1 });
    return new RoundEnv(state, events);
  }

  /** A copy that can be stepped independently (states never change in place). */
  clone(): RoundEnv {
    const copy = new RoundEnv(this.state, this.events);
    copy.prefix = [...this.prefix];
    return copy;
  }

  get terminal(): boolean {
    return this.state.phase !== 'playing' && this.state.phase !== 'post-round';
  }

  /** The seat the engine is waiting on. */
  decider(): Seat {
    const seats = new Set(this.state.prompts.map((p) => p.seat));
    if (seats.size !== 1) throw new Error(`expected one seat to decide, found ${[...seats].join(', ') || 'none'}`);
    return this.state.prompts[0]!.seat;
  }

  get currentPlayer(): number {
    return this.terminal ? TERMINAL : playerOfSeat(this.decider());
  }

  view(player: number): PlayerView {
    return viewFor(this.state, SEAT_OF_PLAYER[player]!);
  }

  /** What `player` has been shown this round. */
  log(player: number): TraceEvent[] {
    return eventsFor(this.events, SEAT_OF_PLAYER[player]!);
  }

  private currentDecision(): Decision {
    if (!this.decision) {
      const seat = this.decider();
      this.decision = new Decision(viewFor(this.state, seat), legalCommands(this.state, seat));
    }
    return this.decision;
  }

  legalActions(): number[] {
    return this.terminal ? [] : this.currentDecision().next(this.prefix);
  }

  step(action: number): void {
    if (this.terminal) throw new Error('the round is over');
    const decision = this.currentDecision();
    if (!decision.next(this.prefix).includes(action)) throw new Error(`illegal action ${action} after [${this.prefix.join(', ')}]`);
    this.prefix.push(action);
    const command = decision.complete(this.prefix);
    if (!command) return;
    this.applyCommand(this.decider(), command);
  }

  private applyCommand(seat: Seat, command: Command): void {
    const result = apply(this.state, seat, command);
    if (!result.ok) throw new Error(`engine rejected ${JSON.stringify(command)}: ${result.error.message}`);
    this.state = result.state;
    this.events = [...this.events, ...result.events];
    this.prefix = [];
    this.decision = null;
  }

  /** +1 for the round winner, -1 for the loser; zeros until the round is over. */
  returns(): [number, number] {
    if (!this.terminal) return [0, 0];
    const winner = this.state.lastRoundWinner;
    if (winner === null) throw new Error('round over without a winner');
    return playerOfSeat(winner) === 0 ? [1, -1] : [-1, 1];
  }
}
