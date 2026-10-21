import type { ClientMessage, ServerMessage } from '@keeps/protocol';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createKeepsServer, type KeepsServer } from '../src/server.ts';

// End to end over real sockets: create, join, start, play, reconnect.

let server: KeepsServer;
let base: string;

beforeAll(async () => {
  server = await createKeepsServer({ port: 0, cardsDir: join(import.meta.dirname, '../../../cards'), adminToken: 'sesame' });
  const address = server.http.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  base = `localhost:${address.port}`;
});

afterAll(() => server.close());

class TestClient {
  socket: WebSocket;
  messages: ServerMessage[] = [];
  private waiters: { match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];

  constructor(headers: Record<string, string> = {}) {
    this.socket = new WebSocket(`ws://${base}/ws`, { headers });
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

describe('admin page', () => {
  const auth = (password: string) => ({ authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` });

  it('asks for the password, and rejects a wrong one', async () => {
    const none = await fetch(`http://${base}/admin`);
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toContain('Basic');
    expect((await fetch(`http://${base}/admin`, { headers: auth('wrong') })).status).toBe(401);
  });

  it("lists live rooms with players' names and real IPs (from Fly-Client-IP), and the top visitors", async () => {
    const client = new TestClient({ 'fly-client-ip': '203.0.113.9' });
    await client.open();
    const welcomed = client.next('welcome');
    client.send({ t: 'create', name: 'Ada' });
    const { code } = await welcomed;

    const json = (await (await fetch(`http://${base}/admin.json`, { headers: auth('sesame') })).json()) as {
      rooms: { code: string; players: { name: string; ip: string }[] }[];
      visitors: { ip: string; names: string[]; connections: number }[];
    };
    const room = json.rooms.find((r) => r.code === code)!;
    expect(room.players).toEqual([expect.objectContaining({ name: 'Ada', ip: '203.0.113.9' })]);
    expect(json.visitors).toContainEqual(expect.objectContaining({ ip: '203.0.113.9', names: ['Ada'], connections: 1 }));

    const html = await (await fetch(`http://${base}/admin`, { headers: auth('sesame') })).text();
    expect(html).toContain(code);
    expect(html).toContain('203.0.113.9');
    await client.close();
  });

  it('escapes player names on the page', async () => {
    const client = new TestClient();
    await client.open();
    const welcomed = client.next('welcome');
    client.send({ t: 'create', name: '<img src=x onerror=alert(1)>' });
    await welcomed;
    const html = await (await fetch(`http://${base}/admin`, { headers: auth('sesame') })).text();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
    await client.close();
  });

  it("doesn't exist when no admin token is configured", async () => {
    const plain = await createKeepsServer({ port: 0, cardsDir: join(import.meta.dirname, '../../../cards') });
    const address = plain.http.address() as { port: number };
    expect((await fetch(`http://localhost:${address.port}/admin`)).status).toBe(404);
    await plain.close();
  });
});
