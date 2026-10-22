import { CARD_IDS, CARDS, type CardId, type PlayerView, type PromptKind, type Seat } from '@keeps/engine';
import { FACE_DOWN, NUM_ACTIONS, POS } from './actions.ts';
import { IDENTITIES, PLACES, type Belief } from './belief.ts';
import { MOVE_KINDS, MOVE_PLACES, OPPONENT_TURNS, PILE_EVENTS, PILE_HISTORY } from './history.ts';

// Observation v2: the same information as v1 plus what v1 left out (the full
// prompt, the legal ids, history), laid out by entity for a network that shares
// weights across cards and across piles. Every fact sits on the row of the
// thing it's about, including which ids are legal or already chosen, and the
// card or pile the prompt is about.
//
//   cards     36 rows (CARD_IDS order)  printed card, where it is, known pile
//                                       position, legal/chosen/subject, its last
//                                       move, whether the opponent knows where it is
//   piles     4 rows (relative: own, left, opposite, right)
//                                       size, identity, unseen, legal/chosen/prompt,
//                                       Fiat claims, opponent's knowledge, recent events
//   players   2 rows (me, opponent)     score, hand, keep, Duplicity, turn, Fiat, round end
//   turns     6 rows                    the opponent's recent turns (what they did)
//   decision  1 row                     the prompt and the moment
//
// No derived tactics: only what the view and the player's own log say (and the
// belief's card-location probabilities, as in v1). LAYOUT describes every
// column, so the Python network reads blocks and columns by name.

const PROMPT_KINDS: readonly PromptKind[] = [
  'action', 'hot-target', 'choose-pile', 'choose-pile-card', 'choose-top-card', 'take-or-discard', 'choose-discard-card',
  'choose-keep-pair', 'choose-direction', 'order-pile', 'duplicity-hide', 'reveal-window', 'choose-player',
  'choose-hand-card', 'give-card', 'joker-copy', 'claim-pile',
];
const PILE_PURPOSES = ['requisition', 'prayer', 'revelation', 'invocation'] as const;
const PLAYER_PURPOSES = ['legerdemain', 'pickpocket'] as const;
const REASONS = ['play', 'before-last-laugh', 'before-scoring'] as const;
const FRAMES = ['turn', 'hocus-pocus', 'retribution', 'last-laugh'] as const;
/** The ids that aren't a card or a position: FACE_DOWN … REVEAL. */
const SPECIAL_IDS = Array.from({ length: NUM_ACTIONS - FACE_DOWN }, (_, i) => FACE_DOWN + i);

type Columns = Record<string, [start: number, width: number]>;
interface Block {
  offset: number;
  rows: number;
  width: number;
  columns: Columns;
}

function block(groups: [string, number][]): { width: number; columns: Columns } {
  const columns: Columns = {};
  let at = 0;
  for (const [name, width] of groups) {
    columns[name] = [at, width];
    at += width;
  }
  return { width: at, columns };
}

const CARD_ROW = block([
  ['coins', 1], ['tithes', 1], ['hot', 1], ['keep', 1], ['action', 1], ['character', 3], ['token', 1],
  ['location', PLACES.length],
  ['top_of', 4], ['depth', 1],
  ['legal', 1], ['chosen', 1], ['subject', 1],
  ['moved', 1], ['move_kind', MOVE_KINDS.length], ['move_by', 2], ['move_from', MOVE_PLACES.length], ['move_to', MOVE_PLACES.length], ['move_age', 1],
  ['opponent_knows', 1],
]);
const PILE_ROW = block([
  ['size', 1], ['face_up', 1], ['identity', IDENTITIES.length], ['unseen', 1], ['opponent_hidden', 1], ['ghost', 1], ['empty', 1],
  ['legal', 1], ['chosen', 1], ['prompt', 1],
  ['claimed_for', 4], ['unclaimed', 1],
  ['opponent_knows_top', 1], ['opponent_knows_order', 1],
  ...Array.from({ length: PILE_HISTORY }, (_, i): [string, number][] => [
    [`event${i}_kind`, PILE_EVENTS.length], [`event${i}_by`, 2], [`event${i}_age`, 1],
  ]).flat(),
]);
const PLAYER_ROW = block([
  ['score', 1], ['hand', 1], ['keep_size', 1], ['known', 1], ['hidden', 1], ['duplicity_holder', 1], ['face_down_in_keep', 1],
  ['turn', 1], ['frame', 1], ['fiat_claimant', 1], ['ended_round', 1],
]);
const TURN_ROW = block([
  ['present', 1], ['age', 1], ['hand_at_start', 1], ['draws', 1], ['keep_to_own', 1], ['keep_to_mine', 1],
  ['action_cards', 1], ['abilities', 1], ['passes', 1], ['gained', 1],
]);
const DECISION_ROW = block([
  ['prompt', PROMPT_KINDS.length], ['pile_purpose', PILE_PURPOSES.length], ['player_purpose', PLAYER_PURPOSES.length], ['reason', REASONS.length],
  ['frame', FRAMES.length], ['frame_remaining', 1], ['actions_taken', 1], ['turn_by', 2], ['frame_by', 2],
  ['post_round', 1], ['ender', 2], ['turn_number', 1], ['piles_total', 1], ['started', 1],
  ['special_legal', SPECIAL_IDS.length], ['special_chosen', SPECIAL_IDS.length], ['prefix_length', 1],
  ['fiat_claimant', 4], ['fiat_claims_left', 1],
]);

