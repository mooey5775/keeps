import { describe, expect, it } from 'vitest';
import { buildPosition, describe as describeEvent, parseReplayLog } from '../../src/index.ts';
import { act, hidden, payloads, respond, revealNow, types } from '../helpers.ts';

// Rule branches that coverage showed no test reaching.


describe('rarely reached rules', () => {
  it('Prayer with every pile empty has no effect', () => {
    const start = buildPosition({ hands: { 0: ['prayer'] }, turn: 0 });
    const { state, events } = act(start, 0, { action: 'play', card: 'prayer' });
    expect(payloads(events, 'no-effect')).toEqual([{ type: 'no-effect', seat: 0, card: 'prayer', reason: 'every pile is empty' }]);
    expect(state.prompts.map((p) => p.kind)).toEqual(['action']);
  });

  it.each([
    ['first', { a: { seat: 2, index: 0 }, b: { seat: 1, index: 1 } }],
    ['second', { a: { seat: 1, index: 1 }, b: { seat: 2, index: 0 } }],
  ] as const)('a face-down Coin card swapped into an Interest keep (as the %s card) does not trigger Interest', (_order, pair) => {
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 1: ['interest', 'juggling'], 2: [{ id: 'chalice', faceDown: { placedBy: 0 } }] },
      piles: { 1: ['dagger'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const { state, events } = respond(played.state, 0, { kind: 'choose-keep-pair', ...pair });
    expect(state.keeps[1].some((c) => c.id === 'chalice' && c.faceDown)).toBe(true);
    expect(types(events)).not.toContain('trigger');
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

  it('revealing Shackles when the turn already has just one action changes nothing', () => {
    const start = buildPosition({ keeps: { 0: ['duplicity', hidden('shackles', 0)] }, piles: { 0: ['chalice'] }, turn: 0, actions: 1 });
    const { events } = revealNow(start, 0);
    expect(types(events)).toEqual(['reveal']);
  });
});

describe('rarely rendered trace text', () => {
  it('describes a Shackled turn and a swap involving a hidden card', () => {
    expect(describeEvent({ type: 'shackled', seat: 1, remaining: 0 })).toBe('S1 is Shackled: 0 actions left this turn');
    expect(describeEvent({ type: 'shackled', seat: 1, remaining: 1 })).toBe('S1 is Shackled: 1 action left this turn');
    expect(
      describeEvent({ type: 'keep-swap', seat: 0, a: { seat: 1, index: 0, card: null }, b: { seat: 2, index: 1, card: 'dagger' } }),
    ).toBe('swap a face-down card (keep S1) ⇄ Dagger (keep S2)');
  });
});

describe('replay logs', () => {
  it('reject a log without an options line', () => {
    expect(() => parseReplayLog('{"seat":0,"command":{"type":"next-round"}}\n')).toThrow(/options/);
    expect(() => parseReplayLog('')).toThrow(/options/);
  });

  it('ignore blank lines', () => {
    const log = parseReplayLog('\n{"options":{"players":2,"seed":1}}\n\n{"seat":0,"command":{"type":"next-round"}}\n\n');
    expect(log.commands).toHaveLength(1);
  });
});
