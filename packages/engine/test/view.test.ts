import { describe, expect, it } from 'vitest';
import { buildPosition, newGame, viewFor } from '../src/index.ts';
import { act, draw, respond } from './helpers.ts';

describe('player views', () => {
  it('R-10 everyone sees pile sizes, played Keep cards, the discard, and hand sizes', () => {
    const state = buildPosition({
      piles: { 0: ['chalice', 'dagger'], 2: ['scepter'] },
      hands: { 0: ['joker'], 1: ['medallion', 'timepiece'] },
      keeps: { 3: ['faberge-egg'] },
      discard: ['pluck'],
      turn: 0,
    });
    for (const viewer of [0, 1, 2, 3, 'spectator'] as const) {
      const view = viewFor(state, viewer);
      expect(view.piles.map((p) => p.size)).toEqual([2, 0, 1, 0]);
      expect(view.keeps[3]!.cards).toEqual([{ faceDown: false, id: 'faberge-egg' }]);
      expect(view.discard).toEqual(['pluck']);
      expect(view.hands.map((h) => h.count)).toEqual([1, 2, 0, 0]);
      expect(view.scores).toEqual([0, 0, 0, 6]);
    }
  });

  it('shows you your own hand and no one else\'s', () => {
    const state = buildPosition({ hands: { 0: ['joker'], 1: ['medallion'] }, turn: 0 });
    const view = viewFor(state, 0);
    expect(view.hands[0]).toEqual({ seat: 0, count: 1, cards: ['joker'] });
    expect(view.hands[1]).toEqual({ seat: 1, count: 1 });
    expect(JSON.stringify(view)).not.toContain('medallion');
    expect(JSON.stringify(viewFor(state, 'spectator'))).not.toMatch(/joker|medallion/);
  });

  it('never shows pile contents or identities, except a face-up top card', () => {
    const state = buildPosition({ piles: { 1: [{ id: 'blunder', faceUp: true }, 'chalice'], 2: ['dagger'] }, turn: 0 });
    const json = JSON.stringify(viewFor(state, 0));
    expect(viewFor(state, 0).piles[1]).toEqual({ position: 1, size: 2, top: 'blunder' });
    expect(json).not.toMatch(/chalice|dagger/);
    expect(json).not.toMatch(/:"(count|fool|friar|mask)"/);
    expect(json).not.toContain('"rng"');
  });

  it('Q-04 shows a face-down card only to the player who placed it', () => {
    const state = buildPosition({
      keeps: { 2: ['duplicity'], 1: [{ id: 'chalice', faceDown: { placedBy: 0 } }] },
      turn: 0,
    });
    expect(viewFor(state, 0).keeps[1]!.cards).toEqual([{ faceDown: true, id: 'chalice' }]);
    expect(viewFor(state, 2).keeps[1]!.cards).toEqual([{ faceDown: true }]);
    expect(viewFor(state, 1).keeps[1]!.cards).toEqual([{ faceDown: true }]);
    expect(viewFor(state, 2).duplicityHolder).toBe(2);
  });

  it('shows your own prompt in full, and only the kind of anyone else\'s', () => {
    const start = buildPosition({ hands: { 0: ['requisition'] }, piles: { 2: ['chalice', 'dagger'] }, turn: 0 });
    const looking = respond(act(start, 0, { action: 'play', card: 'requisition' }).state, 0, { kind: 'choose-pile', pile: 2 }).state;
    const mine = viewFor(looking, 0).prompts[0]!;
    expect(mine).toMatchObject({ mine: true, kind: 'choose-pile-card', cards: ['chalice', 'dagger'] });
    const theirs = viewFor(looking, 1).prompts[0]!;
    expect(theirs).toEqual({ mine: false, id: mine.id, seat: 0, kind: 'choose-pile-card' });
    expect(JSON.stringify(viewFor(looking, 1))).not.toMatch(/chalice|dagger/);
  });

  it('lists the commands you may send, and none for spectators', () => {
    const { state } = newGame({ players: 2, seed: 'view', firstSeat: 0 });
    expect(viewFor(state, 0).legal).toHaveLength(1);
    expect(viewFor(state, 2).frame).toEqual({ seat: 0, kind: 'turn', remaining: 2 });
    expect(viewFor(state, 2).legal).toEqual([]);
    expect(viewFor(state, 'spectator').legal).toEqual([]);
    const after = draw(state, 0).state;
    expect(viewFor(after, 0).legal.length).toBeGreaterThan(0);
  });
});
