import { CARD_IDS, type CardId, type PlayerView, type PromptKind, type Seat } from '@keeps/engine';
import { NUM_ACTIONS } from './actions.ts';
import { IDENTITIES, PLACES, type Belief } from './belief.ts';

// The observation: a fixed-length vector from one player's point of view, made
// only from their view, their belief (itself built from their view and own log),
// and the ids they've chosen so far in the current move. It never sees the game
// state, so it can't leak, and it ignores prompt ids and event numbers.
// Positions are relative to the player: pile 0 is theirs, 1 on their left (a
// ghost in heads-up), 2 the opponent's, 3 on their right (a ghost).
//
// Blocks, in order:
//   cards       36 × 13  where each card is: certain, or a probability over places
//   tops        4 × 36   the known top card of each pile
//   depth       36       how deep a card sits in a pile, if known
//   piles       4 × 9    size, face-up top, identity (4), unseen, opponent's hidden from it, ghost
//   hands       4        hand sizes and the opponent's hidden and known cards
//   keeps       6        scores, keep sizes, who's ahead
//   duplicity   5        who holds it, where a face-down card lies
//   turn        12       whose turn, actions, the active frame
//   decision    17+4+3+36+48+1  prompt kind, pile-choice purpose, reveal-window reason,
//                        the card in question, the ids chosen so far, how many
//   round       2        cards left in the piles, whether we started

const PROMPT_KINDS = [
  'action',
  'hot-target',
  'choose-pile',
  'choose-pile-card',
  'choose-top-card',
  'take-or-discard',
  'choose-discard-card',
  'choose-keep-pair',
  'choose-direction',
  'order-pile',
  'duplicity-hide',
  'reveal-window',
  'choose-player',
  'choose-hand-card',
  'give-card',
  'joker-copy',
  'claim-pile',
] as const satisfies readonly PromptKind[];
// Every prompt kind is listed (a new one is a compile error here).
type MissingKind = Exclude<PromptKind, (typeof PROMPT_KINDS)[number]>;
const allKinds: MissingKind extends never ? true : never = true;
void allKinds;

const PURPOSES = ['requisition', 'prayer', 'revelation', 'invocation'] as const;
const REASONS = ['play', 'before-last-laugh', 'before-scoring'] as const;
const FRAMES = ['turn', 'hocus-pocus', 'retribution', 'last-laugh'] as const;

const SIZES = {
  cards: 36 * PLACES.length,
  tops: 4 * 36,
  depth: 36,
  piles: 4 * 9,
  hands: 4,
  keeps: 6,
  duplicity: 5,
  turn: 12,
  decision: PROMPT_KINDS.length + PURPOSES.length + REASONS.length + 36 + NUM_ACTIONS + 1,
  round: 2,
};
export const OBSERVATION_SIZE = Object.values(SIZES).reduce((a, b) => a + b, 0);

export function encodeObservation(view: PlayerView, belief: Belief, prefix: readonly number[]): Float32Array {
  const me = belief.me;
  const opponent = belief.opponent;
  const rel = (position: number): Seat => ((me + position) % 4) as Seat;
  const out = new Float32Array(OBSERVATION_SIZE);
  let at = 0;
  const put = (value: number) => {
    out[at++] = value;
  };
  const oneHot = (index: number, size: number) => {
    if (index >= 0 && index < size) out[at + index] = 1;
    at += size;
  };

  // cards: where each card is
  const locations = belief.locations(view);
  for (const card of CARD_IDS) {
    const loc = locations.get(card) ?? {};
    for (const place of PLACES) put(loc[place] ?? 0);
  }

  // tops: the known top card of each pile; depth: known positions
  const depth = new Map<CardId, number>();
  for (let r = 0; r < 4; r++) {
    const pile = belief.piles[belief.at[rel(r)]!]!;
    const top = view.piles[rel(r)]!.top ?? pile.slots[0] ?? null;
    oneHot(top ? CARD_IDS.indexOf(top) : -1, 36);
    pile.slots.forEach((card, i) => {
      if (card && !depth.has(card)) depth.set(card, i);
    });
  }
  for (const card of CARD_IDS) put(depth.has(card) ? (depth.get(card)! + 1) / 10 : 0);

  // piles
  const identities = belief.identities();
  for (let r = 0; r < 4; r++) {
    const position = rel(r);
    const p = belief.at[position]!;
    put(view.piles[position]!.size / 9);
    put(view.piles[position]!.top ? 1 : 0);
    for (let i = 0; i < IDENTITIES.length; i++) put(identities[p]![i]!);
    put(belief.unseenIn(p) / 9);
    put(belief.opponentHidden[p]! / 9);
    put(view.seats[position] === 'ghost' ? 1 : 0);
  }

  // hands
  put(view.hands[me]!.count / 10);
  put(view.hands[opponent]!.count / 10);
  put(belief.opponentHidden.reduce((a, b) => a + b, 0) / 10);
  put(belief.opponentKnown.size / 10);

  // keeps (scores are in half-coins)
  const mine = view.scores[me] ?? 0;
  const theirs = view.scores[opponent] ?? 0;
  put(mine / 40);
  put(theirs / 40);
  put(view.keeps[me]!.cards.length / 10);
  put(view.keeps[opponent]!.cards.length / 10);
  put(Math.sign(mine - theirs));
  put((mine - theirs) / 40);

  // duplicity
  put(view.duplicityHolder === me ? 1 : 0);
  put(view.duplicityHolder === opponent ? 1 : 0);
  put(view.keeps[me]!.cards.some((c) => c.faceDown) ? 1 : 0);
  put(view.keeps[opponent]!.cards.some((c) => c.faceDown) ? 1 : 0);
  put(view.keeps.some((k) => k.cards.some((c) => c.faceDown && c.id)) ? 1 : 0);

  // turn
  put(view.turn?.seat === me ? 1 : 0);
  put(view.turn?.seat === opponent ? 1 : 0);
  put(Math.min(view.turn?.actionsTaken ?? 0, 4) / 4); // Hocus Pocus can make a turn longer than two
  put(view.frame?.seat === me ? 1 : 0);
  put(view.frame?.seat === opponent ? 1 : 0);
  oneHot(view.frame ? FRAMES.indexOf(view.frame.kind) : -1, FRAMES.length);
  put(Math.min(view.frame?.remaining ?? 0, 4) / 4);
  put(view.phase === 'post-round' ? 1 : 0);
  put(Math.min(view.turnNumber, 40) / 40);

  // decision: the player's own open prompt
  const prompt = view.prompts.find((p) => p.mine);
  oneHot(prompt ? PROMPT_KINDS.indexOf(prompt.kind) : -1, PROMPT_KINDS.length);
  oneHot(prompt?.mine && prompt.kind === 'choose-pile' ? PURPOSES.indexOf(prompt.purpose) : -1, PURPOSES.length);
  oneHot(prompt?.mine && prompt.kind === 'reveal-window' ? REASONS.indexOf(prompt.reason) : -1, REASONS.length);
  const card = prompt?.mine && (prompt.kind === 'hot-target' || prompt.kind === 'take-or-discard') ? prompt.card : null;
  oneHot(card ? CARD_IDS.indexOf(card) : -1, 36);
  for (let id = 0; id < NUM_ACTIONS; id++) put(prefix.includes(id) ? 1 : 0);
  put(prefix.length / 9);

  // round
  put(view.piles.reduce((n, p) => n + p.size, 0) / 36);
  put(view.startingSeat === me ? 1 : 0);

  if (at !== OBSERVATION_SIZE) throw new Error(`observation filled ${at} of ${OBSERVATION_SIZE}`);
  return out;
}
