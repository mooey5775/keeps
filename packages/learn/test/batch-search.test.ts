// The batched search (demo/lockstep.ts, demo/inference.ts): playouts in lockstep give exactly the results of the
// same playouts one at a time, and the inference socket carries observations and logits exactly.
import { createServer, type Server } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { apply, eventsFor, legalCommands, newGame, viewFor, type GameState, type Seat, type TraceEvent } from '@keeps/engine';
import { Decision, NUM_ACTIONS } from '../src/actions.ts';
import { encoderFingerprint } from '../src/fingerprint.ts';
import { LAYOUT2, OBSERVATION2_SIZE } from '../src/observation2.ts';
import { Policy } from '../src/policy.ts';
import { encodeRequest, LocalInference, SocketInference } from '../demo/inference.ts';
import { drive, playWorlds, worldGames, type WorldsJob } from '../demo/lockstep.ts';
import { playOut } from '../demo/playout.ts';
import { seeded } from '../demo/random.ts';

/** A small entity network with random weights: the playouts' logic doesn't depend on what the network learned. */
function randomPolicy(fingerprint = encoderFingerprint(2)): Policy {
  const b = LAYOUT2.blocks as Record<string, { rows: number; width: number }>;
  const [embed, cardHidden, card, pile, player, turn, trunk, head] = [4, 16, 8, 8, 4, 4, 16, 8];
  const trunkIn = LAYOUT2.places.length * card + b.piles!.rows * pile + b.players!.rows * player + turn + b.decision!.width + card + pile;
  const shapes: [string, number[]][] = [
    ['~/card_embedding', [b.cards!.rows, embed]],
    ['card_in/w', [b.cards!.width, cardHidden]], ['card_in/b', [cardHidden]], ['card_embed/w', [embed, cardHidden]],
    ['card_out/w', [cardHidden, card]], ['card_out/b', [card]],
    ['pile/~/linear_0/w', [b.piles!.width, pile]], ['pile/~/linear_0/b', [pile]], ['pile/~/linear_1/w', [pile, pile]], ['pile/~/linear_1/b', [pile]],
    ['player/~/linear_0/w', [b.players!.width, player]], ['player/~/linear_0/b', [player]], ['player/~/linear_1/w', [player, player]], ['player/~/linear_1/b', [player]],
    ['turn/~/linear_0/w', [b.turns!.width, turn]], ['turn/~/linear_0/b', [turn]], ['turn/~/linear_1/w', [turn, turn]], ['turn/~/linear_1/b', [turn]],
    ['trunk_in/w', [trunkIn, trunk]], ['trunk_in/b', [trunk]],
    ['block0_norm/scale', [trunk]], ['block0_norm/offset', [trunk]], ['block0_a/w', [trunk, trunk]], ['block0_a/b', [trunk]], ['block0_b/w', [trunk, trunk]], ['block0_b/b', [trunk]],
    ['trunk_norm/scale', [trunk]], ['trunk_norm/offset', [trunk]],
    ['query/w', [trunk, head]], ['query/b', [head]],
    ['card_head_candidate/w', [card, head]], ['card_head_candidate/b', [head]], ['card_head_subject/w', [card, head]],
    ['card_head_out/w', [head, 1]], ['card_head_out/b', [1]],
    ['pos_head_candidate/w', [pile + player + card, head]], ['pos_head_candidate/b', [head]], ['pos_head_decision/w', [head, head]],
    ['pos_head_subject/w', [card + pile, head]], ['pos_head_out/w', [head, 1]], ['pos_head_out/b', [1]],
    ['special/w', [trunk, NUM_ACTIONS - 40]], ['special/b', [NUM_ACTIONS - 40]],
    ['value/~/linear_0/w', [trunk, 4]], ['value/~/linear_0/b', [4]], ['value/~/linear_1/w', [4, 1]], ['value/~/linear_1/b', [1]],
  ];
  const random = seeded(1, 1);
  const tensors: { name: string; shape: number[]; offset: number }[] = [];
  const data: number[] = [];
  for (const [name, shape] of shapes) {
    tensors.push({ name, shape, offset: data.length });
    const size = shape.reduce((a, c) => a * c, 1);
    const scale = name.endsWith('/scale') ? 0 : 1 / Math.sqrt(shape[0]!);
    for (let i = 0; i < size; i++) data.push(name.endsWith('/scale') ? 1 : (random() * 2 - 1) * scale);
  }
  const header = new TextEncoder().encode(
    JSON.stringify({
      format: 'keeps-policy', version: 1, run: 'test', step: 1, decisions: null, network: 'entity', observationVersion: 2, layers: [],
      observationSize: OBSERVATION2_SIZE, numActions: NUM_ACTIONS, fingerprint, postprocess: { threshold: 0, discretization: 0 }, evals: null,
      layout: LAYOUT2, tensors,
    }),
  );
  const bytes = new Uint8Array(8 + header.length + 4 * data.length);
  bytes.set(new TextEncoder().encode('KPNN'));
  new DataView(bytes.buffer).setUint32(4, header.length, true);
  bytes.set(header, 8);
  bytes.set(new Uint8Array(Float32Array.from(data).buffer), 8 + header.length);
  return Policy.load(bytes);
}

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
