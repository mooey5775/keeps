import { describe, expect, it } from 'vitest';
import {
  apply,
  CARD_IDS,
  checkInvariants,
  checkRestInvariants,
  formatReplayLog,
  legalCommands,
  newGame,
  parseReplayLog,
  pick,
  playerSeats,
  replay,
  seedRng,
  viewFor,
  type CardId,
  type GameState,
  type ReplayLog,
  type Seat,
  type TraceEvent,
} from '../../src/index.ts';

// Whole games with the full deck: random legal commands from every seat until
// someone wins. After every command we check the invariants, that each
// player's view leaks nothing they shouldn't see, and that the trace is
// well-formed. Then the game is replayed from its log and must match exactly.

/** Card ids a viewer may legitimately see in their view right now. */
function entitled(state: GameState, seat: Seat): Set<CardId> {
  const ok = new Set<CardId>([...state.hands[seat], ...state.discard]);
  for (const keep of state.keeps) {
    for (const c of keep) if (!c.faceDown || c.faceDown.placedBy === seat) ok.add(c.id);
  }
  for (const pile of Object.values(state.piles)) if (pile.cards[0]?.faceUp) ok.add(pile.cards[0].id);
  // Cards the viewer is looking at through one of their own open prompts.
  for (const p of state.prompts) {
    if (p.seat !== seat) continue;
    switch (p.kind) {
      case 'choose-pile-card':
      case 'order-pile':
        p.cards.forEach((c) => ok.add(c));
        break;
      case 'choose-top-card':
      case 'choose-hand-card':
        p.options.forEach((o) => ok.add(o.card));
        break;
      case 'take-or-discard':
        ok.add(p.card);
        break;
      default:
        break;
    }
  }
  return ok;
}

function leaks(state: GameState, seat: Seat): CardId[] {
  // `frame.kind` can be 'hocus-pocus', which is a frame kind, not a card.
  const { frame: _frame, ...view } = viewFor(state, seat);
  const json = JSON.stringify(view);
  const allowed = entitled(state, seat);
  return CARD_IDS.filter((id) => json.includes(`"${id}"`) && !allowed.has(id));
}

function playRandomGame(seed: number, players: 2 | 3 | 4) {
  const rng = seedRng(`full-game-${seed}`);
  const options = { players, seed: `game-${seed}`, marksToWin: 2 } as const;
  let { state, events } = newGame(options);
  const log: ReplayLog = { options, commands: [] };
  const seen = new Set(events.map((e) => e.seq));
  let lastSeq = events.at(-1)!.seq;

  for (let n = 0; state.phase !== 'game-over'; n++) {
    expect(n, `seed ${seed}: game did not finish`).toBeLessThan(5000);
    const options = playerSeats(state).flatMap((seat) => legalCommands(state, seat).map((command) => ({ seat, command })));
    expect(options.length, `seed ${seed}: deadlock`).toBeGreaterThan(0);
    const choice = pick(rng, options);
    const result = apply(state, choice.seat, choice.command);
    if (!result.ok) expect.fail(`seed ${seed}: ${result.error.code}: ${result.error.message}`);
    log.commands.push(choice);
    state = result.state;
    checkTrace(result.events, seen, lastSeq);
    lastSeq = result.events.at(-1)?.seq ?? lastSeq;
    events = [...events, ...result.events];

    expect(checkInvariants(state)).toEqual([]);
    expect(checkRestInvariants(state)).toEqual([]);
    for (const seat of playerSeats(state)) expect(leaks(state, seat), `seed ${seed}, seat ${seat}`).toEqual([]);
  }
  return { state, events, log };
}

function checkTrace(batch: TraceEvent[], seen: Set<number>, lastSeq: number) {
  let previous = lastSeq;
  for (const e of batch) {
    expect(e.seq).toBe(previous + 1);
    previous = e.seq;
    if (e.cause !== null) expect(seen.has(e.cause), `event #${e.seq} has unknown cause #${e.cause}`).toBe(true);
    seen.add(e.seq);
  }
}

describe('random full games', () => {
  for (const players of [2, 3, 4] as const) {
    it(`${players} players: every game ends, with valid states, no leaks, and a sound trace`, () => {
      for (let seed = 0; seed < 25; seed++) {
        const { state } = playRandomGame(seed, players);
        expect(Math.max(...state.marks)).toBe(2);
      }
    });
  }

  it('replays a game from its log, exactly', () => {
    const { state, events, log } = playRandomGame(42, 3);
    const parsed = parseReplayLog(formatReplayLog(log));
    expect(parsed).toEqual(log);
    const replayed = replay(parsed);
    expect(replayed.failure).toBeUndefined();
    expect(replayed.state).toEqual(state);
    expect(replayed.events).toEqual(events);
  });

  it('a replay stops at the first rejected command', () => {
    const { log } = playRandomGame(1, 2);
    const broken: ReplayLog = { ...log, commands: [log.commands[0]!, log.commands[0]!] };
    expect(replay(broken).failure?.index).toBe(1);
  });
});
