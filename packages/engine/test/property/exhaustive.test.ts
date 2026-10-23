import { describe, expect, it } from 'vitest';
import {
  apply,
  buildPosition,
  CARD_IDS,
  legalCommands,
  playerSeats,
  viewFor,
  type CardId,
  type GameState,
  type PositionSpec,
  type Seat,
} from '../../src/index.ts';

// Breadth-first exploration of every legal command, from every seat, for a
// few moves, starting from positions packed with interacting cards. Random
// play rarely picks any one option; this tries all of them near each start.
// At every node: each listed command is accepted (apply() also checks every
// invariant), and no player's view shows a card they may not see.

/** Card ids `seat` may see right now (see full-games.test.ts). */
function entitled(state: GameState, seat: Seat): Set<CardId> {
  const ok = new Set<CardId>([...state.hands[seat], ...state.discard]);
  // Face-down cards: the placer's; everyone's once the round is over.
  const over = state.phase === 'round-over' || state.phase === 'game-over';
  for (const keep of state.keeps) for (const c of keep) if (!c.faceDown || c.faceDown.placedBy === seat || over) ok.add(c.id);
  for (const pile of Object.values(state.piles)) if (pile.cards[0]?.faceUp) ok.add(pile.cards[0].id);
  for (const p of state.prompts) {
    if (p.seat !== seat) continue;
    if (p.kind === 'choose-pile-card' || p.kind === 'order-pile') p.cards.forEach((c) => ok.add(c));
    if (p.kind === 'choose-top-card' || p.kind === 'choose-hand-card') p.options.forEach((o) => ok.add(o.card));
    if (p.kind === 'take-or-discard') ok.add(p.card);
  }
  return ok;
}

function explore(start: GameState, budget: number): { nodes: number; maxDepth: number; outcomes: Set<string> } {
  const queue: { state: GameState; depth: number }[] = [{ state: start, depth: 0 }];
  let nodes = 0;
  let maxDepth = 0;
  const outcomes = new Set<string>();
  while (queue.length > 0 && nodes < budget) {
    const { state, depth } = queue.shift()!;
    nodes++;
    maxDepth = Math.max(maxDepth, depth);
    outcomes.add(state.phase);
    for (const seat of playerSeats(state)) {
      // frame.kind can be 'hocus-pocus' etc., a frame kind rather than a card.
      const { frame: _frame, ...view } = viewFor(state, seat);
      const json = JSON.stringify(view);
      const allowed = entitled(state, seat);
      const leaked = CARD_IDS.filter((id) => json.includes(`"${id}"`) && !allowed.has(id));
      expect(leaked, `S${seat} sees hidden cards at depth ${depth}`).toEqual([]);
    }
    if (state.phase !== 'playing' && state.phase !== 'post-round') continue;
    for (const seat of playerSeats(state)) {
      for (const command of legalCommands(state, seat)) {
        const result = apply(state, seat, command);
        if (!result.ok) expect.fail(`depth ${depth}: S${seat} ${JSON.stringify(command)} rejected: ${result.error.message}`);
        queue.push({ state: result.state, depth: depth + 1 });
      }
    }
  }
  return { nodes, maxDepth, outcomes };
}

const POSITIONS: Record<string, PositionSpec> = {
  'theft and retaliation': {
    hands: { 0: ['legerdemain', 'joker', 'providence', 'hocus-pocus'], 1: ['offering', 'chalice'], 2: ['pluck'], 3: ['pickpocket', 'dagger'] },
    keeps: {
      1: ['retribution', 'interest', { id: 'scepter', faceDown: { placedBy: 2 } }],
      2: ['duplicity', 'last-laugh'],
      3: ['tithes', 'royal-favor', 'shackles'],
    },
    piles: { 0: ['invocation', 'medallion'], 1: ['blunder', 'timepiece'], 2: ['pandemonium'], 3: ['fiat', 'faberge-egg'] },
    discard: ['resurrection', 'prayer'],
    turn: 0,
  },
  'the round about to end': {
    hands: { 0: ['requisition', 'epiphany'], 1: ['count-token'], 2: ['hocus-pocus', 'friar-token'] },
    keeps: {
      0: ['last-laugh', 'sanction', 'acquisition'],
      1: ['fool-token', 'purity'],
      2: ['duplicity', { id: 'retribution', faceDown: { placedBy: 2 } }],
      3: ['interest', 'juggling'],
    },
    piles: { 0: [], 1: ['revelation'], 2: [{ id: 'blunder', faceUp: true }], 3: ['invocation', 'royal-favor'] },
    discard: ['legerdemain', 'pluck'],
    turn: 0,
  },
  'two players and their ghosts': {
    seats: ['player', 'ghost', 'player', 'ghost'],
    hands: { 0: ['prayer', 'resurrection', 'joker'], 2: ['pickpocket', 'tithes', 'chalice'] },
    keeps: { 0: ['acquisition', 'juggling', 'blunder'], 2: ['retribution', 'interest', 'last-laugh'] },
    piles: { 0: ['fiat', 'dagger'], 1: ['pandemonium', 'revelation'], 2: ['royal-favor'], 3: ['invocation', 'hocus-pocus'] },
    discard: ['offering'],
    turn: 0,
  },
  'tokens in reach': {
    hands: { 0: ['providence', 'legerdemain', 'count-token'], 3: ['joker', 'requisition'] },
    keeps: { 0: ['fool-token', 'duplicity'], 1: ['interest', { id: 'friar-token', faceDown: { placedBy: 0 } }], 2: ['retribution'] },
    piles: { 0: ['offering'], 1: ['sanction', 'shackles'], 2: ['epiphany'], 3: ['purity'] },
    turn: 0,
  },
};

describe('exhaustive exploration near dense positions', () => {
  for (const [name, spec] of Object.entries(POSITIONS)) {
    it(name, () => {
      const { nodes, maxDepth } = explore(buildPosition({ ...spec, fill: 'quiet' }), 3000);
      expect(nodes).toBeGreaterThan(100);
      expect(maxDepth).toBeGreaterThanOrEqual(2);
    });
  }
});
