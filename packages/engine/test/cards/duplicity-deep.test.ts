import { describe, expect, it } from 'vitest';
import { apply, buildPosition, keepValue, legalCommands, type CardId, type GameState, type KeepCard, type Seat } from '../../src/index.ts';
import { abilityNames, act, draw, hotTarget, payloads, promptFor, respond, revealNow } from '../helpers.ts';

// Duplicity beyond the clarifications: abilities on revealed cards, who may
// use them, how often windows open, and reveals while others are deciding.

const hidden = (id: CardId, placedBy: Seat = 0): KeepCard => ({ id, faceDown: { placedBy } });
const viewScore = (state: GameState) => keepValue(state.keeps[0]);

describe('revealed cards', () => {
  it('a revealed Sanction can be used later the same turn', () => {
    const start = buildPosition({ keeps: { 0: ['duplicity', hidden('sanction')] }, piles: { 2: ['chalice'] }, turn: 0 });
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
    const start = buildPosition({ keeps: { 0: ['duplicity', hidden('tithes'), 'chalice'] }, piles: { 0: ['dagger'] }, turn: 0 });
    // Face down, Tithes has no value: just the Chalice's 2 coins.
    expect(viewScore(start)).toBe(4);
    const { state } = revealNow(start, 0);
    // Face up, Tithes counts all three cards: 3 + 2 coins.
    expect(viewScore(state)).toBe(10);
    expect(abilityNames(state, 0)).toEqual(['tithes']);
  });
});

describe('reveal windows', () => {
  const interestWindow = () =>
    buildPosition({
      hands: { 0: ['chalice', 'dagger'] },
      keeps: { 2: ['duplicity'], 1: [hidden('interest', 2)] },
      piles: { 1: ['scepter', 'medallion'] },
      turn: 0,
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
