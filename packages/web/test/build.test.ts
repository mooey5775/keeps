import { describe, expect, it } from 'vitest';
import { onServerBuild } from '../src/net/build.ts';

describe('a page from another build of the site', () => {
  it('does nothing when the builds match, or in development', () => {
    expect(onServerBuild('b1', 'b1', null)).toBe('ok');
    expect(onServerBuild(undefined, 'b1', null)).toBe('ok');
    expect(onServerBuild('b2', 'dev', null)).toBe('ok');
  });

  it('reloads once to get the new build, then asks instead of looping', () => {
    expect(onServerBuild('b2', 'b1', null)).toBe('reload');
    expect(onServerBuild('b2', 'b1', 'b2')).toBe('ask');
    // A later deploy reloads again.
    expect(onServerBuild('b3', 'b1', 'b2')).toBe('reload');
  });
});
