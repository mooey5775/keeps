import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { midstrike, midstrikeConfig } from '../src/midstrike.ts';
import type { Room } from '../src/room.ts';
import { createKeepsServer, type KeepsServer } from '../src/server.ts';

const root = join(import.meta.dirname, '../../..');

describe("Midstrike's configuration", () => {
  it("is production's by default", () => {
    const config = midstrikeConfig({}, root);
    expect(config).toEqual({
      weights: join(root, 'packages/bot/weights/midstrike.bin'),
      name: 'Midstrike',
      remoteToken: null,
      remoteWorlds: 2048,
      mediumWorlds: 64,
      localWorlds: 256,
      localSearch: true,
      reviews: true,
    });
  });

  it('says so when a number is wrong, rather than searching some other number of worlds', () => {
    expect(() => midstrikeConfig({ REMOTE_WORLDS: 'many' }, root)).toThrow('REMOTE_WORLDS must be a positive whole number, not many');
    expect(() => midstrikeConfig({ MEDIUM_WORLDS: '0' }, root)).toThrow('MEDIUM_WORLDS');
  });
});

describe("Midstrike's admin pages", () => {
  let server: KeepsServer;
  let base: string;
  beforeAll(async () => {
    // (No search here and no remote machine: no worker threads; the pages and the bot are what's tried.)
    const config = { ...midstrikeConfig({ LOCAL_SEARCH: 'off' }, root), weights: join(root, 'packages/bot/weights/bot.bin') };
    let rooms: ReadonlyMap<string, Room> = new Map();
    const { describe: _, ...bot } = midstrike(config, { dataDir: undefined, adminToken: 'sesame', rooms: () => rooms });
    server = await createKeepsServer({ port: 0, cardsDir: join(root, 'cards'), adminToken: 'sesame', ...bot });
    rooms = server.rooms;
    const address = server.http.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    base = `http://localhost:${address.port}`;
  });
  afterAll(() => server.close());

  const get = (path: string, password?: string) =>
    fetch(base + path, password ? { headers: { authorization: `Basic ${btoa(`admin:${password}`)}` } } : {});

  it('are behind the admin password', async () => {
    for (const path of ['/admin/bot/', '/admin/bot/spectate', '/admin/bot/spectate.json', '/admin/bot/data', '/admin/bot/status.json']) {
      expect((await get(path)).status, path).toBe(401);
      expect((await get(path, 'wrong')).status, path).toBe(401);
      expect((await get(path, 'sesame')).status, path).toBe(200);
    }
  });

  it('say what the bot is doing: here, no search and no remote machine', async () => {
    expect(await (await get('/admin/bot/status.json', 'sesame')).json()).toEqual({
      remote: null,
      reviews: null,
      failures: { counts: { search: 0, move: 0, advice: 0 }, latest: [] },
    });
    expect(await (await get('/admin/bot/spectate.json', 'sesame')).json()).toEqual({ rooms: [], room: null });
  });
});
