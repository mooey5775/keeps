// Which build of the site this page is (set by vite.config.ts), and what to do
// when the server says it serves a different one.

declare const __KEEPS_BUILD__: string | undefined;

/** This page's build id; 'dev' under the Vite dev server and in tests. */
export const PAGE_BUILD: string = typeof __KEEPS_BUILD__ === 'string' ? __KEEPS_BUILD__ : 'dev';

const RELOADED_KEY = 'keeps:reloaded-for';

/**
 * What to do when the server reports its build: nothing if it matches (or
 * either side is a development build), reload once to pick up the new one,
 * or, if a reload already happened for that build and the page is still old,
 * ask the player to reload instead of looping.
 */
export function onServerBuild(serverBuild: string | undefined, pageBuild: string, reloadedFor: string | null): 'ok' | 'reload' | 'ask' {
  if (!serverBuild || serverBuild === pageBuild || pageBuild === 'dev') return 'ok';
  return reloadedFor === serverBuild ? 'ask' : 'reload';
}

export function reloadedFor(): string | null {
  try {
    return sessionStorage.getItem(RELOADED_KEY);
  } catch {
    return null;
  }
}

export function markReloadedFor(build: string): void {
  try {
    sessionStorage.setItem(RELOADED_KEY, build);
  } catch {
    // Without storage, the guard can't hold; asking is the safe fallback next time.
  }
}
