import { legalCommands, newGame, puzzleById, puzzleState, YOU, type Command, type ReplayLog, type Seat } from '@keeps/engine';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { Tracker, Who } from '../src/analytics.ts';
import { buildDispute, RateLimiter, type OnlineDisputeInfo } from '../src/dispute.ts';
import { createKeepsServer, type KeepsServer } from '../src/server.ts';

// Rule disputes: a note to the maintainer with the game attached. They never
// reach the game itself.

const noRoom = () => null;

describe('buildDispute', () => {
  it('rejects empty, oversized, and malformed reports', () => {
    expect(buildDispute(null, noRoom)).toMatchObject({ ok: false });
    expect(buildDispute({ text: '   ', context: { mode: 'hotseat' } }, noRoom)).toMatchObject({ ok: false, error: 'Please describe what happened.' });
    expect(buildDispute({ text: 'x'.repeat(4001), context: {} }, noRoom)).toMatchObject({ ok: false });
    expect(buildDispute({ text: 'hi' }, noRoom)).toMatchObject({ ok: false, error: 'Malformed report.' });
    expect(buildDispute({ text: 'hi', context: { mode: 'other' } }, noRoom)).toMatchObject({ ok: false });
    expect(buildDispute({ text: 'hi', context: { mode: 'puzzle', puzzle: 'P-99', commands: [] } }, noRoom)).toMatchObject({ ok: false });
    expect(buildDispute({ text: 'hi', context: { mode: 'hotseat', replay: { options: 5, commands: [] } } }, noRoom)).toMatchObject({ ok: false });
  });

  it('says so when an online game is no longer on the server', () => {
    expect(buildDispute({ text: 'hi', context: { mode: 'online', room: 'ABCD', token: 't' } }, noRoom)).toEqual({
      ok: false,
      error: 'That game is no longer on the server.',
    });
  });

  it("attaches an online game's replay log and trace, naming the reporter from the room", () => {
    const options = { players: 2 as const, seed: 'dispute', marksToWin: 3 };
    const { state, events } = newGame(options);
    const info: OnlineDisputeInfo = {
      name: 'Ada',
      seat: 0,
      client: 'client-123456',
      game: { round: state.round, phase: state.phase, log: { options, commands: [] }, events },
    };
    const asked: string[] = [];
    const result = buildDispute(
      { text: ' Retribution should have fired ', contact: 'ada@example.com', name: 'Impostor', context: { mode: 'online', room: 'abcd', token: 'tok' } },
      (room, token) => (asked.push(`${room}/${token}`), info),
    );
    expect(asked).toEqual(['ABCD/tok']);
    expect(result).toMatchObject({
      ok: true,
      who: { id: 'client-123456', name: 'Ada' },
      properties: { text: 'Retribution should have fired', contact: 'ada@example.com', mode: 'online', room: 'ABCD', seat: 0, round: 1 },
    });
    if (!result.ok) return;
    expect(String(result.properties.replay)).toContain('"seed":"dispute"');
    expect(String(result.properties.trace_tail).length).toBeGreaterThan(0);
  });

  it('reports a lobby with no game', () => {
    const result = buildDispute({ text: 'hi', context: { mode: 'online', room: 'ABCD', token: 't' } }, () => ({
      name: 'Ada',
      seat: null,
      client: null,
      game: null,
    }));
    expect(result).toMatchObject({ ok: true, who: { id: 'room:ABCD' }, properties: { phase: 'lobby' } });
  });

  it('replays puzzle moves to the position the reporter saw', () => {
    const puzzle = puzzleById('P-01')!;
    const command = legalCommands(puzzleState(puzzle), YOU)[0]!;
    const result = buildDispute(
      { text: 'hi', name: 'Bo', client: 'client-abcdefgh', context: { mode: 'puzzle', puzzle: 'P-01', commands: [{ seat: YOU, command }] } },
      noRoom,
    );
    expect(result).toMatchObject({ ok: true, who: { id: 'client-abcdefgh', name: 'Bo' }, properties: { mode: 'puzzle', puzzle: 'P-01' } });
    if (!result.ok) return;
    expect(result.properties.replay_problem).toBeUndefined();
    expect(JSON.parse(String(result.properties.moves))).toEqual([{ seat: YOU, command }]);
  });

  it('still sends a report whose moves no longer replay, noting where they stop', () => {
    const bogus = { seat: 2 as Seat, command: { t: 'answer', prompt: 999, choice: 0 } as unknown as Command };
    const result = buildDispute({ text: 'hi', context: { mode: 'puzzle', puzzle: 'P-01', commands: [bogus] } }, noRoom);
    expect(result).toMatchObject({ ok: true, who: { name: 'Anonymous' } });
    if (result.ok) expect(String(result.properties.replay_problem)).toMatch(/^move 1 was rejected/);
  });

  it('replays a pass-and-play log', () => {
    const options = { players: 3 as const, seed: 'hotseat', marksToWin: 3 };
    const { state } = newGame(options);
    const seat = state.turn!.seat;
    const log: ReplayLog = { options, commands: [{ seat, command: legalCommands(state, seat)[0]! }] };
    const result = buildDispute({ text: 'hi', context: { mode: 'hotseat', replay: log } }, noRoom);
    expect(result).toMatchObject({ ok: true, properties: { mode: 'hotseat', round: 1 } });
    if (!result.ok) return;
    expect(result.properties.replay_problem).toBeUndefined();
    expect(String(result.properties.replay).trim().split('\n')).toHaveLength(2);
  });
});

