import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildPosition, CARD_IDS, CARDS, eventsFor, keepValue, legalCommands } from '../../src/index.ts';
import {
  abilityNames,
  act,
  actionChoices,
  actionsLeft,
  draw,
  hotTarget,
  keepOf,
  payloads,
  pileIds,
  promptFor,
  respond,
  types,
} from '../helpers.ts';

// One section per card, in card-number order. Each section covers the card's
// edge cases; the deeper rules and clarification tests live in the other files
// in this folder (abilities, effects, triggers, interaction, duplicity).


describe('catalog', () => {
  it('has a section for every card', () => {
    const source = readFileSync(import.meta.filename, 'utf8');
    const missing = CARD_IDS.filter((id) => !source.includes(`describe('${CARDS[id].name}'`));
    expect(missing).toEqual([]);
  });
});

describe('Count Token', () => {
  it('is worth -1 coin', () => {
    expect(keepValue(keepOf('count-token'))).toBe(-2);
  });

  it('two Tokens are not enough to win', () => {
    const start = buildPosition({ keeps: { 0: ['count-token'] }, hands: { 0: ['fool-token'] }, piles: { 0: ['chalice'] }, turn: 0 });
    const { state } = act(start, 0, { action: 'play', card: 'fool-token', target: 0 });
    expect(state.phase).toBe('playing');
  });

  it('Tokens spread across different keeps never win', () => {
    const start = buildPosition({
      keeps: { 0: ['count-token'], 1: ['fool-token'] },
      hands: { 0: ['friar-token'] },
      piles: { 0: ['chalice'] },
      turn: 0,
    });
    const { state } = act(start, 0, { action: 'play', card: 'friar-token', target: 2 });
    expect(state.phase).toBe('playing');
  });

  it('wins even when the keep has very negative coins', () => {
    const start = buildPosition({
      keeps: { 0: ['blunder', 'shackles', 'fool-token', 'friar-token'], 1: ['faberge-egg'] },
      hands: { 0: ['count-token'] },
      turn: 0,
    });
    expect(act(start, 0, { action: 'play', card: 'count-token', target: 0 }).state.marks).toEqual([1, 0, 0, 0]);
  });
});

describe('Acquisition', () => {
  it('drawn as a HOT card into your own keep, it can be used on the same turn', () => {
    const start = buildPosition({
      piles: { 0: ['acquisition'], 1: ['chalice'], 3: ['dagger'] },
      hands: { 0: ['scepter'] },
      turn: 0,
    });
    const placed = hotTarget(draw(start, 0).state, 0, 0);
    expect(abilityNames(placed.state, 0)).toEqual(['acquisition']);
    const used = act(placed.state, 0, { action: 'ability', card: 'acquisition', discard: 'scepter', first: 'left' });
    expect(used.state.hands[0]).toEqual(['chalice', 'dagger']);
  });

  it('can discard your last card', () => {
    const start = buildPosition({ keeps: { 0: ['acquisition'] }, hands: { 0: ['scepter'] }, piles: { 1: ['chalice'], 3: ['dagger'] }, turn: 0 });
    const { state } = act(start, 0, { action: 'ability', card: 'acquisition', discard: 'scepter', first: 'right' });
    expect(state.hands[0]).toEqual(['dagger', 'chalice']);
  });

  it('plays a HOT card from the second draw too', () => {
    const start = buildPosition({
      keeps: { 0: ['acquisition'] },
      hands: { 0: ['scepter'] },
      piles: { 1: ['chalice'], 3: ['blunder'] },
      turn: 0,
    });
    const { state } = act(start, 0, { action: 'ability', card: 'acquisition', discard: 'scepter', first: 'left' });
    expect(state.hands[0]).toEqual(['chalice']);
    expect(state.keeps[0].map((c) => c.id)).toEqual(['acquisition', 'blunder']);
  });

  it('in a ghost-seat game, draws from the ghost piles beside you', () => {
    const start = buildPosition({
      seats: ['player', 'ghost', 'player', 'ghost'],
      keeps: { 0: ['acquisition'] },
      hands: { 0: ['scepter'] },
      piles: { 1: ['chalice'], 3: ['dagger'] },
      turn: 0,
    });
    const { state } = act(start, 0, { action: 'ability', card: 'acquisition', discard: 'scepter', first: 'left' });
    expect(state.hands[0]).toEqual(['chalice', 'dagger']);
  });

  it('stays once per turn across Hocus Pocus actions', () => {
    const start = buildPosition({
      keeps: { 0: ['acquisition'] },
      hands: { 0: ['hocus-pocus', 'scepter', 'timepiece'] },
      piles: { 1: ['chalice'], 3: ['dagger'] },
      turn: 0,
    });
    const used = act(start, 0, { action: 'ability', card: 'acquisition', discard: 'scepter', first: 'left' });
    const hocus = act(used.state, 0, { action: 'play', card: 'hocus-pocus' });
    expect(abilityNames(hocus.state, 0)).toEqual([]);
  });
});

