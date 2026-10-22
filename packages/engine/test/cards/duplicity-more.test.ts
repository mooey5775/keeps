import { describe, expect, it } from 'vitest';
import { buildPosition, keepValue, legalCommands, viewFor } from '../../src/index.ts';
import {
  act,
  actionsLeft,
  draw,
  hidden,
  hotTarget,
  payloads,
  promptFor,
  respond,
  revealNow,
  types,
} from '../helpers.ts';

// More Duplicity: placement variants, which plays open a reveal window,
// a hidden card that moves, every round-end window, and what a revealed
// card does afterward. See duplicity.test.ts and duplicity-deep.test.ts.

const triggerKinds = (events: Parameters<typeof payloads>[0]) => payloads(events, 'trigger').map((t) => `${t.kind}:${t.seat}`);

describe('placement', () => {
  it('Duplicity in another keep, hidden card in your own: they hold the reveal, only you know the card', () => {
    const start = buildPosition({ hands: { 0: ['duplicity', 'faberge-egg'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'duplicity', target: 2 });
    const { state } = respond(played.state, 0, { kind: 'duplicity-hide', card: 'faberge-egg', target: 0 });
    expect(viewFor(state, 0).keeps[0]!.cards).toEqual([{ faceDown: true, id: 'faberge-egg' }]);
    expect(viewFor(state, 2).keeps[0]!.cards).toEqual([{ faceDown: true }]);
    expect(legalCommands(state, 2)).toContainEqual({ type: 'reveal-duplicity' });
    expect(legalCommands(state, 0)).not.toContainEqual({ type: 'reveal-duplicity' });
    // Face down, the Egg is worth nothing yet.
    expect(keepValue(state.keeps[0])).toBe(0);
  });

  it('offers every Keep card in hand to hide, and no other card', () => {
    const start = buildPosition({
      hands: { 0: ['duplicity', 'last-laugh', 'shackles', 'count-token', 'purity', 'interest', 'prayer', 'joker'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'duplicity', target: 0 });
    expect(promptFor(played.state, 0, 'duplicity-hide').options).toEqual(['last-laugh', 'shackles', 'count-token', 'purity', 'interest']);
  });

  it('an invoked Duplicity is placed, then hides a card from its player’s hand', () => {
    const start = buildPosition({ hands: { 0: ['chalice'] }, piles: { 0: ['invocation'], 2: ['duplicity'] }, turn: 0 });
    const invoked = respond(draw(start, 0).state, 0, { kind: 'choose-pile', pile: 2 });
    const placed = hotTarget(invoked.state, 0, 0);
    const { state } = respond(placed.state, 0, { kind: 'duplicity-hide', card: 'chalice', target: 3 });
    expect(state.keeps[3]).toEqual([{ id: 'chalice', faceDown: { placedBy: 0 } }]);
    expect(actionsLeft(state)).toBe(1);
  });

  it('hiding a Coin card in a keep with face-up Interest draws nothing, and neither does revealing it', () => {
    const start = buildPosition({ hands: { 0: ['duplicity', 'chalice'] }, keeps: { 2: ['interest'] }, piles: { 2: ['dagger'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'duplicity', target: 0 });
    const placed = respond(played.state, 0, { kind: 'duplicity-hide', card: 'chalice', target: 2 });
    expect(types(placed.events)).not.toContain('trigger');
    expect(types(revealNow(placed.state, 0).events)).not.toContain('trigger');
  });
});

describe('which plays open a reveal window', () => {
  it('a play that only changes the owner’s hand (Pluck) opens one; a revealed Retribution answers it', () => {
    const start = buildPosition({
      hands: { 0: ['pluck'], 1: ['chalice'] },
      keeps: { 1: [hidden('retribution', 3)], 3: ['duplicity'] },
      piles: { 1: ['dagger', 'scepter'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'pluck' });
    const taken = respond(played.state, 0, { kind: 'choose-hand-card', seat: 1, card: 'chalice' });
    promptFor(taken.state, 3, 'reveal-window');
    const { events } = respond(taken.state, 3, { kind: 'reveal-window', reveal: true });
    expect(triggerKinds(events)).toEqual(['retribution:1']);
  });

  it('Pluck that takes from someone else does not open one for the hidden keep’s owner', () => {
    const start = buildPosition({
      hands: { 0: ['pluck'], 1: ['chalice'], 2: ['dagger'] },
      keeps: { 1: [hidden('retribution', 3)], 3: ['duplicity'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'pluck' });
    const taken = respond(played.state, 0, { kind: 'choose-hand-card', seat: 2, card: 'dagger' });
    expect(taken.state.prompts.map((p) => p.kind)).toEqual(['action']);
  });

  it('Pickpocket that finds no Coin cards changes nothing, so no window', () => {
    const start = buildPosition({
      hands: { 0: ['pickpocket'], 1: ['prayer'] },
      keeps: { 1: [hidden('retribution', 3)], 3: ['duplicity'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'pickpocket' });
    const { state } = respond(played.state, 0, { kind: 'choose-player', seat: 1 });
    expect(state.prompts.map((p) => p.kind)).toEqual(['action']);
  });

  it('Offering: the window opens after every gift is given', () => {
    const start = buildPosition({
      hands: { 0: ['offering'], 1: ['chalice'], 2: ['dagger'] },
      keeps: { 1: [hidden('retribution', 3)], 3: ['duplicity'] },
      piles: { 1: ['scepter', 'medallion'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'offering' });
    const one = respond(played.state, 1, { kind: 'give-card', card: 'chalice' });
    expect(one.state.prompts.map((p) => [p.seat, p.kind])).toEqual([[2, 'give-card']]);
    const two = respond(one.state, 2, { kind: 'give-card', card: 'dagger' });
    promptFor(two.state, 3, 'reveal-window');
    const { events } = respond(two.state, 3, { kind: 'reveal-window', reveal: true });
    expect(triggerKinds(events)).toEqual(['retribution:1']);
  });
});

describe('a hidden card that moves', () => {
  it('a hidden Retribution swapped away and revealed in the window answers for its original keep, like a face-up one (C-30, Q-15)', () => {
    // Face up, this swap would make S1 (who lost it) retaliate and not S2 (who received it).
    // Revealed in the play's window, the hidden card should behave the same.
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 1: [hidden('retribution', 3)], 2: ['chalice'], 3: ['duplicity'] },
      piles: { 1: ['dagger', 'scepter'], 2: ['medallion', 'timepiece'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const swapped = respond(played.state, 0, { kind: 'choose-keep-pair', a: { seat: 1, index: 0 }, b: { seat: 2, index: 0 } });
    expect(swapped.state.keeps[2]).toEqual([hidden('retribution', 3)]);
    const { state, events } = respond(swapped.state, 3, { kind: 'reveal-window', reveal: true });
    expect(triggerKinds(events)).toEqual(['retribution:1']);
    expect(state.stack.at(-1)).toMatchObject({ op: 'action-frame', seat: 1, kind: 'retribution' });
  });

  it('a hidden Interest swapped away for a Coin card draws nothing when revealed (C-21), in either keep', () => {
    // Face up, Interest swapped for a Coin card doesn't trigger: it has to be in the keep before and
    // after (C-21). Revealed in the window, the hidden Interest must not trigger for the Chalice that
    // entered its old keep, nor in its new keep, where no Coin card entered.
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 1: [hidden('interest', 3)], 2: ['chalice'], 3: ['duplicity'] },
      piles: { 1: ['dagger'], 2: ['medallion'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const swapped = respond(played.state, 0, { kind: 'choose-keep-pair', a: { seat: 1, index: 0 }, b: { seat: 2, index: 0 } });
    // S2's keep changed and holds the hidden card now, so the holder gets a window.
    promptFor(swapped.state, 3, 'reveal-window');
    const { state, events } = respond(swapped.state, 3, { kind: 'reveal-window', reveal: true });
    expect(types(events)).not.toContain('trigger');
    expect(state.hands[1]).toEqual([]);
    expect(state.hands[2]).toEqual([]);
  });

  it('the placer still knows the card after Providence moves it; others still don’t', () => {
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 1: [hidden('faberge-egg', 2)], 3: ['chalice', 'duplicity'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const { state } = respond(played.state, 0, { kind: 'choose-keep-pair', a: { seat: 1, index: 0 }, b: { seat: 3, index: 0 } });
    expect(viewFor(state, 2).keeps[3]!.cards[0]).toEqual({ faceDown: true, id: 'faberge-egg' });
    expect(viewFor(state, 0).keeps[3]!.cards[0]).toEqual({ faceDown: true });
    expect(viewFor(state, 3).keeps[3]!.cards[0]).toEqual({ faceDown: true });
  });
});

describe('reveal windows at round end', () => {
  it('without Last Laugh there are still two windows; revealing at the first leaves nothing for the second', () => {
    const start = buildPosition({ keeps: { 0: ['duplicity', hidden('chalice', 0)], 1: ['dagger'] }, turn: 0 });
    const ended = draw(start, 0);
    expect(promptFor(ended.state, 0, 'reveal-window').reason).toBe('before-last-laugh');
    const { events } = respond(ended.state, 0, { kind: 'reveal-window', reveal: true });
    expect(types(events)).toEqual(['reveal', 'score', 'mark']);
  });

  it('a hidden Interest revealed at round end draws nothing', () => {
    const start = buildPosition({ keeps: { 0: ['duplicity', hidden('interest', 0)] }, piles: { 2: ['chalice'] }, turn: 0 });
    const ended = draw(start, 0);
    const { events } = respond(ended.state, 0, { kind: 'reveal-window', reveal: true });
    expect(types(events)).not.toContain('trigger');
  });

  it('the last Token revealed just before scoring is a token victory, with no scoring', () => {
    const start = buildPosition({
      keeps: { 0: ['duplicity', 'count-token', 'fool-token', hidden('friar-token', 0)], 1: ['faberge-egg'] },
      turn: 0,
    });
    const ended = draw(start, 0);
    const first = respond(ended.state, 0, { kind: 'reveal-window', reveal: false });
    const { state, events } = respond(first.state, 0, { kind: 'reveal-window', reveal: true });
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'tokens', winner: 0 }]);
    expect(types(events)).not.toContain('score');
    expect(state.marks).toEqual([1, 0, 0, 0]);
  });

  it('a hidden Shackles revealed at round end does nothing', () => {
    const start = buildPosition({ keeps: { 0: ['duplicity', hidden('shackles', 0)] }, turn: 0 });
    const ended = draw(start, 0);
    const { events } = respond(ended.state, 0, { kind: 'reveal-window', reveal: true });
    expect(types(events)).not.toContain('shackled');
    // But it now counts against the score: -3 coins.
    expect(payloads(events, 'score')[0]!.scores[0]).toBe(-6);
  });

  it('nobody but the holder may reveal at the round-end windows', () => {
    const start = buildPosition({ keeps: { 2: ['duplicity'], 1: [hidden('chalice', 2)] }, turn: 0 });
    const ended = draw(start, 0);
    for (const seat of [0, 1, 3] as const) expect(legalCommands(ended.state, seat)).toEqual([]);
    promptFor(ended.state, 2, 'reveal-window');
  });
});

describe('after a free reveal', () => {
  it('a revealed Interest draws for later Coin cards like any Interest', () => {
    const start = buildPosition({ hands: { 0: ['chalice'] }, keeps: { 1: [hidden('interest', 0)], 0: ['duplicity'] }, piles: { 1: ['dagger'] }, turn: 0 });
    const revealed = revealNow(start, 0);
    const { state, events } = act(revealed.state, 0, { action: 'play', card: 'chalice', target: 1 });
    expect(triggerKinds(events)).toEqual(['interest:1']);
    expect(state.hands[1]).toEqual(['dagger']);
  });

  it('a revealed Retribution answers later plays like any Retribution', () => {
    const start = buildPosition({ hands: { 0: ['chalice'] }, keeps: { 1: [hidden('retribution', 0)], 0: ['duplicity'] }, turn: 0 });
    const revealed = revealNow(start, 0);
    expect(triggerKinds(act(revealed.state, 0, { action: 'play', card: 'chalice', target: 1 }).events)).toEqual(['retribution:1']);
  });

  it('a Last Laugh revealed mid-round acts at round end without needing a window', () => {
    const start = buildPosition({ keeps: { 0: ['duplicity', hidden('last-laugh', 0)] }, hands: { 0: ['chalice'] }, piles: { 0: ['dagger'] }, turn: 0 });
    const revealed = revealNow(start, 0);
    const ended = draw(draw(revealed.state, 0).state, 0);
    expect(payloads(ended.events, 'last-laugh')).toEqual([{ type: 'last-laugh', seat: 0 }]);
    // No reveal windows: there is no face-down card any more.
    expect(ended.state.prompts.map((p) => [p.seat, p.kind])).toEqual([[0, 'action']]);
  });

  it('a holder revealing Shackles during their Retribution ends the turn player’s turn once it resumes', () => {
    // S0 (turn player, hidden Shackles in their keep) plays Chalice into S1's keep; S1 retaliates and,
    // holding Duplicity, reveals S0's Shackles. S0 had taken one action, so S0's turn is over.
    const start = buildPosition({
      hands: { 0: ['chalice'] },
      keeps: { 0: [hidden('shackles', 1)], 1: ['retribution', 'duplicity'] },
      piles: { 0: ['dagger'], 1: ['scepter', 'medallion', 'timepiece'] },
      turn: 0,
    });
    const struck = act(start, 0, { action: 'play', card: 'chalice', target: 1 });
    promptFor(struck.state, 1, 'action');
    const revealed = revealNow(struck.state, 1);
    expect(payloads(revealed.events, 'shackled')).toEqual([{ type: 'shackled', seat: 0, remaining: 0 }]);
    // S1's two Retribution actions are untouched; then the turn passes to S1 for their own turn.
    const done = draw(draw(revealed.state, 1).state, 1);
    expect(payloads(done.events, 'turn-start')).toEqual([{ type: 'turn-start', seat: 1, actions: 2 }]);
  });
});

describe('Duplicity with Retribution and Last Laugh, more combinations', () => {
  it("the holder's own keep can hold the hidden card: they get a window when someone changes it", () => {
    const start = buildPosition({
      hands: { 0: ['chalice'] },
      keeps: { 1: ['duplicity', hidden('retribution', 1)] },
      piles: { 1: ['dagger', 'scepter'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'chalice', target: 1 });
    const { events } = respond(played.state, 1, { kind: 'reveal-window', reveal: true });
    expect(triggerKinds(events)).toEqual(['retribution:1']);
  });

  it('Duplicity into a Retribution keep with the hidden card elsewhere: that owner retaliates once', () => {
    const start = buildPosition({ hands: { 0: ['duplicity', 'chalice'] }, keeps: { 1: ['retribution'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'duplicity', target: 1 });
    const { events } = respond(played.state, 0, { kind: 'duplicity-hide', card: 'chalice', target: 2 });
    expect(triggerKinds(events)).toEqual(['retribution:1']);
  });

  it("the hidden card alone, placed into a Retribution owner's keep, triggers it", () => {
    const start = buildPosition({ hands: { 0: ['duplicity', 'chalice'] }, keeps: { 2: ['retribution'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'duplicity', target: 0 });
    const { events } = respond(played.state, 0, { kind: 'duplicity-hide', card: 'chalice', target: 2 });
    expect(triggerKinds(events)).toEqual(['retribution:2']);
  });

  it("a holder revealing someone else's hidden Last Laugh at round end gives that player the action", () => {
    const start = buildPosition({
      keeps: { 2: ['duplicity'], 1: [hidden('last-laugh', 2)] },
      hands: { 1: ['chalice'] },
      turn: 0,
    });
    const ended = draw(start, 0);
    const revealed = respond(ended.state, 2, { kind: 'reveal-window', reveal: true });
    expect(payloads(revealed.events, 'last-laugh')).toEqual([{ type: 'last-laugh', seat: 1 }]);
    promptFor(revealed.state, 1, 'action');
  });

  it("the Last Laugh action's own play can open a window, and a revealed Interest still draws post-round", () => {
    const start = buildPosition({
      keeps: { 0: ['last-laugh'], 3: ['duplicity'], 2: [hidden('interest', 3)] },
      hands: { 0: ['chalice'] },
      piles: { 2: ['dagger'] },
      turn: 0,
    });
    const ended = draw(start, 0);
    // The round-end window before Last Laugh: pass it.
    const passed = respond(ended.state, 3, { kind: 'reveal-window', reveal: false });
    const played = act(passed.state, 0, { action: 'play', card: 'chalice', target: 2 });
    expect(promptFor(played.state, 3, 'reveal-window').reason).toBe('play');
    const { state, events } = respond(played.state, 3, { kind: 'reveal-window', reveal: true });
    expect(triggerKinds(events)).toEqual(['interest:2']);
    expect(state.hands[2]).toEqual(['dagger']);
    expect(state.phase).toBe('round-over');
  });

  it('a face-down Token moved into a set by Providence wins only when revealed', () => {
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 0: ['count-token', 'fool-token', 'chalice', 'duplicity'], 2: [hidden('friar-token', 0)] },
      piles: { 0: ['dagger'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const swapped = respond(played.state, 0, { kind: 'choose-keep-pair', a: { seat: 0, index: 2 }, b: { seat: 2, index: 0 } });
    // The hidden Token now sits in S0's own keep and S0 made the play, so no window opens; no win yet.
    expect(swapped.state.prompts.map((p) => [p.seat, p.kind])).toEqual([[0, 'action']]);
    expect(swapped.state.phase).toBe('playing');
    const { events } = revealNow(swapped.state, 0);
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'tokens', winner: 0 }]);
  });
});
