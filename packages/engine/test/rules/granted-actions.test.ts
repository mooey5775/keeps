import { describe, expect, it } from 'vitest';
import { buildPosition, type GameState } from '../../src/index.ts';
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

describe('Q-17 in deeper chains', () => {
  it('an invoked Legerdemain stealing Hocus Pocus: the Retribution still comes first', () => {
    const start = buildPosition({
      hands: { 1: ['hocus-pocus'] },
      keeps: { 1: ['retribution'] },
      piles: { 0: ['invocation'], 2: ['legerdemain'], 1: ['chalice', 'dagger'] },
      turn: 0,
    });
    const drawn = draw(start, 0);
    const invoked = respond(drawn.state, 0, { kind: 'choose-pile', pile: 2 });
    const stolen = respond(invoked.state, 0, { kind: 'choose-player', seat: 1 });
    expect(frames(stolen.state)).toEqual(['S0:turn:1', 'S0:hocus-pocus:2', 'S1:retribution:2!']);
    promptFor(stolen.state, 1, 'action');
  });

  it('Joker copying Legerdemain to steal Hocus Pocus behaves the same', () => {
    const start = buildPosition({
      hands: { 0: ['joker', 'legerdemain'], 1: ['hocus-pocus'] },
      keeps: { 1: ['retribution'] },
      piles: { 1: ['chalice', 'dagger'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'joker', copy: 'legerdemain' });
    const stolen = respond(played.state, 0, { kind: 'choose-player', seat: 1 });
    expect(frames(stolen.state)).toEqual(['S0:turn:1', 'S0:hocus-pocus:2', 'S1:retribution:2!']);
  });

  it('as the Last Laugh action: Retribution first, then the stolen actions, still restricted', () => {
    const start = buildPosition({
      keeps: { 0: ['last-laugh', 'sanction'], 1: ['retribution'] },
      hands: { 0: ['legerdemain'], 1: ['hocus-pocus'] },
      piles: { 1: ['chalice', 'dagger'] },
      turn: 0,
    });
    const ended = draw(start, 0).state;
    const stolen = respond(act(ended, 0, { action: 'play', card: 'legerdemain' }).state, 0, { kind: 'choose-player', seat: 1 });
    // The spent Last Laugh frame stays until it's popped, below the stolen actions.
    expect(frames(stolen.state)).toEqual(['S0:last-laugh:0!', 'S0:hocus-pocus:2!', 'S1:retribution:2!']);
    const retaliated = draw(draw(stolen.state, 1).state, 1).state;
    promptFor(retaliated, 0, 'action');
    expect(retaliated.phase).toBe('post-round');
  });

  it('if the Retribution actions end the round, the stolen actions are never taken', () => {
    const start = buildPosition({
      keeps: { 1: ['retribution', 'faberge-egg'] },
      hands: { 0: ['legerdemain'], 1: ['hocus-pocus'] },
      turn: 0,
    });
    const stolen = respond(act(start, 0, { action: 'play', card: 'legerdemain' }).state, 0, { kind: 'choose-player', seat: 1 });
    const { state, events } = draw(stolen.state, 1); // S1's pile is empty
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'empty-pile', ender: 1 }]);
    expect(state.phase).toBe('round-over');
    expect(state.stack).toEqual([]);
  });

  it('if the Retribution actions win by Tokens, the stolen actions are never taken', () => {
    // Legerdemain picks at random; find a seed where it steals Hocus Pocus rather than the Friar Token.
    let state: GameState | null = null;
    for (let seed = 0; seed < 50 && !state; seed++) {
      const candidate = buildPosition({
        keeps: { 1: ['retribution', 'count-token', 'fool-token'] },
        hands: { 0: ['legerdemain'], 1: ['hocus-pocus', 'friar-token'] },
        turn: 0,
        seed,
      });
      const stolen = respond(act(candidate, 0, { action: 'play', card: 'legerdemain' }).state, 0, { kind: 'choose-player', seat: 1 });
      if (payloads(stolen.events, 'steal')[0]?.cards?.[0] === 'hocus-pocus') state = stolen.state;
    }
    if (!state) throw new Error('no seed steals Hocus Pocus');
    expect(state.hands[1]).toEqual(['friar-token']);
    const won = act(state, 1, { action: 'play', card: 'friar-token', target: 1 });
    expect(payloads(won.events, 'round-end')).toEqual([{ type: 'round-end', reason: 'tokens', winner: 1 }]);
    expect(won.state.stack).toEqual([]);
  });
});
