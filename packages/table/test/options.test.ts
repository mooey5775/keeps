import { apply, buildPosition, PUZZLES, puzzleState, viewFor, YOU, type PlayerView } from '@keeps/engine';
import { describe, expect, it } from 'vitest';
import { humanize, logLines } from '../src/log.ts';
import { click, clickable, describeOptions, GROUP_ABOVE, makeNames, narrow, panelItems, shownCards, type Ref } from '../src/options.ts';
import { SCENARIOS, scenarioState } from '../src/scenarios.ts';

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

  it('plays a card on its own at a click though Joker could copy it: copying starts at Joker', () => {
    const view = viewFor(buildPosition({ hands: { 0: ['hocus-pocus', 'joker'] }, turn: 0 }), 0);
    expect(clicks(view, ['hand:hocus-pocus'])).toBe('Play Hocus Pocus');
    expect(clicks(view, ['hand:joker', 'hand:hocus-pocus'])).toBe('Play Joker as Hocus Pocus');
  });

  it('draws at a click on your pile though Sanction could draw from it too: Sanction starts at Sanction', () => {
    const view = viewFor(buildPosition({ keeps: { 0: ['sanction'] }, piles: { 0: ['chalice'], 1: ['dagger'] }, turn: 0 }), 0);
    expect(clicks(view, ['pile:0'])).toBe('Draw from your pile');
    expect(clicks(view, ['keepcard:0:0', 'pile:0'])).toBe('Sanction: draw from your pile (1 card)');
    expect(clicks(view, ['keepcard:0:0', 'pile:1'])).toBe("Sanction: draw from Bo's pile (1 card)");
  });

  it('uses abilities from the keep: Juggling picks two piles', () => {
    const view = viewFor(buildPosition({ keeps: { 0: ['juggling'] }, piles: { 1: ['chalice'] }, turn: 0 }), 0);
    expect(clicks(view, ['keepcard:0:0', 'pile:1', 'pile:3'])).toBe("Juggling: swap Bo's pile (1 card) with Di's pile (0 cards)");
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

describe('drags', () => {
  /** The moves made by carrying `from` to `to`, by label. */
  const carrying = (view: PlayerView, from: Ref, to: string) =>
    optionsOf(view)
      .filter((o) => o.drags?.some((d) => d.from === from && d.to === to))
      .map((o) => o.label);

  it('carry what moves: a card from your hand to where it is played, your pile to your hand', () => {
    const view = viewFor(buildPosition({ hands: { 0: ['dagger', 'hocus-pocus'] }, piles: { 0: ['chalice'] }, turn: 0 }), 0);
    expect(carrying(view, 'hand:dagger', 'keep:2')).toEqual(["Play Dagger into Cy's keep"]);
    expect(carrying(view, 'hand:hocus-pocus', 'table')).toEqual(['Play Hocus Pocus']);
    expect(carrying(view, 'pile:0', 'hand')).toEqual(['Draw from your pile']);
  });

  it('carry piles for Sanction and Juggling, and a card leaving the keep for Blunder; never the card used where it lies', () => {
    const view = viewFor(
      buildPosition({ keeps: { 0: ['sanction', 'juggling'] }, piles: { 0: ['medallion'], 1: ['chalice'], 3: ['dagger'] }, turn: 0 }),
      0,
    );
    expect(carrying(view, 'pile:1', 'hand')).toEqual(["Sanction: draw from Bo's pile (1 card)"]);
    // Your own pile to your hand is only the plain draw (not Sanction's draw from it).
    expect(carrying(view, 'pile:0', 'hand')).toEqual(['Draw from your pile']);
    expect(carrying(view, 'pile:1', 'pile:3')).toEqual(["Juggling: swap Bo's pile (1 card) with Di's pile (1 card)"]);
    expect(carrying(view, 'pile:3', 'pile:1')).toEqual(["Juggling: swap Bo's pile (1 card) with Di's pile (1 card)"]);
    // The cards used where they lie aren't carried.
    expect(optionsOf(view).flatMap((o) => o.drags ?? []).filter((d) => d.from.startsWith('keepcard:'))).toEqual([]);
    const blunder = viewFor(buildPosition({ keeps: { 0: ['blunder'] }, turn: 0 }), 0);
    expect(carrying(blunder, 'keepcard:0:0', 'pile:2')).toEqual(['Blunder (2 actions): put it face up on Cy\'s pile']);
  });

  it('every carry is a move the table can also make by touching: its ends are among the move\'s elements', () => {
    for (const puzzle of PUZZLES) {
      const view = viewFor(puzzleState(puzzle), YOU);
      for (const o of optionsOf(view)) {
        for (const d of o.drags ?? []) {
          expect(o.refs).toContain(d.from);
          if (d.to !== 'table' && d.to !== 'hand') expect(o.refs).toContain(d.to);
        }
      }
    }
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
      "Pass every pile left (on, in play order): you get Di's pile (3 cards), yours goes to Bo",
      "Pass every pile right (back): you get Bo's pile (2 cards), yours goes to Di",
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
    expect(humanize('S3 plays Dagger → keep(S2)', logNames)).toBe("Di plays Dagger → the ghost's keep");
  });

  it('names two ghosts by where they sit on the table, as the seats are labelled', () => {
    // Seat 0 at the bottom: seat 1 is drawn on the left, seat 3 on the right.
    const fromSeat0 = makeNames(['Ada', null, 'Cy', null], 'spectator', 0);
    expect(humanize('S0 draws Chalice from pile@S1', fromSeat0)).toBe("Ada draws Chalice from left ghost's pile");
    expect(humanize('the remaining pile from @S0 goes to S3', fromSeat0)).toBe("The remaining pile from Ada's spot goes to right ghost");
    // Seat 2 at the bottom: the same ghosts swap sides.
    const fromSeat2 = makeNames(['Ada', null, 'Cy', null], 2);
    expect(fromSeat2.seat(1)).toBe('right ghost');
    expect(fromSeat2.possessive(3)).toBe("left ghost's");
    expect(fromSeat2.seat(2)).toBe('you');
  });
});

const scenario = (name: string) => viewFor(scenarioState(SCENARIOS.find((s) => s.name === name)!), 0);

describe('sandbox scenarios', () => {
  it('each reaches a decision for Ann, with every option labelled', () => {
    for (const s of SCENARIOS) {
      const view = viewFor(scenarioState(s), 0);
      expect(view.legal.length, s.name).toBeGreaterThan(0);
      for (const o of optionsOf(view)) expect(o.label, s.name).not.toMatch(/undefined|null|NaN/);
    }
  });
});

describe('the side panel folds many options into groups', () => {
  it('a busy turn shows one button per card and ability, and choosing one is like clicking it', () => {
    const view = scenario('turn');
    const options = optionsOf(view);
    expect(options.length).toBeGreaterThan(30);
    const items = panelItems(options, []);
    const labels = items.map((i) => (i.kind === 'group' ? i.label : i.option.label));
    expect(labels).toEqual([
      'Draw from your pile',
      'Play Dagger…',
      'Play Chalice…',
      'Play Medallion…',
      'Play Fool Token…',
      'Juggling: swap two piles…',
      'Sanction: draw from any pile…',
      'Acquisition: discard a card, draw two…',
      'Blunder (2 actions): put it on a pile…',
    ]);
    // "Play Dagger…" picks the Dagger, exactly as clicking it in the hand does.
    const dagger = items.find((i) => i.kind === 'group' && i.label === 'Play Dagger…');
    expect(dagger).toMatchObject({ kind: 'group', ref: 'hand:dagger', count: 4 });
    // The Dagger's four keeps, plus discarding it to Acquisition: few enough to list as they are.
    const daggerItems = panelItems(narrow(options, ['hand:dagger']), ['hand:dagger']);
    expect(daggerItems.map((i) => (i.kind === 'option' ? i.option.label : i.label))).toEqual([
      'Play Dagger into your keep',
      "Play Dagger into Bo's keep",
      "Play Dagger into Cy's keep",
      "Play Dagger into Di's keep",
      "Acquisition: discard Dagger, draw from Bo's pile first, then Di's pile",
      "Acquisition: discard Dagger, draw from Di's pile first, then Bo's pile",
    ]);
  });

  it('a few options stay as they are', () => {
    const view = viewFor(buildPosition({ hands: { 0: ['dagger'] }, turn: 0 }), 0);
    const options = optionsOf(view);
    expect(options.length).toBeLessThanOrEqual(GROUP_ABOVE);
    expect(panelItems(options, []).every((i) => i.kind === 'option')).toBe(true);
  });

  it('Acquisition: one button opens it; each choice names the pile drawn from first', () => {
    const options = optionsOf(scenario('acquisition'));
    const top = panelItems(options, []);
    expect(top.find((i) => i.kind === 'group' && i.ref === 'keepcard:0:0')).toMatchObject({ label: 'Acquisition: discard a card, draw two…', count: 6 });
    const picked: Ref[] = ['keepcard:0:0'];
    const step = panelItems(narrow(options, picked), picked).map((i) => (i.kind === 'group' ? i.label : i.option.label));
    // Bo sits on Ann's left, Di on her right.
    expect(step.slice(0, 2)).toEqual([
      "Acquisition: discard Dagger, draw from Bo's pile first, then Di's pile",
      "Acquisition: discard Dagger, draw from Di's pile first, then Bo's pile",
    ]);
    expect(step).toHaveLength(6);
  });
});

describe('Providence', () => {
  it('lights up every played card, and either card of a swap can be clicked first', () => {
    const view = scenario('providence');
    const options = optionsOf(view);
    const cards = new Set(options.flatMap((o) => o.refs));
    expect(clickable(options, [])).toEqual(cards);
    expect(clicks(view, ['keepcard:2:2', 'keepcard:0:0'])).toBe("Swap Scepter (your keep) with Royal Favor (Cy's keep)");
    expect(clicks(view, ['keepcard:0:0', 'keepcard:2:2'])).toBe("Swap Scepter (your keep) with Royal Favor (Cy's keep)");
  });

  it('folds the pairs by card instead of listing every pair', () => {
    const options = optionsOf(scenario('providence'));
    expect(options.length).toBeGreaterThan(30);
    const items = panelItems(options, []);
    expect(items.length).toBeLessThan(10);
    expect(items[0]).toMatchObject({ kind: 'group', label: 'Swap Scepter (your keep) with…' });
  });
});

describe('cards shown for a decision', () => {
  it('Requisition shows the pile, and clicking a card takes it', () => {
    const view = scenario('requisition');
    const shown = shownCards(view, names)!;
    expect(shown.title).toBe("Bo's pile, top first: take any card");
    expect(shown.cards.map((c) => c.card)).toEqual(['dagger', 'royal-favor', 'timepiece', 'interest', 'count-token', 'faberge-egg', 'medallion']);
    expect(clicks(view, [shown.cards[2]!.ref!])).toBe('Take Timepiece (card 3 from the top)');
  });

  it('Pluck shows the revealed hands with their owners', () => {
    const view = scenario('pluck');
    const shown = shownCards(view, names)!;
    expect(shown.cards.map((c) => `${c.caption}: ${c.card}`)).toEqual(['Bo: timepiece', 'Bo: providence', 'Cy: retribution', 'Cy: chalice']);
    expect(clicks(view, [shown.cards[3]!.ref!])).toBe("Take Chalice from Cy's hand");
  });

  it('Epiphany shows the top cards; a card or its pile chooses it', () => {
    const view = scenario('epiphany');
    const shown = shownCards(view, names)!;
    const blunder = shown.cards.find((c) => c.card === 'blunder')!;
    expect(blunder.ref).toBe('pile:1');
    expect(clicks(view, ['pile:1'])).toMatch(/^Take Blunder from Bo's pile/);
  });

  it('Resurrection shows the discard, newest first; Prayer shows the card it looks at', () => {
    expect(shownCards(scenario('resurrection'), names)!.cards[0]!.card).toBe('resurrection');
    const prayer = shownCards(scenario('prayer'), names)!;
    expect(prayer.cards).toEqual([{ card: 'dagger', ref: null }]);
  });

  it('a plain turn shows nothing extra', () => {
    expect(shownCards(scenario('turn'), names)).toBeNull();
  });
});

describe('labels', () => {
  it('Legerdemain says how many cards each player holds', () => {
    expect(optionsOf(scenario('legerdemain')).map((o) => o.label)).toEqual([
      'Choose you (0 cards in hand)',
      'Choose Bo (2 cards in hand)',
      'Choose Cy (1 card in hand)',
      'Choose Di (3 cards in hand)',
    ]);
  });
});

describe('log indentation', () => {
  it('stops indenting after a few levels, so long chains of effects stay readable', () => {
    const event = (seq: number, depth: number, type: string) => ({ seq, depth, payload: { type, seat: 0 } }) as never;
    const lines = logLines([event(1, 0, 'turn-start'), ...[1, 2, 3, 4, 5, 6].map((d) => event(d + 1, d, 'draw'))], names);
    expect(lines.map((l) => l.depth)).toEqual([0, 0, 1, 2, 3, 3, 3]);
  });
});
