import { CARDS, isCoinCard, type CardId } from './cards.ts';
import {
  EngineFailure,
  type ActionChoice,
  type Answer,
  type Command,
  type EngineError,
} from './commands.ts';
import { abilityCost, legalAbilities, useAbility } from './abilities.ts';
import { clone, newCtx, push, withPlay, type Ctx } from './context.ts';
import {
  isLegalEffectAnswer,
  legalEffectAnswers,
  resolveEffectAnswer,
  resolveKeepOnPlay,
  resolveNonKeepEffect,
} from './effects.ts';
import { canReveal, faceDownCard, needsPlayWindow, reveal, runWindow } from './duplicity.ts';
import { assertInvariants, assertRestInvariants } from './invariants.ts';
import {
  cardEnteredHand,
  enterKeep,
  keepTargets,
  openPrompt,
  recordChange,
  seatsWithFaceUp,
  spendActions,
} from './moves.ts';
import { roundWinner, tokenWinner } from './scoring.ts';
import { dealGame, startRound, type NewGameOptions } from './setup.ts';
import {
  leftOf,
  pileAtSeat,
  type GameState,
  type Op,
  type Prompt,
  type Seat,
  type TriggerKind,
} from './state.ts';
import { assertNever, Tracer, type TraceEvent } from './trace.ts';

export type ApplyResult =
  | { ok: true; state: GameState; events: TraceEvent[] }
  | { ok: false; error: EngineError };

