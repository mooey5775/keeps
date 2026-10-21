import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { replayFileName, ReplayStore, type DiskSpace } from '../src/replays.ts';

// Replay logs on disk: written after every move, never allowed to break a
// game, and cleaned up (finished games only, oldest first) when the disk runs low.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(opts: { active?: string[]; space?: () => DiskSpace | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'keeps-replays-'));
  dirs.push(dir);
  const logs: string[] = [];
  const store = new ReplayStore(dir, {
    active: () => new Set(opts.active ?? []),
    diskSpace: opts.space ?? (() => ({ free: 90, total: 100 })),
    log: (m) => logs.push(m),
  });
  return { dir, store, logs };
}

/** Writes a fake finished game's log, `ageMinutes` old. */
function oldLog(dir: string, name: string, ageMinutes: number): void {
  const file = join(dir, name);
  writeFileSync(file, '{"options":{}}\n');
  const when = new Date(Date.now() - ageMinutes * 60_000);
  utimesSync(file, when, when);
}

const log = { options: { players: 2 as const, seed: 's', marksToWin: 3 }, commands: [] };

describe('ReplayStore', () => {
  it('saves a game as <code>-<start time>.jsonl', () => {
    const { dir, store } = setup();
    store.save('ABCD', Date.UTC(2026, 9, 21, 8, 30), log);
    expect(readdirSync(dir)).toEqual(['ABCD-2026-10-21T08-30-00-000Z.jsonl']);
    expect(readFileSync(join(dir, replayFileName('ABCD', Date.UTC(2026, 9, 21, 8, 30))), 'utf8')).toContain('"seed":"s"');
  });

  it("logs a failed write instead of throwing, and doesn't flood the log", () => {
    const { dir, store, logs } = setup();
    rmSync(dir, { recursive: true });
    writeFileSync(dir, 'not a directory');
    for (let i = 0; i < 150; i++) expect(() => store.save('ABCD', 0, log)).not.toThrow();
    // The first failure, then one every 100.
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/couldn't save/);
  });

  it('leaves everything alone while the disk has room', () => {
    const { dir, store } = setup({ space: () => ({ free: 50, total: 100 }) });
    oldLog(dir, 'OLD1-a.jsonl', 60);
    expect(store.cleanup()).toBe(0);
    expect(readdirSync(dir)).toEqual(['OLD1-a.jsonl']);
  });

  it('when the disk runs low, deletes finished games oldest first until enough is free, never active ones', () => {
    // A fake disk that starts 10% free (below the 15% trigger); each deleted file frees 5%. Cleanup stops at 25%.
    let dir = '';
    let initial = 0;
    const space = () => ({ free: 10 + 5 * (initial - readdirSync(dir).length), total: 100 });
    const made = setup({ active: ['LIVE-x.jsonl'], space });
    dir = made.dir;
    oldLog(dir, 'LIVE-x.jsonl', 600);
    for (const [name, age] of [['A-1.jsonl', 500], ['B-1.jsonl', 400], ['C-1.jsonl', 300], ['D-1.jsonl', 200], ['E-1.jsonl', 100]] as const) {
      oldLog(dir, name, age);
    }
    initial = readdirSync(dir).length;

    expect(made.store.cleanup()).toBe(3);
    // The live game's log is the oldest file, but it stays.
    expect(readdirSync(dir).sort()).toEqual(['D-1.jsonl', 'E-1.jsonl', 'LIVE-x.jsonl']);
    expect(made.logs.at(-1)).toMatch(/deleted 3/);
  });

  it('deletes every finished game if that is what it takes, but still never an active one', () => {
    const { dir, store } = setup({ active: ['LIVE-x.jsonl'], space: () => ({ free: 1, total: 100 }) });
    oldLog(dir, 'LIVE-x.jsonl', 600);
    oldLog(dir, 'A-1.jsonl', 500);
    oldLog(dir, 'B-1.jsonl', 400);
    expect(store.cleanup()).toBe(2);
    expect(readdirSync(dir)).toEqual(['LIVE-x.jsonl']);
  });

  it('a forced cleanup (after a failed write) frees at least one finished game', () => {
    const { dir, store } = setup({ active: ['LIVE-x.jsonl'], space: () => ({ free: 90, total: 100 }) });
    oldLog(dir, 'LIVE-x.jsonl', 600);
    oldLog(dir, 'A-1.jsonl', 500);
    oldLog(dir, 'B-1.jsonl', 400);
    expect(store.cleanup({ force: true })).toBe(1);
    expect(existsSync(join(dir, 'A-1.jsonl'))).toBe(false);
    expect(existsSync(join(dir, 'LIVE-x.jsonl'))).toBe(true);
  });

  it('does nothing when free space is unknown', () => {
    const { dir, store } = setup({ space: () => null });
    oldLog(dir, 'A-1.jsonl', 500);
    expect(store.cleanup()).toBe(0);
  });
});
