import { expect } from 'vitest';
import {
  apply,
  buildPosition,
  formatTrace,
  legalCommands,
  type ActionChoice,
  type Answer,
  type ApplyResult,
  type CardId,
  type Command,
  type GameState,
  type KeepCard,
  type PositionSpec,
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

/** Answers `seat`'s open prompt of the answer's kind, which must succeed. */
export function respond(state: GameState, seat: Seat, answer: Answer): Step {
  const prompt = promptFor(state, seat, answer.kind);
  return ok(apply(state, seat, { type: 'answer', promptId: prompt.id, answer }));
}

/** Like respond(), but returns the raw result (for testing rejections). */
export function tryRespond(state: GameState, seat: Seat, answer: Answer): ApplyResult {
  const prompt = promptFor(state, seat, answer.kind);
  return apply(state, seat, { type: 'answer', promptId: prompt.id, answer });
}

/** `seat` (the Duplicity holder) reveals the face-down card with the free command. */
export function revealNow(state: GameState, seat: Seat): Step {
  return ok(apply(state, seat, { type: 'reveal-duplicity' }));
}

/** The action choices currently legal for `seat`. */
export function actionChoices(state: GameState, seat: Seat): ActionChoice[] {
  return legalCommands(state, seat).flatMap((c) =>
    c.type === 'answer' && c.answer.kind === 'action' ? [c.answer.choice] : [],
  );
}

/** Abilities currently legal for `seat`, as "card" or "card:detail" strings. */
export function abilityNames(state: GameState, seat: Seat): string[] {
  return [...new Set(actionChoices(state, seat).flatMap((c) => (c.action === 'ability' ? [c.card] : [])))];
}

export function pileIds(state: GameState, position: Seat): CardId[] {
  return state.piles[state.pileAt[position]].cards.map((c) => c.id);
}

/** Concatenates the events of several steps. */
export function allEvents(...steps: Step[]): TraceEvent[] {
  return steps.flatMap((s) => s.events);
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

/** A face-down card for a keep, placed (and so known) by `placedBy`. */
export const hidden = (id: CardId, placedBy: Seat): KeepCard => ({ id, faceDown: { placedBy } });

/** Face-up keep cards. */
export const keepOf = (...ids: CardId[]): KeepCard[] => ids.map((id) => ({ id }));

/** The triggers in `events`, in order, as `kind(S<seat>)`. */
export const triggerOrder = (events: readonly TraceEvent[]) =>
  payloads(events, 'trigger').map((t) => `${t.kind}(S${t.seat})`);

/** The stack's action frames, bottom first, as `S<seat>:<kind>:<remaining>`, with `!` if restricted. */
export const frames = (state: GameState) =>
  state.stack.flatMap((op) => (op.op === 'action-frame' ? [`S${op.seat}:${op.kind}:${op.remaining}${op.restricted ? '!' : ''}`] : []));

/** Builds `spec` with successive seeds until Legerdemain (played by S0 on `victim`) steals `card`. */
export function stealing(spec: PositionSpec, victim: Seat, card: CardId): { start: GameState; stolen: Step } {
  for (let seed = 0; seed < 100; seed++) {
    const start = buildPosition({ ...spec, seed });
    const played = act(start, 0, { action: 'play', card: 'legerdemain' });
    const stolen = respond(played.state, 0, { kind: 'choose-player', seat: victim });
    if (payloads(stolen.events, 'steal')[0]?.cards?.[0] === card) return { start, stolen };
  }
  throw new Error(`no seed under 100 makes Legerdemain steal ${card}`);
}

/** S0 (Last Laugh, plus `keep`) ends the round on their first action; returns the post-round state. */
export function lastLaughAfterEnding(keep: CardId[], hand: CardId[] = []): GameState {
  const start = buildPosition({ keeps: { 0: ['last-laugh', ...keep] }, hands: { 0: hand }, turn: 0 });
  const { state } = draw(start, 0);
  expect(state.phase).toBe('post-round');
  return state;
}
