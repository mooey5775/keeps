import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPEC } from './spec-manifest.ts';

// Every spec id needs a test whose name starts with it, e.g. it('C-01 …').
// Uncovered ids show up as "todo" so the suite stays green while the engine
// is being built. `pnpm test:strict` (SPEC_STRICT=1) turns them into failures.

const TEST_DIR = import.meta.dirname;
const strict = process.env.SPEC_STRICT === '1';

// Matches it('R-01 …'), test("C-12 …"), describe(`P-03 …`), and their .only
// forms. Deliberately not .todo or .skip: those don't count as coverage.
const TITLE = /\b(?:it|test|describe)(?:\.only)?\(\s*['"`]([RCQKP]-\d{2})\b/g;

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return entry.name.endsWith('.test.ts') && path !== import.meta.filename ? [path] : [];
  });
}

const coveredBy = new Map<string, string[]>();
for (const file of testFiles(TEST_DIR)) {
  for (const match of readFileSync(file, 'utf8').matchAll(TITLE)) {
    const id = match[1]!;
    coveredBy.set(id, [...(coveredBy.get(id) ?? []), relative(TEST_DIR, file)]);
  }
}

describe('spec coverage', () => {
  it('manifest ids are unique and well-formed', () => {
    const ids = SPEC.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[RCQKP]-\d{2}$/);
  });

  it('every spec id used in a test name exists in the manifest', () => {
    const known = new Set(SPEC.map((s) => s.id));
    expect([...coveredBy.keys()].filter((id) => !known.has(id))).toEqual([]);
  });

  for (const { id, text } of SPEC) {
    const files = coveredBy.get(id);
    if (files) {
      it(`${id} covered by ${[...new Set(files)].join(', ')}`, () => {});
    } else if (strict) {
      it(`${id} has a test`, () => {
        expect.fail(`No test name starts with ${id}: ${text}`);
      });
    } else {
      it.todo(`${id} needs a test: ${text}`);
    }
  }
});
