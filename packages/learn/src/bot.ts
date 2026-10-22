import { eventsFor, legalCommands, viewFor, type Command, type GameState, type Seat, type TraceEvent } from '@keeps/engine';
import { Decision, NUM_ACTIONS } from './actions.ts';
import { Belief } from './belief.ts';
import { encodeObservation } from './observation.ts';
import { sample, type Policy } from './policy.ts';

// Plays one seat of a two-player game with a trained policy, exactly as in
// training: it sees only its view and its own log, keeps its belief up to date
// from the log, observes its view at each of its own decisions (the belief keeps
// what it saw there, such as face-up pile tops), and picks a command one id at a
// time (see actions.ts), observing after each.
//
// One BotPlayer per seat per game: the belief lasts the whole game (it starts
// over at each round), so the game's events must only ever grow (no undo).

export class BotPlayer {
  readonly seat: Seat;
  private readonly policy: Policy;
  private readonly random: () => number;
  private readonly belief: Belief;
  /** The bot's own log, and how many of the game's events it has read. */
  private readonly log: TraceEvent[] = [];
  private read = 0;
  /** Called with each observation the bot makes (for tests). */
  onObservation: ((obs: Float32Array) => void) | null = null;

  constructor(policy: Policy, seat: Seat, random: () => number = Math.random) {
    this.policy = policy;
    this.seat = seat;
    this.random = random;
    this.belief = new Belief(seat);
  }

  /**
   * Whether the bot has a decision to make: a prompt of its own. Like training,
   * it doesn't use Duplicity's free reveal while only the opponent is deciding,
   * and it leaves starting the next round to the human.
   */
  wantsToMove(state: GameState): boolean {
    return (state.phase === 'playing' || state.phase === 'post-round') && state.prompts.some((p) => p.seat === this.seat);
  }

  /** The command the bot plays now, given every event of the game so far. */
  choose(state: GameState, events: readonly TraceEvent[]): Command {
    if (state.config.seats.filter((s) => s === 'player').length !== 2) throw new Error('the bot only plays two-player games');
    if (!this.wantsToMove(state)) throw new Error(`seat ${this.seat} has nothing to decide`);
    if (events.length < this.read) throw new Error('the game went back (undo?): the bot only follows a game forward');
    this.log.push(...eventsFor(events.slice(this.read), this.seat));
    this.read = events.length;
    const view = viewFor(state, this.seat);
    this.belief.update(this.log).observe(view);
    const decision = new Decision(view, legalCommands(state, this.seat));
    const prefix: number[] = [];
    const legal = new Uint8Array(NUM_ACTIONS);
    for (;;) {
      legal.fill(0);
      for (const id of decision.next(prefix)) legal[id] = 1;
      const obs = encodeObservation(view, this.belief, prefix);
      this.onObservation?.(obs);
      const probabilities = this.policy.probabilities(obs, legal);
      prefix.push(sample(probabilities, this.random));
      const command = decision.complete(prefix);
      if (command) return command;
    }
  }
}
