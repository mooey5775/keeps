import { CARDS, type CardId } from './cards.ts';
import {
  EngineFailure,
  type ActionChoice,
  type Answer,
  type Command,
  type EngineError,
} from './commands.ts';
import { abilityCost, legalAbilities, useAbility } from './abilities.ts';
import { clone, push, type Ctx } from './context.ts';
import {
  assertImplemented,
  isLegalEffectAnswer,
  legalEffectAnswers,
  resolveEffectAnswer,
  resolveNonKeepEffect,
} from './effects.ts';
import { assertInvariants, assertRestInvariants } from './invariants.ts';
import { cardEnteredHand, keepTargets, openPrompt, spendActions } from './moves.ts';
import { roundWinner, tokenWinner } from './scoring.ts';
import { dealGame, startRound, type NewGameOptions } from './setup.ts';
import {
  leftOf,
  pileAtSeat,
  type GameState,
  type Op,
  type Prompt,
  type Seat,
} from './state.ts';
import { assertNever, Tracer, type TraceEvent } from './trace.ts';

export type ApplyResult =
  | { ok: true; state: GameState; events: TraceEvent[] }
  | { ok: false; error: EngineError };

/** Deals a new game and runs it to the first decision (the first player's action). */
export function newGame(options: NewGameOptions): { state: GameState; events: TraceEvent[] } {
  const { state, events } = dealGame(options);
  const ctx: Ctx = { state, tracer: new Tracer(state) };
  advance(ctx);
  assertInvariants(state);
  assertRestInvariants(state);
  return { state, events: [...events, ...ctx.tracer.events] };
}

/**
 * Applies one player command. Pure: `state` is never modified. Rejected
 * commands return an error and change nothing.
 */
export function apply(state: GameState, seat: Seat, command: Command): ApplyResult {
  const rejection = validate(state, seat, command);
  if (rejection) return { ok: false, error: rejection };

  const draft = clone(state);
  const ctx: Ctx = { state: draft, tracer: new Tracer(draft) };
  try {
    execute(ctx, command);
    advance(ctx);
  } catch (error) {
    if (error instanceof EngineFailure) return { ok: false, error: { code: error.code, message: error.message } };
    throw error;
  }
  assertInvariants(draft);
  assertRestInvariants(draft);
  return { ok: true, state: draft, events: ctx.tracer.events };
}

/** Every command `seat` may send right now. */
export function legalCommands(state: GameState, seat: Seat): Command[] {
  if (state.config.seats[seat] !== 'player') return [];
  if (state.phase === 'round-over') return [{ type: 'next-round' }];
  return state.prompts
    .filter((p) => p.seat === seat)
    .flatMap((p) => legalAnswers(state, p).map((answer): Command => ({ type: 'answer', promptId: p.id, answer })));
}

function legalAnswers(state: GameState, prompt: Prompt): Answer[] {
  switch (prompt.kind) {
    case 'action':
      return legalActions(state, prompt.seat).map((choice) => ({ kind: 'action', choice }));
    case 'hot-target':
      return keepTargets(state, prompt.seat, prompt.card).map((target) => ({ kind: 'hot-target', target }));
    default:
      return legalEffectAnswers(state, prompt);
  }
}

function legalActions(state: GameState, seat: Seat): ActionChoice[] {
  const frame = state.stack.at(-1);
  if (frame?.op !== 'action-frame') throw new Error('action prompt without an action frame on top');
  const choices: ActionChoice[] = [{ action: 'draw' }];
  for (const card of state.hands[seat]) {
    if (CARDS[card].keep) {
      for (const target of keepTargets(state, seat, card)) choices.push({ action: 'play', card, target });
    } else {
      choices.push({ action: 'play', card });
    }
  }
  choices.push(...legalAbilities(state, seat, frame));
  return choices;
}

