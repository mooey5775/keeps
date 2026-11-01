// The search (search/search.ts) judges a decision from what the seat knew then, however long it takes: the game
// may move on while it awaits its evaluator (training mode advises a person, who may answer first).
import { describe, expect, it } from 'vitest';
import { apply, newGame, type Command, type GameState, type Seat, type TraceEvent } from '@keeps/engine';
import { BotPlayer } from '../src/bot.ts';
import { searchChoose, type EvaluateJob } from '../src/search/search.ts';
import { randomPolicy } from './support/random-policy.ts';

describe('the search', () => {
  it("keeps the seat's log as it was at the decision while the game moves on (Tithes' reorder, searched card by card)", async () => {
    // A game where seat 0 draws Tithes and reorders a pile with it (seen in the iOS goldens: the person answered the
    // reorder before training mode's search of it was done, and its later steps were given the person's later log).
    const action = (promptId: string, choice: object) => ({ type: 'answer', promptId, answer: { kind: 'action', choice } }) as Command;
    const commands: [Seat, Command][] = [
      [0, action('p8', { action: 'draw' })],
      [0, action('p11', { action: 'draw' })],
      [2, action('p16', { action: 'draw' })],
      [2, { type: 'answer', promptId: 'p20', answer: { kind: 'choose-direction', direction: 'right' } } as Command],
      [2, action('p22', { action: 'draw' })],
      [0, action('p27', { action: 'play', card: 'tithes', target: 0 })],
      [0, action('p30', { action: 'ability', card: 'tithes' })],
    ];
    const after: [Seat, Command][] = [
      [0, { type: 'answer', promptId: 'p34', answer: { kind: 'order-pile', order: ['acquisition', 'royal-favor', 'interest', 'requisition', 'chalice', 'dagger', 'fiat', 'medallion', 'timepiece'] } } as Command],
      [2, action('p38', { action: 'draw' })],
      [2, action('p41', { action: 'play', card: 'faberge-egg', target: 2 })],
    ];
    let { state, events } = newGame({ players: 2, seed: 'golden-2', marksToWin: 1 }) as { state: GameState; events: TraceEvent[] };
    const advisor = new BotPlayer(randomPolicy(), 0);
    // As the room follows a person's seat: the advisor observes each of its decisions.
    const play = ([seat, command]: [Seat, Command]) => {
      if (advisor.wantsToMove(state)) advisor.observe(state, events);
      const r = apply(state, seat, command);
      if (!r.ok) throw new Error(r.error.message);
      state = r.state;
      events = [...events, ...r.events];
    };
    commands.forEach(play);
    expect(state.prompts.find((p) => p.seat === 0)?.kind).toBe('order-pile');

    const decided = state;
    const jobs: EvaluateJob[] = [];
    const evaluator = {
      async evaluate(job: EvaluateJob) {
        jobs.push({ ...job, myLog: [...job.myLog] });
        if (jobs.length === 1) {
          // The person answers meanwhile; the game goes on to their next decision, which the advisor observes.
          after.forEach(play);
          advisor.observe(state, events);
        }
        return [job.commands.map(() => 0.5)];
      },
    };
    await searchChoose(advisor, decided, events, evaluator, { by: 'mode' });
    expect(jobs.length).toBeGreaterThan(1);
    for (const job of jobs) {
      expect(job.state).toBe(decided);
      expect(job.myLog).toEqual(jobs[0]!.myLog);
    }
  });
});
