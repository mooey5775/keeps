import { describe, expect, it } from 'vitest';
import {
  apply,
  legalCommands,
  PUZZLES,
  puzzleOutcome,
  puzzleState,
  YOU,
  type CardId,
  type GameState,
  type Seat,
} from '../../src/index.ts';
import { act, draw, hotTarget, ok, payloads, respond, revealNow, type Step } from '../helpers.ts';

// Each official puzzle, played out with its official solution. When an
// opponent has a decision, we try every choice they could make and require
// that you win in all of them: that's what makes a puzzle's solution forced.

const LEFT = 1 as Seat;
const UPPER = 2 as Seat;
const RIGHT = 3 as Seat;

function start(id: string): GameState {
  const puzzle = PUZZLES.find((p) => p.id === id)!;
  return puzzleState(puzzle);
}

function keepIndex(state: GameState, seat: Seat, card: CardId): number {
  const index = state.keeps[seat].findIndex((c) => c.id === card);
  if (index < 0) throw new Error(`${card} is not in seat ${seat}'s keep`);
  return index;
}

const keepRef = (state: GameState, seat: Seat, card: CardId) => ({ seat, index: keepIndex(state, seat, card) });

function swap(state: GameState, a: [Seat, CardId], b: [Seat, CardId]) {
  return respond(state, YOU, { kind: 'choose-keep-pair', a: keepRef(state, ...a), b: keepRef(state, ...b) });
}

/** Plays opponents' decisions that have only one legal option; stops at a real choice or yours. */
function opponentsPlay(state: GameState): GameState {
  for (let i = 0; i < 50; i++) {
    const prompt = state.prompts[0];
    if (!prompt || prompt.seat === YOU) return state;
    const options = legalCommands(state, prompt.seat).filter((c) => c.type !== 'reveal-duplicity');
    if (options.length !== 1) return state;
    state = ok(apply(state, prompt.seat, options[0]!)).state;
  }
  throw new Error('opponents never finished');
}

/** Every way the round can end from here, branching over all opponents' choices. */
function everyEnding(state: GameState, depth = 0): GameState[] {
  if (state.phase === 'round-over' || state.phase === 'game-over') return [state];
  expect(depth, 'too deep: the round does not end').toBeLessThan(30);
  const prompt = state.prompts[0];
  if (!prompt) throw new Error('nobody is deciding anything');
  expect(prompt.seat, 'the solution should not need another decision from you').not.toBe(YOU);
  return legalCommands(state, prompt.seat).flatMap((command) => everyEnding(ok(apply(state, prompt.seat, command)).state, depth + 1));
}

function expectWon(state: GameState, startTurn = 1) {
  expect(puzzleOutcome(state, startTurn)).toBe('won');
}

function expectAlwaysWon(state: GameState) {
  const endings = everyEnding(state);
  expect(endings.length).toBeGreaterThan(0);
  for (const end of endings) expectWon(end);
  return endings;
}