function layout(): { size: number; blocks: Record<string, Block>; specialIds: number[]; places: string[] } {
  const blocks: Record<string, Block> = {};
  let offset = 0;
  for (const [name, rows, row] of [
    ['cards', CARD_IDS.length, CARD_ROW],
    ['piles', 4, PILE_ROW],
    ['players', 2, PLAYER_ROW],
    ['turns', OPPONENT_TURNS, TURN_ROW],
    ['decision', 1, DECISION_ROW],
  ] as const) {
    blocks[name] = { offset, rows, width: row.width, columns: row.columns };
    offset += rows * row.width;
  }
  return { size: offset, blocks, specialIds: SPECIAL_IDS, places: [...PLACES] };
}

/** Where everything is in the vector: blocks (offset, rows, row width) and named columns within a row. */
export const LAYOUT2 = layout();
export const OBSERVATION2_SIZE = LAYOUT2.size;

const AGE = (turns: number) => Math.min(turns, 20) / 20;
/** A count of things in one turn (Hocus Pocus and forced draws can make it long). */
const COUNT = (n: number) => Math.min(n, 6) / 6;

// The card rows are the hot path (36 per observation): column starts as plain numbers.
const CARDS_OFFSET = LAYOUT2.blocks.cards!.offset;
const CARDS_WIDTH = LAYOUT2.blocks.cards!.width;
const CARD_COLUMNS = Object.fromEntries(Object.entries(LAYOUT2.blocks.cards!.columns).map(([name, [start]]) => [name, start])) as Record<string, number>;
const CHARACTER_INDEX: Record<string, number> = { count: 0, fool: 1, friar: 2 };
const TOKEN_CARDS = new Set<CardId>(['count-token', 'fool-token', 'friar-token']);
const MOVE_KIND_INDEX = Object.fromEntries(MOVE_KINDS.map((k, i) => [k, i])) as Record<string, number>;
const MOVE_PLACE_INDEX = Object.fromEntries(MOVE_PLACES.map((k, i) => [k, i])) as Record<string, number>;

/** Absolute offset of each block's row 0, plus each column's start within a row, resolved once. */
const OFFSETS = Object.fromEntries(
  Object.entries(LAYOUT2.blocks).map(([name, b]) => [
    name,
    { offset: b.offset, width: b.width, col: Object.fromEntries(Object.entries(b.columns).map(([c, [start, width]]) => [c, { start, width }])) },
  ]),
) as Record<string, { offset: number; width: number; col: Record<string, { start: number; width: number }> }>;

