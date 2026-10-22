import { describe, expect, it } from 'vitest';
import {
  apply,
  CARD_IDS,
  CARDS,
  eventsFor,
  isCoinCard,
  legalCommands,
  newGame,
  pick,
  PILE_IDS,
  playerSeats,
  seedRng,
  viewFor,
  type CardId,
  type Command,
  type GameState,
  type PileId,
  type Seat,
  type TraceEvent,
  type Viewer,
} from '../../src/index.ts';

// No leaks: nothing a player is shown may depend on what is hidden from them.
// A leak wouldn't crash anything; a bot trained on the views would just quietly
// learn to cheat, and look great doing it.
//
// The view and log tests check that hidden card *names* never appear. This checks
// the *shape* too: which events happen, which decisions open, and the numbering
// of events and prompt ids. From random games, at many points, for every player
// and a spectator:
// - Cards: swap two cards the viewer can't see, everywhere in the state. The view
//   must not change at all. ("Can't see" means: named nowhere in their current
//   view or in anything they've been shown this round, so it includes what they
//   remember, like a pile they looked through or a card they saw being played.) Then take one more step from both (the same command,
//   renamed if it names a swapped card): unless the step shows the viewer one of
//   the two, the events they're shown and their new view must be identical too.
// - Pile identities: which pile is the Count, Fool, Friar or Mask is hidden from
//   everyone, so relabeling two piles' identities must change no view.
// Swaps only produce states a real game could reach: only cards at rest (in a
// hand, a pile or face down, not part of anything still resolving), a HOT card never sits in a
// hand, and only a Keep card can lie face down in a keep. And the two cards share
// what the rules make public without naming the card: whether it's HOT (a drawn
// HOT card must be played at once, so everyone sees one was drawn) and whether
// it's a Coin card (Pickpocket shows everyone how many Coin cards a hand held),
// and whether it's a Keep card (Duplicity shows whether its player had another).

const CARD_SET = new Set<string>(CARD_IDS);
// Fields whose value can equal a card id without naming a card: trigger and frame
// kinds ('retribution', 'interest', 'royal-favor') and pile-choice purposes
// ('requisition', 'prayer', 'revelation', 'invocation').
const LABEL_KEYS = new Set(['kind', 'purpose', 'reason', 'op', 'type']);

/** Card ids named anywhere in a value (ignoring label fields). */
function cardsIn(value: unknown): Set<CardId> {
  const found = new Set<CardId>();
  JSON.stringify(value, (key, v: unknown) => {
    if (typeof v === 'string' && CARD_SET.has(v) && !LABEL_KEYS.has(key)) found.add(v as CardId);
    return v;
  });
  return found;
}

/** Swaps two cards' names everywhere in a value (ignoring label fields). */
function swapCards<T>(value: T, a: CardId, b: CardId): T {
  return JSON.parse(JSON.stringify(value), (key, v: unknown) =>
    typeof v === 'string' && !LABEL_KEYS.has(key) ? (v === a ? b : v === b ? a : v) : v,
  ) as T;
}

type Place = 'hand' | 'face-down' | 'pile' | 'elsewhere';

// Open decisions whose kind alone tells everyone which card is being played (it
// stays in its player's hand until the decision is made).
const CARD_OF_PROMPT: Partial<Record<string, CardId>> = { 'joker-copy': 'joker', 'duplicity-hide': 'duplicity' };
const impliedByPrompts = (state: GameState) => state.prompts.flatMap((p) => CARD_OF_PROMPT[p.kind] ?? []);

/** Where a card is, as far as what may sit there is concerned. */
function placeOf(state: GameState, card: CardId): Place {
  // A card the pending machinery names (a play in progress, an open decision) isn't at rest.
  if (cardsIn([state.stack, state.prompts, state.openPlays, state.limbo]).has(card) || impliedByPrompts(state).includes(card)) return 'elsewhere';
  if (state.hands.some((h) => h.includes(card))) return 'hand';
  if (state.keeps.some((k) => k.some((c) => c.id === card && c.faceDown))) return 'face-down';
  if (PILE_IDS.some((p) => state.piles[p].cards.some((c) => c.id === card))) return 'pile';
  return 'elsewhere';
}

/** Cards the rules let a viewer tell apart without seeing them. */
const alike = (a: CardId, b: CardId) => CARDS[a].hot === CARDS[b].hot && CARDS[a].keep === CARDS[b].keep && isCoinCard(a) === isCoinCard(b);

/** Could `card` sit at `place` in a real game? */
const fits = (card: CardId, place: Place) =>
  place === 'hand' ? !CARDS[card].hot : place === 'face-down' ? CARDS[card].keep : place === 'pile';

