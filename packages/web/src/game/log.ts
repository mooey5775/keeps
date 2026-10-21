import { describe, type Seat, type TraceEvent } from '@keeps/engine';
import type { Names } from './options.ts';

// The game log: the engine's trace (already filtered for this player by the
// server), minus bookkeeping events, with seat labels turned into names.

const HIDDEN: ReadonlySet<TraceEvent['payload']['type']> = new Set([
  'prompt',
  'action',
  'pile-dealt',
  'pile-placed',
  'turn-end',
  'triggers',
  'game-start',
]);

export interface LogLine {
  seq: number;
  depth: number;
  text: string;
  /** Turn and round headers stand out. */
  heading: boolean;
}

export function logLines(events: readonly TraceEvent[], names: Names): LogLine[] {
  const lines: LogLine[] = [];
  let baseDepth = 0;
  for (const e of events) {
    const type = e.payload.type;
    if (HIDDEN.has(type)) continue;
    const heading = type === 'turn-start' || type === 'round-start' || type === 'round-end' || type === 'game-over';
    if (type === 'turn-start') baseDepth = e.depth + 1;
    lines.push({ seq: e.seq, depth: heading ? 0 : Math.max(0, e.depth - baseDepth), text: humanize(describe(e.payload), names), heading });
  }
  return lines;
}

/** Replaces the trace's seat labels (S0, pile@S1, keep(S2)) with names. */
export function humanize(text: string, names: Names): string {
  const seat = (n: string) => names.seat(Number(n) as Seat);
  const possessive = (n: string) => names.possessive(Number(n) as Seat);
  const out = text
    .replace(/pile@S([0-3])/g, (_, n: string) => `${possessive(n)} pile`)
    .replace(/keep\(S([0-3])\)/g, (_, n: string) => `${possessive(n)} keep`)
    .replace(/@S([0-3])/g, (_, n: string) => `${possessive(n)} spot`)
    .replace(/\bS([0-3])\b/g, (_, n: string) => seat(n));
  return out.charAt(0).toUpperCase() + out.slice(1);
}
