// Watchdogs for the search (search-pool.ts, search-worker.ts) that count only the time the app runs. A locked phone or
// an app in the background suspends the page, but its clock goes on: a plain timeout would take the suspension for a
// worker gone stuck, and end work that was only paused.

/** How often the watchdog looks at the clock. */
const TICK_MS = 1000;
/** A gap this long between two looks: the page was suspended, not running. */
const SUSPENDED_MS = 5 * TICK_MS;

/**
 * `fn` after `ms` of running time, like setTimeout but with any time the page was suspended left out. Returns what
 * cancels it.
 */
export function awakeTimeout(ms: number, fn: () => void): () => void {
  let awake = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const gap = now - last;
    last = now;
    awake += gap >= SUSPENDED_MS ? TICK_MS : gap;
    if (awake < ms) return;
    clearInterval(timer);
    fn();
  }, TICK_MS);
  return () => clearInterval(timer);
}
