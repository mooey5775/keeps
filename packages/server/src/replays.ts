import { mkdirSync, readdirSync, statfsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatReplayLog, type ReplayLog } from '@keeps/engine';
import { replayFileName } from '@keeps/protocol';

// (The file name is the protocol package's, so the app names the games it keeps the same way.)
export { replayFileName };

// Replay logs on disk: one file per game, rewritten after every move. They're
// a debugging aid, so they must never break a game: write errors are logged,
// not thrown. When the disk runs low, finished games' logs are deleted, oldest
// first. Logs of games still in a room are never deleted.

export interface DiskSpace {
  /** Bytes available to this process. */
  free: number;
  total: number;
}

export interface ReplayStoreOptions {
  /** File names (see `replayFileName`) of games that still have a room. */
  active: () => Set<string>;
  /** Free space on the disk holding `dir`; null if unknown. */
  diskSpace?: (dir: string) => DiskSpace | null;
  /** Start deleting when less than this share of the disk is free. */
  lowFree?: number;
  /** Stop deleting once this share of the disk is free. */
  targetFree?: number;
  log?: (message: string) => void;
}

export function statfsSpace(dir: string): DiskSpace | null {
  try {
    const s = statfsSync(dir);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

export class ReplayStore {
  readonly dir: string;
  private readonly active: () => Set<string>;
  private readonly diskSpace: (dir: string) => DiskSpace | null;
  private readonly lowFree: number;
  private readonly targetFree: number;
  private readonly log: (message: string) => void;
  /** Write errors since the last one was logged, so a full disk doesn't flood the log. */
  private failures = 0;

  constructor(dir: string, options: ReplayStoreOptions) {
    this.dir = dir;
    this.active = options.active;
    this.diskSpace = options.diskSpace ?? statfsSpace;
    this.lowFree = options.lowFree ?? 0.15;
    this.targetFree = options.targetFree ?? 0.25;
    this.log = options.log ?? ((message) => console.warn(message));
    mkdirSync(dir, { recursive: true });
  }

  /** Writes a game's log. Never throws; on a full disk, frees space and tries once more. */
  save(code: string, startedAt: number, log: ReplayLog): void {
    const file = join(this.dir, replayFileName(code, startedAt));
    const text = formatReplayLog(log);
    try {
      writeFileSync(file, text);
      this.failures = 0;
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOSPC' && this.cleanup({ force: true }) > 0) {
        try {
          writeFileSync(file, text);
          this.failures = 0;
          return;
        } catch {
          // Reported below.
        }
      }
      if (this.failures++ % 100 === 0) this.log(`[replays] couldn't save ${file}: ${(error as Error).message}`);
    }
  }

  /**
   * Deletes inactive logs, oldest first, while the disk is low on space (or,
   * with `force`, after a failed write). Returns how many were deleted.
   */
  cleanup({ force = false }: { force?: boolean } = {}): number {
    const lowOn = () => {
      const space = this.diskSpace(this.dir);
      return space !== null && space.total > 0 && space.free / space.total < this.targetFree;
    };
    const space = this.diskSpace(this.dir);
    const low = space !== null && space.total > 0 && space.free / space.total < this.lowFree;
    if (!low && !force) return 0;

    const active = this.active();
    let candidates: { name: string; mtime: number }[];
    try {
      candidates = readdirSync(this.dir)
        .filter((name) => name.endsWith('.jsonl') && !active.has(name))
        .map((name) => ({ name, mtime: statSync(join(this.dir, name)).mtimeMs }))
        .sort((a, b) => a.mtime - b.mtime);
    } catch {
      return 0;
    }

    let deleted = 0;
    for (const { name } of candidates) {
      // A forced cleanup frees at least one file even if the disk looks fine.
      if (!(force && deleted === 0) && !lowOn()) break;
      try {
        unlinkSync(join(this.dir, name));
        deleted++;
      } catch {
        // Already gone, or not ours to delete: skip it.
      }
    }
    if (deleted > 0) this.log(`[replays] disk low on space: deleted ${deleted} finished game log(s)`);
    return deleted;
  }
}
