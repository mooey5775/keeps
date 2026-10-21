import { describe, expect, it } from 'vitest';
import { apply, buildPosition, eventsFor, legalCommands, type CardId, type KeepCard, type Seat } from '../../src/index.ts';
import {
  act,
  actionsLeft,
  draw,
  payloads,
  promptFor,
  respond,
  revealNow,
  types,
} from '../helpers.ts';

const hidden = (id: CardId, placedBy: Seat = 0): KeepCard => ({ id, faceDown: { placedBy } });
const canRevealNow = (state: Parameters<typeof legalCommands>[0], seat: Seat) =>
  legalCommands(state, seat).some((c) => c.type === 'reveal-duplicity');

describe('Duplicity', () => {
  it('places another Keep card from your hand face down into any keep, as part of the same action', () => {
    const start = buildPosition({ hands: { 0: ['duplicity', 'chalice', 'hocus-pocus'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'duplicity', target: 0 });
    expect(promptFor(played.state, 0, 'duplicity-hide').options).toEqual(['chalice']);
    const { state, events } = respond(played.state, 0, { kind: 'duplicity-hide', card: 'chalice', target: 1 });
    expect(state.keeps[0]).toEqual([{ id: 'duplicity' }]);
    expect(state.keeps[1]).toEqual([hidden('chalice')]);
    expect(state.hands[0]).toEqual(['hocus-pocus']);
    expect(actionsLeft(state)).toBe(1);
    expect(payloads(eventsFor(events, 1), 'place-face-down')).toEqual([
      { type: 'place-face-down', seat: 0, target: 1, card: null },
    ]);
  });

  it('Q-04 only the placer knows the card; a different holder reveals it blind', () => {
    const start = buildPosition({ hands: { 0: ['duplicity', 'chalice'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'duplicity', target: 2 });
    const placed = respond(played.state, 0, { kind: 'duplicity-hide', card: 'chalice', target: 1 });
    expect(JSON.stringify(eventsFor(placed.events, 2))).not.toContain('chalice');
    expect(payloads(eventsFor(placed.events, 0), 'place-face-down')[0]!.card).toBe('chalice');
    // S2 holds Duplicity, so S2 (not the placer) may reveal.
    expect(canRevealNow(placed.state, 2)).toBe(true);
    expect(canRevealNow(placed.state, 0)).toBe(false);
  });

  it('Q-16 with no other Keep card in hand, Duplicity is played and nothing is placed', () => {
    const start = buildPosition({ hands: { 0: ['duplicity', 'hocus-pocus'] }, turn: 0 });
    const { state, events } = act(start, 0, { action: 'play', card: 'duplicity', target: 0 });
    expect(payloads(events, 'no-effect')).toHaveLength(1);
    expect(state.keeps[0]).toEqual([{ id: 'duplicity' }]);
  });

  it('follows Duplicity: moving it with Providence moves who may reveal', () => {
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 0: ['duplicity', hidden('chalice')], 3: ['dagger'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const swapped = respond(played.state, 0, { kind: 'choose-keep-pair', a: { seat: 0, index: 0 }, b: { seat: 3, index: 0 } });
    // The Dagger (a Coin card) entered the keep holding the face-down card, so the
    // new holder, S3, gets a reveal window for this play.
    promptFor(swapped.state, 3, 'reveal-window');
    const { state } = respond(swapped.state, 3, { kind: 'reveal-window', reveal: false });
    expect(canRevealNow(state, 3)).toBe(true);
    expect(canRevealNow(state, 0)).toBe(false);
  });
});

describe('revealing', () => {
  it('C-11 costs no action and can happen at any time, even on another player\'s turn', () => {
    const start = buildPosition({
      keeps: { 0: ['duplicity', hidden('chalice')] },
      piles: { 1: ['dagger'] },
      turn: 1,
    });
    expect(canRevealNow(start, 0)).toBe(true);
    const { state, events } = revealNow(start, 0);
    expect(state.keeps[0]).toEqual([{ id: 'duplicity' }, { id: 'chalice' }]);
    expect(payloads(events, 'reveal')).toEqual([{ type: 'reveal', seat: 0, keep: 0, card: 'chalice' }]);
    // S1 is still on their first action.
    expect(actionsLeft(state)).toBe(2);
    promptFor(state, 1, 'action');
    expect(canRevealNow(state, 0)).toBe(false);
  });

  it('C-10 a face-down Token does not count toward a token victory until it is revealed', () => {
    const start = buildPosition({
      keeps: { 0: ['duplicity', 'count-token', 'fool-token', hidden('friar-token')] },
      piles: { 0: ['chalice'] },
      turn: 0,
    });
    expect(start.phase).toBe('playing');
    const { state, events } = revealNow(start, 0);
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'tokens', winner: 0 }]);
    expect(state.marks).toEqual([1, 0, 0, 0]);
  });

  it('C-17 placing a Coin card face down never triggers Interest, and neither does revealing it', () => {
    const start = buildPosition({
      hands: { 0: ['duplicity', 'chalice'] },
      keeps: { 1: ['interest'] },
      piles: { 1: ['dagger'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'duplicity', target: 0 });
    const placed = respond(played.state, 0, { kind: 'duplicity-hide', card: 'chalice', target: 1 });
    expect(types(placed.events)).not.toContain('trigger');
    const revealed = revealNow(placed.state, 0);
    expect(types(revealed.events)).not.toContain('trigger');
    expect(revealed.state.hands[1]).toEqual([]);
  });

  it('C-16 Duplicity and its face-down card both entering a Retribution keep trigger it once', () => {
    const start = buildPosition({
      hands: { 0: ['duplicity', 'chalice'] },
      keeps: { 1: ['retribution'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'duplicity', target: 1 });
    const { events } = respond(played.state, 0, { kind: 'duplicity-hide', card: 'chalice', target: 1 });
    expect(payloads(events, 'trigger').map((t) => t.kind)).toEqual(['retribution']);
  });

  it("C-16 revealing a face-down card in a Retribution owner's keep does not trigger it", () => {
    const start = buildPosition({
      keeps: { 0: ['duplicity'], 1: ['retribution', hidden('chalice')] },
      piles: { 0: ['dagger'] },
      turn: 0,
    });
    const { events } = revealNow(start, 0);
    expect(types(events)).toEqual(['reveal']);
  });

  it('Q-06 a revealed Royal Favor does not count as entering the keep', () => {
    // Unreachable in real play (Royal Favor is HOT, so never in a hand to hide),
    // but the ruling pins down what a revealed Royal Favor does: nothing.
    const start = buildPosition({
      keeps: { 0: ['duplicity'], 1: [hidden('royal-favor')] },
      piles: { 1: ['dagger'] },
      turn: 0,
    });
    const { state, events } = revealNow(start, 0);
    expect(types(events)).toEqual(['reveal']);
    expect(state.hands[1]).toEqual([]);
  });
});

describe('reveal windows during a play', () => {
  const interestSetup = (hiddenCard: CardId) =>
    buildPosition({
      hands: { 0: ['chalice'] },
      keeps: { 2: ['duplicity'], 1: [hidden(hiddenCard, 2)] },
      piles: { 1: ['dagger', 'scepter'] },
      turn: 0,
    });

  it('C-15 a face-down Interest can be revealed as a Coin card enters its keep, forcing the draw', () => {
    const played = act(interestSetup('interest'), 0, { action: 'play', card: 'chalice', target: 1 });
    const window = promptFor(played.state, 2, 'reveal-window');
    expect(window.reason).toBe('play');
    const { state, events } = respond(played.state, 2, { kind: 'reveal-window', reveal: true });
    expect(payloads(events, 'trigger').map((t) => t.kind)).toEqual(['interest']);
    expect(state.hands[1]).toEqual(['dagger']);
  });

  it('C-15 passing in the window leaves the Interest face down, with no draw', () => {
    const played = act(interestSetup('interest'), 0, { action: 'play', card: 'chalice', target: 1 });
    const { state, events } = respond(played.state, 2, { kind: 'reveal-window', reveal: false });
    expect(types(events)).not.toContain('trigger');
    expect(state.keeps[1][0]).toEqual(hidden('interest', 2));
  });

  it('opens the same window whatever the hidden card is, so it leaks nothing', () => {
    const played = act(interestSetup('timepiece'), 0, { action: 'play', card: 'chalice', target: 1 });
    promptFor(played.state, 2, 'reveal-window');
  });

  it("does not open a window for plays that don't touch the face-down card's keep", () => {
    const played = act(interestSetup('interest'), 0, { action: 'play', card: 'chalice', target: 3 });
    expect(played.state.prompts.map((p) => p.kind)).toEqual(['action']);
  });

  it('C-13 a face-down Retribution can be revealed as the triggering card is played, for two actions', () => {
    const start = buildPosition({
      hands: { 0: ['chalice'] },
      keeps: { 1: ['duplicity', hidden('retribution', 1)] },
      piles: { 1: ['dagger', 'scepter'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'chalice', target: 1 });
    const { state, events } = respond(played.state, 1, { kind: 'reveal-window', reveal: true });
    expect(payloads(events, 'trigger').map((t) => t.kind)).toEqual(['retribution']);
    expect(state.stack.at(-1)).toMatchObject({ op: 'action-frame', seat: 1, kind: 'retribution', remaining: 2 });
  });

  it('a card face down only since this very play cannot respond to it', () => {
    // S0 hides Interest in S1's keep with Duplicity: no window, no trigger.
    const start = buildPosition({
      hands: { 0: ['duplicity', 'interest'] },
      keeps: { 1: ['chalice'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'duplicity', target: 1 });
    const placed = respond(played.state, 0, { kind: 'duplicity-hide', card: 'interest', target: 1 });
    expect(placed.state.prompts.map((p) => p.kind)).toEqual(['action']);
  });
});

describe('a revealed Shackles', () => {
  const shackledPosition = () =>
    buildPosition({
      keeps: { 0: ['duplicity'], 1: [hidden('shackles')] },
      hands: { 1: ['hocus-pocus'] },
      piles: { 1: ['dagger', 'scepter', 'medallion', 'timepiece'], 2: ['chalice'] },
      turn: 1,
    });

  it("C-14 revealed after the player's first action, it ends their turn", () => {
    const first = draw(shackledPosition(), 1);
    expect(actionsLeft(first.state)).toBe(1);
    const { state, events } = revealNow(first.state, 0);
    expect(payloads(events, 'shackled')).toEqual([{ type: 'shackled', seat: 1, remaining: 0 }]);
    expect(state.turn?.seat).toBe(2);
  });

  it('revealed before their first action, it leaves them one action', () => {
    const { state } = revealNow(shackledPosition(), 0);
    expect(actionsLeft(state)).toBe(1);
    expect(draw(state, 1).state.turn?.seat).toBe(2);
  });

  it('Q-07 actions already granted by Hocus Pocus remain', () => {
    const hocus = act(shackledPosition(), 1, { action: 'play', card: 'hocus-pocus' });
    const { state } = revealNow(hocus.state, 0);
    expect(state.stack.flatMap((op) => (op.op === 'action-frame' ? [[op.kind, op.remaining]] : []))).toEqual([
      ['turn', 0],
      ['hocus-pocus', 2],
    ]);
    const after = draw(draw(state, 1).state, 1);
    expect(after.state.turn?.seat).toBe(2);
  });

  it("doesn't change anything when it isn't its owner's turn", () => {
    const start = buildPosition({ keeps: { 0: ['duplicity'], 1: [hidden('shackles')] }, piles: { 0: ['chalice'] }, turn: 0 });
    const { state, events } = revealNow(start, 0);
    expect(types(events)).toEqual(['reveal']);
    expect(actionsLeft(state)).toBe(2);
  });
});

describe('reveal windows at round end', () => {
  it('C-12 a face-down Last Laugh can be revealed at round end to get its action', () => {
    const start = buildPosition({
      keeps: { 0: ['duplicity', hidden('last-laugh')] },
      hands: { 0: ['chalice'] },
      turn: 0,
    });
    const ended = draw(start, 0);
    expect(promptFor(ended.state, 0, 'reveal-window').reason).toBe('before-last-laugh');
    const revealed = respond(ended.state, 0, { kind: 'reveal-window', reveal: true });
    expect(payloads(revealed.events, 'last-laugh')).toEqual([{ type: 'last-laugh', seat: 0 }]);
    const { events } = act(revealed.state, 0, { action: 'play', card: 'chalice', target: 0 });
    expect(payloads(events, 'score')[0]).toMatchObject({ scores: [4, 0, 0, 0] });
  });

  it('C-03 can reveal after round end, before Last Laugh or after it', () => {
    const position = () =>
      buildPosition({
        keeps: { 0: ['duplicity', hidden('chalice')], 1: ['last-laugh', 'dagger'] },
        turn: 0,
      });
    // Before Last Laugh: S1's action then sees S0's Chalice face-up.
    const early = draw(position(), 0);
    const revealedEarly = respond(early.state, 0, { kind: 'reveal-window', reveal: true });
    expect(revealedEarly.state.keeps[0]).toEqual([{ id: 'duplicity' }, { id: 'chalice' }]);
    promptFor(revealedEarly.state, 1, 'action');

    // After Last Laugh: pass the first window, let S1 act, then reveal just before scoring.
    const late = draw(position(), 0);
    const passed = respond(late.state, 0, { kind: 'reveal-window', reveal: false });
    const laughed = act(passed.state, 1, { action: 'pass' });
    expect(promptFor(laughed.state, 0, 'reveal-window').reason).toBe('before-scoring');
    const { events } = respond(laughed.state, 0, { kind: 'reveal-window', reveal: true });
    // Chalice now counts: S0 and S1 tie at 2 coins; S0 ended the round, so S1 wins the tie.
    expect(payloads(events, 'score')[0]).toMatchObject({ scores: [4, 4, 0, 0], winner: 1 });
  });

  it("C-24 Last Laugh (face-up) acts, then the face-down card can still be revealed before scoring", () => {
    const start = buildPosition({
      keeps: { 0: ['duplicity', 'last-laugh', hidden('faberge-egg')], 1: ['dagger'] },
      hands: { 0: ['chalice'] },
      turn: 0,
    });
    const ended = draw(start, 0);
    const first = respond(ended.state, 0, { kind: 'reveal-window', reveal: false });
    const laughed = act(first.state, 0, { action: 'play', card: 'chalice', target: 0 });
    const { state, events } = respond(laughed.state, 0, { kind: 'reveal-window', reveal: true });
    expect(payloads(events, 'reveal')[0]!.card).toBe('faberge-egg');
    expect(payloads(events, 'score')[0]).toMatchObject({ scores: [10, 4, 0, 0], winner: 0 });
    expect(state.phase).toBe('round-over');
  });

  it('C-24 a face-down Last Laugh revealed at round end still gets its action', () => {
    const start = buildPosition({ keeps: { 2: ['duplicity', hidden('last-laugh', 2)] }, hands: { 2: ['chalice'] }, turn: 0 });
    const ended = draw(start, 0);
    const revealed = respond(ended.state, 2, { kind: 'reveal-window', reveal: true });
    promptFor(revealed.state, 2, 'action');
  });

  it('skips the windows when there is no face-down card', () => {
    const start = buildPosition({ keeps: { 0: ['duplicity'] }, turn: 0 });
    expect(types(draw(start, 0).events)).toEqual(['action', 'empty-draw', 'round-end', 'score', 'mark']);
  });

  it('the free reveal command is not offered once the round is scored', () => {
    const start = buildPosition({ keeps: { 0: ['duplicity', hidden('chalice')] }, turn: 0 });
    const ended = draw(start, 0);
    const scored = respond(respond(ended.state, 0, { kind: 'reveal-window', reveal: false }).state, 0, {
      kind: 'reveal-window',
      reveal: false,
    });
    expect(scored.state.phase).toBe('round-over');
    expect(apply(scored.state, 0, { type: 'reveal-duplicity' }).ok).toBe(false);
  });
});
