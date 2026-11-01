// The app playing on the website's server (packages/server, run here on a free port), through the core's bridge:
// rooms made and joined by their code, games played with the options and words the app gets for its own games, and a
// connection that drops coming back to its seat.
//   pnpm -C packages/server exec vitest run --dir ../../ios/core/test
import { join } from 'node:path';
import { PROTOCOL, type ClientMessage, type ServerMessage } from '../../../packages/protocol/src/index.ts';
import { createKeepsServer, type KeepsServer } from '../../../packages/server/src/server.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreBridge, type FromApp, type ToApp } from '../bridge.ts';
import { LocalServer } from '../local-server.ts';
import { remoteConnection, type LinkState } from '../remote.ts';

let server: KeepsServer;
let url: string;
beforeAll(async () => {
  server = await createKeepsServer({ port: 0, cardsDir: join(import.meta.dirname, '../../../cards') });
  const address = server.http.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  url = `ws://localhost:${address.port}/ws`;
});
afterAll(() => server.close());

/** Waits up to `ms` for `condition`. */
async function until(condition: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The core's bridge, as the app drives it: what it sends, and what comes back. */
function app() {
  const out: ToApp[] = [];
  const local = new LocalServer({ token: () => 't', id: () => 'i', seed: () => 's', random: Math.random, now: Date.now });
  const receive = coreBridge(local, (m) => out.push(structuredClone(m)), () => {});
  const send = (m: FromApp) => receive(JSON.stringify(m));
  const messages = (id: number) => out.flatMap((m) => (m.t === 'server' && m.id === id ? [m] : []));
  const last = <T extends ServerMessage['t']>(id: number, t: T) =>
    messages(id).findLast((m) => m.message.t === t) as (Extract<ToApp, { t: 'server' }> & { message: Extract<ServerMessage, { t: T }> }) | undefined;
  return { out, send, messages, last };
}

describe('the app on a game server elsewhere', () => {
  it('makes a room, is joined by its code, and plays there with the options and words of its own games', async () => {
    const a = app();
    a.send({ t: 'connect', id: 1, server: url });
    a.send({ t: 'client', id: 1, message: { t: 'create', name: 'Ana' } });
    await until(() => !!a.last(1, 'welcome'));
    expect(a.out.filter((m) => m.t === 'link' && m.id === 1).map((m) => (m as { state: LinkState }).state)).toEqual(['connecting', 'open']);
    const code = a.last(1, 'welcome')!.message.code;
    a.send({ t: 'connect', id: 2, server: url });
    a.send({ t: 'client', id: 2, message: { t: 'join', code, name: 'Ben' } });
    await until(() => a.last(1, 'room')?.message.room.players.length === 2);
    a.send({ t: 'client', id: 1, message: { t: 'start' } });
    await until(() => !!a.last(1, 'game') && !!a.last(2, 'game'));
    // Each side gets its game with what the app shows: the options for its moves, the log's lines, the table's words.
    for (let move = 0; move < 12; move++) {
      const mover = [1, 2].find((id) => (a.last(id, 'game')!.options?.length ?? 0) > 0)!;
      const before = a.messages(mover).length;
      const game = a.last(mover, 'game')!;
      expect(game.table?.names).toHaveLength(4);
      expect(game.lines?.length).toBeGreaterThan(0);
      a.send({ t: 'client', id: mover, message: { t: 'command', command: game.options![0]!.command } });
      await until(() => a.messages(mover).length > before);
      expect(a.last(mover, 'error'), `move ${move}`).toBeUndefined();
    }
    a.send({ t: 'close', id: 1 });
    a.send({ t: 'close', id: 2 });
  });

  it('comes back to its seat when the connection drops, and says what it couldn’t send meanwhile', async () => {
    const sockets: WebSocket[] = [];
    const states: LinkState[] = [];
    const got: ServerMessage[] = [];
    const ana = remoteConnection({
      url,
      receive: (m) => got.push(m),
      state: (s) => states.push(s),
      socket: (u) => (sockets.push(new WebSocket(u)), sockets.at(-1)!),
      backoff: () => 50,
    });
    ana.receive({ t: 'create', name: 'Ana' });
    await until(() => got.some((m) => m.t === 'welcome'));
    const code = (got.find((m) => m.t === 'welcome') as Extract<ServerMessage, { t: 'welcome' }>).code;
    const ben = remoteConnection({ url, receive: () => {}, state: () => {} });
    ben.receive({ t: 'join', code, name: 'Ben' });
    await until(() => server.rooms.get(code)?.playerCount === 2);
    ana.receive({ t: 'start' } satisfies ClientMessage);
    await until(() => got.some((m) => m.t === 'game'));
    const games = () => got.filter((m) => m.t === 'game').length;

    // Dropped: away, a move isn't held for later but refused at once; back, the seat and the game come again.
    sockets.at(-1)!.close();
    await until(() => states.includes('reconnecting'));
    ana.receive({ t: 'propose-undo' });
    expect(got.at(-1)).toEqual({ t: 'error', message: "Not connected: that wasn't sent (reconnecting…)." });
    const before = games();
    await until(() => states.at(-1) === 'open' && games() > before);
    expect(sockets).toHaveLength(2);
    expect(got.filter((m) => m.t === 'welcome')).toHaveLength(2);
    expect(server.rooms.get(code)?.playerCount).toBe(2);
    // Gone for good: closed, and not coming back.
    ana.close();
    expect(states.at(-1)).toBe('closed');
    ben.close();
  });

  it('stops at a server that speaks another version of the protocol, saying which side is behind', () => {
    // A server that welcomes with `protocol` (absent: one from before there was a version).
    const at = (protocol: number | undefined) => {
      const got: ServerMessage[] = [];
      const states: LinkState[] = [];
      const fake = { readyState: 1, send: () => {}, close: () => {} } as unknown as WebSocket;
      const c = remoteConnection({ url: 'wss://keeps.example/ws', receive: (m) => got.push(m), state: (s) => states.push(s), socket: () => fake });
      c.receive({ t: 'create', name: 'Ana' });
      fake.onopen?.(new Event('open'));
      fake.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ t: 'welcome', code: 'ABCD', token: 't', playerId: 'p', protocol }) }));
      return { got, states };
    };
    expect(at(undefined).got).toEqual([{ t: 'error', message: "keeps.example runs an older Keeps than this app: it can't be played on until it's updated." }]);
    expect(at(PROTOCOL + 1).got).toEqual([{ t: 'error', message: 'keeps.example runs a newer Keeps: update this app to play there.' }]);
    expect(at(PROTOCOL + 1).states.at(-1)).toBe('closed');
    expect(at(PROTOCOL).got.map((m) => m.t)).toEqual(['welcome']);
  });

  it("passes over a kind of message newer than the app (the server updated first), and goes on", () => {
    const got: ServerMessage[] = [];
    const fake = { readyState: 1, send: () => {}, close: () => {} } as unknown as WebSocket;
    const c = remoteConnection({ url: 'wss://keeps.example/ws', receive: (m) => got.push(m), state: () => {}, socket: () => fake });
    c.receive({ t: 'create', name: 'Ana' });
    fake.onopen?.(new Event('open'));
    const say = (m: object) => fake.onmessage?.(new MessageEvent('message', { data: JSON.stringify(m) }));
    say({ t: 'welcome', code: 'ABCD', token: 't', playerId: 'p', protocol: PROTOCOL });
    say({ t: 'fireworks', colour: 'gold' });
    say({ t: 'notice', message: 'Midstrike is thinking.' });
    expect(got.map((m) => m.t)).toEqual(['welcome', 'notice']);
  });

  it("says so when the server can't be reached", async () => {
    const got: ServerMessage[] = [];
    const states: LinkState[] = [];
    const c = remoteConnection({ url: 'ws://localhost:1/ws', receive: (m) => got.push(m), state: (s) => states.push(s) });
    c.receive({ t: 'create', name: 'Ana' });
    await until(() => states.includes('closed'));
    expect(got).toEqual([{ t: 'error', message: "Couldn't reach localhost:1." }]);
  });
});