/** Stable JSON for comparing commands regardless of key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

function validate(state: GameState, seat: Seat, command: Command): EngineError | null {
  if (state.config.seats[seat] !== 'player') {
    return { code: 'not-a-player', message: `seat ${seat} is not a player` };
  }
  if (command.type === 'answer') {
    const prompt = state.prompts.find((p) => p.id === command.promptId);
    if (!prompt) return { code: 'unknown-prompt', message: `no open prompt ${command.promptId}` };
    if (prompt.seat !== seat) {
      return { code: 'not-your-prompt', message: `prompt ${prompt.id} is for seat ${prompt.seat}` };
    }
    const { answer } = command;
    if (answer.kind !== prompt.kind) {
      return { code: 'illegal', message: `prompt ${prompt.id} is a ${prompt.kind} prompt, not ${answer.kind}` };
    }
    if (answer.kind !== 'action' && answer.kind !== 'hot-target' && prompt.kind !== 'action' && prompt.kind !== 'hot-target') {
      const special = isLegalEffectAnswer(state, prompt, answer);
      if (special !== null) {
        return special ? null : { code: 'illegal', message: `illegal answer: ${canonical(answer)}` };
      }
    }
  }
  const wanted = canonical(command);
  if (!legalCommands(state, seat).some((c) => canonical(c) === wanted)) {
    return { code: 'illegal', message: `illegal command for seat ${seat}: ${wanted}` };
  }
  return null;
}

function execute(ctx: Ctx, command: Command): void {
  const { state, tracer } = ctx;
  switch (command.type) {
    case 'next-round':
      startRound(state, tracer);
      return;
    case 'answer': {
      const prompt = state.prompts.find((p) => p.id === command.promptId)!;
      state.prompts = state.prompts.filter((p) => p !== prompt);
      tracer.at(prompt.event, prompt.depth + 1, () => answer(ctx, prompt, command.answer));
      return;
    }
    default:
      assertNever(command);
  }
}

function answer(ctx: Ctx, prompt: Prompt, given: Answer): void {
  switch (given.kind) {
    case 'action':
      takeAction(ctx, prompt.seat, given.choice);
      return;
    case 'hot-target': {
      if (prompt.kind !== 'hot-target') throw new Error('answer kind does not match prompt');
      push(ctx, { op: 'play', seat: prompt.seat, card: prompt.card, target: given.target, hot: true });
      return;
    }
    default:
      if (prompt.kind === 'action' || prompt.kind === 'hot-target') throw new Error('answer kind does not match prompt');
      resolveEffectAnswer(ctx, prompt, given);
  }
}

function takeAction(ctx: Ctx, seat: Seat, choice: ActionChoice): void {
  const { state, tracer } = ctx;
  const frame = state.stack.at(-1);
  if (frame?.op !== 'action-frame' || frame.seat !== seat || frame.remaining <= 0) {
    throw new Error(`no action frame for seat ${seat} on top of the stack`);
  }
  const cost = choice.action === 'ability' ? abilityCost(choice) : 1;
  spendActions(state, seat, cost);
  if (state.turn?.seat === seat) state.turn.actionsTaken += cost;
  const seq = tracer.emit({ type: 'action', seat, frame: frame.kind, remaining: frame.remaining, choice });
  tracer.within(seq, () => {
    switch (choice.action) {
      case 'draw':
        push(ctx, { op: 'draw', seat, from: seat });
        return;
      case 'play':
        push(ctx, { op: 'play', seat, card: choice.card, target: choice.target ?? null, hot: false });
        return;
      case 'ability':
        useAbility(ctx, seat, choice);
        return;
      default:
        assertNever(choice);
    }
  });
}

/** Runs the resolution stack until the engine needs a decision (or the round/game is over). */
export function advance(ctx: Ctx): void {
  const { state } = ctx;
  for (let steps = 0; ; steps++) {
    if (steps > 10_000) throw new Error('advance: runaway resolution loop');
    if (state.prompts.length > 0) return;
    if (checkTokenVictory(ctx)) continue;
    const top = state.stack.at(-1);
    if (!top) {
      if (state.phase !== 'playing') return;
      nextTurn(ctx);
      continue;
    }
    if (top.op === 'action-frame') {
      if (top.remaining > 0) {
        ctx.tracer.at(top.cause, top.depth, () => openPrompt(ctx, { seat: top.seat, kind: 'action' }));
        return;
      }
      state.stack.pop();
      continue;
    }
    state.stack.pop();
    ctx.tracer.at(top.cause, top.depth, () => runOp(ctx, top));
  }
}

function runOp(ctx: Ctx, op: Op): void {
  switch (op.op) {
    case 'draw':
      return runDraw(ctx, op.seat, op.from);
    case 'play':
      return runPlay(ctx, op.seat, op.card, op.target, op.hot);
    case 'hot-check':
      return runHotCheck(ctx, op.seat);
    case 'score':
      return runScore(ctx);
    case 'action-frame':
      throw new Error('action frames are handled by advance()');
    default:
      assertNever(op);
  }
}

/** Turn start. Shackles face-up in your own keep limits the turn to one action. */
export function beginTurn(ctx: Ctx, seat: Seat): void {
  const { state, tracer } = ctx;
  state.turnNumber++;
  state.turn = { seat, actionsTaken: 0, usedOncePerTurn: [] };
  const shackled = state.keeps[seat].some((c) => c.id === 'shackles' && !c.faceDown);
  const actions = shackled ? 1 : 2;
  const seq = tracer.emit({ type: 'turn-start', seat, actions });
  tracer.within(seq, () =>
    push(ctx, { op: 'action-frame', seat, remaining: actions, kind: 'turn', restricted: false }),
  );
}

/** Play passes to the left, skipping ghosts. */
function nextTurn(ctx: Ctx): void {
  const { state, tracer } = ctx;
  let seat: Seat;
  if (state.turn) {
    tracer.at(null, 0, () => tracer.emit({ type: 'turn-end', seat: state.turn!.seat }));
    seat = leftOf(state.turn.seat);
    while (state.config.seats[seat] !== 'player') seat = leftOf(seat);
  } else {
    if (state.startingSeat === null) throw new Error('no starting seat');
    seat = state.startingSeat;
  }
  tracer.at(null, 0, () => beginTurn(ctx, seat));
}

