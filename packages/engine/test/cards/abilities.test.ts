import { describe, expect, it } from 'vitest';
import { buildPosition, keepValue } from '../../src/index.ts';
import {
  abilityNames,
  act,
  actionChoices,
  actionsLeft,
  draw,
  hotTarget,
  payloads,
  pileIds,
  promptFor,
  respond,
  tryRespond,
  types,
} from '../helpers.ts';

describe('Juggling', () => {
  it('swaps any two piles, using one action', () => {
    const start = buildPosition({ keeps: { 0: ['juggling'] }, piles: { 1: ['chalice'], 3: ['dagger'] }, turn: 0 });
    const { state, events } = act(start, 0, { action: 'ability', card: 'juggling', piles: [1, 3] });
    expect(pileIds(state, 1)).toEqual(['dagger']);
    expect(pileIds(state, 3)).toEqual(['chalice']);
    expect(actionsLeft(state)).toBe(1);
    expect(payloads(events, 'pile-swap')).toEqual([{ type: 'pile-swap', seat: 0, a: 1, b: 3 }]);
  });

  it('can be used once per turn, and again on your next turn', () => {
    const start = buildPosition({
      keeps: { 0: ['juggling'] },
      piles: { 0: ['chalice', 'dagger'], 1: ['medallion', 'scepter'], 2: ['timepiece', 'faberge-egg'], 3: ['count-token', 'fool-token'] },
      turn: 0,
    });
    expect(abilityNames(start, 0)).toEqual(['juggling']);
    let state = act(start, 0, { action: 'ability', card: 'juggling', piles: [0, 1] }).state;
    expect(abilityNames(state, 0)).toEqual([]);
    state = draw(state, 0).state;
    for (const seat of [1, 2, 3] as const) state = draw(draw(state, seat).state, seat).state;
    expect(state.turn?.seat).toBe(0);
    expect(abilityNames(state, 0)).toEqual(['juggling']);
  });

  it("can't be used from another player's keep", () => {
    const start = buildPosition({ keeps: { 1: ['juggling'] }, turn: 0 });
    expect(abilityNames(start, 0)).toEqual([]);
  });

  it('is usable the same turn it is drawn and played into your keep', () => {
    const start = buildPosition({ piles: { 0: ['juggling', 'chalice'] }, turn: 0 });
    const placed = hotTarget(draw(start, 0).state, 0, 0);
    expect(abilityNames(placed.state, 0)).toEqual(['juggling']);
  });
});

describe('Sanction', () => {
  it('draws from any pile, once per turn', () => {
    const start = buildPosition({ keeps: { 0: ['sanction'] }, piles: { 2: ['chalice', 'dagger'] }, turn: 0 });
    const { state } = act(start, 0, { action: 'ability', card: 'sanction', from: 2 });
    expect(state.hands[0]).toEqual(['chalice']);
    expect(pileIds(state, 2)).toEqual(['dagger']);
    expect(abilityNames(state, 0)).toEqual([]);
  });

  it('ends the round when drawing from an empty pile (Rags to Riches)', () => {
    const start = buildPosition({
      keeps: { 0: ['sanction'], 1: ['chalice'] },
      hands: { 0: ['purity'] },
      piles: { 0: ['dagger'] },
      turn: 0,
    });
    const pure = act(start, 0, { action: 'play', card: 'purity', target: 0 });
    const { state, events } = act(pure.state, 0, { action: 'ability', card: 'sanction', from: 3 });
    expect(payloads(events, 'round-end')).toEqual([{ type: 'round-end', reason: 'empty-pile', ender: 0 }]);
    expect(payloads(events, 'score')[0]).toMatchObject({ winner: 0, scores: [20, 4, 0, 0] });
    expect(state.marks).toEqual([1, 0, 0, 0]);
  });
});