describe("the app's reports", () => {
  const app = { version: '0.1', build: '219', device: 'iPhone17,1' };
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');

  it("carries the app's version and device, the phone's game if there is one, and a screenshot", () => {
    const options = { players: 2 as const, seed: 'phone', marksToWin: 3 };
    const log: ReplayLog = { options, commands: [] };
    const result = buildDispute({ text: 'the card flew wrong', client: 'install-1234', app, screenshot: jpeg, context: { mode: 'phone', replay: log } }, noRoom);
    expect(result).toMatchObject({ ok: true, who: { id: 'install-1234' }, properties: { mode: 'phone', app_version: '0.1', app_build: '219', device: 'iPhone17,1', round: 1 } });
    if (!result.ok) return;
    expect(result.screenshot?.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(result.properties.screenshot).toBeUndefined(); // (kept by the server, not sent to analytics)
  });

  it('takes a report from the lobby (no game), and refuses a screenshot that is no JPEG or too large', () => {
    expect(buildDispute({ text: 'hi', app, context: { mode: 'phone' } }, noRoom)).toMatchObject({ ok: true, properties: { phase: 'lobby' } });
    expect(buildDispute({ text: 'hi', screenshot: Buffer.from('png?').toString('base64'), context: { mode: 'phone' } }, noRoom)).toEqual({ ok: false, error: 'Malformed report.' });
    const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(300 * 1024)]).toString('base64');
    expect(buildDispute({ text: 'hi', screenshot: huge, context: { mode: 'phone' } }, noRoom)).toEqual({ ok: false, error: 'Malformed report.' });
  });
});

