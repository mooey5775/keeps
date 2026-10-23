import { describe, expect, it } from 'vitest';
import {
  apply,
  buildPosition,
  eventsFor,
  keepValue,
  legalCommands,
  viewFor,
  type CardId,
  type GameState,
  type Seat,
} from '../../src/index.ts';
import {
  abilityNames,
  act,
  actionsLeft,
  draw,
  hidden,
  hotTarget,
  keepOf,
  payloads,
  promptFor,
  respond,
  revealNow,
  types,
} from '../helpers.ts';

// Duplicity hides a Keep card face down; whoever has Duplicity face-up may
// reveal it at any time. Reveal windows are the moments the engine stops to
// offer that reveal: during a play that changes the hidden card's keep, and
// twice at round end. See also property/duplicity-oracle.test.ts and
// property/hidden-identity.test.ts.

const canRevealNow = (state: Parameters<typeof legalCommands>[0], seat: Seat) =>
  legalCommands(state, seat).some((c) => c.type === 'reveal-duplicity');

const viewScore = (state: GameState) => keepValue(state.keeps[0]);

const triggerKinds = (events: Parameters<typeof payloads>[0]) => payloads(events, 'trigger').map((t) => `${t.kind}:${t.seat}`);

describe('Duplicity', () => {
  it('places another Keep card from your hand face down into any keep, as part of the same action', () => {
    const start = buildPosition({ hands: { 0: ['duplicity', 'chalice', 'hocus-pocus'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'duplicity', target: 0 });
    expect(promptFor(played.state, 0, 'duplicity-hide').options).toEqual(['chalice']);
    const { state, events } = respond(played.state, 0, { kind: 'duplicity-hide', card: 'chalice', target: 1 });
    expect(state.keeps[0]).toEqual([{ id: 'duplicity' }]);
    expect(state.keeps[1]).toEqual([hidden('chalice', 0)]);
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
      keeps: { 0: ['duplicity', hidden('chalice', 0)], 3: ['dagger'] },
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

  it('can be played into another player\'s keep, giving them the reveal', () => {
    const start = buildPosition({ hands: { 0: ['duplicity', 'chalice'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'duplicity', target: 3 });
    const { state } = respond(played.state, 0, { kind: 'duplicity-hide', card: 'chalice', target: 0 });
    expect(legalCommands(state, 3)).toContainEqual({ type: 'reveal-duplicity' });
  });

  it('a hidden Purity scores normally once revealed', () => {
    expect(keepValue([{ id: 'purity', faceDown: { placedBy: 0 } }])).toBe(0);
    expect(keepValue(keepOf('purity'))).toBe(20);
  });
});

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

describe('revealing', () => {
  it('C-11 costs no action and can happen at any time, even on another player\'s turn', () => {
    const start = buildPosition({
      keeps: { 0: ['duplicity', hidden('chalice', 0)] },
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
      keeps: { 0: ['duplicity', 'count-token', 'fool-token', hidden('friar-token', 0)] },
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
      keeps: { 0: ['duplicity'], 1: ['retribution', hidden('chalice', 0)] },
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
      keeps: { 0: ['duplicity'], 1: [hidden('royal-favor', 0)] },
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

  const interestWindow = () =>
    buildPosition({
      hands: { 0: ['chalice', 'dagger'] },
      keeps: { 2: ['duplicity'], 1: [hidden('interest', 2)] },
      piles: { 1: ['scepter', 'medallion'] },
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

  it('opens once per play: passing it lets the play finish', () => {
    const played = act(interestWindow(), 0, { action: 'play', card: 'chalice', target: 1 });
    const passed = respond(played.state, 2, { kind: 'reveal-window', reveal: false });
    expect(passed.state.prompts.map((p) => [p.seat, p.kind])).toEqual([[0, 'action']]);
  });

  it('opens again for the next play that qualifies', () => {
    const played = act(interestWindow(), 0, { action: 'play', card: 'chalice', target: 1 });
    const passed = respond(played.state, 2, { kind: 'reveal-window', reveal: false });
    const again = act(passed.state, 0, { action: 'play', card: 'dagger', target: 1 });
    promptFor(again.state, 2, 'reveal-window');
    const revealed = respond(again.state, 2, { kind: 'reveal-window', reveal: true });
    // Revealed for the Dagger: one Interest draw, for the Dagger only.
    expect(payloads(revealed.events, 'trigger').map((t) => t.kind)).toEqual(['interest']);
    expect(revealed.state.hands[1]).toEqual(['scepter']);
  });

  it('during a window, the free reveal command is replaced by the window’s own answer', () => {
    const played = act(interestWindow(), 0, { action: 'play', card: 'chalice', target: 1 });
    const commands = legalCommands(played.state, 2);
    expect(commands.some((c) => c.type === 'reveal-duplicity')).toBe(false);
    expect(apply(played.state, 2, { type: 'reveal-duplicity' }).ok).toBe(false);
  });

  it("no window when the hidden card's own keep owner plays a non-Coin card into their own keep", () => {
    // Revealing Interest (window for S0's Chalice) makes S1 draw Juggling, which is HOT. S1 plays it into
    // its own keep: not a Coin card, and S1 is the one playing, so no new window opens.
    const start = buildPosition({
      hands: { 0: ['chalice'] },
      keeps: { 2: ['duplicity'], 1: [hidden('interest', 2)] },
      piles: { 1: ['juggling', 'scepter'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'chalice', target: 1 });
    const revealed = respond(played.state, 2, { kind: 'reveal-window', reveal: true });
    expect(revealed.state.prompts.map((p) => [p.seat, p.kind])).toEqual([[1, 'hot-target']]);
    const placed = hotTarget(revealed.state, 1, 1);
    expect(placed.state.prompts.map((p) => [p.seat, p.kind])).toEqual([[0, 'action']]);
  });

  it('a nested play by another player into the hidden card’s keep does get a window', () => {
    // The face-down card sits in S3's keep. S0's Chalice into S1 (Interest) makes S1 draw Juggling,
    // which S1 plays into S3's keep: that changes S3's keep, so the holder gets a window for it.
    const start = buildPosition({
      hands: { 0: ['chalice'] },
      keeps: { 1: ['interest'], 2: ['duplicity'], 3: [hidden('retribution', 2)] },
      piles: { 1: ['juggling'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'chalice', target: 1 });
    const placed = hotTarget(played.state, 1, 3);
    expect(placed.state.prompts.map((p) => [p.seat, p.kind])).toEqual([[2, 'reveal-window']]);
    // Revealing Retribution now: S3 retaliates against S1's play.
    const revealed = respond(placed.state, 2, { kind: 'reveal-window', reveal: true });
    expect(revealed.state.stack.at(-1)).toMatchObject({ op: 'action-frame', seat: 3, kind: 'retribution' });
  });

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

describe('reveals while several players are deciding', () => {
  it('revealing during Offering’s simultaneous gives leaves the gives open', () => {
    const start = buildPosition({
      hands: { 0: ['offering'], 1: ['chalice'], 2: ['dagger'] },
      keeps: { 3: ['duplicity', hidden('scepter', 3)] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'offering' });
    expect(legalCommands(played.state, 3)).toEqual([{ type: 'reveal-duplicity' }]);
    const revealed = revealNow(played.state, 3);
    expect(revealed.state.prompts.map((p) => [p.seat, p.kind])).toEqual([
      [1, 'give-card'],
      [2, 'give-card'],
    ]);
  });

  it('revealing the last Token during Offering’s gives wins at once and cancels the gives', () => {
    const start = buildPosition({
      hands: { 0: ['offering'], 1: ['chalice'], 2: ['dagger'] },
      keeps: { 3: ['duplicity', 'count-token', 'fool-token', hidden('friar-token', 3)] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'offering' });
    const { state, events } = revealNow(played.state, 3);
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'tokens', winner: 3 }]);
    expect(state.prompts).toEqual([]);
    expect(state.openPlays).toEqual([]);
    expect(state.marks).toEqual([0, 0, 0, 1]);
  });
});

describe('revealed cards', () => {
  it('a revealed Sanction can be used later the same turn', () => {
    const start = buildPosition({ keeps: { 0: ['duplicity', hidden('sanction', 0)] }, piles: { 2: ['chalice'] }, turn: 0 });
    expect(abilityNames(start, 0)).toEqual([]);
    const revealed = revealNow(start, 0);
    expect(abilityNames(revealed.state, 0)).toEqual(['sanction']);
  });

  it("a revealed ability belongs to the keep's owner, not the Duplicity holder who revealed it", () => {
    const start = buildPosition({
      keeps: { 2: ['duplicity'], 1: [hidden('juggling', 2)] },
      piles: { 0: ['chalice', 'dagger'], 1: ['scepter'] },
      turn: 0,
    });
    const revealed = revealNow(start, 2);
    expect(abilityNames(revealed.state, 0)).toEqual([]);
    const s1Turn = draw(draw(revealed.state, 0).state, 0).state;
    expect(s1Turn.turn?.seat).toBe(1);
    expect(abilityNames(s1Turn, 1)).toEqual(['juggling']);
  });

  it('a revealed Tithes makes its keep worth more at once', () => {
    const start = buildPosition({ keeps: { 0: ['duplicity', hidden('tithes', 0), 'chalice'] }, piles: { 0: ['dagger'] }, turn: 0 });
    // Face down, Tithes has no value: just the Chalice's 2 coins.
    expect(viewScore(start)).toBe(4);
    const { state } = revealNow(start, 0);
    // Face up, Tithes counts all three cards: 3 + 2 coins.
    expect(viewScore(state)).toBe(10);
    expect(abilityNames(state, 0)).toEqual(['tithes']);
  });

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

  it('a revealed Interest answers only the Coin card that entered its own keep', () => {
    // Providence swaps Dagger (S2) and Scepter (S1, where Interest hides). Both are Coin cards
    // entering a keep, but only the Dagger entered the hidden Interest's keep.
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 1: [hidden('interest', 3), 'scepter'], 2: ['dagger'], 3: ['duplicity'] },
      piles: { 1: ['chalice', 'medallion'], 2: ['timepiece'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const swapped = respond(played.state, 0, { kind: 'choose-keep-pair', a: { seat: 1, index: 1 }, b: { seat: 2, index: 0 } });
    const { state, events } = respond(swapped.state, 3, { kind: 'reveal-window', reveal: true });
    expect(payloads(events, 'trigger').map((t) => `${t.kind}:${t.seat}`)).toEqual(['interest:1']);
    expect(state.hands[1]).toEqual(['chalice']);
    expect(state.hands[2]).toEqual([]);
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

describe('a revealed Shackles', () => {
  const shackledPosition = () =>
    buildPosition({
      keeps: { 0: ['duplicity'], 1: [hidden('shackles', 0)] },
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
    const start = buildPosition({ keeps: { 0: ['duplicity'], 1: [hidden('shackles', 0)] }, piles: { 0: ['chalice'] }, turn: 0 });
    const { state, events } = revealNow(start, 0);
    expect(types(events)).toEqual(['reveal']);
    expect(actionsLeft(state)).toBe(2);
  });

  it('revealing Shackles when the turn already has just one action changes nothing', () => {
    const start = buildPosition({ keeps: { 0: ['duplicity', hidden('shackles', 0)] }, piles: { 0: ['chalice'] }, turn: 0, actions: 1 });
    const { events } = revealNow(start, 0);
    expect(types(events)).toEqual(['reveal']);
  });
});

describe('reveal windows at round end', () => {
  it('C-12 a face-down Last Laugh can be revealed at round end to get its action', () => {
    const start = buildPosition({
      keeps: { 0: ['duplicity', hidden('last-laugh', 0)] },
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
        keeps: { 0: ['duplicity', hidden('chalice', 0)], 1: ['last-laugh', 'dagger'] },
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
      keeps: { 0: ['duplicity', 'last-laugh', hidden('faberge-egg', 0)], 1: ['dagger'] },
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
    const start = buildPosition({ keeps: { 0: ['duplicity', hidden('chalice', 0)] }, turn: 0 });
    const ended = draw(start, 0);
    const scored = respond(respond(ended.state, 0, { kind: 'reveal-window', reveal: false }).state, 0, {
      kind: 'reveal-window',
      reveal: false,
    });
    expect(scored.state.phase).toBe('round-over');
    expect(apply(scored.state, 0, { type: 'reveal-duplicity' }).ok).toBe(false);
  });

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

describe('with Retribution and Last Laugh', () => {
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

describe('face-down cards have no effect', () => {
  it('a face-down Juggling, Sanction, Tithes or Blunder gives no ability', () => {
    const fd = (id: 'juggling' | 'sanction' | 'tithes' | 'blunder') => ({ id, faceDown: { placedBy: 1 as const } });
    for (const card of ['juggling', 'sanction', 'tithes', 'blunder'] as const) {
      const start = buildPosition({ keeps: { 0: [fd(card)], 1: ['duplicity'] }, hands: { 0: ['chalice'] }, turn: 0 });
      expect(abilityNames(start, 0)).toEqual([]);
    }
  });

  it('a face-down Interest does not draw when a Coin card enters', () => {
    const start = buildPosition({
      hands: { 0: ['chalice'] },
      keeps: { 1: [{ id: 'interest', faceDown: { placedBy: 0 } }] },
      piles: { 1: ['dagger'] },
      turn: 0,
    });
    // No Duplicity holder, so no reveal window either.
    const { state, events } = act(start, 0, { action: 'play', card: 'chalice', target: 1 });
    expect(types(events)).not.toContain('trigger');
    expect(state.hands[1]).toEqual([]);
  });

  it('a face-down Retribution does not trigger', () => {
    const start = buildPosition({
      hands: { 0: ['chalice'] },
      keeps: { 1: [{ id: 'retribution', faceDown: { placedBy: 0 } }] },
      turn: 0,
    });
    expect(types(act(start, 0, { action: 'play', card: 'chalice', target: 1 }).events)).not.toContain('trigger');
  });

  it('a face-down Last Laugh that stays hidden gives no action at round end', () => {
    const start = buildPosition({ keeps: { 0: ['duplicity', { id: 'last-laugh', faceDown: { placedBy: 0 } }] }, hands: { 0: ['chalice'] }, turn: 0 });
    const ended = draw(start, 0);
    const passed = respond(ended.state, 0, { kind: 'reveal-window', reveal: false });
    expect(types(passed.events)).not.toContain('last-laugh');
    // Straight to the second window (the face-down card can still be revealed for scoring).
    expect(promptFor(passed.state, 0, 'reveal-window').reason).toBe('before-scoring');
  });

  it('a card never revealed is shown to everyone once the round is over, still face down and unscored', () => {
    const start = buildPosition({ keeps: { 0: ['duplicity', { id: 'chalice', faceDown: { placedBy: 0 } }] }, hands: { 0: ['dagger'] }, turn: 0 });
    const ended = draw(start, 0);
    // Between the round's end and scoring, the card can still be revealed: still secret.
    expect(viewFor(ended.state, 2).keeps[0]!.cards[1]).toEqual({ faceDown: true });
    const passed = respond(ended.state, 0, { kind: 'reveal-window', reveal: false });
    const { state } = respond(passed.state, 0, { kind: 'reveal-window', reveal: false });
    expect(state.phase).toBe('round-over');
    for (const viewer of [0, 2, 'spectator'] as const) {
      expect(viewFor(state, viewer).keeps[0]!.cards[1]).toEqual({ faceDown: true, id: 'chalice' });
    }
    expect(viewFor(state, 2).scores[0]).toBe(0);
  });

  it('a revealed Last Laugh after its window has passed gives no action', () => {
    const start = buildPosition({ keeps: { 0: ['duplicity', { id: 'last-laugh', faceDown: { placedBy: 0 } }] }, hands: { 0: ['chalice'] }, turn: 0 });
    const ended = draw(start, 0);
    const passed = respond(ended.state, 0, { kind: 'reveal-window', reveal: false });
    const { state, events } = respond(passed.state, 0, { kind: 'reveal-window', reveal: true });
    expect(types(events)).toEqual(['reveal', 'score', 'mark']);
    expect(state.phase).toBe('round-over');
  });
});