export function encodeObservation2(view: PlayerView, belief: Belief, prefix: readonly number[], legal: readonly number[]): Float32Array {
  const out = new Float32Array(OBSERVATION2_SIZE);
  const me = belief.me;
  const opp = belief.opponent;
  const rel = (seat: Seat) => (seat - me + 4) % 4;
  const at = (position: number): Seat => ((me + position) % 4) as Seat;
  const history = belief.history;
  const legalSet = new Set(legal);
  const chosen = new Set(prefix);
  const prompt = view.prompts.find((p) => p.mine);
  const put = (blockName: string, row: number, column: string, value: number, index = 0) => {
    const b = OFFSETS[blockName]!;
    const c = b.col[column]!;
    if (index < 0 || index >= c.width) return;
    out[b.offset + row * b.width + c.start + index] = value;
  };

  // cards
  const locations = belief.locationTable(view);
  const subject: CardId | null = prompt?.mine && (prompt.kind === 'hot-target' || prompt.kind === 'take-or-discard') ? prompt.card : null;
  const topOf = new Map<CardId, number>();
  const depth = new Map<CardId, number>();
  for (let r = 0; r < 4; r++) {
    const pile = belief.piles[belief.at[at(r)]!]!;
    const top = view.piles[at(r)]!.top ?? pile.slots[0] ?? null;
    if (top) topOf.set(top, r);
    pile.slots.forEach((card, i) => {
      if (card && !depth.has(card)) depth.set(card, i);
    });
  }
  const C = CARD_COLUMNS;
  const location = (C.location ?? 0);
  CARD_IDS.forEach((card, c) => {
    // CARD(card) === c: rows are in CARD_IDS order.
    const base = CARDS_OFFSET + c * CARDS_WIDTH;
    const printed = CARDS[card];
    if (typeof printed.coins === 'number') out[base + C.coins!] = printed.coins / 20;
    else if (printed.coins === 'tithes') out[base + C.tithes!] = 1;
    if (printed.hot) out[base + C.hot!] = 1;
    out[base + (printed.keep ? C.keep! : C.action!)] = 1;
    out[base + C.character! + CHARACTER_INDEX[printed.character]!] = 1;
    if (TOKEN_CARDS.has(card)) out[base + C.token!] = 1;
    out.set(locations.subarray(c * PLACES.length, (c + 1) * PLACES.length), base + location);
    const top = topOf.get(card);
    if (top !== undefined) out[base + C.top_of! + top] = 1;
    const d = depth.get(card);
    if (d !== undefined) out[base + C.depth!] = (d + 1) / 10;
    if (legalSet.has(c)) out[base + C.legal!] = 1;
    if (chosen.has(c)) out[base + C.chosen!] = 1;
    if (subject === card) out[base + C.subject!] = 1;
    const move = history.lastMove.get(card);
    if (move) {
      out[base + C.moved!] = 1;
      out[base + C.move_kind! + MOVE_KIND_INDEX[move.kind]!] = 1;
      out[base + C.move_by! + (move.byMe ? 0 : 1)] = 1;
      out[base + C.move_from! + MOVE_PLACE_INDEX[move.from]!] = 1;
      out[base + C.move_to! + MOVE_PLACE_INDEX[move.to]!] = 1;
      out[base + C.move_age!] = AGE(history.turn - move.turn);
    }
    if (history.opponentKnows.has(card)) out[base + C.opponent_knows!] = 1;
  });

  // piles
  const identities = belief.identities();
  const promptPile = prompt?.mine && 'pile' in prompt ? (prompt.pile as Seat) : null;
  const claim = prompt?.mine && prompt.kind === 'claim-pile' ? prompt : null;
  for (let r = 0; r < 4; r++) {
    const position = at(r);
    const p = belief.at[position]!;
    const pileView = view.piles[position]!;
    put('piles', r, 'size', pileView.size / 12);
    put('piles', r, 'face_up', pileView.top ? 1 : 0);
    for (let i = 0; i < IDENTITIES.length; i++) put('piles', r, 'identity', identities[p]![i]!, i);
    put('piles', r, 'unseen', belief.unseenIn(p) / 9);
    put('piles', r, 'opponent_hidden', belief.opponentHidden[p]! / 9);
    put('piles', r, 'ghost', view.seats[position] === 'ghost' ? 1 : 0);
    put('piles', r, 'empty', pileView.size === 0 ? 1 : 0);
    if (legalSet.has(POS(r))) put('piles', r, 'legal', 1);
    if (chosen.has(POS(r))) put('piles', r, 'chosen', 1);
    if (promptPile === position) put('piles', r, 'prompt', 1);
    if (claim) {
      const made = claim.claims.find((c) => c.from === position);
      if (made) put('piles', r, 'claimed_for', 1, rel(made.claimant));
      else put('piles', r, 'unclaimed', 1);
    }
    if (history.opponentKnowsTop[p]) put('piles', r, 'opponent_knows_top', 1);
    if (history.opponentKnowsOrder[p]) put('piles', r, 'opponent_knows_order', 1);
    history.pileEvents[p]!.forEach((e, i) => {
      put('piles', r, `event${i}_kind`, 1, PILE_EVENTS.indexOf(e.kind));
      put('piles', r, `event${i}_by`, 1, e.byMe ? 0 : 1);
      put('piles', r, `event${i}_age`, AGE(history.turn - e.turn));
    });
  }

  // players: me, then the opponent
  const ender = view.roundEnd?.kind === 'empty-pile' ? view.roundEnd.enderSeat : null;
  [me, opp].forEach((seat, row) => {
    put('players', row, 'score', (view.scores[seat] ?? 0) / 40);
    put('players', row, 'hand', view.hands[seat]!.count / 10);
    put('players', row, 'keep_size', view.keeps[seat]!.cards.length / 15);
    if (seat === opp) {
      put('players', row, 'known', belief.opponentKnown.size / 10);
      put('players', row, 'hidden', belief.opponentHidden.reduce((a, b) => a + b, 0) / 10);
    }
    if (view.duplicityHolder === seat) put('players', row, 'duplicity_holder', 1);
    if (view.keeps[seat]!.cards.some((c) => c.faceDown)) put('players', row, 'face_down_in_keep', 1);
    if (view.turn?.seat === seat) put('players', row, 'turn', 1);
    if (view.frame?.seat === seat) put('players', row, 'frame', 1);
    if (claim?.claimant === seat) put('players', row, 'fiat_claimant', 1);
    if (ender === seat) put('players', row, 'ended_round', 1);
  });

  // the opponent's recent turns, newest first
  history.opponentTurns.forEach((t, row) => {
    put('turns', row, 'present', 1);
    put('turns', row, 'age', AGE(history.turn - t.turn));
    put('turns', row, 'hand_at_start', t.handAtStart / 10);
    put('turns', row, 'draws', COUNT(t.draws));
    put('turns', row, 'keep_to_own', COUNT(t.keepToOwn));
    put('turns', row, 'keep_to_mine', COUNT(t.keepToMine));
    put('turns', row, 'action_cards', COUNT(t.actionCards));
    put('turns', row, 'abilities', COUNT(t.abilities));
    put('turns', row, 'passes', COUNT(t.passes));
    put('turns', row, 'gained', COUNT(t.gained));
  });

  // decision
  if (prompt) put('decision', 0, 'prompt', 1, PROMPT_KINDS.indexOf(prompt.kind));
  if (prompt?.mine && prompt.kind === 'choose-pile') put('decision', 0, 'pile_purpose', 1, PILE_PURPOSES.indexOf(prompt.purpose));
  if (prompt?.mine && prompt.kind === 'choose-player') put('decision', 0, 'player_purpose', 1, PLAYER_PURPOSES.indexOf(prompt.purpose));
  if (prompt?.mine && prompt.kind === 'reveal-window') put('decision', 0, 'reason', 1, REASONS.indexOf(prompt.reason));
  if (view.frame) {
    put('decision', 0, 'frame', 1, FRAMES.indexOf(view.frame.kind));
    put('decision', 0, 'frame_remaining', Math.min(view.frame.remaining, 4) / 4);
    put('decision', 0, 'frame_by', 1, view.frame.seat === me ? 0 : 1);
  }
  if (view.turn) {
    put('decision', 0, 'actions_taken', Math.min(view.turn.actionsTaken, 4) / 4);
    put('decision', 0, 'turn_by', 1, view.turn.seat === me ? 0 : 1);
  }
  if (view.phase === 'post-round') put('decision', 0, 'post_round', 1);
  if (ender !== null) put('decision', 0, 'ender', 1, ender === me ? 0 : 1);
  put('decision', 0, 'turn_number', Math.min(view.turnNumber, 40) / 40);
  put('decision', 0, 'piles_total', view.piles.reduce((n, p) => n + p.size, 0) / 36);
  if (view.startingSeat === me) put('decision', 0, 'started', 1);
  SPECIAL_IDS.forEach((id, i) => {
    if (legalSet.has(id)) put('decision', 0, 'special_legal', 1, i);
    if (chosen.has(id)) put('decision', 0, 'special_chosen', 1, i);
  });
  put('decision', 0, 'prefix_length', prefix.length / 9);
  if (claim) {
    put('decision', 0, 'fiat_claimant', 1, rel(claim.claimant));
    put('decision', 0, 'fiat_claims_left', claim.queue.length / 4);
  }
  return out;
}