describe('Fiat', () => {
  it('four players all claim, starting with whoever played it, even into another keep', () => {
    const start = buildPosition({
      piles: { 0: ['chalice'], 1: ['fiat', 'dagger'], 2: ['scepter'], 3: ['medallion'] },
      turn: 1,
    });
    let state = hotTarget(draw(start, 1).state, 1, 3).state;
    expect(state.keeps[3]).toEqual([{ id: 'fiat' }]);
    const order: number[] = [];
    for (const seat of [1, 2, 3, 0] as const) {
      const prompt = promptFor(state, seat, 'claim-pile');
      order.push(prompt.seat);
      state = respond(state, seat, { kind: 'claim-pile', from: prompt.options[0]! }).state;
    }
    expect(order).toEqual([1, 2, 3, 0]);
    // Each player took the lowest-numbered pile left: S1 took @S0's, S2 took @S1's,
    // S3 took @S2's, and S0 got @S3's.
    expect([0, 1, 2, 3].map((s) => pileIds(state, s as 0)[0] ?? null)).toEqual(['medallion', 'chalice', 'dagger', 'scepter']);
  });

  it('options shrink as piles are claimed', () => {
    const start = buildPosition({ piles: { 0: ['fiat', 'chalice'] }, turn: 0 });
    let state = hotTarget(draw(start, 0).state, 0, 0).state;
    expect(promptFor(state, 0, 'claim-pile').options).toEqual([0, 1, 2, 3]);
    state = respond(state, 0, { kind: 'claim-pile', from: 2 }).state;
    expect(promptFor(state, 1, 'claim-pile').options).toEqual([0, 1, 3]);
  });

  it('is worth no coins and changes no keep but its own', () => {
    expect(keepValue(keepOf('fiat'))).toBe(0);
  });
});

describe('Royal Favor', () => {
  it('is worth half a coin', () => {
    expect(keepValue(keepOf('royal-favor', 'chalice'))).toBe(5);
  });

  it('played into your own keep makes you draw', () => {
    const start = buildPosition({ piles: { 0: ['royal-favor', 'chalice'] }, turn: 0 });
    const { state } = hotTarget(draw(start, 0).state, 0, 0);
    expect(state.hands[0]).toEqual(['chalice']);
    expect(actionsLeft(state)).toBe(1);
  });

  it('a HOT card it draws is played at once', () => {
    const start = buildPosition({ piles: { 0: ['royal-favor'], 2: ['blunder'] }, turn: 0 });
    const { state } = hotTarget(draw(start, 0).state, 0, 2);
    expect(state.keeps[2].map((c) => c.id)).toEqual(['royal-favor', 'blunder']);
  });
});