describe('official puzzles', () => {
  it('all 25 positions are valid starting positions on your turn', () => {
    expect(PUZZLES).toHaveLength(25);
    for (const puzzle of PUZZLES) {
      const state = puzzleState(puzzle);
      expect(state.turn?.seat).toBe(YOU);
      expect(puzzleOutcome(state, 1)).toBe('playing');
    }
  });

  it('P-01 Humble Beginnings: draw twice; the second draw ends the round', () => {
    const { state } = draw(draw(start('P-01'), YOU).state, YOU);
    expectWon(state);
  });

  it('P-02 Divine Intervention: Providence swaps Blunder onto the upper player, then draw', () => {
    const s = start('P-02');
    const played = act(s, YOU, { action: 'play', card: 'providence' });
    const swapped = swap(played.state, [YOU, 'blunder'], [UPPER, 'scepter']);
    const { state, events } = draw(swapped.state, YOU);
    expect(payloads(events, 'score')[0]).toMatchObject({ scores: [8, 6, -14, 0], winner: YOU });
    expectWon(state);
  });

  it('P-03 Rags to Riches: Purity, then Sanction from the empty right pile', () => {
    const pure = act(start('P-03'), YOU, { action: 'play', card: 'purity', target: YOU });
    const { state } = act(pure.state, YOU, { action: 'ability', card: 'sanction', from: RIGHT });
    expectWon(state);
  });

  it('P-04 This Looks Familiar: Juggling, then the Fool Token on the Interest player', () => {
    const juggled = act(start('P-04'), YOU, { action: 'ability', card: 'juggling', piles: [LEFT, UPPER] });
    const { state, events } = act(juggled.state, YOU, { action: 'play', card: 'fool-token', target: UPPER });
    // Tied at 2 coins; the upper player drew to end it, so you win the tie.
    expect(payloads(events, 'score')[0]).toMatchObject({ winner: YOU, tiedWith: [UPPER] });
    expectWon(state);
  });

  it('P-05 Better Than Two Pair: Hocus Pocus for three actions, collect all three Tokens', () => {
    let s = act(start('P-05'), YOU, { action: 'play', card: 'hocus-pocus' }).state;
    s = act(s, YOU, { action: 'play', card: 'fool-token', target: YOU }).state;
    s = draw(s, YOU).state;
    const { state, events } = act(s, YOU, { action: 'play', card: 'friar-token', target: YOU });
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'tokens', winner: YOU }]);
    expectWon(state);
  });

  it('P-06 Best Served Cold: Providence, then Last Laugh on the left player; every reply loses for them', () => {
    const played = act(start('P-06'), YOU, { action: 'play', card: 'providence' });
    const swapped = swap(played.state, [YOU, 'retribution'], [LEFT, 'dagger']);
    const { state, events } = act(swapped.state, YOU, { action: 'play', card: 'last-laugh', target: LEFT });
    expect(payloads(events, 'trigger').map((t) => `${t.kind}:${t.seat}`)).toEqual(['retribution:1']);
    const endings = expectAlwaysWon(state);
    expect(endings.length).toBeGreaterThan(3);
  });

  it('P-07 Nothing Doing, solution 1: Pluck the Fool Token, hide and reveal it with Duplicity, Providence for the Count Token', () => {
    let s = act(start('P-07'), YOU, { action: 'play', card: 'pluck' }).state;
    s = respond(s, YOU, { kind: 'choose-hand-card', seat: LEFT, card: 'fool-token' }).state;
    s = act(s, YOU, { action: 'play', card: 'hocus-pocus' }).state;
    s = act(s, YOU, { action: 'play', card: 'duplicity', target: YOU }).state;
    s = respond(s, YOU, { kind: 'duplicity-hide', card: 'fool-token', target: YOU }).state;
    s = revealNow(s, YOU).state;
    s = act(s, YOU, { action: 'play', card: 'providence' }).state;
    const { state, events } = swap(s, [YOU, 'duplicity'], [RIGHT, 'count-token']);
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'tokens', winner: YOU }]);
    expectWon(state);
  });

  it('P-07 Nothing Doing, solution 2: Pluck Joker, Joker as Providence, end the round, then Last Laugh with Providence', () => {
    let s = act(start('P-07'), YOU, { action: 'play', card: 'pluck' }).state;
    s = respond(s, YOU, { kind: 'choose-hand-card', seat: LEFT, card: 'joker' }).state;
    s = act(s, YOU, { action: 'play', card: 'hocus-pocus' }).state;
    s = act(s, YOU, { action: 'play', card: 'joker', copy: 'providence' }).state;
    s = swap(s, [YOU, 'friar-token'], [UPPER, 'last-laugh']).state;
    s = draw(s, YOU).state;
    expect(s.phase).toBe('post-round');
    s = act(s, YOU, { action: 'play', card: 'providence' }).state;
    const { state, events } = swap(s, [YOU, 'last-laugh'], [RIGHT, 'purity']);
    expect(payloads(events, 'score')[0]).toMatchObject({ winner: YOU, scores: [20, 11, 6, 0] });
    expectWon(state);
  });

  it('P-08 Last Laugh 1: play one card, end the round, play the other with Last Laugh', () => {
    let s = act(start('P-08'), YOU, { action: 'play', card: 'timepiece', target: YOU }).state;
    s = draw(s, YOU).state;
    const { state } = act(s, YOU, { action: 'play', card: 'dagger', target: YOU });
    expectWon(state);
  });

  it('P-09 Last Laugh 2: draw twice, then Medallion spoils the left player’s Purity', () => {
    const s = draw(draw(start('P-09'), YOU).state, YOU).state;
    const { state } = act(s, YOU, { action: 'play', card: 'medallion', target: LEFT });
    expectWon(state);
  });

  it('P-10 Last Laugh 3: Sanction for Last Laugh; the left player must end the round; then Hocus Pocus, Resurrection, Providence', () => {
    let s = act(start('P-10'), YOU, { action: 'ability', card: 'sanction', from: RIGHT }).state;
    s = act(s, YOU, { action: 'play', card: 'last-laugh', target: YOU }).state;
    // The left player has no cards and an empty pile: drawing is their only move.
    expect(legalCommands(s, LEFT)).toHaveLength(1);
    s = opponentsPlay(s);
    expect(s.phase).toBe('post-round');
    s = act(s, YOU, { action: 'play', card: 'hocus-pocus' }).state;
    s = act(s, YOU, { action: 'play', card: 'resurrection' }).state;
    s = respond(s, YOU, { kind: 'choose-discard-card', card: 'providence' }).state;
    s = act(s, YOU, { action: 'play', card: 'providence' }).state;
    const { state } = swap(s, [YOU, 'sanction'], [LEFT, 'purity']);
    expectWon(state, 2);
  });

  it('P-11 Royal Favor 1: Shackles the upper player, then the HOT Royal Favor ends it via the right player', () => {
    const shackled = act(start('P-11'), YOU, { action: 'play', card: 'shackles', target: UPPER });
    const drawn = draw(shackled.state, YOU);
    const { state, events } = hotTarget(drawn.state, YOU, RIGHT);
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'empty-pile', ender: RIGHT }]);
    expectWon(state);
  });

  it('P-12 Royal Favor 2: Providence sends Royal Favor to the upper player, who draws Blunder; Sanction ends it', () => {
    const played = act(start('P-12'), YOU, { action: 'play', card: 'providence' });
    const swapped = swap(played.state, [YOU, 'royal-favor'], [UPPER, 'faberge-egg']);
    expect(swapped.state.keeps[UPPER].map((c) => c.id)).toContain('blunder');
    const { state } = act(swapped.state, YOU, { action: 'ability', card: 'sanction', from: LEFT });
    expectWon(state);
  });

  it('P-13 Royal Favor 3: one Shackled action, Resurrection for Royal Favor, and the chain wins the tie-break', () => {
    const s = start('P-13');
    expect(s.stack.at(-1)).toMatchObject({ op: 'action-frame', remaining: 1 });
    const taken = respond(act(s, YOU, { action: 'play', card: 'resurrection' }).state, YOU, { kind: 'choose-discard-card', card: 'royal-favor' });
    const { state, events } = hotTarget(taken.state, YOU, RIGHT);
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'empty-pile', ender: RIGHT }]);
    expect(payloads(events, 'score')[0]).toMatchObject({ winner: YOU, tiedWith: [LEFT] });
    expectWon(state);
  });

  it('P-14 Purity 1: the Friar Token spoils the upper player’s Purity; then draw', () => {
    const played = act(start('P-14'), YOU, { action: 'play', card: 'friar-token', target: UPPER });
    expectWon(draw(played.state, YOU).state);
  });

  it('P-15 Purity 2: Shackles in your own keep makes it pure; then draw', () => {
    const played = act(start('P-15'), YOU, { action: 'play', card: 'shackles', target: YOU });
    expectWon(draw(played.state, YOU).state);
  });

  it('P-16 Purity 3: resurrect Tithes, play it to force the end, then Tithes with Last Laugh', () => {
    let s = act(start('P-16'), YOU, { action: 'play', card: 'resurrection' }).state;
    s = respond(s, YOU, { kind: 'choose-discard-card', card: 'tithes' }).state;
    s = act(s, YOU, { action: 'play', card: 'tithes', target: YOU }).state;
    expect(s.phase).toBe('post-round');
    const { state, events } = act(s, YOU, { action: 'ability', card: 'tithes' });
    expect(payloads(events, 'score')[0]).toMatchObject({ winner: YOU });
    expect(state.keeps[YOU].map((c) => c.id)).toEqual(['last-laugh', 'interest', 'purity']);
    expectWon(state);
  });

  it('P-17 Blunder 1: Hocus Pocus, move Blunder away, draw to end', () => {
    let s = act(start('P-17'), YOU, { action: 'play', card: 'hocus-pocus' }).state;
    s = act(s, YOU, { action: 'ability', card: 'blunder', pile: LEFT }).state;
    expectWon(draw(s, YOU).state);
  });

  it('P-18 Blunder 2: Scepter and the Count Token, then the left player is forced to draw Blunder', () => {
    let s = act(start('P-18'), YOU, { action: 'play', card: 'scepter', target: YOU }).state;
    s = act(s, YOU, { action: 'play', card: 'count-token', target: UPPER }).state;
    expect(s.turn?.seat).toBe(LEFT);
    // Hocus Pocus and Tithes give the left player choices, but none of them escape.
    expectAlwaysWon(s);
  });

  it('P-19 Blunder 3: Purity, draw Blunder to force the end, then Tithes with Last Laugh', () => {
    let s = act(start('P-19'), YOU, { action: 'play', card: 'purity', target: YOU }).state;
    s = draw(s, YOU).state;
    expect(s.phase).toBe('post-round');
    expectWon(act(s, YOU, { action: 'ability', card: 'tithes' }).state);
  });

  it('P-20 Resurrection 1: resurrect Pandemonium, rotate the empty pile to you, draw', () => {
    let s = act(start('P-20'), YOU, { action: 'play', card: 'resurrection' }).state;
    s = respond(s, YOU, { kind: 'choose-discard-card', card: 'pandemonium' }).state;
    s = respond(s, YOU, { kind: 'choose-direction', direction: 'left' }).state;
    expect(s.piles[s.pileAt[YOU]].cards).toEqual([]);
    expectWon(draw(s, YOU).state);
  });

  it('P-21 Resurrection 2: resurrect Prayer, discard the right pile’s card and draw, then the Friar Token with Last Laugh', () => {
    let s = act(start('P-21'), YOU, { action: 'play', card: 'resurrection' }).state;
    s = respond(s, YOU, { kind: 'choose-discard-card', card: 'prayer' }).state;
    s = act(s, YOU, { action: 'play', card: 'prayer' }).state;
    s = respond(s, YOU, { kind: 'choose-pile', pile: RIGHT }).state;
    s = respond(s, YOU, { kind: 'take-or-discard', take: false }).state;
    expect(s.phase).toBe('post-round');
    expectWon(act(s, YOU, { action: 'play', card: 'friar-token', target: YOU }).state);
  });

  it('P-22 Resurrection 3: Joker as Resurrection for Invocation, Invoke Hocus Pocus, then Invoke the empty pile', () => {
    let s = act(start('P-22'), YOU, { action: 'play', card: 'joker', copy: 'resurrection' }).state;
    s = respond(s, YOU, { kind: 'choose-discard-card', card: 'invocation' }).state;
    s = respond(s, YOU, { kind: 'choose-pile', pile: RIGHT }).state;
    s = act(s, YOU, { action: 'play', card: 'shackles', target: LEFT }).state;
    s = act(s, YOU, { action: 'play', card: 'medallion', target: YOU }).state;
    s = act(s, YOU, { action: 'play', card: 'resurrection' }).state;
    s = respond(s, YOU, { kind: 'choose-discard-card', card: 'invocation' }).state;
    const { state, events } = respond(s, YOU, { kind: 'choose-pile', pile: LEFT });
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'empty-pile', ender: YOU }]);
    expectWon(state);
  });

  it('P-23 Tokens 1: Hocus Pocus, then all three Tokens', () => {
    let s = act(start('P-23'), YOU, { action: 'play', card: 'hocus-pocus' }).state;
    for (const token of ['count-token', 'fool-token', 'friar-token'] as const) {
      s = act(s, YOU, { action: 'play', card: token, target: YOU }).state;
    }
    expectWon(s);
  });

  it('P-24 Tokens 2: Acquisition for the Friar Token, a Token to end it via Interest, the last Token with Last Laugh', () => {
    let s = act(start('P-24'), YOU, { action: 'ability', card: 'acquisition', discard: 'providence', first: 'left' }).state;
    expect(s.hands[YOU]).toContain('friar-token');
    s = act(s, YOU, { action: 'play', card: 'count-token', target: YOU }).state;
    expect(s.phase).toBe('post-round');
    const { state, events } = act(s, YOU, { action: 'play', card: 'friar-token', target: YOU });
    expect(payloads(events, 'round-end').at(-1)).toEqual({ type: 'round-end', reason: 'tokens', winner: YOU });
    expectWon(state);
  });

  it('P-25 Tokens 3: Joker and Providence move Interest so the upper player draws the Count Token; Legerdemain takes it', () => {
    let s = act(start('P-25'), YOU, { action: 'play', card: 'hocus-pocus' }).state;
    s = act(s, YOU, { action: 'play', card: 'joker', copy: 'providence' }).state;
    s = swap(s, [RIGHT, 'interest'], [UPPER, 'scepter']).state;
    s = act(s, YOU, { action: 'play', card: 'providence' }).state;
    s = swap(s, [RIGHT, 'scepter'], [UPPER, 'juggling']).state;
    expect(s.hands[UPPER]).toEqual(['count-token']);
    s = act(s, YOU, { action: 'play', card: 'legerdemain' }).state;
    s = respond(s, YOU, { kind: 'choose-player', seat: UPPER }).state;
    const { state } = hotTarget(s, YOU, YOU);
    expectWon(state);
  });
});

