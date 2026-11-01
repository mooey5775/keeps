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
import { Belief } from './belief.ts';
import { encodeObservation, OBSERVATION_SIZE } from './observation.ts';
import { encodeObservation2, OBSERVATION2_SIZE } from './observation2.ts';

/** Observation versions: 1 (observation.ts), 2 (observation2.ts). */
export type ObservationVersion = 1 | 2;
export const observationSize = (version: ObservationVersion): number => (version === 2 ? OBSERVATION2_SIZE : OBSERVATION_SIZE);

// One heads-up round as a two-player, zero-sum, turn-based game: the shape
// OpenSpiel expects. Player 0 sits at seat 0 and player 1 at seat 2 (two players
// sit opposite; the ghost piles are at seats 1 and 3). The round winner gets +1,
// the loser -1. Chance (the deal, Legerdemain's random steal) comes from the
// engine's seeded generator, so a round is "sampled stochastic".
//
// The player to move is whoever the engine is waiting on (in a two-player round
// that's always one seat). Duplicity's free reveal (C-11, "at any time") is
// offered to its holder at their own decisions and in the engine's reveal
// windows, not while the opponent decides: a deliberate simplification. Its one
// known cost: the holder can't reveal a hidden Shackles after the turn player's
// first action to end their turn (C-14). See docs/BOT.md, "Known limitations".

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
  private legalCache: { decision: Decision; length: number; ids: number[] } | null = null;
  /** Each player's belief, kept up to date from their log (built on first use). */
  private beliefs: (Belief | null)[] = [null, null];
  /**
   * Separate beliefs for peekInto (a central critic's view of the player not
   * moving), so peeking never changes what a player's own belief has observed.
   */
  private peekBeliefs: (Belief | null)[] = [null, null];
  /** What each player has been shown, extended as events happen. */
  private logs: TraceEvent[][];
  private views: { state: GameState | null; views: (PlayerView | null)[] } = { state: null, views: [null, null] };
  /** Off: the engine skips legality and invariant checks (commands come from its own legal list). For training speed. */
  readonly checked: boolean;

  /** Which observation `observation()` encodes. */
  readonly version: ObservationVersion;

  private constructor(state: GameState, events: TraceEvent[], checked: boolean, version: ObservationVersion = 1) {
    this.version = version;
    this.state = state;
    this.events = events;
    this.checked = checked;
    this.logs = SEAT_OF_PLAYER.map((seat) => eventsFor(events, seat));
  }

  /** A fresh round, dealt from `seed`. */
  static start(seed: string, { checked = true, observation = 1 }: { checked?: boolean; observation?: ObservationVersion } = {}): RoundEnv {
    const { state, events } = newGame({ players: 2, seed, marksToWin: 1 });
    return new RoundEnv(state, events, checked, observation);
  }

  /** A copy that can be stepped independently (states never change in place). */
  clone(): RoundEnv {
    const copy = new RoundEnv(this.state, [...this.events], this.checked, this.version);
    copy.prefix = [...this.prefix];
    // What each player has seen goes beyond the log (views at earlier decisions): copy it.
    copy.beliefs = this.beliefs.map((b) => b?.clone() ?? null);
    copy.peekBeliefs = this.peekBeliefs.map((b) => b?.clone() ?? null);
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

  /** Observation v2 written into `out` at `start` (no allocation; for the self-play worker). */
  observeInto(player: number, out: Float32Array, start: number): void {
    if (this.version !== 2) {
      out.set(this.observation(player), start);
      return;
    }
    const view = this.view(player);
    const belief = (this.beliefs[player] ??= new Belief(SEAT_OF_PLAYER[player]!, { sound: true })).update(this.log(player)).observe(view);
    const moving = !this.terminal && this.currentPlayer === player;
    encodeObservation2(view, belief, moving ? this.prefix : [], moving ? this.legalActions() : [], out, start);
  }

  /**
   * Observation v2 of `player` now, from a belief of its own (observed at every
   * peek), for a critic that sees both players. A player's real belief observes
   * its view only at its own decisions (observeInto, and the bot), and the view
   * can show things only for a moment, so observing more often can conclude
   * more: peeking with the real belief would change what the player later sees.
   */
  peekInto(player: number, out: Float32Array, start: number): void {
    if (this.version !== 2) throw new Error('peekInto needs observation v2');
    const view = this.view(player);
    const belief = (this.peekBeliefs[player] ??= new Belief(SEAT_OF_PLAYER[player]!, { sound: true })).update(this.log(player)).observe(view);
    const moving = !this.terminal && this.currentPlayer === player;
    encodeObservation2(view, belief, moving ? this.prefix : [], moving ? this.legalActions() : [], out, start);
  }

  /** What `player` observes now (see observation.ts); the chosen ids count only for the player to move. */
  observation(player: number): Float32Array {
    const view = this.view(player);
    const belief = (this.beliefs[player] ??= new Belief(SEAT_OF_PLAYER[player]!, { sound: this.version >= 2 })).update(this.log(player)).observe(view);
    const moving = !this.terminal && this.currentPlayer === player;
    if (this.version === 2) return encodeObservation2(view, belief, moving ? this.prefix : [], moving ? this.legalActions() : []);
    return encodeObservation(view, belief, moving ? this.prefix : []);
  }

  view(player: number): PlayerView {
    // Cached until the state changes (a move of several ids observes the same state each time).
    if (this.views.state !== this.state) this.views = { state: this.state, views: [null, null] };
    return (this.views.views[player] ??= viewFor(this.state, SEAT_OF_PLAYER[player]!));
  }

  /** What `player` has been shown this round. */
  log(player: number): readonly TraceEvent[] {
    return this.logs[player]!;
  }

  private currentDecision(): Decision {
    if (!this.decision) {
      const seat = this.decider();
      this.decision = new Decision(this.view(playerOfSeat(seat)), legalCommands(this.state, seat));
    }
    return this.decision;
  }

  legalActions(): number[] {
    if (this.terminal) return [];
    // Asked for both the observation's flags and the move list: compute once per step.
    const decision = this.currentDecision();
    if (this.legalCache?.decision !== decision || this.legalCache.length !== this.prefix.length) {
      this.legalCache = { decision, length: this.prefix.length, ids: decision.next(this.prefix) };
    }
    return this.legalCache.ids;
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
    const result = apply(this.state, seat, command, { trusted: !this.checked });
    if (!result.ok) throw new Error(`engine rejected ${JSON.stringify(command)}: ${result.error.message}`);
    this.state = result.state;
    this.events.push(...result.events);
    SEAT_OF_PLAYER.forEach((s, player) => this.logs[player]!.push(...eventsFor(result.events, s)));
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
