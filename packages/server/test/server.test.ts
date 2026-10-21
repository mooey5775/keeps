import type { ClientMessage, ServerMessage } from '@keeps/protocol';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createKeepsServer, type KeepsServer } from '../src/server.ts';

// End to end over real sockets: create, join, start, play, reconnect.

let server: KeepsServer;
let base: string;

beforeAll(async () => {
  server = await createKeepsServer({ port: 0, cardsDir: join(import.meta.dirname, '../../../cards') });
  const address = server.http.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  base = `localhost:${address.port}`;
});

afterAll(() => server.close());

class TestClient {
  socket: WebSocket;
  messages: ServerMessage[] = [];
  private waiters: { match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];

  constructor() {
    this.socket = new WebSocket(`ws://${base}/ws`);
    this.socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as ServerMessage;
      this.messages.push(message);
      this.waiters = this.waiters.filter((w) => (w.match(message) ? (w.resolve(message), false) : true));
    });
  }

  open(): Promise<void> {
    return new Promise((resolve) => this.socket.once('open', () => resolve()));
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  next<T extends ServerMessage['t']>(t: T, match: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true) {
    return new Promise<Extract<ServerMessage, { t: T }>>((resolve) => {
      this.waiters.push({
        match: (m) => m.t === t && match(m as Extract<ServerMessage, { t: T }>),
        resolve: resolve as (m: ServerMessage) => void,
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.socket.once('close', () => resolve());
      this.socket.close();
    });
  }
}

describe('server', () => {
  it('serves card images, refuses path tricks, and reports health', async () => {
    const card = await fetch(`http://${base}/cards/01CountToken.png`);
    expect(card.status).toBe(200);
    expect(card.headers.get('content-type')).toBe('image/png');
    expect((await fetch(`http://${base}/cards/..%2Fpackage.json`)).status).toBe(404);
    expect(await (await fetch(`http://${base}/health`)).text()).toBe('ok');
  });

  it('runs a room from creation to the first moves, and resumes a dropped player', async () => {
    const host = new TestClient();
    await host.open();
    const welcomed = host.next('welcome');
    host.send({ t: 'create', name: 'Host' });
    const { code, token } = await welcomed;
    expect(code).toMatch(/^[A-Z]{4}$/);

    const guest = new TestClient();
    await guest.open();
    const guestWelcome = guest.next('welcome');
    guest.send({ t: 'join', code: code.toLowerCase(), name: 'Guest' });
    await guestWelcome;
    await host.next('room', (m) => m.room.players.length === 2);

    const hostGame = host.next('game');
    const guestGame = guest.next('game');
    host.send({ t: 'start' });
    const [h, g] = await Promise.all([hostGame, guestGame]);
    const mover = h.view.legal.length > 0 ? host : guest;
    const view = (mover === host ? h : g).view;

    const update = mover.next('game');
    mover.send({ t: 'command', command: view.legal[0]! });
    expect((await update).reset).toBe(false);

    // Drop the host's connection and resume with the token.
    await host.close();
    const again = new TestClient();
    await again.open();
    const resumed = again.next('game');
    again.send({ t: 'resume', code, token });
    const full = await resumed;
    expect(full.reset).toBe(true);
    expect(full.log.length).toBeGreaterThan(0);

    await Promise.all([again.close(), guest.close()]);
  });

  it('tells a client with a stale room or token that it is gone', async () => {
    const client = new TestClient();
    await client.open();
    const gone = client.next('gone');
    client.send({ t: 'resume', code: 'ZZZZ', token: 'nope' });
    await gone;
    const error = client.next('error');
    client.send({ t: 'join', code: 'ZZZZ', name: 'x' });
    expect((await error).message).toBe('No room called ZZZZ.');
    await client.close();
  });
});
