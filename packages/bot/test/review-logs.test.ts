// The round review's jobs carry each player's log as BotPlayer would keep it: their own events, and what their view
// showed at each of their own decisions. So a player's estimates (and the worlds for their options) come from what
// they saw, and only that: no note of one player's view is ever in the other's log.
import { describe, expect, it } from 'vitest';
import { apply, eventsFor, legalCommands, newGame, viewFor, type GameState, type Seat, type TraceEvent } from '@keeps/engine';
import { isObserved, noteObservation } from '../src/belief.ts';
import { Reviewer, type ReviewJobs } from '../src/review/review.ts';
import type { ReviewJob } from '../src/review/jobs.ts';
import { seeded } from '../src/random.ts';

/** A pool that keeps the jobs it's given (and runs none). */
function recordingPool(jobs: ReviewJob[]): ReviewJobs {
  return { submit: (_group, _tag, job) => void jobs.push(job), cancel: () => 0, drop: () => 0, setAside: () => [] };
}

describe('the round review', () => {
  it("gives each job the players' logs as they kept them, with what each saw at their own decisions", () => {
    const PERSON = 0 as Seat;
    const BOT = 2 as Seat;
    let checked = 0;
    for (let g = 0; g < 6; g++) {
      const jobs: ReviewJob[] = [];
      const reviewer = new Reviewer(recordingPool(jobs), () => {});
      let { state, events } = newGame({ players: 2, seed: `review-logs-${g}`, marksToWin: 2 }) as { state: GameState; events: TraceEvent[] };
      const game = { state, events, startedAt: g };
      reviewer.start(`T${g}`, game, PERSON, BOT, ['Ana', null, 'Bot', null]);
      const random = seeded(g, 3);
      // The reference: each player's log, kept as BotPlayer keeps the bot's.
      const refs = new Map<Seat, TraceEvent[]>([[PERSON, []], [BOT, []]]);
      let read = 0;
      for (let step = 0; step < 600 && state.phase !== 'game-over'; step++) {
        const seat = (state.phase === 'round-over' ? PERSON : state.prompts[0]!.seat) as Seat;
        const legal = legalCommands(state, seat).filter((c) => c.type !== 'reveal-duplicity');
        const command = legal[Math.floor(random() * legal.length)]!;
        for (const [s, log] of refs) log.push(...eventsFor(events.slice(read), s));
        const playing = state.phase === 'playing' || state.phase === 'post-round';
        if (playing) noteObservation(refs.get(seat)!, viewFor(state, seat), seat);
        const before = new Map([...refs].map(([s, log]) => [s, [...log]]));
        const r = apply(state, seat, command);
        if (!r.ok) throw new Error(r.error.message);
        const was = state;
        state = r.state;
        events = [...events, ...r.events];
        for (const [s, log] of refs) log.push(...eventsFor(r.events, s));
        read = events.length;
        const after = new Map([...refs].map(([s, log]) => [s, [...log]]));
        game.state = state;
        game.events = events;
        jobs.length = 0;
        reviewer.moved(game, was, seat, command, state, events, r.events);
        for (const job of jobs) {
          const want = job.state === was ? before : job.state === state ? after : null;
          expect(want, 'a job from a position other than the move\'s').not.toBeNull();
          if (job.kind === 'worlds') {
            expect(job.myLog).toEqual(want!.get(job.me));
            for (const e of job.myLog) if (isObserved(e)) expect(e.visibility).toEqual([job.me]);
          } else {
            for (const [s, log] of job.logs) expect(log).toEqual(want!.get(s));
          }
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });
});