describe('Requisition', () => {
  it('can take the bottom card of a pile', () => {
    const start = buildPosition({ hands: { 0: ['requisition'] }, piles: { 3: ['chalice', 'dagger', 'scepter'] }, turn: 0 });
    const looked = respond(act(start, 0, { action: 'play', card: 'requisition' }).state, 0, { kind: 'choose-pile', pile: 3 });
    const { state } = respond(looked.state, 0, { kind: 'choose-pile-card', index: 2 });
    expect(state.hands[0]).toEqual(['scepter']);
    expect(pileIds(state, 3)).toEqual(['chalice', 'dagger']);
  });

  it('can look through your own pile', () => {
    const start = buildPosition({ hands: { 0: ['requisition'] }, piles: { 0: ['chalice'], 3: ['dagger'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'requisition' });
    expect(promptFor(played.state, 0, 'choose-pile').options).toEqual([0, 3]);
  });

  it('offers only non-empty piles', () => {
    const start = buildPosition({ hands: { 0: ['requisition'] }, piles: { 2: ['chalice'] }, turn: 0 });
    expect(promptFor(act(start, 0, { action: 'play', card: 'requisition' }).state, 0, 'choose-pile').options).toEqual([2]);
  });
});

describe('Interest', () => {
  it('Tithes entering the keep counts as a Coin card (Purity 3)', () => {
    const start = buildPosition({ hands: { 0: ['tithes'] }, keeps: { 0: ['interest'] }, piles: { 0: ['chalice'] }, turn: 0 });
    expect(act(start, 0, { action: 'play', card: 'tithes', target: 0 }).state.hands[0]).toEqual(['chalice']);
  });

  it('a Blunder drawn into an Interest keep triggers another draw (Royal Favor 3)', () => {
    const start = buildPosition({ keeps: { 0: ['interest'] }, piles: { 0: ['blunder', 'chalice'] }, turn: 0 });
    const { state } = draw(start, 0);
    expect(state.hands[0]).toEqual(['chalice']);
    expect(actionsLeft(state)).toBe(1);
  });

  it('negative Coin cards (Shackles, Tokens) trigger it too', () => {
    const start = buildPosition({ hands: { 0: ['shackles'] }, keeps: { 1: ['interest'] }, piles: { 1: ['chalice'] }, turn: 0 });
    expect(act(start, 0, { action: 'play', card: 'shackles', target: 1 }).state.hands[1]).toEqual(['chalice']);
  });
});

describe('Chalice', () => {
  it('is worth 2 coins and has no other effect', () => {
    expect(keepValue(keepOf('chalice'))).toBe(4);
    expect(CARDS.chalice.text).toBe('');
  });
});

describe('Dagger', () => {
  it('is worth 2 coins', () => {
    expect(keepValue(keepOf('dagger'))).toBe(4);
  });
});

describe('Medallion', () => {
  it('is worth 2 coins, and can bring a Purity keep down (Last Laugh 2)', () => {
    expect(keepValue(keepOf('purity'))).toBe(20);
    expect(keepValue(keepOf('purity', 'medallion'))).toBe(4);
  });
});

describe('Scepter', () => {
  it('is worth 2 coins', () => {
    expect(keepValue(keepOf('scepter'))).toBe(4);
  });
});

describe('Timepiece', () => {
  it('is worth 2 coins', () => {
    expect(keepValue(keepOf('timepiece'))).toBe(4);
  });
});

describe('Fabergé Egg', () => {
  it('is worth 3 coins, the most of any single card', () => {
    expect(keepValue(keepOf('faberge-egg'))).toBe(6);
    const values = CARD_IDS.map((id) => CARDS[id].coins).filter((c): c is number => typeof c === 'number');
    expect(Math.max(...values)).toBe(6);
  });
});

describe('Fool Token', () => {
  it('is worth -1 coin, and completes the set wherever it lands', () => {
    expect(keepValue(keepOf('fool-token'))).toBe(-2);
    const start = buildPosition({ keeps: { 2: ['count-token', 'friar-token'] }, hands: { 0: ['fool-token'] }, turn: 0 });
    expect(act(start, 0, { action: 'play', card: 'fool-token', target: 2 }).state.marks).toEqual([0, 0, 1, 0]);
  });
});

describe('Juggling', () => {
  it('can swap your own pile with a ghost\'s', () => {
    const start = buildPosition({
      seats: ['player', 'ghost', 'player', 'ghost'],
      keeps: { 0: ['juggling'] },
      piles: { 0: ['chalice'], 1: ['dagger'] },
      turn: 0,
    });
    const { state } = act(start, 0, { action: 'ability', card: 'juggling', piles: [0, 1] });
    expect(pileIds(state, 0)).toEqual(['dagger']);
  });

  it('can move an empty pile to set up a round end (This Looks Familiar)', () => {
    const start = buildPosition({ keeps: { 0: ['juggling'] }, piles: { 1: ['chalice'] }, turn: 0 });
    const { state } = act(start, 0, { action: 'ability', card: 'juggling', piles: [1, 2] });
    expect(pileIds(state, 1)).toEqual([]);
    expect(pileIds(state, 2)).toEqual(['chalice']);
  });
});

describe('Pandemonium', () => {
  it('rotates ghost piles along with everyone else\'s', () => {
    const start = buildPosition({
      seats: ['player', 'ghost', 'player', 'ghost'],
      piles: { 0: ['pandemonium'], 1: ['chalice'], 2: ['dagger'], 3: ['scepter'] },
      turn: 0,
    });
    const { state } = respond(draw(start, 0).state, 0, { kind: 'choose-direction', direction: 'left' });
    expect([0, 1, 2, 3].map((s) => pileIds(state, s as 0)[0] ?? null)).toEqual(['scepter', null, 'chalice', 'dagger']);
  });

  it('resurrected or invoked, it still costs no action', () => {
    const start = buildPosition({ hands: { 0: ['resurrection'] }, discard: ['pandemonium'], turn: 0 });
    const taken = respond(act(start, 0, { action: 'play', card: 'resurrection' }).state, 0, { kind: 'choose-discard-card', card: 'pandemonium' });
    const { state } = respond(taken.state, 0, { kind: 'choose-direction', direction: 'right' });
    expect(actionsLeft(state)).toBe(1);
  });
});

describe('Blunder', () => {
  it('is worth -10 coins', () => {
    expect(keepValue(keepOf('blunder'))).toBe(-20);
  });

  it('can never be played into another keep, even when invoked by someone else', () => {
    const start = buildPosition({ piles: { 0: ['invocation'], 2: ['blunder'] }, turn: 0 });
    const { state } = respond(draw(start, 0).state, 0, { kind: 'choose-pile', pile: 2 });
    // S0 invoked it, so it goes into S0's keep with no choice offered.
    expect(state.keeps[0]).toEqual([{ id: 'blunder' }]);
    expect(state.prompts.map((p) => p.kind)).toEqual(['action']);
  });

  it('removing it from your keep brings your score back up (Blunder 1)', () => {
    const start = buildPosition({
      keeps: { 0: ['blunder', 'medallion', 'royal-favor'] },
      hands: { 0: ['hocus-pocus'] },
      turn: 0,
    });
    const hocus = act(start, 0, { action: 'play', card: 'hocus-pocus' });
    const removed = act(hocus.state, 0, { action: 'ability', card: 'blunder', pile: 2 });
    expect(keepValue(removed.state.keeps[0])).toBe(5);
    const { events } = draw(removed.state, 0);
    expect(payloads(events, 'score')[0]).toMatchObject({ winner: 0 });
  });
});

describe('Joker', () => {
  it('can copy Prayer, Resurrection, Epiphany, or any other non-Keep card in hand', () => {
    const start = buildPosition({
      hands: { 0: ['joker', 'prayer', 'resurrection', 'epiphany', 'chalice'] },
      turn: 0,
    });
    const copies = actionChoices(start, 0).flatMap((c) => (c.action === 'play' && c.card === 'joker' ? [c.copy] : []));
    expect(copies).toEqual(['prayer', 'resurrection', 'epiphany']);
  });

  it('copying Prayer uses Prayer\'s prompts, and the copied card stays in hand', () => {
    const start = buildPosition({ hands: { 0: ['joker', 'prayer'] }, piles: { 2: ['chalice'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'joker', copy: 'prayer' });
    const looked = respond(played.state, 0, { kind: 'choose-pile', pile: 2 });
    const { state } = respond(looked.state, 0, { kind: 'take-or-discard', take: true });
    expect(state.hands[0]).toEqual(['prayer', 'chalice']);
    expect(state.discard).toEqual(['joker']);
  });

  it('copying Resurrection can bring Joker itself back', () => {
    const start = buildPosition({ hands: { 0: ['joker', 'resurrection'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'joker', copy: 'resurrection' });
    const { state } = respond(played.state, 0, { kind: 'choose-discard-card', card: 'joker' });
    expect(state.hands[0]).toEqual(['resurrection', 'joker']);
  });
});

describe('Hocus Pocus', () => {
  it('as the last action of a turn, gives two more before the turn ends', () => {
    const start = buildPosition({ hands: { 0: ['hocus-pocus'] }, piles: { 0: ['chalice', 'dagger', 'scepter'] }, turn: 0 });
    let state = draw(start, 0).state;
    state = act(state, 0, { action: 'play', card: 'hocus-pocus' }).state;
    expect(state.turn?.seat).toBe(0);
    state = draw(draw(state, 0).state, 0).state;
    expect(state.turn?.seat).toBe(1);
  });

  it('during Retribution actions, extends them', () => {
    const start = buildPosition({
      hands: { 1: ['hocus-pocus'] },
      piles: { 1: ['chalice', 'dagger', 'scepter'] },
      turn: 0,
      frames: [{ seat: 1, kind: 'retribution', remaining: 2 }],
    });
    let state = act(start, 1, { action: 'play', card: 'hocus-pocus' }).state;
    for (let i = 0; i < 3; i++) state = draw(state, 1).state;
    expect(state.hands[1]).toEqual(['chalice', 'dagger', 'scepter']);
    promptFor(state, 0, 'action');
  });
});

describe('Legerdemain', () => {
  it('a stolen Keep card can be played into any keep, including the victim\'s', () => {
    const start = buildPosition({ hands: { 0: ['legerdemain'], 2: ['chalice'] }, turn: 0 });
    const stolen = respond(act(start, 0, { action: 'play', card: 'legerdemain' }).state, 0, { kind: 'choose-player', seat: 2 });
    expect(promptFor(stolen.state, 0, 'hot-target').card).toBe('chalice');
    const { state } = hotTarget(stolen.state, 0, 2);
    expect(state.keeps[2]).toEqual([{ id: 'chalice' }]);
  });

  it('the theft is public, since the card is then played face up', () => {
    const start = buildPosition({ hands: { 0: ['legerdemain'], 2: ['chalice'] }, turn: 0 });
    const stolen = respond(act(start, 0, { action: 'play', card: 'legerdemain' }).state, 0, { kind: 'choose-player', seat: 2 });
    expect(payloads(eventsFor(stolen.events, 3), 'steal')[0]!.cards).toEqual(['chalice']);
  });

  it('on an empty-handed player it does nothing', () => {
    const start = buildPosition({ hands: { 0: ['legerdemain'] }, turn: 0 });
    const { events } = respond(act(start, 0, { action: 'play', card: 'legerdemain' }).state, 0, { kind: 'choose-player', seat: 2 });
    expect(payloads(events, 'no-effect')).toHaveLength(1);
  });
});

describe('Pickpocket', () => {
  it('takes Tokens and Tithes too, since they are Coin cards', () => {
    const start = buildPosition({ hands: { 0: ['pickpocket'], 1: ['friar-token', 'tithes', 'purity'] }, turn: 0 });
    const { state } = respond(act(start, 0, { action: 'play', card: 'pickpocket' }).state, 0, { kind: 'choose-player', seat: 1 });
    expect(state.hands[0]).toEqual(['friar-token', 'tithes']);
    expect(state.hands[1]).toEqual(['purity']);
  });

  it('takes nothing from a hand with no Coin cards', () => {
    const start = buildPosition({ hands: { 0: ['pickpocket'], 1: ['purity', 'joker'] }, turn: 0 });
    const { state, events } = respond(act(start, 0, { action: 'play', card: 'pickpocket' }).state, 0, { kind: 'choose-player', seat: 1 });
    expect(payloads(events, 'no-effect')).toHaveLength(1);
    expect(state.hands[1]).toEqual(['purity', 'joker']);
  });
});

describe('Pluck', () => {
  it('can take a Keep card or a non-Keep card', () => {
    const start = buildPosition({ hands: { 0: ['pluck'], 1: ['chalice', 'prayer'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'pluck' });
    const { state } = respond(played.state, 0, { kind: 'choose-hand-card', seat: 1, card: 'prayer' });
    expect(state.hands[0]).toEqual(['prayer']);
  });

  it('does not look at your own hand', () => {
    const start = buildPosition({ hands: { 0: ['pluck', 'chalice'], 2: ['dagger'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'pluck' });
    expect(promptFor(played.state, 0, 'choose-hand-card').options).toEqual([{ seat: 2, card: 'dagger' }]);
  });
});

describe('Duplicity', () => {
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

describe('Last Laugh', () => {
  it('in the keep of a player who is behind, can still turn the round (Last Laugh 2)', () => {
    const start = buildPosition({
      keeps: { 0: ['last-laugh', 'chalice'], 1: ['purity'] },
      hands: { 0: ['medallion'] },
      piles: { 0: ['dagger'] },
      turn: 0,
    });
    let state = draw(start, 0).state;
    state = draw(state, 0).state; // empty: round ends
    const { events } = act(state, 0, { action: 'play', card: 'medallion', target: 1 });
    expect(payloads(events, 'score')[0]).toMatchObject({ scores: [4, 4, 0, 0], winner: 1 });
  });
});

describe('Shackles', () => {
  it('is worth -3 coins', () => {
    expect(keepValue(keepOf('shackles'))).toBe(-6);
  });

  it('played into another player\'s keep, limits their next turn', () => {
    const start = buildPosition({ hands: { 0: ['shackles'] }, piles: { 0: ['chalice'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'shackles', target: 1 });
    const { events } = draw(played.state, 0);
    expect(payloads(events, 'turn-start')).toEqual([{ type: 'turn-start', seat: 1, actions: 1 }]);
  });

  it('can make your own keep total zero for Purity (Purity 2)', () => {
    expect(keepValue(keepOf('purity', 'shackles', 'chalice', 'royal-favor'))).toBe(-1);
    expect(keepValue(keepOf('purity', 'shackles', 'faberge-egg'))).toBe(20);
  });
});

describe('Friar Token', () => {
  it('is worth -1 coin, and can make an otherwise-pure keep impure (Purity 1)', () => {
    expect(keepValue(keepOf('purity', 'friar-token'))).toBe(-2);
  });
});

describe('Sanction', () => {
  it('can draw from your own pile like a normal draw', () => {
    const start = buildPosition({ keeps: { 0: ['sanction'] }, piles: { 0: ['chalice'] }, turn: 0 });
    expect(act(start, 0, { action: 'ability', card: 'sanction', from: 0 }).state.hands[0]).toEqual(['chalice']);
  });

  it('a HOT card it draws is played immediately', () => {
    const start = buildPosition({ keeps: { 0: ['sanction'] }, piles: { 2: ['pandemonium'] }, turn: 0 });
    promptFor(act(start, 0, { action: 'ability', card: 'sanction', from: 2 }).state, 0, 'choose-direction');
  });
});

describe('Invocation', () => {
  it('invoking a HOT card plays it as normal', () => {
    const start = buildPosition({ piles: { 0: ['invocation'], 1: ['revelation', 'chalice'] }, turn: 0 });
    const invoked = respond(draw(start, 0).state, 0, { kind: 'choose-pile', pile: 1 });
    promptFor(invoked.state, 0, 'choose-pile');
    expect(invoked.state.discard).toEqual(['invocation', 'revelation']);
  });

  it('the invoked card is drawn privately, then revealed by being played', () => {
    const start = buildPosition({ piles: { 0: ['invocation'], 2: ['chalice'] }, turn: 0 });
    const invoked = respond(draw(start, 0).state, 0, { kind: 'choose-pile', pile: 2 });
    const placed = hotTarget(invoked.state, 0, 1);
    expect(payloads(eventsFor([...invoked.events, ...placed.events], 3), 'play').map((p) => p.card)).toEqual(['chalice']);
  });
});

describe('Revelation', () => {
  it('flipping an empty pile changes nothing', () => {
    const start = buildPosition({ piles: { 0: ['revelation'] }, turn: 0 });
    const { state } = respond(draw(start, 0).state, 0, { kind: 'choose-pile', pile: 2 });
    expect(pileIds(state, 2)).toEqual([]);
  });
});

describe('Epiphany', () => {
  it('a HOT card taken this way is played immediately', () => {
    const start = buildPosition({ hands: { 0: ['epiphany'] }, piles: { 1: ['blunder'], 2: ['chalice'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'epiphany' });
    const { state } = respond(played.state, 0, { kind: 'choose-top-card', pile: 1 });
    expect(state.keeps[0]).toEqual([{ id: 'blunder' }]);
  });

  it('has no effect when every pile is empty', () => {
    const start = buildPosition({ hands: { 0: ['epiphany'] }, turn: 0 });
    expect(payloads(act(start, 0, { action: 'play', card: 'epiphany' }).events, 'no-effect')).toHaveLength(1);
  });

  it('only you see the tops', () => {
    const start = buildPosition({ hands: { 0: ['epiphany'] }, piles: { 1: ['chalice'] }, turn: 0 });
    expect(JSON.stringify(eventsFor(act(start, 0, { action: 'play', card: 'epiphany' }).events, 1))).not.toContain('chalice');
  });
});

describe('Offering', () => {
  it('with nobody else holding cards, just discards your hand', () => {
    const start = buildPosition({ hands: { 0: ['offering', 'chalice'] }, turn: 0 });
    const { state } = act(start, 0, { action: 'play', card: 'offering' });
    expect(state.discard).toEqual(['offering', 'chalice']);
    expect(state.prompts.map((p) => p.kind)).toEqual(['action']);
  });

  it('works with an empty hand of your own', () => {
    const start = buildPosition({ hands: { 0: ['offering'], 2: ['chalice'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'offering' });
    expect(respond(played.state, 2, { kind: 'give-card', card: 'chalice' }).state.hands[0]).toEqual(['chalice']);
  });

  it('a giver can only give a card they hold', () => {
    const start = buildPosition({ hands: { 0: ['offering'], 2: ['chalice'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'offering' });
    const answers = legalCommands(played.state, 2).map((c) => c.type === 'answer' && c.answer);
    expect(answers).toEqual([{ kind: 'give-card', card: 'chalice' }]);
  });
});

describe('Prayer', () => {
  it('only offers non-empty piles', () => {
    const start = buildPosition({ hands: { 0: ['prayer'] }, piles: { 3: ['chalice'] }, turn: 0 });
    expect(promptFor(act(start, 0, { action: 'play', card: 'prayer' }).state, 0, 'choose-pile').options).toEqual([3]);
  });

  it('a HOT top card it takes is played immediately', () => {
    const start = buildPosition({ hands: { 0: ['prayer'] }, piles: { 3: ['pandemonium'] }, turn: 0 });
    const looked = respond(act(start, 0, { action: 'play', card: 'prayer' }).state, 0, { kind: 'choose-pile', pile: 3 });
    promptFor(respond(looked.state, 0, { kind: 'take-or-discard', take: true }).state, 0, 'choose-direction');
  });

  it('discarding a HOT top card does not play it', () => {
    const start = buildPosition({ hands: { 0: ['prayer'] }, piles: { 3: ['pandemonium', 'chalice'] }, turn: 0 });
    const looked = respond(act(start, 0, { action: 'play', card: 'prayer' }).state, 0, { kind: 'choose-pile', pile: 3 });
    const { state } = respond(looked.state, 0, { kind: 'take-or-discard', take: false });
    expect(state.discard).toEqual(['prayer', 'pandemonium']);
    expect(state.hands[0]).toEqual(['chalice']);
  });
});

describe('Providence', () => {
  it('can move Blunder onto a rival to put you ahead (Divine Intervention)', () => {
    const start = buildPosition({
      hands: { 0: ['providence'] },
      keeps: { 0: ['blunder', 'chalice'], 2: ['medallion', 'tithes'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const { state } = respond(played.state, 0, { kind: 'choose-keep-pair', a: { seat: 0, index: 0 }, b: { seat: 2, index: 0 } });
    expect(keepValue(state.keeps[0])).toBe(8);
    expect(keepValue(state.keeps[2])).toBeLessThan(0);
  });

  it('rejects swapping a card with itself', () => {
    const start = buildPosition({ hands: { 0: ['providence'] }, keeps: { 1: ['chalice', 'dagger'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'providence' });
    const prompt = promptFor(played.state, 0, 'choose-keep-pair');
    const result = legalCommands(played.state, 0).some(
      (c) => c.type === 'answer' && c.answer.kind === 'choose-keep-pair' && c.answer.a.index === c.answer.b.index && c.answer.a.seat === c.answer.b.seat,
    );
    expect(result).toBe(false);
    expect(prompt).toBeTruthy();
  });
});

describe('Resurrection', () => {
  it('offers every card in the discard', () => {
    const start = buildPosition({ hands: { 0: ['resurrection'] }, discard: ['chalice', 'pluck'], turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'resurrection' });
    expect(legalCommands(played.state, 0).map((c) => c.type === 'answer' && c.answer)).toEqual([
      { kind: 'choose-discard-card', card: 'chalice' },
      { kind: 'choose-discard-card', card: 'pluck' },
      { kind: 'choose-discard-card', card: 'resurrection' },
    ]);
  });

  it('a resurrected card is public', () => {
    const start = buildPosition({ hands: { 0: ['resurrection'] }, discard: ['chalice'], turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'resurrection' });
    const { events } = respond(played.state, 0, { kind: 'choose-discard-card', card: 'chalice' });
    expect(events.find((e) => e.payload.type === 'take')!.visibility).toBe('all');
  });
});

describe('Purity', () => {
  it('is worth 10 in an empty-otherwise keep and is not a Coin card for Interest', () => {
    const start = buildPosition({ hands: { 0: ['purity'] }, keeps: { 0: ['interest'] }, piles: { 0: ['chalice'] }, turn: 0 });
    const { state, events } = act(start, 0, { action: 'play', card: 'purity', target: 0 });
    expect(types(events)).not.toContain('trigger');
    expect(keepValue(state.keeps[0])).toBe(20);
  });

  it('a pure 10 beats Fabergé Egg plus Chalice', () => {
    const start = buildPosition({ keeps: { 0: ['purity'], 1: ['faberge-egg', 'chalice'] }, turn: 0 });
    expect(payloads(draw(start, 0).events, 'score')[0]).toMatchObject({ winner: 0 });
  });
});

describe('Retribution', () => {
  it('Offering makes every holder-giver retaliate', () => {
    const start = buildPosition({
      hands: { 0: ['offering'], 1: ['chalice'] },
      keeps: { 1: ['retribution'] },
      piles: { 1: ['dagger', 'scepter'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'offering' });
    const { events } = respond(played.state, 1, { kind: 'give-card', card: 'chalice' });
    expect(payloads(events, 'trigger').map((t) => `${t.kind}:${t.seat}`)).toEqual(['retribution:1']);
  });

  it('Pluck taking from its owner triggers it; just looking does not', () => {
    const start = buildPosition({ hands: { 0: ['pluck'], 1: ['chalice'], 2: ['dagger'] }, keeps: { 1: ['retribution'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'pluck' });
    expect(types(respond(played.state, 0, { kind: 'choose-hand-card', seat: 2, card: 'dagger' }).events)).not.toContain('trigger');
    expect(types(respond(played.state, 0, { kind: 'choose-hand-card', seat: 1, card: 'chalice' }).events)).toContain('trigger');
  });
});

describe('Tithes', () => {
  it('counts every card in its keep, so it grows as cards arrive', () => {
    expect(keepValue(keepOf('tithes'))).toBe(2);
    expect(keepValue(keepOf('tithes', 'interest', 'retribution', 'last-laugh'))).toBe(8);
  });

  it('in another player\'s keep, cannot be used by you', () => {
    const start = buildPosition({ keeps: { 1: ['tithes'] }, turn: 0 });
    expect(abilityNames(start, 0)).toEqual([]);
  });
});