describe("POST /dispute: the app's screenshot", () => {
  it('is kept on the data volume, linked from the event, and shown only to the admin', async () => {
    const captured: Record<string, unknown>[] = [];
    const tracker: Tracker = { capture: (_e, _w, properties = {}) => void captured.push(properties), shutdown: async () => {} };
    const dataDir = mkdtempSync(join(tmpdir(), 'keeps-reports-'));
    const server = await createKeepsServer({ port: 0, cardsDir: join(import.meta.dirname, '../../../cards'), tracker, dataDir, adminToken: 'sesame', siteUrl: 'https://keeps.example' });
    try {
      const address = server.http.address();
      if (!address || typeof address === 'string') throw new Error('no port');
      const at = `http://localhost:${address.port}`;
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);
      const sent = await fetch(`${at}/dispute`, { method: 'POST', body: JSON.stringify({ text: 'hi', screenshot: jpeg.toString('base64'), context: { mode: 'phone' } }) });
      expect(sent.status).toBe(200);
      const link = String(captured[0]!.screenshot);
      expect(link).toMatch(/^https:\/\/keeps\.example\/admin\/reports\/[\w-]+\.jpg$/);
      const path = new URL(link).pathname;
      expect((await fetch(at + path)).status).toBe(401);
      const shown = await fetch(at + path, { headers: { authorization: `Basic ${btoa('admin:sesame')}` } });
      expect(shown.headers.get('content-type')).toBe('image/jpeg');
      expect(Buffer.from(await shown.arrayBuffer())).toEqual(jpeg);
      expect((await fetch(`${at}/admin/reports/..%2Fsecret.jpg`, { headers: { authorization: `Basic ${btoa('admin:sesame')}` } })).status).toBe(404);
    } finally {
      await server.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('RateLimiter', () => {
  it('allows `limit` hits per window per key', () => {
    const limiter = new RateLimiter(2, 1000);
    expect([limiter.allow('a', 0), limiter.allow('a', 10), limiter.allow('a', 20), limiter.allow('b', 20)]).toEqual([true, true, false, true]);
    expect(limiter.allow('a', 1005)).toBe(true);
  });
});

describe('POST /dispute', () => {
  const captured: { event: string; who: Who; properties: Record<string, unknown> }[] = [];
  const tracker: Tracker = { capture: (event, who, properties = {}) => void captured.push({ event, who, properties }), shutdown: async () => {} };
  let server: KeepsServer;
  let base: string;

  beforeAll(async () => {
    server = await createKeepsServer({ port: 0, cardsDir: join(import.meta.dirname, '../../../cards'), tracker });
    const address = server.http.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    base = `localhost:${address.port}`;
  });
  afterAll(() => server.close());

  const post = (body: unknown, ip: string) =>
    fetch(`http://${base}/dispute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'fly-client-ip': ip },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it("sends an online report to analytics with the room's game, without touching the game", async () => {
    const socket = new WebSocket(`ws://${base}/ws`);
    await new Promise((resolve) => socket.once('open', resolve));
    const welcome = new Promise<{ code: string; token: string }>((resolve) =>
      socket.on('message', (data) => {
        const m = JSON.parse(String(data)) as { t: string; code: string; token: string };
        if (m.t === 'welcome') resolve(m);
      }),
    );
    socket.send(JSON.stringify({ t: 'create', name: 'Host', client: 'client-host-1' }));
    const { code, token } = await welcome;
    let after = 0;
    socket.on('message', () => after++);

    const res = await post({ text: 'Fiat ghosts moved wrong', context: { mode: 'online', room: code, token } }, '203.0.113.9');
    expect(res.status).toBe(200);
    const report = captured.find((c) => c.event === 'rules_dispute')!;
    expect(report.who).toEqual({ id: 'client-host-1', name: 'Host', ip: '203.0.113.9' });
    expect(report.properties).toMatchObject({ text: 'Fiat ghosts moved wrong', room: code, phase: 'lobby' });
    // Nobody in the room hears about it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(after).toBe(0);
    socket.close();

    const wrongToken = await post({ text: 'hi', context: { mode: 'online', room: code, token: 'nope' } }, '203.0.113.9');
    expect(wrongToken.status).toBe(400);
  });

  it('rejects bad JSON, and limits reports per IP', async () => {
    expect((await post('{nope', '198.51.100.1')).status).toBe(400);
    const valid = { text: 'hi', context: { mode: 'puzzle', puzzle: 'P-01', commands: [] } };
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await post(valid, '198.51.100.1')).status);
    expect(statuses).toEqual([200, 200, 200, 200, 429]);
    expect((await post(valid, '198.51.100.2')).status).toBe(200);
  });
});
