import type { ClientMessage, ServerMessage } from '@keeps/protocol';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { VisitorLog } from '../src/admin.ts';
import { RateLimiter } from '../src/dispute.ts';
import { createKeepsServer, type KeepsServer, type ServerOptions } from '../src/server.ts';

// Nothing on the server may grow forever: rooms end, sockets close, logs are
// bounded, and replay files make way when the disk fills. Bad input mustn't
// crash the process (that would end every game).

const HOUR = 60 * 60 * 1000;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function start(options: Partial<ServerOptions> = {}): Promise<{ server: KeepsServer; base: string }> {
  const server = await createKeepsServer({ port: 0, cardsDir: join(import.meta.dirname, '../../../cards'), ...options });
  cleanups.push(() => server.close());
  const address = server.http.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { server, base: `localhost:${address.port}` };
}

class Client {
  socket: WebSocket;
  messages: ServerMessage[] = [];
  closed: Promise<void>;

  constructor(base: string, ip = '203.0.113.1') {
    this.socket = new WebSocket(`ws://${base}/ws`, { headers: { 'fly-client-ip': ip } });
    this.socket.on('message', (data) => this.messages.push(JSON.parse(String(data)) as ServerMessage));
    this.closed = new Promise((resolve) => this.socket.once('close', () => resolve()));
    cleanups.push(() => {
      this.socket.terminate();
    });
  }

  open(): Promise<void> {
    return new Promise((resolve) => this.socket.once('open', () => resolve()));
  }

