import type { Command, PlayerView, Seat, TraceEvent } from '@keeps/engine';

// Messages between the browser and the server, over one WebSocket.

export interface Settings {
  /** Victory marks needed to win the game. */
  marksToWin: number;
  /** Who takes the first turn of round 1: the host, or a random player. */
  firstPlayer: 'random' | 'host';
}

export const DEFAULT_SETTINGS: Settings = { marksToWin: 3, firstPlayer: 'random' };

export interface RoomPlayer {
  id: string;
  name: string;
  connected: boolean;
  host: boolean;
  /** Seat at the table once a game starts; null in the lobby or for spectators. */
  seat: Seat | null;
}

export interface RoomSummary {
  code: string;
  phase: 'lobby' | 'game';
  players: RoomPlayer[];
  settings: Settings;
  /** The receiving player's id. */
  you: string;
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

export type ClientMessage =
  | { t: 'create'; name: string }
  | { t: 'join'; code: string; name: string }
  | { t: 'resume'; code: string; token: string }
  | { t: 'settings'; settings: Settings }
  | { t: 'start' }
  | { t: 'command'; command: Command }
  | { t: 'propose-undo' }
  | { t: 'vote-undo'; accept: boolean }
  | { t: 'back-to-lobby' }
  | { t: 'leave' };

export type ServerMessage =
  /** You are in a room; keep the token to resume after a disconnect. */
  | { t: 'welcome'; code: string; token: string; playerId: string }
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
    }
  | { t: 'error'; message: string }
  /** The room no longer exists (e.g. a stale resume). */
  | { t: 'gone' };

export const NAME_MAX = 20;
export const ROOM_CODE = /^[A-Z]{4}$/;
