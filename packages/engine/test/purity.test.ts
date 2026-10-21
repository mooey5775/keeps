import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The engine must be deterministic and I/O-free so it can run identically on
// the server and in the browser, and so replays reproduce games exactly.

const SRC = join(import.meta.dirname, '../src');

const FORBIDDEN: [RegExp, string][] = [
  [/Math\.random/, 'use the seeded rng in rng.ts'],
  [/\bDate\b/, 'time must not affect the game'],
  [/\b(setTimeout|setInterval|queueMicrotask)\b/, 'the engine is synchronous'],
  [/\bprocess\./, 'no environment access'],
  [/\bconsole\./, 'emit trace events instead'],
  [/\bfetch\(/, 'no I/O'],
  [/from ['"]node:/, 'no Node built-ins'],
  [/\basync\b|\bawait\b/, 'the engine is synchronous'],
];

describe('engine purity', () => {
  const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} avoids nondeterminism and I/O`, () => {
      const source = readFileSync(join(SRC, file), 'utf8');
      for (const [pattern, reason] of FORBIDDEN) {
        expect(pattern.test(source), `${file} matches ${pattern} (${reason})`).toBe(false);
      }
    });
  }
});
