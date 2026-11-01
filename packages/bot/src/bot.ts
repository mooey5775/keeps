import { eventsFor, legalCommands, viewFor, type Command, type GameState, type Seat, type TraceEvent } from '@keeps/engine';
import { Decision, NUM_ACTIONS } from './actions.ts';
import { Belief, noteObservation } from './belief.ts';
import { encodeObservation } from './observation.ts';
import { encodeObservation2 } from './observation2.ts';
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
  readonly policy: Policy;
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
    // Observation v2 reads the sound belief (v1 policies were trained on the old one).
    this.belief = new Belief(seat, { sound: policy.observation >= 2 });
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
    const view = this.observe(state, events);
    const decision = new Decision(view, legalCommands(state, this.seat));
    const prefix: number[] = [];
    const legal = new Uint8Array(NUM_ACTIONS);
    for (;;) {
      legal.fill(0);
      const ids = decision.next(prefix);
      for (const id of ids) legal[id] = 1;
      const obs = this.policy.observation === 2 ? encodeObservation2(view, this.belief, prefix, ids) : encodeObservation(view, this.belief, prefix);
      this.onObservation?.(obs);
      const probabilities = this.policy.probabilities(obs, legal);
      prefix.push(sample(probabilities, this.random));
      const command = decision.complete(prefix);
      if (command) return command;
    }
  }

  /**
   * What the bot would play in this seat now, as advice: every complete legal command with the
   * network's probability of it (the product along its ids, of the raw policy), most likely first.
   * It sees exactly what choose() would (this seat's view and belief), and observes this decision
   * the same way, so a seat it advises keeps the belief it would have if it were playing there.
   * A pile reorder (Tithes) lists no commands: the advice is then the network's own order.
   */
  suggest(state: GameState, events: readonly TraceEvent[]): { command: Command; probability: number }[] {
    if (!this.wantsToMove(state)) return [];
    const view = this.observe(state, events);
    const decision = new Decision(view, legalCommands(state, this.seat));
    const legal = new Uint8Array(NUM_ACTIONS);
    const probabilities = (prefix: number[]): Float32Array => {
      legal.fill(0);
      const ids = decision.next(prefix);
      for (const id of ids) legal[id] = 1;
      const obs = this.policy.observation === 2 ? encodeObservation2(view, this.belief, prefix, ids) : encodeObservation(view, this.belief, prefix);
      return this.policy.raw(obs, legal);
    };
    let encodings = decision.encodings();
    if (encodings.length === 0) {
      const prefix: number[] = [];
      while (!decision.complete(prefix)) {
        const p = probabilities(prefix);
        prefix.push(decision.next(prefix).reduce((best, id) => (p[id]! > p[best]! ? id : best)));
      }
      encodings = [prefix];
    }
    const rows = encodings.map((ids) => {
      let probability = 1;
      for (let i = 0; i < ids.length; i++) probability *= probabilities(ids.slice(0, i))[ids[i]!]!;
      return { command: decision.complete(ids)!, probability };
    });
    const total = rows.reduce((sum, r) => sum + r.probability, 0) || 1;
    return rows.map((r) => ({ command: r.command, probability: r.probability / total })).sort((a, b) => b.probability - a.probability);
  }

  /**
   * Brings the bot's log and belief up to date with a decision of its seat (and checks it may decide),
   * as choose() does. A seat it only advises calls this at each decision, so its belief stays what it
   * would be if it were playing there.
   */
  observe(state: GameState, events: readonly TraceEvent[]): ReturnType<typeof viewFor> {
    if (state.config.seats.filter((s) => s === 'player').length !== 2) throw new Error('the bot only plays two-player games');
    if (!this.wantsToMove(state)) throw new Error(`seat ${this.seat} has nothing to decide`);
    if (events.length < this.read) throw new Error('the game went back (undo?): the bot only follows a game forward');
    this.log.push(...eventsFor(events.slice(this.read), this.seat));
    this.read = events.length;
    const view = viewFor(state, this.seat);
    // What the view shows goes in the log (the search is given the log), and the belief learns it from there.
    this.belief.update(noteObservation(this.log, view, this.seat));
    return view;
  }

  /**
   * What the seat knows at its decision now, for a search of it (searchChoose): observe(), and copies of its log and
   * belief, which move on with the game while the search awaits (a seat training mode advises may well answer first).
   */
  knowledge(state: GameState, events: readonly TraceEvent[]): { view: ReturnType<typeof viewFor>; log: TraceEvent[]; belief: Belief } {
    const view = this.observe(state, events);
    return { view, log: [...this.log], belief: this.belief.clone() };
  }
}
