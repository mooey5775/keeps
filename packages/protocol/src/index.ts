import type { Command, PlayerView, Seat, TraceEvent } from '@keeps/engine';

// Messages between the browser and the server, over one WebSocket.

export interface Settings {
  /** Victory marks needed to win the game. */
  marksToWin: number;
  /**
   * Who takes the first turn of round 1: a random player, or one chosen by the
   * host (by player id). Back to random if the chosen player leaves.
   */
  firstPlayer: 'random' | { player: string };
  /** How hard the bot plays, where the server offers a choice (RoomSummary.botLevels); absent: hard. */
  botLevel?: BotLevel;
}

/** The bot's difficulty: its network's own move (easy), or searched over few worlds (medium) or many (hard). */
export type BotLevel = 'easy' | 'medium' | 'hard';
export const BOT_LEVELS: readonly BotLevel[] = ['easy', 'medium', 'hard'];

export const DEFAULT_SETTINGS: Settings = { marksToWin: 3, firstPlayer: 'random' };

export interface RoomPlayer {
  id: string;
  name: string;
  connected: boolean;
  host: boolean;
  /** Seat at the table once a game starts; null in the lobby or for spectators. */
  seat: Seat | null;
  /** A computer player (two-player games only). */
  bot?: boolean;
}

export interface RoomSummary {
  code: string;
  phase: 'lobby' | 'game';
  players: RoomPlayer[];
  settings: Settings;
  /** The receiving player's id. */
  you: string;
  /** Whether this server can add a bot player. */
  botAvailable: boolean;
  /** Whether the host can choose the bot's difficulty (Settings.botLevel). */
  botLevels?: boolean;
  /** Whether your training mode is on: in games against the bot, its suggestion for your moves. */
  training?: boolean;
}

/** Training mode: a move and how likely the bot's network is to play it in your seat. */
export interface Hint {
  command: Command;
  probability: number;
  /** When the bot searched your move (played it out in sampled deals): its chance of winning the round with it, 0..1. */
  win?: number;
}

/**
 * After a round of a game against the bot: how it went, move by move, for one player (sent only once
 * the round is over: it shows what was hidden). Filled in as the server works it out (`pending`).
 * Chances are of winning the round, 0..1, for the player the review is for; null until worked out.
 */
export interface RoundReview {
  /** The game it belongs to (a new game starts a new set of reviews). */
  game: string;
  round: number;
  /** The player it's for. */
  seat: Seat;
  /** Pieces of work still to do (0: complete). */
  pending: number;
  /** Who won the round (null: nobody), and the coins each seat ended with (null: not a player). */
  winner: Seat | null;
  scores: (number | null)[];
  /** After each move of the round: who moved, what happened (as this player's log showed it) and their chance of winning. */
  moves: {
    turn: number;
    seat: Seat;
    events: TraceEvent[];
    /** Played out with every card known. */
    truth: number | null;
    /** As this player could tell. */
    mine: number | null;
    /** As the other player could tell. */
    theirs: number | null;
  }[];
  /** Each decision with a choice (both players'): the options, best first by what the decider knew. */
  decisions: {
    /** The move it made (index into `moves`). */
    move: number;
    seat: Seat;
    options: {
      label: string;
      /** The decider's chance of winning with it: from what they knew, and with every card known. */
      known: number | null;
      truth: number | null;
      played: boolean;
    }[];
    /** This player's decisions only, once clear: how the move played compares with the best. */
    verdict: 'best' | 'mistake' | 'mistake-worked-out' | 'blunder' | 'unlucky' | null;
  }[];
}

export interface UndoState {
  /** Whether a proposal could be made now (there is something to undo this round). */
  available: boolean;
  /** Player who proposed undoing the last move, if a vote is open. */
  proposedBy: string | null;
  /** Player ids that have accepted so far. */
  accepted: string[];
  /** Player ids whose acceptance is still needed. */
  waitingOn: string[];
}

/** `client` is an anonymous id for the browser (for analytics), optional. */
export type ClientMessage =
  /** `bot`: add a bot player to the new room straight away. */
  | { t: 'create'; name: string; client?: string; bot?: boolean }
  | { t: 'join'; code: string; name: string; client?: string }
  | { t: 'resume'; code: string; token: string; client?: string }
  | { t: 'settings'; settings: Settings }
  | { t: 'start' }
  | { t: 'command'; command: Command }
  | { t: 'propose-undo' }
  | { t: 'vote-undo'; accept: boolean }
  | { t: 'back-to-lobby' }
  /** Host, in the lobby: add a bot player (the room must be for two). */
  | { t: 'add-bot' }
  | { t: 'remove-bot' }
  /** Training mode on or off: in games against the bot, its suggestion for each of your moves. */
  | { t: 'training'; on: boolean }
  | { t: 'leave' };

export type ServerMessage =
  /** You are in a room; keep the token to resume after a disconnect. */
  /** `build`: the site build the server serves; a page from another build reloads. */
  /** `protocol`: the server's PROTOCOL (absent: from before it had one). */
  | { t: 'welcome'; code: string; token: string; playerId: string; build?: string; protocol?: number }
  | { t: 'room'; room: RoomSummary }
  | {
      t: 'game';
      view: PlayerView;
      /** New log entries you may see. With `reset`, the full log so far (replacing yours). */
      log: TraceEvent[];
      reset: boolean;
      /** Player names by seat (null for ghost seats). */
      names: (string | null)[];
      undo: UndoState;
      /**
       * Training mode: the bot's suggestion for your current decision (every legal move, most likely
       * first), worked out from your own view only. Null when you have no decision; absent when off.
       */
      hints?: Hint[] | null;
    }
  /** Games against the bot: the review of a finished round (sent again as it fills in). */
  | { t: 'review'; review: RoundReview }
  | { t: 'error'; message: string }
  /** The room no longer exists (e.g. a stale resume). */
  | { t: 'gone' }
  /** Your seat was resumed on another connection (another tab or device); this one is dropped. */
  | { t: 'replaced' };

export const NAME_MAX = 20;

/**
 * The protocol's version, sent in each welcome: a client that speaks another stops there and says which side is out of
 * date (the app, installed and not updated for months, plays on the website's server). Bump it when a message changes
 * in a way a client built before can't read: a field removed, renamed or retyped, or a new one it must have. Rather
 * than bump it, make a new field optional, and new message kinds ones an older client can pass over.
 */
export const PROTOCOL = 2; // 2: resigning (a new event and a new round end, which an app built before can't read)
export const ROOM_CODE = /^[A-Z]{4}$/;

/** A game's replay file (engine/src/replay.ts's format), by its room and when it started: "ABCD-2026-10-30T22-41-36-000Z.jsonl". The server and the app keep games so. */
export function replayFileName(code: string, startedAt: number): string {
  return `${code}-${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}.jsonl`;
}
