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
// The iOS app sends its bug reports here too (shake to report): with the app's
// version and device, and a screenshot, which the server keeps (not PostHog).

export const DISPUTE_TEXT_MAX = 4000;
export const DISPUTE_CONTACT_MAX = 200;
const COMMANDS_MAX = 2000;
const TRACE_LINES = 80;
/** The largest screenshot kept (a JPEG, the app's, scaled down: well under this; base64, it fits the request's 512 KB). */
export const SCREENSHOT_MAX = 300 * 1024;

/** What the browser sends to POST /dispute. */
export interface DisputeRequest {
  text: string;
  contact?: string;
  /** The reporter's name, for puzzles and pass-and-play (online games know it). */
  name?: string;
  /** The browser's anonymous id, to link the report to its session recording. */
  client?: string;
  /** From the iOS app: its version, build and device. */
  app?: { version: string; build: string; device: string };
  /** From the iOS app: the screen as it was (a JPEG, base64). */
  screenshot?: string;
  context:
    | { mode: 'online'; room: string; token: string }
    | { mode: 'puzzle'; puzzle: string; commands: { seat: Seat; command: Command }[] }
    | { mode: 'hotseat'; replay: ReplayLog }
    /** The app's own game (against Midstrike, on the phone), if one is open. */
    | { mode: 'phone'; replay?: ReplayLog };
}

/** What an online room tells us about the reporter and their game. */
export interface OnlineDisputeInfo {
  name: string;
  seat: Seat | null;
  client: string | null;
  game: { round: number; phase: string; log: ReplayLog; events: TraceEvent[] } | null;
}

/** A report, ready to send: `screenshot`, the JPEG to keep (the server stores it and links it from the event). */
export type DisputeResult =
  | { ok: true; who: Omit<Who, 'ip'>; properties: Record<string, unknown>; screenshot?: Buffer }
  | { ok: false; error: string };

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
  const app = appDetails(body.app);
  const base = { text, contact: contact || null, mode: context.mode, ...app };
  let screenshot: Buffer | undefined;
  if (body.screenshot !== undefined) {
    const decoded = typeof body.screenshot === 'string' && /^[A-Za-z0-9+/=]+$/.test(body.screenshot) ? Buffer.from(body.screenshot, 'base64') : null;
    // (A JPEG's first bytes: FF D8 FF.)
    if (!decoded || decoded.length > SCREENSHOT_MAX || decoded[0] !== 0xff || decoded[1] !== 0xd8 || decoded[2] !== 0xff) {
      return { ok: false, error: 'Malformed report.' };
    }
    screenshot = decoded;
  }
  const result = gather(body, context, base, findOnline);
  return result.ok && screenshot ? { ...result, screenshot } : result;
}

/** The app's version, build and device, as event properties (none if they're not all short strings). */
function appDetails(app: unknown): Record<string, string> {
  if (!isObject(app)) return {};
  const field = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 40 ? v : null);
  const [version, build, device] = [field(app.version), field(app.build), field(app.device)];
  return version && build && device ? { app_version: version, app_build: build, device } : {};
}

/** A game's replay log, checked and replayed: its round, its phase and the end of its trace (null: malformed). */
function replayed(log: unknown): Record<string, unknown> | null {
  if (!isObject(log) || !isObject(log.options) || !Array.isArray(log.commands) || log.commands.length > COMMANDS_MAX) return null;
  let result;
  try {
    result = replay(log as unknown as ReplayLog);
  } catch {
    return null;
  }
  return {
    round: result.state.round,
    phase: result.state.phase,
    replay: formatReplayLog(log as unknown as ReplayLog),
    trace_tail: tail(result.events),
    ...(result.failure ? { replay_problem: `move ${result.failure.index + 1} was rejected: ${result.failure.error.message}` } : {}),
  };
}

function gather(
  body: Record<string, unknown>,
  context: Record<string, unknown>,
  base: Record<string, unknown>,
  findOnline: (room: string, token: string) => OnlineDisputeInfo | null,
): DisputeResult {
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
      const game = replayed(context.replay);
      if (!game) return { ok: false, error: 'Malformed report.' };
      return { ok: true, who: { id: clientId(body.client) ?? 'hotseat-player', name: playerName(body.name) }, properties: { ...base, ...game } };
    }
    case 'phone': {
      // (In the lobby, no game: the report alone.)
      const game = context.replay === undefined ? { phase: 'lobby' } : replayed(context.replay);
      if (!game) return { ok: false, error: 'Malformed report.' };
      return { ok: true, who: { id: clientId(body.client) ?? 'phone-player', name: playerName(body.name) }, properties: { ...base, ...game } };
    }
    default:
      return { ok: false, error: 'Malformed report.' };
  }
}

function playerName(name: unknown): string {
  return (typeof name === 'string' && name.trim().slice(0, 40)) || 'Anonymous';
}

/** Allows `limit` requests per key (an IP) per `windowMs`. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Forgets keys with no hits in the window, so the map doesn't grow forever. */
  prune(now: number): void {
    for (const [key, hits] of this.hits) {
      if (!hits.some((t) => now - t < this.windowMs)) this.hits.delete(key);
    }
  }

  get size(): number {
    return this.hits.size;
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
