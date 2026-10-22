import { buildPosition, CARD_IDS, PILE_IDS, type CardId, type GameState, type PileId, type Seat } from '@keeps/engine';
import { describe, expect, it } from 'vitest';
import { Belief, IDENTITIES, pilePlace, type Place } from '../src/belief.ts';
import { RoundEnv, SEAT_OF_PLAYER } from '../src/env.ts';

// The belief tracker is built from one player's own view and log. It must stay
// sound: over random rounds, at every step, for both players, it follows every
// pile exactly, and it never gives probability zero to the truth (the real
// identities of the piles, or where any card really is). It should also be
// informative: well above a uniform guess by the end of a round.

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Where a card really is, in the tracker's terms for player `me`. */
function truePlace(state: GameState, me: Seat, belief: Belief, card: CardId): Place[] {
  const opponent = ((me + 2) % 4) as Seat;
  if (state.hands[me].includes(card)) return ['my-hand'];
  if (state.hands[opponent].includes(card)) return belief.opponentKnown.has(card) ? ['opponent-hand'] : ['opponent-hidden'];
  for (const seat of [me, opponent]) {
    const c = state.keeps[seat].find((k) => k.id === card);
    if (!c) continue;
    if (!c.faceDown) return [seat === me ? 'my-keep' : 'opponent-keep'];
    if (c.faceDown.placedBy === me) return [seat === me ? 'my-keep-face-down' : 'opponent-keep-face-down'];
    return ['opponent-hidden'];
  }
  if (state.discard.includes(card)) return ['discard'];
  for (let position = 0; position < 4; position++) {
    if (state.piles[state.pileAt[position]!].cards.some((c) => c.id === card)) return [pilePlace(me, position as Seat)];
  }
  return ['other'];
}

describe('belief tracking (heads-up)', () => {
  it('follows every pile and never rules out the truth, at every step of 300 random rounds, for both players', () => {
    let checks = 0;
    let truthOnIdentity = 0;
    let rounds = 0;
    let unlocated = 0;
    let truthOnUnlocated = 0;
    for (let g = 0; g < 300; g++) {
      const random = rng(g + 7);
      const env = RoundEnv.start(`belief-${g}`);
      const dealt: PileId[] = [...env.state.pileAt]; // physical pile k was dealt at position k
      const beliefs = [new Belief(SEAT_OF_PLAYER[0]!), new Belief(SEAT_OF_PLAYER[1]!)];
      for (let step = 0; !env.terminal && step < 5000; step++) {
        if (env.prefix.length === 0) {
          for (let player = 0; player < 2; player++) {
            const me = SEAT_OF_PLAYER[player]!;
            const view = env.view(player);
            const belief = beliefs[player]!.update(env.log(player)).observe(view);
            const where = `round ${g}, step ${step}, player ${player}`;
            // Piles: the tracker knows which physical pile is where, and its size.
            for (let position = 0; position < 4; position++) {
              expect(dealt[belief.at[position]!], `${where}: pile at ${position}`).toBe(env.state.pileAt[position]);
              expect(belief.piles[belief.at[position]!]!.size, `${where}: size at ${position}`).toBe(view.piles[position]!.size);
            }
            // Identities: the true assignment is never ruled out.
            const truth = dealt.map((id) => IDENTITIES[PILE_IDS.indexOf(id)]!);
            const weight = belief.identityWeights().find((w) => w.assignment.every((id, p) => id === truth[p]))!.weight;
            expect(weight, `${where}: true identities ruled out`).toBeGreaterThan(0);
            // Locations: each card's true place has some probability.
            const locations = belief.locations(view);
            for (const card of CARD_IDS) {
              const loc = locations.get(card)!;
              const places = truePlace(env.state, me, belief, card);
              const p = places.reduce((sum, place) => sum + (loc[place] ?? 0), 0);
              expect(p, `${where}: ${card} is really in ${places.join('/')}, belief ${JSON.stringify(loc)}`).toBeGreaterThan(0);
              const certain = Object.values(loc).some((v) => v === 1);
              if (!certain) {
                unlocated++;
                truthOnUnlocated += p;
              }
            }
            checks++;
          }
        }
        const actions = env.legalActions();
        env.step(actions[Math.floor(random() * actions.length)]!);
      }
      // How sure each player is of the identities by the end.
      for (let player = 0; player < 2; player++) {
        const belief = beliefs[player]!.update(env.log(player));
        const truth = dealt.map((id) => IDENTITIES[PILE_IDS.indexOf(id)]!);
        truthOnIdentity += belief.identityWeights().find((w) => w.assignment.every((id, p) => id === truth[p]))!.weight;
        rounds++;
      }
    }
    expect(checks).toBeGreaterThan(5000);
    const identity = truthOnIdentity / rounds;
    const location = truthOnUnlocated / unlocated;
    console.log(`end of round: P(true identities) = ${identity.toFixed(3)} (uniform 0.042); unlocated cards: P(true place) = ${location.toFixed(3)}`);
    expect(identity).toBeGreaterThan(0.2);
  });

  it('works out which pile is the Mask from two characters, and a character pile from its cards', () => {
    // Position 0 (ours) is the Count pile: we see two Count cards in it. Position 1 shows a Fool and a Friar card: the Mask.
    const belief = new Belief(0);
    const log = [
      { type: 'round-start', round: 1, startingSeat: 0 },
      ...[0, 1, 2, 3].map((position) => ({ type: 'pile-placed', position, size: 9 })),
      { type: 'look', seat: 0, piles: [0, 1, 2, 3], cards: ['chalice', 'juggling', 'sanction', 'dagger'] },
    ].map((payload, seq) => ({ seq, round: 1, depth: 0, cause: null, payload })) as never;
    belief.update(log);
    const ids = belief.identities();
    // Pile 0 showed one Count card (chalice): Count or Mask. Pile 3 too (dagger).
    // Pile 1 showed a Fool card, pile 2 a Friar card. Each of piles 0 and 3 is the Count pile or the Mask.
    expect(ids[1]![IDENTITIES.indexOf('count')]).toBe(0);
    expect(ids[0]![IDENTITIES.indexOf('fool')]).toBe(0);
    expect(ids[0]![IDENTITIES.indexOf('count')]! + ids[0]![IDENTITIES.indexOf('mask')]!).toBeCloseTo(1);
    // Seeing a Fool card in pile 0 as well would make it the Mask.
    belief.update([
      ...log,
      { seq: 9, round: 1, depth: 0, cause: null, payload: { type: 'draw', seat: 0, from: 0, card: 'chalice' } },
      { seq: 10, round: 1, depth: 0, cause: null, payload: { type: 'look', seat: 0, piles: [0], cards: ['pandemonium'] } },
    ] as never);
    expect(belief.identities()[0]![IDENTITIES.indexOf('mask')]).toBeCloseTo(1);
    void buildPosition;
  });
});
