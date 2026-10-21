import type { Command, EngineError } from './commands.ts';
import { apply, newGame } from './engine.ts';
import type { NewGameOptions } from './setup.ts';
import type { GameState, Seat } from './state.ts';
import type { TraceEvent } from './trace.ts';

// A game is fully determined by its options (including the seed) and its
// commands, so a replay log reproduces it exactly. The server writes one per
// room; a bug report is a replay log, and a replay log becomes a regression test.

export interface ReplayLog {
  options: NewGameOptions;
  commands: { seat: Seat; command: Command }[];
}

export interface ReplayResult {
  state: GameState;
  events: TraceEvent[];
  /** The first rejected command, if any; the replay stops there. */
  failure?: { index: number; error: EngineError };
}

export function replay(log: ReplayLog): ReplayResult {
  let { state, events } = newGame(log.options);
  for (const [index, { seat, command }] of log.commands.entries()) {
    const result = apply(state, seat, command);
    if (!result.ok) return { state, events, failure: { index, error: result.error } };
    state = result.state;
    events = [...events, ...result.events];
  }
  return { state, events };
}

/** Parses the JSONL format: an options line, then one command per line. */
export function parseReplayLog(text: string): ReplayLog {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const [header, ...rest] = lines.map((l) => JSON.parse(l) as unknown);
  const options = (header as { options?: NewGameOptions } | undefined)?.options;
  if (!options) throw new Error('replay log must start with an {"options": ...} line');
  return { options, commands: rest as ReplayLog['commands'] };
}

export function formatReplayLog(log: ReplayLog): string {
  return [JSON.stringify({ options: log.options }), ...log.commands.map((c) => JSON.stringify(c))].join('\n') + '\n';
}
