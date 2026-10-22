import { describe, expect, it } from 'vitest';
import { buildPosition } from '../../src/index.ts';
import { act, draw, frames, payloads, promptFor, respond } from '../helpers.ts';

// Ruling Q-17: actions a card grants (Hocus Pocus, played directly, copied
// by Joker, stolen with Legerdemain, or invoked) are taken after the
// enclosing play has resolved and queued its triggers.


describe('granted actions come after the enclosing play (Q-17)', () => {
  it('Q-17 stealing Hocus Pocus from a Retribution owner: the Retribution actions come first', () => {
    const start = buildPosition({
      hands: { 0: ['legerdemain'], 1: ['hocus-pocus'] },
      keeps: { 1: ['retribution'] },
      piles: { 0: ['chalice', 'dagger', 'scepter'], 1: ['medallion', 'timepiece'] },
      turn: 0,
    });
    const stolen = respond(act(start, 0, { action: 'play', card: 'legerdemain' }).state, 0, { kind: 'choose-player', seat: 1 });
    expect(payloads(stolen.events, 'trigger').map((t) => `${t.kind}:${t.seat}`)).toEqual(['retribution:1']);
    expect(frames(stolen.state)).toEqual(['S0:turn:1', 'S0:hocus-pocus:2', 'S1:retribution:2!']);
    promptFor(stolen.state, 1, 'action');

    // S1 retaliates, then S0 takes the two stolen actions and the last turn action.
    let state = draw(draw(stolen.state, 1).state, 1).state;
    for (let i = 0; i < 3; i++) {
      promptFor(state, 0, 'action');
      state = draw(state, 0).state;
    }
    expect(state.hands[0]).toEqual(['chalice', 'dagger', 'scepter']);
    expect(state.turn?.seat).toBe(1);
  });

  it('Q-17 a Duplicity reveal window for the theft also comes before the stolen actions', () => {
    const start = buildPosition({
      hands: { 0: ['legerdemain'], 1: ['hocus-pocus'] },
      keeps: { 1: [{ id: 'retribution', faceDown: { placedBy: 2 } }], 2: ['duplicity'] },
      piles: { 1: ['medallion', 'timepiece'] },
      turn: 0,
    });
    const stolen = respond(act(start, 0, { action: 'play', card: 'legerdemain' }).state, 0, { kind: 'choose-player', seat: 1 });
    expect(stolen.state.prompts.map((p) => [p.seat, p.kind])).toEqual([[2, 'reveal-window']]);
    // Revealing the hidden Retribution in that window makes S1 retaliate, still before S0's stolen actions.
    const revealed = respond(stolen.state, 2, { kind: 'reveal-window', reveal: true });
    expect(frames(revealed.state)).toEqual(['S0:turn:1', 'S0:hocus-pocus:2', 'S1:retribution:2!']);
  });

  it('Q-17 with nothing triggered, the stolen actions simply follow', () => {
    const start = buildPosition({ hands: { 0: ['legerdemain'], 1: ['hocus-pocus'] }, piles: { 0: ['chalice'] }, turn: 0 });
    const stolen = respond(act(start, 0, { action: 'play', card: 'legerdemain' }).state, 0, { kind: 'choose-player', seat: 1 });
    expect(frames(stolen.state)).toEqual(['S0:turn:1', 'S0:hocus-pocus:2']);
    promptFor(stolen.state, 0, 'action');
  });

  it('a stolen card that grants no actions is unaffected: Retribution, then the turn continues', () => {
    // S1's only card is stolen and played, so the stolen Offering takes nothing
    // from S1: one Retribution (two actions), then S0's last turn action.
    const start = buildPosition({
      hands: { 0: ['legerdemain'], 1: ['offering'] },
      keeps: { 1: ['retribution'] },
      piles: { 1: ['medallion', 'timepiece'] },
      turn: 0,
    });
    const stolen = respond(act(start, 0, { action: 'play', card: 'legerdemain' }).state, 0, { kind: 'choose-player', seat: 1 });
    expect(payloads(stolen.events, 'trigger').map((t) => t.kind)).toEqual(['retribution']);
    const state = draw(draw(stolen.state, 1).state, 1).state;
    expect(frames(state)).toEqual(['S0:turn:1']);
    promptFor(state, 0, 'action');
  });

  it('Hocus Pocus played from hand already works this way: its play resolves before its actions', () => {
    const start = buildPosition({ hands: { 0: ['hocus-pocus'] }, piles: { 0: ['chalice'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'hocus-pocus' });
    expect(played.state.openPlays).toEqual([]);
    expect(frames(played.state)).toEqual(['S0:turn:1', 'S0:hocus-pocus:2']);
  });
});