  send(message: ClientMessage | string): void {
    this.socket.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  async next<T extends ServerMessage['t']>(t: T): Promise<Extract<ServerMessage, { t: T }>> {
    for (let i = 0; i < 200; i++) {
      const found = this.messages.find((m) => m.t === t);
      if (found) {
        this.messages.splice(this.messages.indexOf(found), 1);
        return found as Extract<ServerMessage, { t: T }>;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no ${t}; got ${this.messages.map((m) => m.t).join(', ')}`);
  }
}

async function host(base: string, ip?: string): Promise<{ client: Client; code: string; token: string }> {
  const client = new Client(base, ip);
  await client.open();
  client.send({ t: 'create', name: 'Host' });
  const { code, token } = await client.next('welcome');
  return { client, code, token };
}

function get(base: string, path: string): Promise<number> {
  const [hostname, port] = base.split(':');
  return new Promise((resolve, reject) => {
    request({ hostname, port: Number(port), path }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    })
      .on('error', reject)
      .end();
  });
}

describe('rooms end', () => {
  it('an empty room is deleted after 2 hours idle', async () => {
    const { server, base } = await start();
    const { client, code } = await host(base);
    client.socket.close();
    await client.closed;
    await new Promise((resolve) => setTimeout(resolve, 20));

    server.sweep(Date.now() + 1.9 * HOUR);
    expect(server.rooms.has(code)).toBe(true);
    server.sweep(Date.now() + 2.1 * HOUR);
    expect(server.rooms.has(code)).toBe(false);
  });

  it('a room nobody has touched in 6 hours is closed even with a tab still open, and that tab is told and disconnected', async () => {
    const { server, base } = await start();
    const { client, code } = await host(base);

    server.sweep(Date.now() + 5 * HOUR);
    expect(server.rooms.has(code)).toBe(true);
    server.sweep(Date.now() + 6.1 * HOUR);
    expect(server.rooms.has(code)).toBe(false);
    await client.next('gone');
    await client.closed;
  });
});

describe('connections', () => {
  it('a seat taken over by another connection closes the old one, so it cannot keep the room alive', async () => {
    const { base } = await start();
    const { client, code, token } = await host(base);
    const other = new Client(base);
    await other.open();
    other.send({ t: 'resume', code, token });
    await other.next('welcome');
    await client.next('replaced');
    await client.closed;
  });

  it('an oversized message closes that connection without crashing the server', async () => {
    const { server, base } = await start();
    const { client, code } = await host(base);
    client.send('x'.repeat(100 * 1024));
    await client.closed;
    expect(await get(base, '/health')).toBe(200);
    expect(server.rooms.has(code)).toBe(true);
  });

  it('a malformed URL gets a 400, not a crash', async () => {
    const { base } = await start();
    expect(await get(base, '/%E0%A4%A')).toBe(400);
    expect(await get(base, '/health')).toBe(200);
  });
});

describe('replay files', () => {
  it('when the disk runs low, finished games are deleted but the running game is kept', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'keeps-data-'));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    let low = false;
    const { server, base } = await start({ dataDir, diskSpace: () => ({ free: low ? 5 : 90, total: 100 }) });

    const { client, code } = await host(base);
    const guest = new Client(base);
    await guest.open();
    guest.send({ t: 'join', code, name: 'Guest' });
    await guest.next('welcome');
    client.send({ t: 'start' });
    await client.next('game');
    const dir = join(dataDir, 'replays');
    const [live] = readdirSync(dir);
    expect(live).toMatch(new RegExp(`^${code}-`));

    const old = join(dir, 'OLDX-2026-01-01T00-00-00-000Z.jsonl');
    writeFileSync(old, '{"options":{}}\n');
    utimesSync(old, new Date(0), new Date(0));

    server.sweep();
    expect(existsSync(old)).toBe(true);
    low = true;
    server.sweep();
    expect(existsSync(old)).toBe(false);
    expect(readdirSync(dir)).toEqual([live]);
  });
});

describe('bounded bookkeeping', () => {
  it('the visitor log keeps the most recently seen IPs and a few names each', () => {
    const log = new VisitorLog(3, 2);
    for (const ip of ['a', 'b', 'c', 'd']) log.record(ip, 'x', 1);
    log.record('b', 'y', 2);
    log.record('b', 'z', 3);
    expect(log.size).toBe(3);
    const top = log.top();
    expect(top.map((v) => v.ip).sort()).toEqual(['b', 'c', 'd']);
    expect(top.find((v) => v.ip === 'b')!.names).toEqual(['x', 'y']);
  });

  it('the rate limiter forgets IPs once their window has passed', () => {
    const limiter = new RateLimiter(2, 1000);
    limiter.allow('a', 0);
    limiter.allow('b', 900);
    limiter.prune(1500);
    expect(limiter.size).toBe(1);
    limiter.prune(2000);
    expect(limiter.size).toBe(0);
  });
});

describe('rule disputes', () => {
  it('a report the engine chokes on gets an error reply, not a crash', async () => {
    const { base } = await start();
    const [hostname, port] = base.split(':');
    const body = JSON.stringify({ text: 'hi', context: { mode: 'puzzle', puzzle: 'P-01', commands: [{ seat: 99, command: { t: 'answer', prompt: 'x', choice: { nonsense: true } } }] } });
    const status = await new Promise<number>((resolve, reject) => {
      request({ hostname, port: Number(port), path: '/dispute', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
        .on('error', reject)
        .end(body);
    });
    expect([200, 500]).toContain(status);
    expect(await get(base, '/health')).toBe(200);
  });
});

describe('build id', () => {
  it("tells browsers which build of the site it serves, from the web build's build-id.txt", async () => {
    const webDir = mkdtempSync(join(tmpdir(), 'keeps-web-'));
    cleanups.push(() => rmSync(webDir, { recursive: true, force: true }));
    writeFileSync(join(webDir, 'index.html'), '<!doctype html>');
    writeFileSync(join(webDir, 'build-id.txt'), 'build-42\n');
    const { base } = await start({ webDir });
    const client = new Client(base);
    await client.open();
    client.send({ t: 'create', name: 'X' });
    expect((await client.next('welcome')).build).toBe('build-42');
  });

  it('says nothing about builds without a web build', async () => {
    const { base } = await start();
    const client = new Client(base);
    await client.open();
    client.send({ t: 'create', name: 'X' });
    expect((await client.next('welcome')).build).toBeUndefined();
  });
});
