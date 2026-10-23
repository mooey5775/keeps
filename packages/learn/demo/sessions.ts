// Who played on the demo, and how it went: every game whose replay changed since a time.
//   node sessions.ts [--since <ISO time or ms>]     (default: the last restart, from data/last-restart)
// One line per game: room, times, players (from data/sessions.jsonl; by seat for games before it
// existed), rounds, marks, and the result (won, or unfinished and where it stood).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { apply, newGame, type GameState, type Seat } from '../../engine/src/index.ts';

const DATA = join(import.meta.dirname, 'data');
const sinceArg = process.argv.indexOf('--since') >= 0 ? process.argv[process.argv.indexOf('--since') + 1]! : null;
const lastRestart = existsSync(join(DATA, 'last-restart')) ? readFileSync(join(DATA, 'last-restart'), 'utf8').trim() : '0';
const raw = sinceArg ?? lastRestart;
const since = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);

type Session = { replay: string; room: string; startedAt: number; bot: string; players: { seat: number; name: string; bot: boolean }[] };
const sessions = new Map<string, Session>();
if (existsSync(join(DATA, 'sessions.jsonl'))) {
  for (const line of readFileSync(join(DATA, 'sessions.jsonl'), 'utf8').split('\n')) if (line.trim()) {
    const s = JSON.parse(line) as Session;
    sessions.set(s.replay, s);
  }
}
const time = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour12: false });

const files = readdirSync(join(DATA, 'replays'))
  .map((f) => ({ f, mtime: statSync(join(DATA, 'replays', f)).mtimeMs }))
  .filter(({ mtime }) => mtime >= since)
  .sort((a, b) => a.mtime - b.mtime);
if (!files.length) console.log(`nobody played since ${time(since)}`);
for (const { f, mtime } of files) {
  const lines = readFileSync(join(DATA, 'replays', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  let state = newGame(lines[0].options).state as GameState;
  for (const { seat, command } of lines.slice(1)) {
    const r = apply(state, seat as Seat, command);
    if (!r.ok) break;
    state = r.state;
  }
  const s = sessions.get(f);
  const seats = state.config.seats.flatMap((kind, seat) => (kind === 'player' ? [seat] : []));
  const name = (seat: number) => s?.players.find((p) => p.seat === seat)?.name ?? `seat ${seat}`;
  const who = seats.map((seat) => (s ? `${name(seat)} (seat ${seat})` : name(seat))).join(' vs ');
  const marks = seats.map((seat) => `${name(seat)} ${state.marks[seat as Seat]}`).join(', ');
  const started = Number(lines.length > 1 ? Date.parse(f.slice(5, -6).replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z/, 'T$1:$2:$3.$4Z')) : mtime);
  const roundsDone = state.phase === 'round-over' || state.phase === 'game-over' ? state.round : state.round - 1;
  let result: string;
  if (state.phase === 'game-over') {
    const winner = seats.find((seat) => state.marks[seat as Seat] >= state.config.marksToWin)!;
    result = `${name(winner)} won the game ${marks}`;
  } else if (lines.length <= 1) {
    result = 'started, no moves';
  } else {
    const leader = seats.reduce((a, b) => (state.marks[b as Seat] > state.marks[a as Seat] ? b : a));
    const tied = seats.every((seat) => state.marks[seat as Seat] === state.marks[leader as Seat]);
    result = `unfinished after ${roundsDone} round${roundsDone === 1 ? '' : 's'} (${marks}${tied ? ', level' : `, ${name(leader)} ahead`}; first to ${state.config.marksToWin})`;
  }
  console.log(`${f.slice(0, 4)} ${time(isNaN(started) ? mtime : started)}–${time(mtime)}: ${who}${s ? ` [${s.bot}]` : ''}: ${result}`);
}
