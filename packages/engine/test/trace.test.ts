import { describe, expect, it } from 'vitest';
import { buildPosition, eventsFor, formatTrace, Tracer } from '../src/index.ts';

function setup() {
  const state = buildPosition({});
  return { state, tracer: new Tracer(state) };
}

describe('trace', () => {
  it('numbers events from the state, so numbering continues across tracers', () => {
    const { state, tracer } = setup();
    expect(tracer.emit({ type: 'note', text: 'a' })).toBe(1);
    expect(tracer.emit({ type: 'note', text: 'b' })).toBe(2);
    const next = new Tracer(state);
    expect(next.emit({ type: 'note', text: 'c' })).toBe(3);
    expect(state.traceSeq).toBe(3);
  });

  it('records round, turn, and the default "all" visibility', () => {
    const { tracer } = setup();
    tracer.emit({ type: 'note', text: 'hello' });
    expect(tracer.events[0]).toEqual({
      seq: 1,
      round: 1,
      turn: 0,
      depth: 0,
      cause: null,
      visibility: 'all',
      payload: { type: 'note', text: 'hello' },
    });
  });

  it('within() nests depth and sets the cause, and restores both afterward', () => {
    const { tracer } = setup();
    const root = tracer.emit({ type: 'note', text: 'root' });
    tracer.within(root, () => {
      const child = tracer.emit({ type: 'note', text: 'child' });
      tracer.within(child, () => tracer.emit({ type: 'note', text: 'grandchild' }));
      tracer.emit({ type: 'note', text: 'explicit' }, { cause: null });
    });
    tracer.emit({ type: 'note', text: 'after' });
    expect(tracer.events.map((e) => [e.payload.type === 'note' && e.payload.text, e.depth, e.cause])).toEqual([
      ['root', 0, null],
      ['child', 1, 1],
      ['grandchild', 2, 2],
      ['explicit', 1, null],
      ['after', 0, null],
    ]);
  });

  it('restores depth even if the nested code throws', () => {
    const { tracer } = setup();
    expect(() => tracer.within(1, () => { throw new Error('boom'); })).toThrow('boom');
    tracer.emit({ type: 'note', text: 'x' });
    expect(tracer.events[0]!.depth).toBe(0);
  });

  it('eventsFor shows private events only to their viewers and never leaks the hidden payload', () => {
    const { tracer } = setup();
    tracer.emit({ type: 'note', text: 'public' });
    tracer.emit(
      { type: 'note', text: 'SECRET: S1 drew Joker' },
      { visibility: [1], redacted: { type: 'note', text: 'S1 drew a card' } },
    );
    tracer.emit({ type: 'note', text: 'SECRET: server only' }, { visibility: [] });

    const forS1 = eventsFor(tracer.events, 1).map((e) => e.payload);
    expect(forS1).toEqual([
      { type: 'note', text: 'public' },
      { type: 'note', text: 'SECRET: S1 drew Joker' },
    ]);

    const forS2 = eventsFor(tracer.events, 2);
    expect(forS2.map((e) => e.payload)).toEqual([
      { type: 'note', text: 'public' },
      { type: 'note', text: 'S1 drew a card' },
    ]);
    expect(forS2[1]!.wasRedacted).toBe(true);
    expect(JSON.stringify(forS2)).not.toContain('SECRET');

    expect(eventsFor(tracer.events, 'server')).toHaveLength(3);
    expect(eventsFor(tracer.events, 'spectator').map((e) => e.payload)).toEqual([
      { type: 'note', text: 'public' },
      { type: 'note', text: 'S1 drew a card' },
    ]);
  });

  it('formats one indented line per event with causes and visibility', () => {
    const { tracer } = setup();
    const root = tracer.emit({ type: 'note', text: 'S0 plays Royal Favor' });
    tracer.within(root, () => {
      tracer.emit({ type: 'note', text: 'S2 draws' }, { visibility: [2] });
      tracer.emit({ type: 'note', text: 'deal' }, { visibility: [] });
    });
    expect(formatTrace(tracer.events)).toBe(
      [
        '#1    R1 T0   S0 plays Royal Favor',
        '#2    R1 T0     S2 draws  ← #1  [private: S2]',
        '#3    R1 T0     deal  ← #1  [server only]',
      ].join('\n'),
    );
  });
});
