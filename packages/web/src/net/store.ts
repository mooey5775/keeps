import type { Command, PlayerView, TraceEvent } from '@keeps/engine';
import type { ClientMessage, Hint, RoomSummary, RoundReview, ServerMessage, Settings, UndoState } from '@keeps/protocol';
import { useSyncExternalStore } from 'react';
import { markReloadedFor, onServerBuild, PAGE_BUILD, reloadedFor } from './build.ts';

// The connection to the game server: one WebSocket per tab, reconnecting
// automatically and resuming the seat with the token saved for that room.

export interface NetGame {
  view: PlayerView;
  log: TraceEvent[];
  names: (string | null)[];
  undo: UndoState;
  /** Training mode: the bot's suggestion for your current decision (null: off, or not your decision). */
  hints: Hint[] | null;
}

export interface RoomState {
  /** 'replaced': this seat was taken over by another tab or device. */
  status: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'gone' | 'replaced';
  code: string | null;
  playerId: string | null;
  room: RoomSummary | null;
  game: NetGame | null;
  /** Games against the bot: the reviews of this game's finished rounds, by round. */
  reviews: RoundReview[];
  error: { id: number; message: string } | null;
}

const initial: RoomState = { status: 'idle', code: null, playerId: null, room: null, game: null, reviews: [], error: null };

// Seat tokens. Each tab keeps its own (sessionStorage survives a reload), so
// a second tab in the same browser can join as a different player. The
// browser also remembers the latest one (localStorage), to come back after
// the browser was closed.
const tokenKey = (code: string) => `keeps:token:${code}`;

function read(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

/** This tab's seat in the room, if it has one. */
export function tabToken(code: string): string | null {
  return read(() => sessionStorage, tokenKey(code));
}

/** The seat this browser last had in the room, from any tab. */
export function browserToken(code: string): string | null {
  return read(() => localStorage, tokenKey(code));
}

function saveToken(code: string, token: string): void {
  for (const storage of [() => sessionStorage, () => localStorage]) {
    try {
      storage().setItem(tokenKey(code), token);
    } catch {
      // Private mode: the seat just can't be resumed after a reload.
    }
  }
}

function forgetToken(code: string): void {
  for (const storage of [() => sessionStorage, () => localStorage]) {
    try {
      storage().removeItem(tokenKey(code));
    } catch {
      // ignore
    }
  }
}

/**
 * A random, anonymous id for this browser, so analytics can count returning
 * players across rooms. It identifies nothing but this browser's storage.
 */
export function clientId(): string {
  try {
    const existing = localStorage.getItem('keeps:client');
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem('keeps:client', id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

// Tabs of this browser tell each other which room they are in, so a new tab
// can ask before taking over a seat another tab is using.
const tabs = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('keeps-tabs');

/** Whether another open tab of this browser is in room `code` right now. */
export function otherTabInRoom(code: string): Promise<boolean> {
  if (!tabs) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent<{ here?: string }>) => {
      if (event.data.here === code) {
        tabs.removeEventListener('message', onMessage);
        resolve(true);
      }
    };
    tabs.addEventListener('message', onMessage);
    tabs.postMessage({ who: code });
    setTimeout(() => {
      tabs.removeEventListener('message', onMessage);
      resolve(false);
    }, 250);
  });
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

  /** Creates a room (with `bot`, the bot is added to it straight away). */
  create(name: string, { bot = false }: { bot?: boolean } = {}): void {
    this.connect({ t: 'create', name, client: clientId(), ...(bot ? { bot: true } : {}) });
  }

  join(code: string, name: string): void {
    this.connect({ t: 'join', code, name, client: clientId() });
  }

  /** Resumes a seat by token (default: this tab's, then this browser's). */
  resume(code: string, token = tabToken(code) ?? browserToken(code)): boolean {
    if (!token) return false;
    this.connect({ t: 'resume', code, token, client: clientId() });
    return true;
  }

  /** Training mode on or off (games against the bot): the bot's suggestion for each of your moves. */
  setTraining(on: boolean): void {
    this.send({ t: 'training', on });
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
    socket.onmessage = (event) => {
      // Ignore a socket this tab already replaced with a newer one.
      if (this.socket === socket) this.receive(JSON.parse(String(event.data)) as ServerMessage);
    };
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
      case 'welcome': {
        saveToken(message.code, message.token);
        // From now on, reconnecting means resuming this seat.
        this.hello = { t: 'resume', code: message.code, token: message.token, client: clientId() };
        this.set({ status: 'open', code: message.code, playerId: message.playerId });
        // The site was updated since this page loaded: reload into the room (the
        // seat token is saved, so it resumes), rather than run old code against it.
        const update = onServerBuild(message.build, PAGE_BUILD, reloadedFor());
        if (update === 'reload' && message.build) {
          markReloadedFor(message.build);
          this.close();
          location.assign(`/r/${message.code}`);
        } else if (update === 'ask') {
          this.set({ error: { id: ++this.errorId, message: 'Keeps was updated. Please reload this page.' } });
        }
        return;
      }
      case 'room':
        this.set({ room: message.room, ...(message.room.phase === 'lobby' ? { game: null, reviews: [] } : {}) });
        return;
      case 'review': {
        // A review of another game starts the set over.
        const others = this.state.reviews.filter((r) => r.game === message.review.game && r.round !== message.review.round);
        this.set({ reviews: [...others, message.review].sort((a, b) => a.round - b.round) });
        return;
      }
      case 'game': {
        const previous = this.state.game;
        const log = message.reset || !previous ? message.log : [...previous.log, ...message.log];
        this.set({ game: { view: message.view, log, names: message.names, undo: message.undo, hints: message.hints ?? null } });
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
      case 'replaced':
        // Another tab or device took this seat. Don't reconnect and fight over it.
        this.close();
        this.set({ status: 'replaced' });
        return;
      default:
        return message satisfies never;
    }
  }
}

export const roomStore = new RoomStore();

tabs?.addEventListener('message', (event: MessageEvent<{ who?: string }>) => {
  const { code, status } = roomStore.get();
  if (event.data.who && event.data.who === code && (status === 'open' || status === 'reconnecting')) {
    tabs.postMessage({ here: code });
  }
});

export function useRoomState(): RoomState {
  return useSyncExternalStore(roomStore.subscribe, roomStore.get);
}
