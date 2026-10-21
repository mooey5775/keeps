import type { Command, PlayerView, TraceEvent } from '@keeps/engine';
import type { ClientMessage, RoomSummary, ServerMessage, Settings, UndoState } from '@keeps/protocol';
import { useSyncExternalStore } from 'react';

// The connection to the game server: one WebSocket per tab, reconnecting
// automatically and resuming the seat with the token saved for that room.

export interface NetGame {
  view: PlayerView;
  log: TraceEvent[];
  names: (string | null)[];
  undo: UndoState;
}

export interface RoomState {
  status: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'gone';
  code: string | null;
  playerId: string | null;
  room: RoomSummary | null;
  game: NetGame | null;
  error: { id: number; message: string } | null;
}

const initial: RoomState = { status: 'idle', code: null, playerId: null, room: null, game: null, error: null };

const tokenKey = (code: string) => `keeps:token:${code}`;

export function savedToken(code: string): string | null {
  try {
    return localStorage.getItem(tokenKey(code));
  } catch {
    return null;
  }
}

function saveToken(code: string, token: string): void {
  try {
    localStorage.setItem(tokenKey(code), token);
  } catch {
    // Private mode: the seat just can't be resumed after a reload.
  }
}

function forgetToken(code: string): void {
  try {
    localStorage.removeItem(tokenKey(code));
  } catch {
    // ignore
  }
}

class RoomStore {
  private state: RoomState = initial;
  private listeners = new Set<() => void>();
  private socket: WebSocket | null = null;
  /** First message to send on (re)connect: create, join, or resume. */
  private hello: ClientMessage | null = null;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private errorId = 0;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get = () => this.state;

  private set(patch: Partial<RoomState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  create(name: string): void {
    this.connect({ t: 'create', name });
  }

  join(code: string, name: string): void {
    this.connect({ t: 'join', code, name });
  }

  resume(code: string): boolean {
    const token = savedToken(code);
    if (!token) return false;
    this.connect({ t: 'resume', code, token });
    return true;
  }

  send(message: ClientMessage): void {
    this.socket?.send(JSON.stringify(message));
  }

  command(command: Command): void {
    this.send({ t: 'command', command });
  }

  settings(settings: Settings): void {
    this.send({ t: 'settings', settings });
  }

  /** Leaves the room and closes the connection. */
  leave(): void {
    if (this.state.code) {
      this.send({ t: 'leave' });
      if (this.state.room?.phase !== 'game') forgetToken(this.state.code);
    }
    this.close();
    this.state = initial;
    for (const l of this.listeners) l();
  }

  dismissError(): void {
    this.set({ error: null });
  }

  private close(): void {
    this.hello = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  private connect(hello: ClientMessage): void {
    this.close();
    this.hello = hello;
    this.retry = 0;
    this.set({ ...initial, status: 'connecting', code: 'code' in hello ? hello.code.toUpperCase() : null });
    this.open();
  }

  private open(): void {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${location.host}/ws`);
    this.socket = socket;
    socket.onopen = () => {
      this.retry = 0;
      if (this.hello) socket.send(JSON.stringify(this.hello));
    };
    socket.onmessage = (event) => this.receive(JSON.parse(String(event.data)) as ServerMessage);
    socket.onclose = () => {
      if (this.socket !== socket || !this.hello) return;
      // Unexpected drop: come back and resume the same seat.
      this.set({ status: 'reconnecting' });
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      this.retryTimer = setTimeout(() => this.open(), delay);
    };
  }

  private receive(message: ServerMessage): void {
    switch (message.t) {
      case 'welcome':
        saveToken(message.code, message.token);
        // From now on, reconnecting means resuming this seat.
        this.hello = { t: 'resume', code: message.code, token: message.token };
        this.set({ status: 'open', code: message.code, playerId: message.playerId });
        return;
      case 'room':
        this.set({ room: message.room, ...(message.room.phase === 'lobby' ? { game: null } : {}) });
        return;
      case 'game': {
        const previous = this.state.game;
        const log = message.reset || !previous ? message.log : [...previous.log, ...message.log];
        this.set({ game: { view: message.view, log, names: message.names, undo: message.undo } });
        return;
      }
      case 'error':
        this.set({ error: { id: ++this.errorId, message: message.message } });
        // A failed create/join leaves us without a room.
        if (!this.state.playerId) {
          this.close();
          this.set({ status: 'idle' });
        }
        return;
      case 'gone':
        if (this.state.code) forgetToken(this.state.code);
        this.close();
        this.set({ ...initial, status: 'gone' });
        return;
      default:
        return message satisfies never;
    }
  }
}

export const roomStore = new RoomStore();

export function useRoomState(): RoomState {
  return useSyncExternalStore(roomStore.subscribe, roomStore.get);
}
