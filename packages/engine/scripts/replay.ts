// Re-runs a replay log and prints its trace.
// Usage: pnpm --filter @keeps/engine replay <log.jsonl> [--as <seat>]
import { readFileSync } from 'node:fs';
import { eventsFor, formatTrace, parseReplayLog, replay, type Seat } from '../src/index.ts';

const [file, flag, seatArg] = process.argv.slice(2);
if (!file) {
  console.error('usage: replay <log.jsonl> [--as <seat>]');
  process.exit(2);
}
const result = replay(parseReplayLog(readFileSync(file, 'utf8')));
const viewer = flag === '--as' ? (Number(seatArg) as Seat) : 'server';
console.log(formatTrace(eventsFor(result.events, viewer)));
if (result.failure) {
  console.error(`\ncommand #${result.failure.index} was rejected: ${result.failure.error.code}: ${result.failure.error.message}`);
  process.exit(1);
}
