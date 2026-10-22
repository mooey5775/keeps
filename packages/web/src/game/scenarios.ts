import { apply, buildPosition, legalCommands, type Answer, type Command, type GameState, type PositionSpec } from '@keeps/engine';

// Fixed positions for looking at the table UI, one per kind of decision, shown
// at /sandbox/<name> (unlisted). The screenshot script uses them to compare the
// UI before and after a change. Ann (seat 0) is always the one deciding.

export const SANDBOX_NAMES = ['Ann', 'Bo', 'Cy', 'Di'];

export interface Scenario {
  name: string;
  title: string;
  spec: PositionSpec;
  /** Answers Ann gives to reach the decision, matched against the legal ones. */
  steps?: ((answer: Answer) => boolean)[];
}

const plays = (card: string) => (a: Answer) => a.kind === 'action' && a.choice.action === 'play' && a.choice.card === card;
const pile = (seat: number) => (a: Answer) => a.kind === 'choose-pile' && a.pile === seat;
const ability = (card: string) => (a: Answer) => a.kind === 'action' && a.choice.action === 'ability' && a.choice.card === card;

export const SCENARIOS: Scenario[] = [
  {
    name: 'turn',
    title: 'A turn with many choices',
    spec: {
      hands: { 0: ['dagger', 'chalice', 'medallion', 'fool-token'] },
      keeps: { 0: ['juggling', 'sanction', 'acquisition', 'blunder'] },
      piles: { 0: ['?', '?', '?'], 1: ['?', '?'], 2: ['?', '?', '?', '?'], 3: ['?'] },
      turn: 0,
    },
  },
  {
    name: 'acquisition',
    title: 'Acquisition',
    spec: {
      hands: { 0: ['dagger', 'chalice', 'timepiece'] },
      keeps: { 0: ['acquisition'] },
      piles: { 1: ['?', '?'], 3: ['?', '?', '?'] },
      turn: 0,
    },
  },
  {
    name: 'providence',
    title: 'Providence',
    spec: {
      hands: { 0: ['providence'] },
      keeps: { 0: ['scepter', 'dagger', 'sanction'], 1: ['juggling', 'shackles'], 2: ['interest', 'fool-token', 'royal-favor'], 3: ['chalice'] },
      piles: { 0: ['?'], 1: ['?'], 2: ['?'], 3: ['?'] },
      turn: 0,
    },
    steps: [plays('providence')],
  },
  {
    name: 'tithes',
    title: 'Tithes',
    spec: {
      keeps: { 0: ['tithes', 'chalice'] },
      piles: { 0: ['sanction', 'providence', 'purity', 'friar-token', 'epiphany'], 1: ['?'] },
      turn: 0,
    },
    steps: [ability('tithes')],
  },
  {
    name: 'requisition',
    title: 'Requisition',
    spec: {
      hands: { 0: ['requisition'] },
      piles: { 0: ['?'], 1: ['dagger', 'royal-favor', 'timepiece', 'interest', 'count-token', 'faberge-egg', 'medallion'], 2: ['?'], 3: ['?'] },
      turn: 0,
    },
    steps: [plays('requisition'), pile(1)],
  },
  {
    name: 'epiphany',
    title: 'Epiphany',
    spec: {
      hands: { 0: ['epiphany'] },
      piles: { 0: ['?'], 1: ['blunder', '?'], 2: ['last-laugh', '?'], 3: ['chalice', '?'] },
      turn: 0,
    },
    steps: [plays('epiphany')],
  },
  {
    name: 'prayer',
    title: 'Prayer',
    spec: {
      hands: { 0: ['prayer'] },
      piles: { 0: ['?'], 1: ['?'], 2: ['dagger', '?', '?'], 3: ['?'] },
      turn: 0,
    },
    steps: [plays('prayer'), pile(2)],
  },
  {
    name: 'resurrection',
    title: 'Resurrection',
    spec: {
      hands: { 0: ['resurrection'] },
      discard: ['pluck', 'pickpocket', 'count-token', 'tithes', 'fool-token', 'invocation', 'pandemonium'],
      piles: { 0: ['?'], 1: ['?'], 2: ['?'], 3: ['?'] },
      turn: 0,
    },
    steps: [plays('resurrection')],
  },
  {
    name: 'pluck',
    title: 'Pluck',
    spec: {
      hands: { 0: ['pluck'], 1: ['timepiece', 'providence'], 2: ['retribution', 'chalice'], 3: [] },
      piles: { 0: ['?'], 1: ['?'], 2: ['?'], 3: ['?'] },
      turn: 0,
    },
    steps: [plays('pluck')],
  },
  {
    name: 'legerdemain',
    title: 'Legerdemain',
    spec: {
      hands: { 0: ['legerdemain'], 1: ['?', '?'], 2: ['?'], 3: ['?', '?', '?'] },
      piles: { 0: ['?'], 1: ['?'], 2: ['?'], 3: ['?'] },
      turn: 0,
    },
    steps: [plays('legerdemain')],
  },
];

/** The scenario's position, after Ann's steps. */
export function scenarioState(scenario: Scenario): GameState {
  let state = buildPosition({ fill: 'quiet', ...scenario.spec });
  for (const step of scenario.steps ?? []) {
    const command = legalCommands(state, 0).find((c): c is Extract<Command, { type: 'answer' }> => c.type === 'answer' && step(c.answer));
    if (!command) throw new Error(`${scenario.name}: no legal command for a step`);
    const result = apply(state, 0, command);
    if (!result.ok) throw new Error(`${scenario.name}: ${result.error.message}`);
    state = result.state;
  }
  return state;
}