/** Swaps which physical pile carries identity `p` and which carries `q`. */
function swapPileIds(state: GameState, p: PileId, q: PileId): GameState {
  const swap = (id: PileId): PileId => (id === p ? q : id === q ? p : id);
  const next = structuredClone(state);
  next.pileAt = state.pileAt.map(swap) as GameState['pileAt'];
  for (const id of PILE_IDS) next.piles[swap(id)] = { ...structuredClone(state.piles[id]), id: swap(id) };
  return next;
}

const viewers = (state: GameState): Viewer[] => [...playerSeats(state), 'spectator'];
const shown = (events: readonly TraceEvent[], viewer: Viewer) => eventsFor(events, viewer);

function randomStep(state: GameState, rng: ReturnType<typeof seedRng>): { seat: Seat; command: Command } | null {
  const options = playerSeats(state).flatMap((seat) => legalCommands(state, seat).map((command) => ({ seat, command })));
  return options.length === 0 ? null : (pick(rng, options) as { seat: Seat; command: Command });
}

describe('nothing a player is shown depends on what is hidden from them', () => {
  it('R-10 swapping two cards a viewer cannot see changes nothing they are shown, now or on the next step', () => {
    let checks = 0;
    let steps = 0;
    for (let g = 0; g < 150; g++) {
      const rng = seedRng(`leak-${g}`);
      // Mostly two-player games (the bot's target), some three and four.
      let { state, events: log } = newGame({ players: g % 4 === 3 ? 4 : g % 4 === 2 ? 3 : 2, seed: `leak-${g}`, marksToWin: 2 });
      for (let n = 0; n < 400 && state.phase !== 'game-over'; n++) {
        const step = randomStep(state, rng);
        if (!step) break;
        if (n % 3 === 0) {
          for (const viewer of viewers(state)) {
            const view = viewFor(state, viewer);
            const visible = cardsIn([view, shown(log.filter((e) => e.round === state.round), viewer)]);
            const hidden = CARD_IDS.filter((c) => !visible.has(c) && placeOf(state, c) !== 'elsewhere');
            const pairs = hidden.flatMap((a) => hidden.filter((b) => a < b && alike(a, b) && fits(a, placeOf(state, b)) && fits(b, placeOf(state, a))).map((b) => [a, b] as const));
            if (pairs.length === 0) continue;
            const [a, b] = pick(rng, pairs);
            const swapped = swapCards(state, a, b);
            const where = `game ${g}, step ${n}, viewer ${viewer}, swapping ${a} (${placeOf(state, a)}) and ${b} (${placeOf(state, b)})`;
            expect(viewFor(swapped, viewer), where).toEqual(view);
            checks++;

            const real = apply(state, step.seat, step.command);
            const other = apply(swapped, step.seat, swapCards(step.command, a, b));
            if (!real.ok) throw new Error(real.error.message);
            if (!other.ok) {
              const named = cardsIn(step.command);
              if (named.has(a) || named.has(b)) continue; // the mover could see a swapped card
              expect.fail(`${where}: an unrelated command became illegal: ${other.error.message}`);
            }
            const after = [viewFor(real.state, viewer), shown(real.events, viewer), viewFor(other.state, viewer), shown(other.events, viewer)];
            const seen = cardsIn(after);
            if (seen.has(a) || seen.has(b)) continue; // the step showed the viewer one of them
            const what = `${where}: after ${JSON.stringify(step.command)} by seat ${step.seat}`;
            expect(shown(other.events, viewer), `${what}: events`).toEqual(shown(real.events, viewer));
            expect(viewFor(other.state, viewer), `${what}: view`).toEqual(viewFor(real.state, viewer));
            steps++;
          }
        }
        const result = apply(state, step.seat, step.command);
        if (!result.ok) throw new Error(result.error.message);
        state = result.state;
        log = [...log, ...result.events];
      }
    }
    expect(checks).toBeGreaterThan(5000);
    expect(steps).toBeGreaterThan(3000);
  });

  it('R-10 relabeling which pile is the Count, Fool, Friar or Mask changes no view', () => {
    let checks = 0;
    for (let g = 0; g < 60; g++) {
      const rng = seedRng(`leak-piles-${g}`);
      let { state } = newGame({ players: g % 3 === 2 ? 4 : 2, seed: `leak-piles-${g}`, marksToWin: 2 });
      for (let n = 0; n < 300 && state.phase !== 'game-over'; n++) {
        if (n % 5 === 0) {
          const p = pick(rng, [...PILE_IDS]);
          const q = pick(rng, PILE_IDS.filter((x) => x !== p));
          const relabeled = swapPileIds(state, p, q);
          for (const viewer of viewers(state)) {
            expect(viewFor(relabeled, viewer), `game ${g}, step ${n}, viewer ${viewer}, piles ${p}/${q}`).toEqual(viewFor(state, viewer));
            checks++;
          }
        }
        const step = randomStep(state, rng);
        if (!step) break;
        const result = apply(state, step.seat, step.command);
        if (!result.ok) throw new Error(result.error.message);
        state = result.state;
      }
    }
    expect(checks).toBeGreaterThan(2000);
  });
});