describe('restricted action frames', () => {
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

describe('Acquisition', () => {
  const position = () =>
    buildPosition({
      keeps: { 0: ['acquisition'] },
      hands: { 0: ['chalice'] },
      piles: { 1: ['dagger', 'scepter'], 3: ['medallion'] },
      turn: 0,
    });

  it('discards a card, then draws from the left and right piles in the chosen order', () => {
    const { state, events } = act(position(), 0, { action: 'ability', card: 'acquisition', discard: 'chalice', first: 'right' });
    expect(state.discard).toEqual(['chalice']);
    expect(state.hands[0]).toEqual(['medallion', 'dagger']);
    expect(payloads(events, 'draw').map((d) => d.from)).toEqual([3, 1]);
    expect(actionsLeft(state)).toBe(1);
  });

  it('needs a non-empty hand, and is once per turn', () => {
    const empty = buildPosition({ keeps: { 0: ['acquisition'] }, turn: 0 });
    expect(abilityNames(empty, 0)).toEqual([]);
    const used = act(position(), 0, { action: 'ability', card: 'acquisition', discard: 'chalice', first: 'left' });
    expect(abilityNames(used.state, 0)).toEqual([]);
  });

  it('Q-08 the second pile is the one at that position after the first draw resolves', () => {
    // Drawing left reveals Pandemonium, which rotates the piles before the right draw.
    const start = buildPosition({
      keeps: { 0: ['acquisition'] },
      hands: { 0: ['chalice'] },
      piles: { 1: ['pandemonium'], 2: ['scepter'], 3: ['medallion'] },
      turn: 0,
    });
    const drawn = act(start, 0, { action: 'ability', card: 'acquisition', discard: 'chalice', first: 'left' });
    promptFor(drawn.state, 0, 'choose-direction');
    // Rotating left moves the pile at S2 (Scepter) to S3, the right-hand position of S0.
    const { state } = respond(drawn.state, 0, { kind: 'choose-direction', direction: 'left' });
    expect(state.hands[0]).toEqual(['scepter']);
    expect(pileIds(state, 0)).toEqual(['medallion']);
  });

  it('ends the round if the first pile is empty, skipping the second draw', () => {
    const start = buildPosition({
      keeps: { 0: ['acquisition'] },
      hands: { 0: ['chalice'] },
      piles: { 3: ['medallion'] },
      turn: 0,
    });
    const { state, events } = act(start, 0, { action: 'ability', card: 'acquisition', discard: 'chalice', first: 'left' });
    expect(types(events)).toContain('round-end');
    expect(payloads(events, 'draw')).toEqual([]);
    expect(pileIds(state, 3)).toEqual(['medallion']);
  });
});

describe('Shackles', () => {
  it('can be discarded from your own keep with one action', () => {
    const start = buildPosition({ keeps: { 0: ['shackles'] }, turn: 0, actions: 2 });
    const { state, events } = act(start, 0, { action: 'ability', card: 'shackles' });
    expect(state.keeps[0]).toEqual([]);
    expect(state.discard).toEqual(['shackles']);
    expect(payloads(events, 'discard')).toEqual([{ type: 'discard', seat: 0, cards: ['shackles'], from: 'keep' }]);
  });

  it('a Shackled player can spend their single action discarding it', () => {
    const start = buildPosition({ keeps: { 0: ['shackles'] }, turn: 0 });
    expect(actionsLeft(start)).toBe(1);
    const { state } = act(start, 0, { action: 'ability', card: 'shackles' });
    expect(state.turn?.seat).toBe(1);
  });

  it("can't be discarded from someone else's keep", () => {
    const start = buildPosition({ keeps: { 1: ['shackles'] }, turn: 0 });
    expect(abilityNames(start, 0)).toEqual([]);
  });
});

describe('Tithes', () => {
  it('C-36 discards every Coin card in your keep, Tithes included', () => {
    const start = buildPosition({
      keeps: { 0: ['tithes', 'chalice', 'purity', 'juggling', 'count-token'] },
      turn: 0,
    });
    const { state } = act(start, 0, { action: 'ability', card: 'tithes' });
    expect(state.keeps[0]).toEqual([{ id: 'purity' }, { id: 'juggling' }]);
    expect(state.discard).toEqual(['tithes', 'chalice', 'count-token']);
  });

  it('C-18 the face-down card counts for Tithes, but Tithes never discards it', () => {
    const start = buildPosition({
      keeps: { 0: ['tithes', { id: 'faberge-egg', faceDown: { placedBy: 1 } }] },
      turn: 0,
    });
    expect(keepValue(start.keeps[0])).toBe(4); // two cards → 2 coins
    const { state } = act(start, 0, { action: 'ability', card: 'tithes' });
    expect(state.keeps[0]).toEqual([{ id: 'faberge-egg', faceDown: { placedBy: 1 } }]);
    expect(state.discard).toEqual(['tithes']);
  });

  it('then lets you look through and reorder your own pile, privately', () => {
    const start = buildPosition({
      keeps: { 0: ['tithes'] },
      piles: { 0: ['chalice', { id: 'blunder', faceUp: true }, 'dagger'] },
      turn: 0,
    });
    const used = act(start, 0, { action: 'ability', card: 'tithes' });
    const prompt = promptFor(used.state, 0, 'order-pile');
    expect(prompt.cards).toEqual(['chalice', 'blunder', 'dagger']);
    const look = used.events.find((e) => e.payload.type === 'look')!;
    expect(look.visibility).toEqual([0]);

    const { state, events } = respond(used.state, 0, { kind: 'order-pile', order: ['dagger', 'chalice', 'blunder'] });
    expect(state.piles[state.pileAt[0]].cards).toEqual([
      { id: 'dagger', faceUp: false },
      { id: 'chalice', faceUp: false },
      { id: 'blunder', faceUp: true },
    ]);
    expect(events.find((e) => e.payload.type === 'pile-reorder')!.redacted).toEqual({
      type: 'pile-reorder', seat: 0, pile: 0, order: null,
    });
  });

  it('rejects an order that is not a permutation of the pile', () => {
    const start = buildPosition({ keeps: { 0: ['tithes'] }, piles: { 0: ['chalice', 'dagger'] }, turn: 0 });
    const used = act(start, 0, { action: 'ability', card: 'tithes' }).state;
    for (const order of [['chalice'], ['chalice', 'chalice'], ['chalice', 'scepter']] as const) {
      const result = tryRespond(used, 0, { kind: 'order-pile', order: [...order] });
      expect(result.ok).toBe(false);
    }
  });

  it('skips the reorder when your pile is empty', () => {
    const start = buildPosition({ keeps: { 0: ['tithes'] }, turn: 0 });
    const { state } = act(start, 0, { action: 'ability', card: 'tithes' });
    promptFor(state, 0, 'action');
  });

  it('is usable during Retribution actions', () => {
    const start = buildPosition({
      keeps: { 1: ['tithes'] },
      turn: 0,
      frames: [{ seat: 1, kind: 'retribution', remaining: 2 }],
    });
    expect(abilityNames(start, 1)).toEqual(['tithes']);
  });
});

describe('Blunder', () => {
  it('costs two actions to place it face-up onto any pile', () => {
    const start = buildPosition({ keeps: { 0: ['blunder'] }, piles: { 2: ['chalice'] }, turn: 0 });
    expect(abilityNames(start, 0)).toEqual(['blunder']);
    const { state, events } = act(start, 0, { action: 'ability', card: 'blunder', pile: 2 });
    expect(state.keeps[0]).toEqual([]);
    expect(state.piles[state.pileAt[2]].cards).toEqual([
      { id: 'blunder', faceUp: true },
      { id: 'chalice', faceUp: false },
    ]);
    expect(payloads(events, 'turn-end')).toEqual([{ type: 'turn-end', seat: 0 }]);
  });

  it('whoever draws the placed Blunder must play it into their own keep (Blunder 2)', () => {
    const start = buildPosition({ keeps: { 0: ['blunder'] }, piles: { 1: ['chalice'] }, turn: 0 });
    const placed = act(start, 0, { action: 'ability', card: 'blunder', pile: 1 });
    const { state, events } = draw(placed.state, 1);
    expect(state.keeps[1]).toEqual([{ id: 'blunder' }]);
    // A face-up card's draw is public.
    expect(events.find((e) => e.payload.type === 'draw')!.visibility).toBe('all');
  });

  it("C-08 any two consecutive actions work: Hocus Pocus's last action plus a turn action", () => {
    const start = buildPosition({
      keeps: { 0: ['blunder'] },
      hands: { 0: ['hocus-pocus'] },
      piles: { 0: ['chalice'], 3: ['dagger'] },
      turn: 0,
    });
    const hocus = act(start, 0, { action: 'play', card: 'hocus-pocus' }); // turn: 1 left, Hocus Pocus: 2
    const drawn = draw(hocus.state, 0); // Hocus Pocus: 1 left
    expect(abilityNames(drawn.state, 0)).toEqual(['blunder']);
    const { state } = act(drawn.state, 0, { action: 'ability', card: 'blunder', pile: 3 });
    expect(pileIds(state, 3)).toEqual(['blunder', 'dagger']);
    expect(state.turn?.seat).toBe(1);
  });

  it('C-08 both Retribution actions can be used to remove Blunder', () => {
    const start = buildPosition({
      keeps: { 1: ['blunder'] },
      turn: 0,
      frames: [{ seat: 1, kind: 'retribution', remaining: 2 }],
    });
    expect(actionChoices(start, 1)).toContainEqual({ action: 'ability', card: 'blunder', pile: 0 });
  });

  it('Q-03 removing Blunder cannot span two turns, or a Shackled single action', () => {
    const start = buildPosition({ keeps: { 0: ['blunder'] }, piles: { 0: ['chalice'] }, turn: 0 });
    expect(abilityNames(draw(start, 0).state, 0)).toEqual([]);
    const shackled = buildPosition({ keeps: { 0: ['blunder', 'shackles'] }, turn: 0 });
    expect(abilityNames(shackled, 0)).toEqual(['shackles']);
  });
});
