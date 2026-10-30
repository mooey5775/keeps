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


/** Column starts of a block's rows, as plain numbers (the encoder writes by index). */
function starts(blockName: string): Record<string, number> {
  return Object.fromEntries(Object.entries(LAYOUT2.blocks[blockName]!.columns).map(([name, [start]]) => [name, start]));
}
const PILE = { offset: LAYOUT2.blocks.piles!.offset, width: LAYOUT2.blocks.piles!.width, col: starts('piles') };
const PLAYER = { offset: LAYOUT2.blocks.players!.offset, width: LAYOUT2.blocks.players!.width, col: starts('players') };
const TURN = { offset: LAYOUT2.blocks.turns!.offset, width: LAYOUT2.blocks.turns!.width, col: starts('turns') };
const DECISION = { offset: LAYOUT2.blocks.decision!.offset, col: starts('decision') };
const PILE_EVENT_COLUMNS = Array.from({ length: PILE_HISTORY }, (_, i) => ({
  kind: PILE.col[`event${i}_kind`]!,
  by: PILE.col[`event${i}_by`]!,
  age: PILE.col[`event${i}_age`]!,
}));
const PILE_EVENT_INDEX = Object.fromEntries(PILE_EVENTS.map((k, i) => [k, i])) as Record<string, number>;
const PROMPT_INDEX = Object.fromEntries(PROMPT_KINDS.map((k, i) => [k, i])) as Record<string, number>;
// Scratch flags for the ids in play (the encoder isn't reentrant; Node runs it on one thread).
const LEGAL = new Uint8Array(NUM_ACTIONS);
const CHOSEN = new Uint8Array(NUM_ACTIONS);
// Scratch by card (CARD_IDS order): which pile's top it is (-1: none) and its depth in a pile (-1: none known).
const TOP_OF = new Int8Array(CARD_IDS.length);
const DEPTH = new Int8Array(CARD_IDS.length);
const CARD_NUMBER = Object.fromEntries(CARD_IDS.map((card, c) => [card, c])) as Record<CardId, number>;

/** The card rows' printed columns (they never change), copied in at once: the rest of every row starts at zero. */
const PRINTED_CARDS = (() => {
  const C = CARD_COLUMNS;
  const rows = new Float32Array(CARD_IDS.length * CARDS_WIDTH);
  CARD_IDS.forEach((card, c) => {
    const base = c * CARDS_WIDTH;
    const printed = CARDS[card];
    if (typeof printed.coins === 'number') rows[base + C.coins!] = printed.coins / 20;
    else if (printed.coins === 'tithes') rows[base + C.tithes!] = 1;
    if (printed.hot) rows[base + C.hot!] = 1;
    rows[base + (printed.keep ? C.keep! : C.action!)] = 1;
    rows[base + C.character! + CHARACTER_INDEX[printed.character]!] = 1;
    if (TOKEN_CARDS.has(card)) rows[base + C.token!] = 1;
  });
  return rows;
})();

/**
 * Encodes into `out` at `start` (a fresh array by default), so a worker can
 * write straight into its frame. `legal`: the ids legal after `prefix`.
 */
