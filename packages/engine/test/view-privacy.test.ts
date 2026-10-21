import { describe, expect, it } from 'vitest';
import { buildPosition, eventsFor, viewFor, type CardId, type GameState, type Seat, type TraceEvent } from '../src/index.ts';
import { act, draw, respond, type Step } from './helpers.ts';

// Every prompt that carries hidden cards, checked from every other seat and
// from a spectator: neither the view nor the log may mention those cards.

function hiddenFrom(state: GameState, events: TraceEvent[], cards: CardId[], viewers: (Seat | 'spectator')[]) {
  for (const viewer of viewers) {
    const view = JSON.stringify(viewFor(state, viewer));
    const log = JSON.stringify(eventsFor(events, viewer));
    for (const card of cards) {
      expect(view, `view of ${viewer} mentions ${card}`).not.toContain(`"${card}"`);
      expect(log, `log of ${viewer} mentions ${card}`).not.toContain(`"${card}"`);
    }
  }
}

const others = (seat: Seat): (Seat | 'spectator')[] => [...([0, 1, 2, 3] as Seat[]).filter((s) => s !== seat), 'spectator'];
const eventsOf = (...steps: Step[]) => steps.flatMap((s) => s.events);

describe('private prompts', () => {
  it('Requisition: the pile you look through', () => {
    const start = buildPosition({ hands: { 0: ['requisition'] }, piles: { 2: ['chalice', 'dagger', 'scepter'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'requisition' });
    const looking = respond(played.state, 0, { kind: 'choose-pile', pile: 2 });
    hiddenFrom(looking.state, eventsOf(played, looking), ['chalice', 'dagger', 'scepter'], others(0));
    const taken = respond(looking.state, 0, { kind: 'choose-pile-card', index: 1 });
    hiddenFrom(taken.state, eventsOf(played, looking, taken), ['chalice', 'dagger', 'scepter'], others(0));
  });

  it('Epiphany: the top cards you look at, and the one you take', () => {
    const start = buildPosition({ hands: { 0: ['epiphany'] }, piles: { 1: ['chalice'], 3: ['dagger'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'epiphany' });
    hiddenFrom(played.state, played.events, ['chalice', 'dagger'], others(0));
    const taken = respond(played.state, 0, { kind: 'choose-top-card', pile: 3 });
    hiddenFrom(taken.state, eventsOf(played, taken), ['chalice', 'dagger'], others(0));
  });

  it('Prayer: the top card, whether taken (hidden) or discarded (then public)', () => {
    const start = buildPosition({ hands: { 0: ['prayer'] }, piles: { 2: ['chalice', 'dagger'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'prayer' });
    const looking = respond(played.state, 0, { kind: 'choose-pile', pile: 2 });
    hiddenFrom(looking.state, eventsOf(played, looking), ['chalice'], others(0));
    const taken = respond(looking.state, 0, { kind: 'take-or-discard', take: true });
    hiddenFrom(taken.state, eventsOf(played, looking, taken), ['chalice'], others(0));
    // Discarded instead: the discard is public, but the follow-up draw stays private.
    const discarded = respond(looking.state, 0, { kind: 'take-or-discard', take: false });
    expect(JSON.stringify(viewFor(discarded.state, 1).discard)).toContain('chalice');
    hiddenFrom(discarded.state, eventsOf(played, looking, discarded), ['dagger'], others(0));
  });

  it('Tithes: your pile as you reorder it', () => {
    const start = buildPosition({ keeps: { 0: ['tithes'] }, piles: { 0: ['chalice', 'dagger'] }, turn: 0 });
    const used = act(start, 0, { action: 'ability', card: 'tithes' });
    hiddenFrom(used.state, used.events, ['chalice', 'dagger'], others(0));
    const ordered = respond(used.state, 0, { kind: 'order-pile', order: ['dagger', 'chalice'] });
    hiddenFrom(ordered.state, eventsOf(used, ordered), ['chalice', 'dagger'], others(0));
  });

  it('Pluck: the revealed hands are seen only by the plucker, and the taken card by the two involved', () => {
    const start = buildPosition({ hands: { 0: ['pluck'], 2: ['chalice'], 3: ['dagger'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'pluck' });
    // S2 must not see S3's hand, and vice versa; S1 and spectators see neither.
    hiddenFrom(played.state, played.events, ['dagger'], [1, 2, 'spectator']);
    hiddenFrom(played.state, played.events, ['chalice'], [1, 3, 'spectator']);
    const taken = respond(played.state, 0, { kind: 'choose-hand-card', seat: 3, card: 'dagger' });
    hiddenFrom(taken.state, eventsOf(played, taken), ['dagger'], [1, 2, 'spectator']);
  });

  it('Offering: each gift is seen only by its giver and the receiver', () => {
    const start = buildPosition({ hands: { 0: ['offering'], 1: ['chalice'], 2: ['dagger'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'offering' });
    const one = respond(played.state, 1, { kind: 'give-card', card: 'chalice' });
    const two = respond(one.state, 2, { kind: 'give-card', card: 'dagger' });
    hiddenFrom(two.state, eventsOf(played, one, two), ['chalice'], [2, 3, 'spectator']);
    hiddenFrom(two.state, eventsOf(played, one, two), ['dagger'], [1, 3, 'spectator']);
  });

  it('Pickpocket: the Coin cards taken are seen only by the two involved', () => {
    const start = buildPosition({ hands: { 0: ['pickpocket'], 2: ['chalice', 'count-token'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'pickpocket' });
    const taken = respond(played.state, 0, { kind: 'choose-player', seat: 2 });
    hiddenFrom(taken.state, eventsOf(played, taken), ['chalice', 'count-token'], [1, 3, 'spectator']);
  });

  it('Duplicity: the cards you could hide, and the one you hid', () => {
    const start = buildPosition({ hands: { 0: ['duplicity', 'chalice', 'dagger'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'duplicity', target: 0 });
    hiddenFrom(played.state, played.events, ['chalice', 'dagger'], others(0));
    const hidden = respond(played.state, 0, { kind: 'duplicity-hide', card: 'chalice', target: 2 });
    hiddenFrom(hidden.state, eventsOf(played, hidden), ['chalice', 'dagger'], others(0));
  });

  it('Joker played as HOT: the cards it could copy (your hand)', () => {
    const start = buildPosition({ hands: { 0: ['legerdemain', 'prayer', 'epiphany'], 1: ['joker'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'legerdemain' });
    const stolen = respond(played.state, 0, { kind: 'choose-player', seat: 1 });
    // The stolen Joker is public (it will be played), the cards it could copy are not.
    hiddenFrom(stolen.state, eventsOf(played, stolen), ['prayer', 'epiphany'], others(0));
  });

  it('a drawn HOT card waiting for its keep is hidden until it is played', () => {
    const start = buildPosition({ piles: { 0: ['juggling'] }, turn: 0 });
    const drawn = draw(start, 0);
    hiddenFrom(drawn.state, drawn.events, ['juggling'], others(0));
    const placed = respond(drawn.state, 0, { kind: 'hot-target', target: 1 });
    expect(JSON.stringify(viewFor(placed.state, 2))).toContain('"juggling"');
  });

  it('Acquisition: both draws stay private, the discard is public', () => {
    const start = buildPosition({ keeps: { 0: ['acquisition'] }, hands: { 0: ['scepter'] }, piles: { 1: ['chalice'], 3: ['dagger'] }, turn: 0 });
    const used = act(start, 0, { action: 'ability', card: 'acquisition', discard: 'scepter', first: 'left' });
    hiddenFrom(used.state, used.events, ['chalice', 'dagger'], others(0));
    expect(viewFor(used.state, 2).discard).toEqual(['scepter']);
  });
});
