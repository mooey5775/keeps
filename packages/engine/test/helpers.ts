import { expect } from 'vitest';
import {
  apply,
  formatTrace,
  type ActionChoice,
  type ApplyResult,
  type Command,
  type GameState,
  type Prompt,
  type Seat,
  type TraceEvent,
  type TracePayload,
} from '../src/index.ts';

export interface Step {
  state: GameState;
  events: TraceEvent[];
}

/** Unwraps a successful apply(), failing the test (with the error) otherwise. */
export function ok(result: ApplyResult): Step {
  if (!result.ok) expect.fail(`command rejected: ${result.error.code}: ${result.error.message}`);
  return { state: result.state, events: result.events };
}

export function promptFor<K extends Prompt['kind']>(
  state: GameState,
  seat: Seat,
  kind: K,
): Extract<Prompt, { kind: K }> {
  const prompt = state.prompts.find((p) => p.seat === seat && p.kind === kind);
  if (!prompt) {
    expect.fail(`no ${kind} prompt for S${seat}; open prompts: ${JSON.stringify(state.prompts)}`);
  }
  return prompt as Extract<Prompt, { kind: K }>;
}

export function actionCommand(state: GameState, seat: Seat, choice: ActionChoice): Command {
  return { type: 'answer', promptId: promptFor(state, seat, 'action').id, answer: { kind: 'action', choice } };
}

/** `seat` takes one action, which must succeed. */
export function act(state: GameState, seat: Seat, choice: ActionChoice): Step {
  return ok(apply(state, seat, actionCommand(state, seat, choice)));
}

export const draw = (state: GameState, seat: Seat): Step => act(state, seat, { action: 'draw' });

/** `seat` chooses the keep that receives their pending HOT Keep card. */
export function hotTarget(state: GameState, seat: Seat, target: Seat): Step {
  const prompt = promptFor(state, seat, 'hot-target');
  return ok(apply(state, seat, { type: 'answer', promptId: prompt.id, answer: { kind: 'hot-target', target } }));
}

/** Payload types, in order. */
export function types(events: readonly TraceEvent[]): TracePayload['type'][] {
  return events.map((e) => e.payload.type);
}

export function payloads<T extends TracePayload['type']>(
  events: readonly TraceEvent[],
  type: T,
): Extract<TracePayload, { type: T }>[] {
  return events.map((e) => e.payload).filter((p): p is Extract<TracePayload, { type: T }> => p.type === type);
}

/** Readable trace, for debugging failing tests: console.log(show(events)). */
export const show = formatTrace;

/** The top action frame's remaining actions. */
export function actionsLeft(state: GameState): number {
  const top = state.stack.at(-1);
  if (top?.op !== 'action-frame') expect.fail(`top of stack is not an action frame: ${JSON.stringify(top)}`);
  return top.remaining;
}
