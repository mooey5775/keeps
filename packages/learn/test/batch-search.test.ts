// The batched search (demo/lockstep.ts, demo/inference.ts): playouts in lockstep give exactly the results of the
// same playouts one at a time, and the inference socket carries observations and logits exactly.
import { createServer, type Server } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { apply, eventsFor, legalCommands, newGame, viewFor, type GameState, type Seat, type TraceEvent } from '@keeps/engine';
import { Decision, NUM_ACTIONS } from '../src/actions.ts';
import { OBSERVATION2_SIZE } from '../src/observation2.ts';
import { encodeRequest, LocalInference, SocketInference } from '../demo/inference.ts';
import { drive, playWorlds, worldGames, type WorldsJob } from '../demo/lockstep.ts';
import { playOut } from '../demo/playout.ts';
import { seeded } from '../demo/random.ts';
import { randomPolicy } from './support/random-policy.ts';

const policy = randomPolicy();
const local = new LocalInference(policy);

/**
 * A decision with a real choice from a seeded game: the first one after `moves` moves (each a seeded pick from the
 * legal commands; 0: the game's first decision with a choice, reached by first legal commands).
 */
function position(seed: string, moves = 0): Omit<WorldsJob, 'n' | 'seed'> {
  let { state, events } = newGame({ players: 2, seed, marksToWin: 3 }) as { state: GameState; events: TraceEvent[] };
  const random = seeded(seed.length, moves);
  for (let played = 0; ; played++) {
    if (state.phase !== 'playing') throw new Error(`${seed}: the round ended after ${played} moves`);
    const me = state.prompts[0]!.seat as Seat;
    const decision = new Decision(viewFor(state, me), legalCommands(state, me));
    const commands = decision.encodings().map((ids) => decision.complete(ids)!);
    if (commands.length > 1 && played >= moves) return { state, me, myLog: eventsFor(events, me), commands };
    const legal = legalCommands(state, me).filter((c) => c.type !== 'reveal-duplicity');
    const r = apply(state, me, played < moves ? legal[Math.floor(random() * legal.length)]! : legal[0]!);
    if (!r.ok) throw new Error(r.error.message);
    state = r.state;
    events = [...events, ...r.events];
  }
}

describe('the batched search', () => {
  it('plays each playout exactly as one at a time would', async () => {
    const job = { ...position('lockstep-1'), n: 3, seed: 42 };
    expect(job.commands.length).toBeGreaterThan(1);
    const oneAtATime = worldGames(job, policy, true).map((game) => playOut(game, policy));
    const batched = await drive(worldGames(job, policy, true), (rows) => local.logits(rows), NUM_ACTIONS, 2);
    expect(batched).toEqual(oneAtATime);
    // However the batches are cut, and however few playouts run at once.
    const ragged = await drive(worldGames(job, policy, true), (rows) => local.logits(rows), NUM_ACTIONS, 3, 2);
    expect(ragged).toEqual(oneAtATime);
    for (const r of oneAtATime) expect([1, -1]).toContain(r);
  });

  it('is reproducible from its seed, and the seed matters', async () => {
    const base = position('lockstep-2');
    const logits = (rows: Float32Array[]) => local.logits(rows);
    const a = await playWorlds({ ...base, n: 4, seed: 7 }, policy, true, logits);
    const b = await playWorlds({ ...base, n: 4, seed: 7 }, policy, true, logits);
    expect(a).toEqual(b);
    expect(a).toHaveLength(4);
    for (const row of a) expect(row).toHaveLength(base.commands.length);
    const others = await Promise.all([8, 9, 10].map((seed) => playWorlds({ ...base, n: 4, seed }, policy, true, logits)));
    expect(others.some((o) => JSON.stringify(o) !== JSON.stringify(a))).toBe(true);
  });
});

/** The request's observations, dense again (the GPU server's side of encodeRequest). */
function decodeRequest(bytes: Uint8Array): Float32Array[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rows = view.getUint32(0, true);
  const nonzeros = view.getUint32(4, true);
  const values = 8 + 4 * rows;
  const indices = values + 4 * nonzeros;
  const out: Float32Array[] = [];
  let k = 0;
  for (let r = 0; r < rows; r++) {
    const obs = new Float32Array(OBSERVATION2_SIZE);
    for (const end = view.getUint32(8 + 4 * r, true); k < end; k++) obs[view.getUint16(indices + 2 * k, true)] = view.getFloat32(values + 4 * k, true);
    out.push(obs);
  }
  return out;
}

/** A stand-in for bot/keeps_bot/serve.py: the protocol, the network run here. */
function fakeServer(path: string, fingerprint: string): Server {
  const server = createServer((socket) => {
    let got = Buffer.alloc(0);
    let hello = false;
    socket.on('data', async (chunk: Buffer) => {
      got = Buffer.concat([got, chunk]);
      for (;;) {
        if (!hello) {
          if (got.length < 8 || got.length < 8 + got.readUInt32LE(4)) return;
          const info = JSON.parse(got.subarray(8, 8 + got.readUInt32LE(4)).toString());
          got = got.subarray(8 + got.readUInt32LE(4));
          const answer = Buffer.from(JSON.stringify(info.fingerprint === fingerprint ? { ok: true } : { error: 'wrong network' }));
          socket.write(Buffer.concat([Buffer.from(Uint32Array.of(answer.length).buffer), answer]));
          hello = true;
          continue;
        }
        if (got.length < 8) return;
        const size = 8 + 4 * got.readUInt32LE(0) + 6 * got.readUInt32LE(4);
        if (got.length < size) return;
        const rows = decodeRequest(new Uint8Array(got.subarray(0, size)));
        got = got.subarray(size);
        socket.write(Buffer.from((await local.logits(rows)).buffer));
      }
    });
  });
  server.listen(path);
  return server;
}

