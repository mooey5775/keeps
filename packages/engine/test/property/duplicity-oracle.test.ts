import { describe, expect, it } from 'vitest';
import {
  apply,
  buildPosition,
  CARD_IDS,
  CARDS,
  legalCommands,
  playerSeats,
  randomInt,
  seedRng,
  shuffle,
  type CardId,
  type Command,
  type GameState,
  type KeepCard,
  type PositionSpec,
  type Seat,
  type TraceEvent,
} from '../../src/index.ts';

// An oracle for Duplicity's reveal windows. The rule: a hidden Interest or
// Retribution revealed in a play's window responds to that play "as if it had
// been face up all along" (C-13, C-15). So whenever a window opens, compare:
//   actual:         reveal in the window, then see which triggers the play queues;
//   counterfactual: rewind to before the play, turn the hidden card face up,
//                   replay the same commands, and see which triggers it queues.
// They must be the same.

type Step = { seat: Seat; command: Command };

function randomPosition(seed: number, hiddenCard: 'interest' | 'retribution'): PositionSpec {
  const rng = seedRng(`oracle-${seed}`);
  const cards = shuffle(rng, CARD_IDS.filter((c) => c !== 'duplicity' && c !== hiddenCard));
  const piles: Record<number, CardId[]> = { 0: [], 1: [], 2: [], 3: [] };
  const hands: Record<number, CardId[]> = { 0: [], 1: [], 2: [], 3: [] };
  const keeps: Record<number, (CardId | KeepCard)[]> = { 0: [], 1: [], 2: [], 3: [] };
  const discard: CardId[] = [];
  for (const card of cards) {
    const r = randomInt(rng, 10);
    const seat = randomInt(rng, 4);
    if (r < 3) piles[seat]!.push(card);
    else if (r < 6 && !CARDS[card].hot) hands[seat]!.push(card);
    else if (r < 8 && CARDS[card].keep) keeps[seat]!.push(card);
    else discard.push(card);
  }
  const holder = randomInt(rng, 4);
  keeps[holder]!.push('duplicity');
  keeps[randomInt(rng, 4)]!.push({ id: hiddenCard, faceDown: { placedBy: holder as Seat } });
  return { piles, hands, keeps, discard, turn: randomInt(rng, 4) as Seat, seed, fill: 'quiet' };
}

/** The triggers queued after the play whose card is `card`, from a batch of events. */
function triggersFor(events: TraceEvent[], card: CardId): string[] | null {
  const batch = events.findLast((e) => e.payload.type === 'triggers' && e.payload.card === card);
  if (!batch || batch.payload.type !== 'triggers') return null;
  return batch.payload.triggers.map((t) => `${t.kind}:${t.seat}`);
}

/** Replays `steps` from `state`, re-pointing each answer at the matching open prompt there. */
function replay(state: GameState, steps: Step[]): { state: GameState; events: TraceEvent[] } | null {
  const events: TraceEvent[] = [];
  for (const { seat, command } of steps) {
    let sent = command;
    if (command.type === 'answer') {
      const prompt = state.prompts.find((p) => p.seat === seat && p.kind === command.answer.kind);
      if (!prompt) return null;
      sent = { ...command, promptId: prompt.id };
    }
    const result = apply(state, seat, sent);
    if (!result.ok) return null;
    state = result.state;
    events.push(...result.events);
  }
  return { state, events };
}

function faceUp(state: GameState): GameState {
  const copy = structuredClone(state);
  for (const keep of copy.keeps) for (let i = 0; i < keep.length; i++) if (keep[i]!.faceDown) keep[i] = { id: keep[i]!.id };
  return copy;
}

function check(start: GameState, budget: number): { windows: number; compared: number } {
  // Breadth-first, remembering how we got to each state.
  const queue: { state: GameState; path: { before: GameState; step: Step }[] }[] = [{ state: start, path: [] }];
  let windows = 0;
  let compared = 0;
  for (let n = 0; queue.length > 0 && n < budget; n++) {
    const { state, path } = queue.shift()!;
    const window = state.prompts.find((p) => p.kind === 'reveal-window' && p.reason === 'play');
    if (window && window.kind === 'reveal-window' && window.playId !== null) {
      windows++;
      const play = state.openPlays.find((p) => p.id === window.playId)!;
      const revealed = apply(state, window.seat, { type: 'answer', promptId: window.id, answer: { kind: 'reveal-window', reveal: true } });
      if (!revealed.ok) throw new Error(revealed.error.message);
      const actual = triggersFor(revealed.events, play.card) ?? [];

      // Rewind to just before the action that started this chain.
      const startIndex = path.findLastIndex((p) => p.step.command.type === 'answer' && p.step.command.answer.kind === 'action');
      if (startIndex >= 0) {
        const steps = path.slice(startIndex).map((p) => p.step);
        // Earlier windows in the same chain don't exist face up; skip chains that had any.
        const clean = steps.every((s) => s.command.type === 'answer' && s.command.answer.kind !== 'reveal-window');
        const rerun = clean ? replay(faceUp(path[startIndex]!.before), steps) : null;
        if (rerun) {
          const counterfactual = triggersFor(rerun.events, play.card) ?? [];
          expect(actual, `seed position, play ${play.card}, steps ${JSON.stringify(steps.map((s) => s.command))}`).toEqual(counterfactual);
          compared++;
        }
      }
    }
    if (state.phase !== 'playing' && state.phase !== 'post-round') continue;
    for (const seat of playerSeats(state)) {
      for (const command of legalCommands(state, seat)) {
        if (command.type === 'reveal-duplicity') continue;
        const result = apply(state, seat, command);
        if (!result.ok) throw new Error(result.error.message);
        queue.push({ state: result.state, path: [...path, { before: state, step: { seat, command } }] });
      }
    }
  }
  return { windows, compared };
}

describe('Duplicity reveal-window oracle', () => {
  for (const hiddenCard of ['retribution', 'interest'] as const) {
    it(`a hidden ${hiddenCard} revealed in a window queues exactly what it would have face up`, () => {
      let compared = 0;
      for (let seed = 0; seed < 20; seed++) {
        const result = check(buildPosition(randomPosition(seed, hiddenCard)), 300);
        compared += result.compared;
      }
      expect(compared).toBeGreaterThan(200);
    });
  }
});