export function encodeObservation2(
  view: PlayerView,
  belief: Belief,
  prefix: readonly number[],
  legal: readonly number[],
  out: Float32Array = new Float32Array(OBSERVATION2_SIZE),
  start = 0,
): Float32Array {
  out.fill(0, start, start + OBSERVATION2_SIZE);
  out.set(PRINTED_CARDS, start + CARDS_OFFSET);
  const me = belief.me;
  const opp = belief.opponent;
  const rel = (seat: Seat) => (seat - me + 4) % 4;
  const at = (position: number): Seat => ((me + position) % 4) as Seat;
  const history = belief.history;
  LEGAL.fill(0);
  CHOSEN.fill(0);
  for (const id of legal) LEGAL[id] = 1;
  for (const id of prefix) CHOSEN[id] = 1;
  const prompt = view.prompts.find((p) => p.mine);

  // cards
  const C = CARD_COLUMNS;
  const location = C.location!;
  const locations = belief.locationTable(view);
  const subject: CardId | null = prompt?.mine && (prompt.kind === 'hot-target' || prompt.kind === 'take-or-discard') ? prompt.card : null;
  TOP_OF.fill(-1);
  DEPTH.fill(-1);
  for (let r = 0; r < 4; r++) {
    const pile = belief.piles[belief.at[at(r)]!]!;
    const top = view.piles[at(r)]!.top ?? pile.slots[0] ?? null;
    // A later pile's top wins, as a later set() would.
    if (top) TOP_OF[CARD_NUMBER[top]] = r;
    const slots = pile.slots;
    for (let i = 0; i < slots.length; i++) {
      const card = slots[i];
      if (card && DEPTH[CARD_NUMBER[card]]! < 0) DEPTH[CARD_NUMBER[card]] = i;
    }
  }
  const PL = PLACES.length;
  for (let c = 0; c < CARD_IDS.length; c++) {
    // CARD(card) === c: rows are in CARD_IDS order. (Printed columns: PRINTED_CARDS, above.)
    const card = CARD_IDS[c]!;
    const base = start + CARDS_OFFSET + c * CARDS_WIDTH;
    for (let i = 0; i < PL; i++) out[base + location + i] = locations[c * PL + i]!;
    const top = TOP_OF[c]!;
    if (top >= 0) out[base + C.top_of! + top] = 1;
    const d = DEPTH[c]!;
    if (d >= 0) out[base + C.depth!] = (d + 1) / 10;
    if (LEGAL[c]) out[base + C.legal!] = 1;
    if (CHOSEN[c]) out[base + C.chosen!] = 1;
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
  }

  // piles
  const identities = belief.identities();
  const promptPile = prompt?.mine && 'pile' in prompt ? (prompt.pile as Seat) : null;
  const claim = prompt?.mine && prompt.kind === 'claim-pile' ? prompt : null;
  const P = PILE.col;
  for (let r = 0; r < 4; r++) {
    const base = start + PILE.offset + r * PILE.width;
    const position = at(r);
    const p = belief.at[position]!;
    const pileView = view.piles[position]!;
    out[base + P.size!] = pileView.size / 12;
    if (pileView.top) out[base + P.face_up!] = 1;
    for (let i = 0; i < IDENTITIES.length; i++) out[base + P.identity! + i] = identities[p]![i]!;
    out[base + P.unseen!] = belief.unseenIn(p) / 9;
    out[base + P.opponent_hidden!] = belief.opponentHidden[p]! / 9;
    if (view.seats[position] === 'ghost') out[base + P.ghost!] = 1;
    if (pileView.size === 0) out[base + P.empty!] = 1;
    if (LEGAL[POS(r)]) out[base + P.legal!] = 1;
    if (CHOSEN[POS(r)]) out[base + P.chosen!] = 1;
    if (promptPile === position) out[base + P.prompt!] = 1;
    if (claim) {
      const made = claim.claims.find((c) => c.from === position);
      if (made) out[base + P.claimed_for! + rel(made.claimant)] = 1;
      else out[base + P.unclaimed!] = 1;
    }
    if (history.opponentKnowsTop[p]) out[base + P.opponent_knows_top!] = 1;
    if (history.opponentKnowsOrder[p]) out[base + P.opponent_knows_order!] = 1;
    const events = history.pileEvents[p]!;
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      const cols = PILE_EVENT_COLUMNS[i]!;
      out[base + cols.kind + PILE_EVENT_INDEX[e.kind]!] = 1;
      out[base + cols.by + (e.byMe ? 0 : 1)] = 1;
      out[base + cols.age] = AGE(history.turn - e.turn);
    }
  }

  // players: me, then the opponent
  const ender = view.roundEnd?.kind === 'empty-pile' ? view.roundEnd.enderSeat : null;
  const Q = PLAYER.col;
  for (let row = 0; row < 2; row++) {
    const seat = row === 0 ? me : opp;
    const base = start + PLAYER.offset + row * PLAYER.width;
    out[base + Q.score!] = (view.scores[seat] ?? 0) / 40;
    out[base + Q.hand!] = view.hands[seat]!.count / 10;
    out[base + Q.keep_size!] = view.keeps[seat]!.cards.length / 15;
    if (seat === opp) {
      out[base + Q.known!] = belief.opponentKnown.size / 10;
      out[base + Q.hidden!] = belief.opponentHidden.reduce((a, b) => a + b, 0) / 10;
    }
    if (view.duplicityHolder === seat) out[base + Q.duplicity_holder!] = 1;
    if (view.keeps[seat]!.cards.some((c) => c.faceDown)) out[base + Q.face_down_in_keep!] = 1;
    if (view.turn?.seat === seat) out[base + Q.turn!] = 1;
    if (view.frame?.seat === seat) out[base + Q.frame!] = 1;
    if (claim?.claimant === seat) out[base + Q.fiat_claimant!] = 1;
    if (ender === seat) out[base + Q.ended_round!] = 1;
  }

  // the opponent's recent turns, newest first
  const T = TURN.col;
  history.opponentTurns.forEach((t, row) => {
    const base = start + TURN.offset + row * TURN.width;
    out[base + T.present!] = 1;
    out[base + T.age!] = AGE(history.turn - t.turn);
    out[base + T.hand_at_start!] = t.handAtStart / 10;
    out[base + T.draws!] = COUNT(t.draws);
    out[base + T.keep_to_own!] = COUNT(t.keepToOwn);
    out[base + T.keep_to_mine!] = COUNT(t.keepToMine);
    out[base + T.action_cards!] = COUNT(t.actionCards);
    out[base + T.abilities!] = COUNT(t.abilities);
    out[base + T.passes!] = COUNT(t.passes);
    out[base + T.gained!] = COUNT(t.gained);
  });

  // decision
  const D = DECISION.col;
  const base = start + DECISION.offset;
  if (prompt) out[base + D.prompt! + PROMPT_INDEX[prompt.kind]!] = 1;
  if (prompt?.mine && prompt.kind === 'choose-pile') out[base + D.pile_purpose! + PILE_PURPOSES.indexOf(prompt.purpose)] = 1;
  if (prompt?.mine && prompt.kind === 'choose-player') out[base + D.player_purpose! + PLAYER_PURPOSES.indexOf(prompt.purpose)] = 1;
  if (prompt?.mine && prompt.kind === 'reveal-window') out[base + D.reason! + REASONS.indexOf(prompt.reason)] = 1;
  if (view.frame) {
    out[base + D.frame! + FRAMES.indexOf(view.frame.kind)] = 1;
    out[base + D.frame_remaining!] = Math.min(view.frame.remaining, 4) / 4;
    out[base + D.frame_by! + (view.frame.seat === me ? 0 : 1)] = 1;
  }
  if (view.turn) {
    out[base + D.actions_taken!] = Math.min(view.turn.actionsTaken, 4) / 4;
    out[base + D.turn_by! + (view.turn.seat === me ? 0 : 1)] = 1;
  }
  if (view.phase === 'post-round') out[base + D.post_round!] = 1;
  if (ender !== null) out[base + D.ender! + (ender === me ? 0 : 1)] = 1;
  out[base + D.turn_number!] = Math.min(view.turnNumber, 40) / 40;
  out[base + D.piles_total!] = view.piles.reduce((n, p) => n + p.size, 0) / 36;
  if (view.startingSeat === me) out[base + D.started!] = 1;
  for (let i = 0; i < SPECIAL_IDS.length; i++) {
    if (LEGAL[SPECIAL_IDS[i]!]) out[base + D.special_legal! + i] = 1;
    if (CHOSEN[SPECIAL_IDS[i]!]) out[base + D.special_chosen! + i] = 1;
  }
  out[base + D.prefix_length!] = prefix.length / 9;
  if (claim) {
    out[base + D.fiat_claimant! + rel(claim.claimant)] = 1;
    out[base + D.fiat_claims_left!] = claim.queue.length / 4;
  }
  return out;
}