/** Deals a new game and runs it to the first decision (the first player's action). */
export function newGame(options: NewGameOptions): { state: GameState; events: TraceEvent[] } {
  const { state, events } = dealGame(options);
  const ctx = newCtx(state, new Tracer(state));
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
  const ctx = newCtx(draft, new Tracer(draft));
  try {
    execute(ctx, seat, command);
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
  const commands = state.prompts
    .filter((p) => p.seat === seat)
    .flatMap((p) => legalAnswers(state, p).map((answer): Command => ({ type: 'answer', promptId: p.id, answer })));
  if (canReveal(state, seat)) commands.push({ type: 'reveal-duplicity' });
  return commands;
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
  const hand = state.hands[seat];
  for (const card of hand) {
    if (CARDS[card].keep) {
      for (const target of keepTargets(state, seat, card)) choices.push({ action: 'play', card, target });
    } else if (card === 'joker') {
      // Joker must reveal a non-Keep card from your hand to copy (Q-09).
      for (const copy of jokerCopies(state, seat)) choices.push({ action: 'play', card, copy });
    } else {
      choices.push({ action: 'play', card });
    }
  }
  choices.push(...legalAbilities(state, seat, frame));
  // Last Laugh's action is optional.
  if (frame.kind === 'last-laugh') choices.push({ action: 'pass' });
  return choices;
}

/** Non-Keep cards in `seat`'s hand that Joker could reveal and copy. */
function jokerCopies(state: GameState, seat: Seat): CardId[] {
  return [...new Set(state.hands[seat].filter((c) => c !== 'joker' && !CARDS[c].keep))];
}

/** Stable JSON for comparing commands regardless of key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function validate(state: GameState, seat: Seat, command: Command): EngineError | null {
  if (state.config.seats[seat] !== 'player') {
    return { code: 'not-a-player', message: `seat ${seat} is not a player` };
  }
  // Commands arrive as JSON from browsers: check the shape before reading it.
  if (!isObject(command) || typeof command.type !== 'string') {
    return { code: 'illegal', message: 'malformed command' };
  }
  if (command.type === 'answer' && (typeof command.promptId !== 'string' || !isObject(command.answer) || typeof command.answer.kind !== 'string')) {
    return { code: 'illegal', message: 'malformed answer' };
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

function execute(ctx: Ctx, seat: Seat, command: Command): void {
  const { state, tracer } = ctx;
  switch (command.type) {
    case 'next-round':
      startRound(state, tracer);
      return;
    case 'reveal-duplicity':
      reveal(ctx, seat, null);
      return;
    case 'answer': {
      const prompt = state.prompts.find((p) => p.id === command.promptId)!;
      state.prompts = state.prompts.filter((p) => p !== prompt);
      tracer.at(prompt.event, prompt.depth + 1, () =>
        withPlay(ctx, prompt.play, () => answer(ctx, prompt, command.answer)),
      );
      return;
    }
    default:
      assertNever(command);
  }
}

function answer(ctx: Ctx, prompt: Prompt, given: Answer): void {
  switch (given.kind) {
    case 'action':
      // An action is never part of an earlier play's resolution.
      withPlay(ctx, null, () => takeAction(ctx, prompt.seat, given.choice));
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
  const cost = choice.action === 'ability' ? abilityCost(choice) : choice.action === 'pass' ? frame.remaining : 1;
  spendActions(state, seat, cost);
  if (state.turn?.seat === seat) state.turn.actionsTaken += cost;
  const seq = tracer.emit({ type: 'action', seat, frame: frame.kind, remaining: frame.remaining, choice });
  tracer.within(seq, () => {
    switch (choice.action) {
      case 'draw':
        push(ctx, { op: 'draw', seat, from: seat });
        return;
      case 'play':
        push(ctx, {
          op: 'play',
          seat,
          card: choice.card,
          target: choice.target ?? null,
          hot: false,
          ...(choice.copy ? { copy: choice.copy } : {}),
        });
        return;
      case 'ability':
        useAbility(ctx, seat, choice);
        return;
      case 'pass':
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
    if (checkTokenVictory(ctx)) continue;
    if (state.prompts.length > 0) return;
    const top = state.stack.at(-1);
    if (!top) {
      if (state.phase !== 'playing') return;
      nextTurn(ctx);
      continue;
    }
    if (top.op === 'action-frame') {
      if (top.remaining > 0) {
        ctx.tracer.at(top.cause, top.depth, () =>
          withPlay(ctx, top.play, () => openPrompt(ctx, { seat: top.seat, kind: 'action' })),
        );
        return;
      }
      state.stack.pop();
      continue;
    }
    state.stack.pop();
    ctx.tracer.at(top.cause, top.depth, () => withPlay(ctx, top.play, () => runOp(ctx, top)));
  }
}

function runOp(ctx: Ctx, op: Op): void {
  switch (op.op) {
    case 'draw':
      return runDraw(ctx, op.seat, op.from, op.invoke ?? false);
    case 'play':
      return runPlay(ctx, op.seat, op.card, op.target, op.hot, op.copy);
    case 'hot-check':
      return runHotCheck(ctx, op.seat);
    case 'play-as-hot':
      if (!ctx.state.hands[op.seat].includes(op.card)) throw new Error(`${op.card} is not in seat ${op.seat}'s hand`);
      return playAsHot(ctx, op.seat, op.card);
    case 'last-laugh':
      return runLastLaugh(ctx);
    case 'after-play':
      return runAfterPlay(ctx, op.playId, op.windowed ?? false);
    case 'window':
      return runWindow(ctx, op.reason, op.playId);
    case 'trigger':
      return runTrigger(ctx, op.kind, op.seat, op.source);
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

function runDraw(ctx: Ctx, seat: Seat, from: Seat, invoke: boolean): void {
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
  if (invoke) {
    // Invocation: the drawn card is played as if HOT, whatever it is.
    recordChange(ctx, seat);
    tracer.within(seq, () => push(ctx, { op: 'play-as-hot', seat, card: top.id }));
  } else {
    cardEnteredHand(ctx, seat, top.id, seq);
  }
}

/**
 * HOT cards cost no action and must be played as soon as they enter a hand.
 * Handles one HOT card, then re-checks for more.
 */
function runHotCheck(ctx: Ctx, seat: Seat): void {
  const card = ctx.state.hands[seat].find((c) => CARDS[c].hot);
  if (!card) return;
  push(ctx, { op: 'hot-check', seat });
  playAsHot(ctx, seat, card);
}

/**
 * Plays `card` from `seat`'s hand right now at no action cost: HOT cards, and
 * cards played "as if HOT" (Legerdemain, Invocation). Keep cards need a target
 * keep (Blunder: always your own); Joker needs a card to reveal and copy.
 */
function playAsHot(ctx: Ctx, seat: Seat, card: CardId): void {
  if (card === 'blunder') {
    push(ctx, { op: 'play', seat, card, target: seat, hot: true });
  } else if (CARDS[card].keep) {
    openPrompt(ctx, { seat, kind: 'hot-target', card });
  } else if (card === 'joker' && jokerCopies(ctx.state, seat).length > 0) {
    openPrompt(ctx, { seat, kind: 'joker-copy', options: jokerCopies(ctx.state, seat) });
  } else {
    push(ctx, { op: 'play', seat, card, target: null, hot: true });
  }
}

/**
 * Plays a card from `seat`'s hand. Keep cards enter the target keep; non-Keep
 * cards are discarded first, then resolve (so Resurrection can fetch itself).
 * Triggers are collected while the play resolves and queued by its
 * after-play op, which runs once everything the play started is finished.
 */
function runPlay(ctx: Ctx, seat: Seat, card: CardId, target: Seat | null, hot: boolean, copy?: CardId): void {
  const { state, tracer } = ctx;
  const hand = state.hands[seat];
  const index = hand.indexOf(card);
  if (index < 0) throw new Error(`seat ${seat} cannot play ${card}: not in hand`);
  const keep = CARDS[card].keep;
  if (keep && (target === null || !keepTargets(state, seat, card).includes(target))) {
    throw new Error(`invalid keep target ${target} for ${card}`);
  }

  const retribution = seatsWithFaceUp(state, 'retribution');
  hand.splice(index, 1);
  if (!keep) state.discard.push(card);
  const id = tracer.emit({ type: 'play', seat, card, target: keep ? target : null, hot, ...(copy ? { copy } : {}) });
  const hidden = faceDownCard(state);
  state.openPlays.push({
    id,
    actor: seat,
    card,
    retribution,
    changed: [seat],
    entries: [],
    hidden: hidden && { seat: hidden.seat, card: hidden.card },
  });

  tracer.within(id, () => {
    withPlay(ctx, null, () => push(ctx, { op: 'after-play', playId: id }));
    withPlay(ctx, id, () => {
      if (keep) {
        enterKeep(ctx, target!, { id: card });
        resolveKeepOnPlay(ctx, card, seat);
      } else {
        resolveNonKeepEffect(ctx, card, seat, copy);
      }
    });
  });
}

/**
 * Queues the play's triggers so they resolve in the official order
 * (C-01): Retribution, then Interest, then Royal Favor.
 * - Retribution: a seat other than the player who had it face-up when the
 *   play started, and whose hand or keep the play changed. Once per play.
 * - Interest: each face-up Coin card that entered a keep where Interest
 *   already was (and stayed).
 * - Royal Favor: each time it entered a keep face-up.
 */
function runAfterPlay(ctx: Ctx, playId: number, windowed: boolean): void {
  const { state, tracer } = ctx;
  const record = state.openPlays.find((p) => p.id === playId);
  if (!record) throw new Error(`after-play for unknown play ${playId}`);
  if (!windowed && needsPlayWindow(state, record)) {
    // Let the Duplicity holder reveal before this play's triggers are collected.
    push(ctx, { op: 'after-play', playId, windowed: true });
    push(ctx, { op: 'window', reason: 'play', playId });
    return;
  }
  state.openPlays = state.openPlays.filter((p) => p !== record);

  const triggers: { kind: TriggerKind; seat: Seat }[] = [
    ...record.retribution
      .filter((s) => s !== record.actor && record.changed.includes(s))
      .map((seat) => ({ kind: 'retribution' as const, seat })),
    ...record.entries
      .filter((e) => e.interest && isCoinCard(e.card))
      .map((e) => ({ kind: 'interest' as const, seat: e.seat })),
    ...record.entries
      .filter((e) => e.card === 'royal-favor')
      .map((e) => ({ kind: 'royal-favor' as const, seat: e.seat })),
  ];
  if (triggers.length === 0) return;
  const seq = tracer.emit({ type: 'triggers', card: record.card, triggers });
  tracer.within(seq, () => {
    for (const trigger of [...triggers].reverse()) push(ctx, { op: 'trigger', ...trigger, source: record.card });
  });
}

function runTrigger(ctx: Ctx, kind: TriggerKind, seat: Seat, source: CardId): void {
  const seq = ctx.tracer.emit({ type: 'trigger', kind, seat, source });
  ctx.tracer.within(seq, () => {
    switch (kind) {
      case 'retribution':
        push(ctx, { op: 'action-frame', seat, remaining: 2, kind: 'retribution', restricted: true });
        return;
      case 'interest':
      case 'royal-favor':
        push(ctx, { op: 'draw', seat, from: seat });
        return;
      default:
        assertNever(kind);
    }
  });
}

function endRoundByEmptyPile(ctx: Ctx, ender: Seat): void {
  const { state, tracer } = ctx;
  state.roundEnd = { kind: 'empty-pile', enderSeat: ender };
  state.stack = [];
  state.prompts = [];
  state.openPlays = [];
  state.phase = 'post-round';
  const seq = tracer.emit({ type: 'round-end', reason: 'empty-pile', ender });
  // Nothing else happens before scoring except Last Laugh (and what it
  // triggers), with chances to reveal Duplicity's card before and after it.
  tracer.within(seq, () => {
    push(ctx, { op: 'score' });
    push(ctx, { op: 'window', reason: 'before-scoring', playId: null });
    push(ctx, { op: 'last-laugh' });
    push(ctx, { op: 'window', reason: 'before-last-laugh', playId: null });
  });
}

/** "If this card is in your keep when the round ends, you may take one action right before scoring." */
function runLastLaugh(ctx: Ctx): void {
  for (const seat of seatsWithFaceUp(ctx.state, 'last-laugh')) {
    const seq = ctx.tracer.emit({ type: 'last-laugh', seat });
    ctx.tracer.within(seq, () =>
      push(ctx, { op: 'action-frame', seat, remaining: 1, kind: 'last-laugh', restricted: true }),
    );
  }
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
  state.openPlays = [];
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
