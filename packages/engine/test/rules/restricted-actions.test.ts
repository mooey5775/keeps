import { describe, expect, it } from 'vitest';
import { buildPosition } from '../../src/index.ts';
import { abilityNames, act, lastLaughAfterEnding, promptFor } from '../helpers.ts';

// Retribution's and Last Laugh's actions can't use Acquisition, Sanction, or
// Juggling (C-07, C-23, C-33, C-34, C-35).

describe('restricted actions (Retribution and Last Laugh)', () => {
  const ability = (card: 'acquisition' | 'sanction' | 'juggling') => {
    // Before the round ends, on S0's own turn, the ability is available.
    const live = buildPosition({ keeps: { 0: ['last-laugh', card] }, hands: { 0: ['chalice'] }, turn: 0 });
    expect(abilityNames(live, 0)).toContain(card);
    // During Last Laugh's action it is not.
    const ended = lastLaughAfterEnding([card], ['chalice']);
    expect(abilityNames(ended, 0)).not.toContain(card);
    // Nor during Retribution's actions.
    const struck = buildPosition({ keeps: { 1: ['retribution', card] }, hands: { 0: ['dagger'], 1: ['chalice'] }, turn: 0 });
    const { state } = act(struck, 0, { action: 'play', card: 'dagger', target: 1 });
    promptFor(state, 1, 'action');
    expect(abilityNames(state, 1)).not.toContain(card);
  };

  it("C-07 Acquisition can't be used with Retribution or Last Laugh actions", () => ability('acquisition'));

  it("C-34 Sanction can't be used with Retribution or Last Laugh actions", () => ability('sanction'));

  it("C-35 Juggling can't be used with Retribution or Last Laugh actions", () => ability('juggling'));

  it("C-23 Last Laugh's action can't use Acquisition, Sanction, or Juggling", () => {
    const ended = lastLaughAfterEnding(['acquisition', 'sanction', 'juggling', 'tithes'], ['chalice']);
    // It is still S0's turn, so only the restriction stops these.
    expect(ended.turn?.seat).toBe(0);
    expect(abilityNames(ended, 0)).toEqual(['tithes']);
  });

  it("C-33 the owner's Retribution actions can't use Acquisition, Sanction, or Juggling", () => {
    const start = buildPosition({
      hands: { 0: ['chalice'], 1: ['dagger'] },
      keeps: { 1: ['retribution', 'sanction', 'juggling', 'acquisition', 'tithes'] },
      turn: 0,
    });
    const { state } = act(start, 0, { action: 'play', card: 'chalice', target: 1 });
    promptFor(state, 1, 'action');
    expect(abilityNames(state, 1)).toEqual(['tithes']);
  });

  it("C-33 Retribution's actions can't use Acquisition, Sanction, or Juggling", () => {
    const start = buildPosition({
      keeps: { 1: ['acquisition', 'sanction', 'juggling', 'tithes'] },
      hands: { 1: ['chalice'] },
      piles: { 0: ['dagger'] },
      turn: 0,
      frames: [{ seat: 1, kind: 'retribution', remaining: 2 }],
    });
    promptFor(start, 1, 'action');
    expect(abilityNames(start, 1)).toEqual(['tithes']);
  });

  it('Hocus Pocus played during Retribution actions keeps the restriction', () => {
    const start = buildPosition({
      keeps: { 1: ['sanction'] },
      hands: { 1: ['hocus-pocus'] },
      turn: 0,
      frames: [{ seat: 1, kind: 'retribution', remaining: 2 }],
    });
    const { state } = act(start, 1, { action: 'play', card: 'hocus-pocus' });
    const top = state.stack.at(-1);
    expect(top).toMatchObject({ op: 'action-frame', seat: 1, kind: 'hocus-pocus', remaining: 2, restricted: true });
    expect(abilityNames(state, 1)).toEqual([]);
  });
});