function runDraw(ctx: Ctx, seat: Seat, from: Seat): void {
  const { state, tracer } = ctx;
  const pile = pileAtSeat(state, from);
  const top = pile.cards.shift();
  if (!top) {
    const afterRoundEnd = state.phase === 'post-round';
    tracer.emit({ type: 'empty-draw', seat, from, afterRoundEnd });
    if (!afterRoundEnd) endRoundByEmptyPile(ctx, seat);
    return;
  }
  state.hands[seat].push(top.id);
  // A face-up top card (Revelation, a placed Blunder) was public already.
  const seq = top.faceUp
    ? tracer.emit({ type: 'draw', seat, from, card: top.id })
    : tracer.emit(
        { type: 'draw', seat, from, card: top.id },
        { visibility: [seat], redacted: { type: 'draw', seat, from, card: null } },
      );
  cardEnteredHand(ctx, seat, top.id, seq);
}

/**
 * HOT cards cost no action and must be played as soon as they enter a hand.
 * Handles one HOT card, then re-checks for more.
 */
function runHotCheck(ctx: Ctx, seat: Seat): void {
  const { state } = ctx;
  const card = state.hands[seat].find((c) => CARDS[c].hot);
  if (!card) return;
  push(ctx, { op: 'hot-check', seat });
  if (!CARDS[card].keep) {
    push(ctx, { op: 'play', seat, card, target: null, hot: true });
  } else if (card === 'blunder') {
    push(ctx, { op: 'play', seat, card, target: seat, hot: true });
  } else {
    assertImplemented(card);
    openPrompt(ctx, { seat, kind: 'hot-target', card });
  }
}

function runPlay(ctx: Ctx, seat: Seat, card: CardId, target: Seat | null, hot: boolean): void {
  const { state, tracer } = ctx;
  const hand = state.hands[seat];
  const index = hand.indexOf(card);
  if (index < 0) throw new Error(`seat ${seat} cannot play ${card}: not in hand`);
  assertImplemented(card);
  hand.splice(index, 1);

  if (CARDS[card].keep) {
    if (target === null || !keepTargets(state, seat, card).includes(target)) {
      throw new Error(`invalid keep target ${target} for ${card}`);
    }
    state.keeps[target].push({ id: card });
    tracer.emit({ type: 'play', seat, card, target, hot });
    return;
  }
  // Non-Keep cards are discarded first, then resolve (so Resurrection can fetch itself).
  state.discard.push(card);
  const seq = tracer.emit({ type: 'play', seat, card, target: null, hot });
  tracer.within(seq, () => resolveNonKeepEffect(ctx, card, seat));
}

function endRoundByEmptyPile(ctx: Ctx, ender: Seat): void {
  const { state, tracer } = ctx;
  state.roundEnd = { kind: 'empty-pile', enderSeat: ender };
  state.stack = [];
  state.prompts = [];
  state.phase = 'post-round';
  const seq = tracer.emit({ type: 'round-end', reason: 'empty-pile', ender });
  tracer.within(seq, () => push(ctx, { op: 'score' }));
}

function runScore(ctx: Ctx): void {
  const { state, tracer } = ctx;
  if (state.roundEnd?.kind !== 'empty-pile') throw new Error('scoring without an empty-pile round end');
  const result = roundWinner(state, state.roundEnd.enderSeat);
  const seq = tracer.emit({ type: 'score', scores: result.scores, winner: result.winner, tiedWith: result.tiedWith });
  tracer.within(seq, () => awardMark(ctx, result.winner));
}

/**
 * Token victory: the instant one keep holds all three Tokens face-up, the round
 * is completely over, even after round end. No Last Laugh, no Retribution.
 */
function checkTokenVictory(ctx: Ctx): boolean {
  const { state, tracer } = ctx;
  if (state.phase !== 'playing' && state.phase !== 'post-round') return false;
  const winner = tokenWinner(state);
  if (winner === null) return false;
  state.roundEnd = { kind: 'tokens', winner };
  state.stack = [];
  state.prompts = [];
  const seq = tracer.emit({ type: 'round-end', reason: 'tokens', winner });
  tracer.within(seq, () => awardMark(ctx, winner));
  return true;
}

function awardMark(ctx: Ctx, winner: Seat): void {
  const { state, tracer } = ctx;
  state.marks[winner]++;
  state.lastRoundWinner = winner;
  state.turn = null;
  state.stack = [];
  tracer.emit({ type: 'mark', seat: winner, marks: state.marks[winner] });
  if (state.marks[winner] >= state.config.marksToWin) {
    state.phase = 'game-over';
    tracer.emit({ type: 'game-over', winner });
  } else {
    state.phase = 'round-over';
  }
}
