import { describe, expect, it } from 'vitest';
import {
  apply,
  describe as describeEvent,
  eventsFor,
  formatTrace,
  legalCommands,
  newGame,
  pick,
  playerSeats,
  seedRng,
  type TraceEvent,
  type TracePayload,
} from '../../src/index.ts';

// The trace is what players read (as the game log) and what we read when
// debugging, so across many random games: every event type renders as
// readable text, and private events always have a redacted copy that leaves
// out exactly the hidden part.

function collectEvents(games: number): TraceEvent[] {
  const all: TraceEvent[] = [];
  for (let game = 0; game < games; game++) {
    const rng = seedRng(`trace-quality-${game}`);
    const start = newGame({ players: (2 + (game % 3)) as 2 | 3 | 4, seed: `trace-quality-${game}`, marksToWin: 2 });
    let state = start.state;
    all.push(...start.events);
    while (state.phase !== 'game-over') {
      const options = playerSeats(state).flatMap((seat) => legalCommands(state, seat).map((command) => ({ seat, command })));
      const choice = pick(rng, options);
      const result = apply(state, choice.seat, choice.command);
      if (!result.ok) throw new Error(result.error.message);
      state = result.state;
      all.push(...result.events);
    }
  }
  return all;
}

const events = collectEvents(40);
const ofType = <T extends TracePayload['type']>(type: T) => events.filter((e) => e.payload.type === type);

describe('trace quality', () => {
  it('random games produce most event types', () => {
    const seen = new Set(events.map((e) => e.payload.type));
    const expected: TracePayload['type'][] = [
      'game-start', 'round-start', 'pile-dealt', 'turn-start', 'turn-end', 'prompt', 'action', 'draw', 'empty-draw',
      'play', 'extra-actions', 'pile-swap', 'pile-rotate', 'pile-flip', 'look', 'take', 'discard', 'keep-swap',
      'pile-reorder', 'place-on-pile', 'steal', 'give', 'look-hands', 'reveal-card', 'piles-to-center', 'pile-claim',
      'last-laugh', 'place-face-down', 'reveal', 'triggers', 'trigger', 'round-end', 'score', 'mark', 'game-over',
    ];
    expect(expected.filter((t) => !seen.has(t))).toEqual([]);
  });

  it('every event renders as text with no undefined values or raw objects', () => {
    for (const e of events) {
      const text = describeEvent(e.payload);
      expect(text.length, JSON.stringify(e.payload)).toBeGreaterThan(0);
      expect(text, JSON.stringify(e.payload)).not.toMatch(/undefined|NaN|\[object|null/);
      if (e.redacted) expect(describeEvent(e.redacted), JSON.stringify(e.redacted)).not.toMatch(/undefined|NaN|\[object|null/);
    }
    expect(formatTrace(events).split('\n')).toHaveLength(events.length);
  });

  it('private events of these types always carry a redacted copy', () => {
    const mustRedact = new Set<TracePayload['type']>(['draw', 'take', 'look', 'look-hands', 'steal', 'give', 'pile-reorder', 'place-face-down', 'pile-dealt']);
    for (const e of events) {
      if (e.visibility === 'all' || !mustRedact.has(e.payload.type)) continue;
      expect(e.redacted, `#${e.seq} ${e.payload.type}`).toBeDefined();
    }
  });

  it('redacted copies hide the card details and keep everything else', () => {
    for (const e of events) {
      if (!e.redacted) continue;
      const full = e.payload as Record<string, unknown>;
      const red = e.redacted as Record<string, unknown>;
      switch (e.payload.type) {
        case 'draw':
        case 'take':
        case 'give':
        case 'place-face-down':
          expect(red.card).toBeNull();
          expect({ ...red, card: full.card }).toEqual(full);
          break;
        case 'look':
          expect(red.cards).toBeNull();
          break;
        case 'look-hands':
          expect(red.hands).toBeNull();
          break;
        case 'steal':
          expect(red.cards).toBeNull();
          expect(red.count).toBe(full.count);
          break;
        case 'pile-reorder':
          expect(red.order).toBeNull();
          break;
        case 'pile-dealt':
          expect(red).toEqual({ type: 'pile-placed', position: full.position, size: (full.cards as unknown[]).length });
          break;
        default:
          break;
      }
    }
  });

  it('a face-up draw is public, a face-down draw private to the drawer', () => {
    for (const e of ofType('draw')) {
      if (e.visibility === 'all') continue;
      expect(e.visibility).toEqual([(e.payload as { seat: number }).seat]);
    }
  });

  it('spectators never see a private payload', () => {
    const forSpectator = eventsFor(events, 'spectator');
    for (const e of forSpectator) expect(e.visibility === 'all' || e.wasRedacted === true).toBe(true);
    const json = JSON.stringify(forSpectator.filter((e) => e.payload.type === 'draw' && e.wasRedacted));
    expect(json).not.toMatch(/"card":"/);
  });

  it('an event is never caused by itself or by a later event', () => {
    for (const e of events) if (e.cause !== null) expect(e.cause).toBeLessThan(e.seq);
  });
});