describe('the inference socket', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keeps-inference-'));
  const path = join(dir, 'socket');
  const server = fakeServer(path, policy.info.fingerprint);
  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('encodes requests as a one-by-one scan would, -0s and odd lengths included', () => {
    const one = (rows: Float32Array[]) => {
      const nonzero = rows.flatMap((obs) => [...obs.keys()].filter((i) => obs[i] !== 0).map((i) => [i, obs[i]!] as const));
      const bytes = new Uint8Array(8 + 4 * rows.length + 6 * nonzero.length);
      const view = new DataView(bytes.buffer);
      view.setUint32(0, rows.length, true);
      view.setUint32(4, nonzero.length, true);
      let k = 0;
      rows.forEach((obs, r) => {
        for (let i = 0; i < obs.length; i++) {
          if (obs[i] === 0) continue;
          view.setFloat32(8 + 4 * rows.length + 4 * k, obs[i]!, true);
          view.setUint16(8 + 4 * rows.length + 4 * nonzero.length + 2 * k, i, true);
          k++;
        }
        view.setUint32(8 + 4 * r, k, true);
      });
      return bytes;
    };
    const random = seeded(5, 5);
    for (let t = 0; t < 300; t++) {
      const rows = Array.from({ length: 1 + Math.floor(random() * 5) }, () => {
        const n = Math.floor(random() * 40);
        const offset = Math.floor(random() * 3);
        const obs = new Float32Array(new ArrayBuffer(4 * (n + offset)), 4 * offset, n);
        for (let i = 0; i < n; i++) {
          const u = random();
          obs[i] = u < 0.6 ? 0 : u < 0.7 ? -0 : u < 0.8 ? 1e-40 : random() - 0.5;
        }
        return obs;
      });
      expect(encodeRequest(rows)).toEqual(one(rows));
    }
  });

  it('carries the observations exactly (sparse, float32)', async () => {
    const games = worldGames({ ...position('socket-1'), n: 2, seed: 3 }, policy, true);
    const rows = games.map((g) => g.next().value as { obs: Float32Array }).map((a) => a.obs);
    expect(decodeRequest(encodeRequest(rows))).toEqual(rows);
  });

  it('answers pipelined requests in order, with the network’s own logits', async () => {
    const inference = await SocketInference.connect(path, policy);
    const job = { ...position('socket-2'), n: 2, seed: 5 };
    const rows = worldGames(job, policy, true).map((g) => (g.next().value as { obs: Float32Array }).obs);
    const parts = [rows.slice(0, 1), rows.slice(1, 3), rows.slice(3)];
    const answers = await Promise.all(parts.map((p) => inference.logits(p)));
    parts.forEach((p, i) => expect(answers[i]).toEqual(Float32Array.from(p.flatMap((obs) => [...policy.logits(obs)]))));
    // A whole search through it gives the same results as the network run here.
    const logits = (r: Float32Array[]) => inference.logits(r);
    expect(await playWorlds(job, policy, true, logits)).toEqual(await playWorlds(job, policy, true, (r) => local.logits(r)));
    inference.close();
  });

  it('refuses a client with another network', async () => {
    const other = randomPolicy();
    (other.info as { fingerprint: string }).fingerprint = 'another';
    await expect(SocketInference.connect(path, other)).rejects.toThrow(/refused/);
  });
});

/** FNV-1a over the observations' float bits, in the order the network was asked. */
function hashObservations(rows: Float32Array[], hash: { value: number; count: number }): void {
  for (const obs of rows) {
    const bits = new Uint32Array(obs.buffer, obs.byteOffset, obs.length);
    let h = hash.value;
    for (let i = 0; i < bits.length; i++) h = Math.imul(h ^ bits[i]!, 16777619) >>> 0;
    hash.value = h;
    hash.count++;
  }
}

describe('the search, against a recorded run', () => {
  // Small searches' results and every observation they sent the network, recorded from code known to play right
  // (3ceacaa, before the playouts' speed-ups): a change that should leave the search's play alone must reproduce
  // them exactly. After a change meant to change play (the rules, the encoding, the belief), record them again:
  //   UPDATE_GOLDEN=1 pnpm --filter @keeps/learn exec vitest run test/batch-search.test.ts
  const path = new URL('./fixtures/search-golden.json', import.meta.url);
  it('plays exactly as recorded', async () => {
    const hash = { value: 2166136261, count: 0 };
    const logits = (rows: Float32Array[]) => {
      hashObservations(rows, hash);
      return local.logits(rows);
    };
    const results = [];
    for (const [i, [seed, moves]] of ([['golden-1', 0], ['golden-2', 10], ['golden-3', 20], ['golden-4', 30]] as const).entries()) {
      results.push(await playWorlds({ ...position(seed, moves), n: 5, seed: 300 + i }, policy, true, logits));
    }
    const run = { results, observations: hash.count, hash: hash.value };
    if (process.env.UPDATE_GOLDEN || !existsSync(path)) writeFileSync(path, JSON.stringify(run) + '\n');
    expect(run).toEqual(JSON.parse(readFileSync(path, 'utf8')));
  });
});
