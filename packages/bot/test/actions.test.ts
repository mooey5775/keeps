import { buildPosition, legalCommands, viewFor, type Command, type Seat } from '@keeps/engine';
import { describe, expect, it } from 'vitest';
import { actionName, CARD, Decision, encode, NUM_ACTIONS, POS } from '../src/actions.ts';
import { RoundEnv } from '../src/env.ts';

// The action space must be a faithful, unambiguous re-encoding of the engine's
// legal commands: over many random rounds, at every decision, each legal
// command has its own id sequence, no complete sequence starts another, every
// sequence leads back to its command one id at a time, and a round can be
// played to the end through ids alone.

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('action ids', () => {
  it('re-encode every legal command uniquely, prefix-free, and reachable one id at a time, in 400 random rounds', () => {
    let decisions = 0;
    let longest = 0;
    const kinds = new Set<string>();
    for (let g = 0; g < 400; g++) {
      const random = rng(g + 1);
      const env = RoundEnv.start(`actions-${g}`);
      for (let step = 0; !env.terminal && step < 5000; step++) {
        if (env.prefix.length === 0) {
          const seat = env.decider();
          const view = viewFor(env.state, seat);
          const legal = legalCommands(env.state, seat);
          const decision = new Decision(view, legal);
          const encodings = decision.encodings();
          const keys = encodings.map((ids) => ids.join(','));
          expect(new Set(keys).size, `round ${g}: two commands share ids`).toBe(keys.length);
          for (const ids of encodings) {
            longest = Math.max(longest, ids.length);
            for (const id of ids) expect(id >= 0 && id < NUM_ACTIONS).toBe(true);
            // Prefix-free: no other complete sequence is a proper prefix of this one.
            for (const other of encodings) {
              if (other !== ids && other.length < ids.length) expect(other.every((id, i) => ids[i] === id), `${other} starts ${ids}`).toBe(false);
            }
            // Reachable: each id is offered at its step, and the whole sequence spells out the command.
            for (let i = 0; i < ids.length; i++) {
              expect(decision.next(ids.slice(0, i))).toContain(ids[i]);
              if (i < ids.length - 1) expect(decision.complete(ids.slice(0, i + 1))).toBeNull();
            }
            const command = decision.complete(ids);
            expect(command && encode(command, view)).toEqual(ids);
          }
          // Every legal command is covered (Tithes: any order, so it lists none).
          if (encodings.length > 0) expect(encodings).toHaveLength(legal.filter((c) => c.type !== 'next-round').length);
          decisions++;
          for (const c of legal) kinds.add(c.type === 'answer' ? c.answer.kind : c.type);
        }
        const actions = env.legalActions();
        expect(actions.length, `round ${g}, step ${step}: stuck`).toBeGreaterThan(0);
        expect(actions, 'legal actions must be ascending (OpenSpiel)').toEqual([...actions].sort((x, y) => x - y));
        env.step(actions[Math.floor(random() * actions.length)]!);
      }
      expect(env.terminal, `round ${g} did not finish`).toBe(true);
      const [a, b] = env.returns();
      expect(a + b).toBe(0);
      expect(Math.abs(a)).toBe(1);
    }
    expect(decisions).toBeGreaterThan(10_000);
    expect(kinds.size).toBeGreaterThanOrEqual(15);
    expect(longest).toBeLessThanOrEqual(9);
  });

  it('Tithes: any order of the pile can be chosen, one card at a time', () => {
    const start = buildPosition({
      seats: ['player', 'ghost', 'player', 'ghost'],
      keeps: { 0: ['tithes'] },
      piles: { 0: ['dagger', 'chalice', 'scepter', 'medallion'], 2: ['?'] },
      turn: 0,
    });
    const seat: Seat = 0;
    const use = legalCommands(start, seat).find((c) => c.type === 'answer' && c.answer.kind === 'action' && c.answer.choice.action === 'ability')!;
    const decision = new Decision(viewFor(start, seat), [use]);
    expect(decision.next([])).toEqual([CARD('tithes')]);
    expect(decision.complete([CARD('tithes')])).toBe(use);

    // An order the engine doesn't list (it lists only as-is and reversed).
    const env = RoundEnv.start('tithes-order');
    (env as unknown as { state: typeof start }).state = start;
    env.step(CARD('tithes'));
    const order = ['scepter', 'dagger', 'medallion', 'chalice'] as const;
    for (const card of order) {
      expect(env.legalActions()).toContain(CARD(card));
      env.step(CARD(card));
    }
    expect(env.state.piles[env.state.pileAt[0]].cards.map((c) => c.id)).toEqual(order);
  });

  it('names seats and piles relative to the chooser, as the observation does', () => {
    // The network can't tell which seat it's in (the observation is relative), so
    // "my keep" must be the same id from either seat. With absolute seats it was
    // 50/50 on every keep and pile choice, whatever it learned.
    const seatOf = (c: Command): Seat[] => {
      if (c.type !== 'answer') return [];
      const a = c.answer;
      if (a.kind === 'action') {
        const ch = a.choice;
        if (ch.action === 'play' && ch.target !== undefined) return [ch.target];
        if (ch.action === 'ability' && ch.card === 'sanction') return [ch.from];
        if (ch.action === 'ability' && ch.card === 'blunder') return [ch.pile];
        if (ch.action === 'ability' && ch.card === 'juggling') return [...ch.piles];
        return [];
      }
      if (a.kind === 'hot-target' || a.kind === 'duplicity-hide') return [a.target];
      if (a.kind === 'choose-pile' || a.kind === 'choose-top-card') return [a.pile];
      if (a.kind === 'choose-player') return [a.seat];
      if (a.kind === 'claim-pile') return [a.from];
      return [];
    };
    const kinds = new Set<string>();
    for (let g = 0; g < 200; g++) {
      const random = rng(500 + g);
      const env = RoundEnv.start(`relative-${g}`, { checked: false });
      while (!env.terminal) {
        if (env.prefix.length === 0) {
          const seat = env.decider();
          const view = viewFor(env.state, seat);
          for (const command of legalCommands(env.state, seat)) {
            if (command.type === 'next-round') continue;
            const ids = encode(command, view);
            for (const named of seatOf(command)) {
              const expected = POS((named - seat + 4) % 4);
              expect(ids, `seat ${seat}: ${JSON.stringify(command)}`).toContain(expected);
              if (named === seat) expect(ids).toContain(POS(0));
              kinds.add(command.type === 'answer' ? command.answer.kind : command.type);
            }
          }
        }
        const legal = env.legalActions();
        env.step(legal[Math.floor(random() * legal.length)]!);
      }
    }
    expect(kinds.size).toBeGreaterThanOrEqual(4);
  });

  it('has 48 ids with readable names', () => {
    expect(NUM_ACTIONS).toBe(48);
    expect(new Set(Array.from({ length: NUM_ACTIONS }, (_, i) => actionName(i))).size).toBe(48);
  });
});
