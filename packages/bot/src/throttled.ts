/**
 * `log`, at most once a `periodMs`: for failures that could come by the thousand (each search's, each review job's)
 * and should still show in the log however long the server's been up. A line after a quiet spell says how many
 * were left out.
 */
export function throttled(log: (line: string) => void = console.error, periodMs = 60_000): (line: string) => void {
  let last = -Infinity;
  let skipped = 0;
  return (line) => {
    const now = Date.now();
    if (now - last < periodMs) {
      skipped++;
      return;
    }
    log(skipped ? `${line} (and ${skipped} more like it since the last)` : line);
    last = now;
    skipped = 0;
  };
}