describe('wrong answers lose', () => {
  it('Rags to Riches: ending the round before playing Purity', () => {
    const { state } = act(start('P-03'), YOU, { action: 'ability', card: 'sanction', from: RIGHT });
    expect(puzzleOutcome(state, 1)).toBe('lost');
  });

  it('This Looks Familiar: the Fool Token without the Juggling leaves the round going', () => {
    const played = act(start('P-04'), YOU, { action: 'play', card: 'fool-token', target: UPPER });
    expect(played.state.phase).toBe('playing');
    const ended = draw(played.state, YOU);
    expect(ended.state.turn?.seat).toBe(LEFT);
  });

  it('Best Served Cold: Last Laugh without Providence first triggers nothing, and your turn ends with the round going on', () => {
    const laughed = act(start('P-06'), YOU, { action: 'play', card: 'last-laugh', target: LEFT });
    expect(payloads(laughed.events, 'trigger')).toEqual([]);
    const { state } = draw(laughed.state, YOU);
    expect(state.phase).toBe('playing');
    expect(state.turn?.seat).toBe(LEFT);
  });

  it('Royal Favor 3: putting Royal Favor in your own keep does not end the round', () => {
    const taken = respond(act(start('P-13'), YOU, { action: 'play', card: 'resurrection' }).state, YOU, { kind: 'choose-discard-card', card: 'royal-favor' });
    const { state } = hotTarget(taken.state, YOU, YOU);
    expect(state.phase).toBe('playing');
    expect(state.turn?.seat).toBe(LEFT);
  });
});

describe('puzzle outcome', () => {
  it('is lost when play comes back to you without the round ending', () => {
    let s: GameState = start('P-01');
    const step = (st: GameState): Step => draw(st, st.turn!.seat);
    // Draw once, then pass the turn around (everyone just draws).
    s = step(s).state;
    expect(puzzleOutcome(s, 1)).toBe('playing');
    const looped = { ...s, turn: { seat: YOU, actionsTaken: 0, usedOncePerTurn: [] }, turnNumber: 5 };
    expect(puzzleOutcome(looped, 1)).toBe('lost');
  });
});
