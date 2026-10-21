import {
  apply,
  eventsFor,
  formatReplayLog,
  formatTrace,
  puzzleById,
  puzzleState,
  replay,
  type Command,
  type ReplayLog,
  type Seat,
  type TraceEvent,
} from '@keeps/engine';
import type { Who } from './analytics.ts';

// Rule disputes: a player thinks the engine got a rule wrong. A report never
// touches the game it's about; it goes to the site's maintainer (as a PostHog
// event) with enough of the game attached to reproduce it and fix the engine.

export const DISPUTE_TEXT_MAX = 4000;
export const DISPUTE_CONTACT_MAX = 200;
const COMMANDS_MAX = 2000;
const TRACE_LINES = 80;

/** What the browser sends to POST /dispute. */
export interface DisputeRequest {
  text: string;
  contact?: string;
  /** The reporter's name, for puzzles and pass-and-play (online games know it). */
  name?: string;
  /** The browser's anonymous id, to link the report to its session recording. */
  client?: string;
  context:
    | { mode: 'online'; room: string; token: string }
    | { mode: 'puzzle'; puzzle: string; commands: { seat: Seat; command: Command }[] }
    | { mode: 'hotseat'; replay: ReplayLog };
}

/** What an online room tells us about the reporter and their game. */
export interface OnlineDisputeInfo {
  name: string;
  seat: Seat | null;
  client: string | null;
  game: { round: number; phase: string; log: ReplayLog; events: TraceEvent[] } | null;
}

export type DisputeResult = { ok: true; who: Omit<Who, 'ip'>; properties: Record<string, unknown> } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const clientId = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null);
const tail = (events: TraceEvent[]) => formatTrace(eventsFor(events, 'server').slice(-TRACE_LINES));

/**
 * Validates a dispute and gathers what the maintainer needs: the text, how to
 * reach the reporter, and the game (replay log and the end of its trace).
 */
export function buildDispute(
  body: unknown,
  findOnline: (room: string, token: string) => OnlineDisputeInfo | null,
): DisputeResult {
  if (!isObject(body)) return { ok: false, error: 'Malformed report.' };
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return { ok: false, error: 'Please describe what happened.' };
  if (text.length > DISPUTE_TEXT_MAX) return { ok: false, error: `Please keep it under ${DISPUTE_TEXT_MAX} characters.` };
  const contact = typeof body.contact === 'string' ? body.contact.trim().slice(0, DISPUTE_CONTACT_MAX) : '';
  const context = body.context;
  if (!isObject(context)) return { ok: false, error: 'Malformed report.' };
  const base = { text, contact: contact || null, mode: context.mode };

  switch (context.mode) {
    case 'online': {
      const info = typeof context.room === 'string' && typeof context.token === 'string' ? findOnline(context.room.toUpperCase(), context.token) : null;
      if (!info) return { ok: false, error: 'That game is no longer on the server.' };
      return {
        ok: true,
        who: { id: info.client ?? clientId(body.client) ?? `room:${context.room}`, name: info.name },
        properties: {
          ...base,
          room: String(context.room).toUpperCase(),
          seat: info.seat,
          ...(info.game
            ? { round: info.game.round, phase: info.game.phase, replay: formatReplayLog(info.game.log), trace_tail: tail(info.game.events) }
            : { phase: 'lobby' }),
        },
      };
    }
    case 'puzzle': {
      const puzzle = typeof context.puzzle === 'string' ? puzzleById(context.puzzle) : undefined;
      if (!puzzle || !Array.isArray(context.commands) || context.commands.length > COMMANDS_MAX) {
        return { ok: false, error: 'Malformed report.' };
      }
      // Replay the moves to reconstruct exactly what the reporter saw.
      let state = puzzleState(puzzle);
      const events: TraceEvent[] = [];
      let failure: string | null = null;
      for (const [i, entry] of (context.commands as { seat: Seat; command: Command }[]).entries()) {
        const result = isObject(entry) ? apply(state, entry.seat, entry.command) : null;
        if (!result?.ok) {
          failure = `move ${i + 1} was rejected${result && !result.ok ? `: ${result.error.message}` : ''}`;
          break;
        }
        state = result.state;
        events.push(...result.events);
      }
      return {
        ok: true,
        who: { id: clientId(body.client) ?? 'puzzle-player', name: playerName(body.name) },
        properties: {
          ...base,
          puzzle: puzzle.id,
          puzzle_title: puzzle.title,
          round: state.round,
          phase: state.phase,
          moves: JSON.stringify(context.commands),
          trace_tail: tail(events),
          ...(failure ? { replay_problem: failure } : {}),
        },
      };
    }
    case 'hotseat': {
      const log = context.replay;
      if (!isObject(log) || !isObject(log.options) || !Array.isArray(log.commands) || log.commands.length > COMMANDS_MAX) {
        return { ok: false, error: 'Malformed report.' };
      }
      let result;
      try {
        result = replay(log as unknown as ReplayLog);
      } catch {
        return { ok: false, error: 'Malformed report.' };
      }
      return {
        ok: true,
        who: { id: clientId(body.client) ?? 'hotseat-player', name: playerName(body.name) },
        properties: {
          ...base,
          round: result.state.round,
          phase: result.state.phase,
          replay: formatReplayLog(log as unknown as ReplayLog),
          trace_tail: tail(result.events),
          ...(result.failure ? { replay_problem: `move ${result.failure.index + 1} was rejected: ${result.failure.error.message}` } : {}),
        },
      };
    }
    default:
      return { ok: false, error: 'Malformed report.' };
  }
}

function playerName(name: unknown): string {
  return (typeof name === 'string' && name.trim().slice(0, 40)) || 'Anonymous';
}

/** Allows `limit` reports per IP per `windowMs`. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  allow(key: string, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
