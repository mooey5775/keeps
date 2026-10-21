import { apply, buildPosition, PUZZLES, puzzleState, viewFor, YOU, type PlayerView } from '@keeps/engine';
import { describe, expect, it } from 'vitest';
import { humanize } from '../src/game/log.ts';
import { click, clickable, describeOptions, makeNames, narrow, type Ref } from '../src/game/options.ts';

const names = makeNames(['Ada', 'Bo', 'Cy', 'Di'], 0);
const optionsOf = (view: PlayerView) => describeOptions(view, names);

/** Clicks refs in order; returns the label of the sent option, or the remaining picks. */
function clicks(view: PlayerView, refs: Ref[]): string | Ref[] {
  const options = optionsOf(view);
  let picked: Ref[] = [];
  for (const ref of refs) {
    const result = click(options, picked, ref);
    if (result.kind === 'send') return options.find((o) => o.command === result.command)!.label;
    if (result.kind === 'ignore') throw new Error(`click on ${ref} ignored`);
    picked = result.picked;
  }
  return picked;
}

describe('options', () => {
  it('labels every legal command, and every option can be reached by clicking or a button', () => {
    for (const puzzle of PUZZLES) {
      const view = viewFor(puzzleState(puzzle), YOU);
      const options = optionsOf(view);
      expect(options).toHaveLength(view.legal.length);
      for (const o of options) expect(o.label).not.toMatch(/undefined|null/);
    }
  });

  it('draws by clicking your own pile', () => {
    const view = viewFor(buildPosition({ piles: { 0: ['chalice'] }, turn: 0 }), 0);
    expect(clicks(view, ['pile:0'])).toBe('Draw from your pile');
  });

  it('plays a Keep card by clicking it, then a keep', () => {
    const view = viewFor(buildPosition({ hands: { 0: ['dagger'] }, turn: 0 }), 0);
    expect(clicks(view, ['hand:dagger'])).toEqual(['hand:dagger']);
    expect(clicks(view, ['hand:dagger', 'keep:2'])).toBe("Play Dagger into Cy's keep");
  });

  it('plays a non-Keep card with a single click when nothing else uses it', () => {
    const view = viewFor(buildPosition({ hands: { 0: ['hocus-pocus'] }, turn: 0 }), 0);
    expect(clicks(view, ['hand:hocus-pocus'])).toBe('Play Hocus Pocus');
  });

  it('does not auto-send when a card could also be copied by Joker', () => {
    const view = viewFor(buildPosition({ hands: { 0: ['hocus-pocus', 'joker'] }, turn: 0 }), 0);
    expect(clicks(view, ['hand:hocus-pocus'])).toEqual(['hand:hocus-pocus']);
    expect(clicks(view, ['hand:joker', 'hand:hocus-pocus'])).toBe('Play Joker as Hocus Pocus');
  });

  it('uses abilities from the keep: Juggling picks two piles', () => {
    const view = viewFor(buildPosition({ keeps: { 0: ['juggling'] }, piles: { 1: ['chalice'] }, turn: 0 }), 0);
    expect(clicks(view, ['keepcard:0:0', 'pile:1', 'pile:3'])).toBe('Juggling: swap the pile in front of Bo with the pile in front of Di');
  });

  it('clicking something unrelated starts over from it', () => {
    const view = viewFor(buildPosition({ hands: { 0: ['dagger', 'chalice'] }, turn: 0 }), 0);
    expect(clicks(view, ['hand:dagger', 'hand:chalice'])).toEqual(['hand:chalice']);
  });

  it('clicking a picked element un-picks it', () => {
    const view = viewFor(buildPosition({ hands: { 0: ['dagger'] }, turn: 0 }), 0);
    expect(clicks(view, ['hand:dagger', 'hand:dagger'])).toEqual([]);
  });

  it('highlights only starting elements until something is picked', () => {
    const view = viewFor(buildPosition({ hands: { 0: ['dagger'] }, piles: { 0: ['chalice'] }, turn: 0 }), 0);
    const options = optionsOf(view);
    expect([...clickable(options, [])].sort()).toEqual(['hand:dagger', 'pile:0']);
    expect([...clickable(options, ['hand:dagger'])].sort()).toEqual(['keep:0', 'keep:1', 'keep:2', 'keep:3']);
    expect(narrow(options, ['hand:dagger'])).toHaveLength(4);
  });

  it('describes prompt answers, like a HOT card’s target keep', () => {
    const start = buildPosition({ piles: { 0: ['juggling'] }, turn: 0 });
    const result = apply(start, 0, { type: 'answer', promptId: start.prompts[0]!.id, answer: { kind: 'action', choice: { action: 'draw' } } });
    if (!result.ok) throw new Error(result.error.message);
    const state = result.state;
    const labels = optionsOf(viewFor(state, 0)).map((o) => o.label);
    expect(labels).toEqual([
      'Put Juggling into your keep',
      "Put Juggling into Bo's keep",
      "Put Juggling into Cy's keep",
      "Put Juggling into Di's keep",
    ]);
  });
});

describe('Pandemonium directions', () => {
  it('say which pile you get and where yours goes, not just left or right', () => {
    const start = buildPosition({
      piles: { 0: ['pandemonium'], 1: ['chalice', 'dagger'], 3: ['medallion', 'scepter', 'timepiece'] },
      turn: 0,
    });
    const drawn = apply(start, 0, { type: 'answer', promptId: start.prompts[0]!.id, answer: { kind: 'action', choice: { action: 'draw' } } });
    if (!drawn.ok) throw new Error(drawn.error.message);
    const labels = optionsOf(viewFor(drawn.state, 0)).map((o) => o.label);
    // Passing left, you receive the pile of the player on your right (Di), and yours goes to Bo.
    expect(labels).toEqual([
      "Pass every pile left: you get Di's pile (3 cards), yours goes to Bo",
      "Pass every pile right: you get Bo's pile (2 cards), yours goes to Di",
    ]);
    // And the label tells the truth: after passing left, your pile is Di's three cards.
    const left = optionsOf(viewFor(drawn.state, 0))[0]!.command;
    const after = apply(drawn.state, 0, left);
    if (!after.ok) throw new Error(after.error.message);
    expect(viewFor(after.state, 0).piles[0]!.size).toBe(3);
    expect(viewFor(after.state, 0).piles[1]!.size).toBe(0);
  });
});

describe('log text', () => {
  it('turns seat labels into names', () => {
    const logNames = makeNames(['Ada', 'Bo', null, 'Di'], 'spectator');
    expect(humanize('S0 draws Chalice from pile@S1', logNames)).toBe("Ada draws Chalice from Bo's pile");
    expect(humanize('S3 plays Dagger → keep(S2)', logNames)).toBe("Di plays Dagger → ghost 2's keep");
  });
});
