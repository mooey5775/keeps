import { apply, newGame, viewFor, type Command, type PlayerView, type Seat } from '@keeps/engine';
import { describe, expect, it } from 'vitest';
import { click, clickable, describeOptions, makeNames, narrow, panelItems, shownCards, type Option, type Ref } from '../src/options.ts';

// The UI's picture of the possible moves must match the engine's. Over many
// random games, at every decision, every legal command:
// - has a real label,
// - involves only elements that are actually on the table,
// - can be reached by clicking its elements (or, when several commands share
//   the same elements, by a button after clicking them), and never makes a
//   click send a different command,
// - and appears in the side panel, directly or inside a group.
// If a rules change gives a command a shape the UI misreads, this fails.

const GAMES = 120;
const names = ['Ann', 'Bo', 'Cy', 'Di'];

/** A small seeded RNG, so a failure can be replayed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Whether the table draws something you could click for `ref`. */
function onTable(view: PlayerView, me: Seat, ref: Ref, shown: Set<Ref>): boolean {
  const [kind, a, b] = ref.split(':') as [string, string, string | undefined];
  const seat = Number(a) as Seat;
  switch (kind) {
    case 'hand':
      return (view.hands[me]!.cards ?? []).includes(a as never);
    case 'pile':
      return seat >= 0 && seat < 4;
    case 'keep':
      return view.seats[seat] === 'player';
    case 'keepcard':
      return view.seats[seat] === 'player' && view.keeps[seat]!.cards[Number(b)] !== undefined;
    case 'discard':
      return view.discard.includes(a as never);
    case 'player':
      return seat >= 0 && seat < 4;
    case 'shown':
      return shown.has(ref);
    default:
      return false;
  }
}

/** Clicks an option's elements, starting where it can start. Returns what happened. */
function clickThrough(options: Option[], option: Option): { sent: Command | null; remaining: Option[] } {
  const start = (option.starts ?? option.refs.slice(0, 1))[0]!;
  const order = [start, ...option.refs.filter((r) => r !== start)];
  let picked: Ref[] = [];
  for (const ref of order) {
    const result = click(options, picked, ref);
    if (result.kind === 'send') return { sent: result.command, remaining: [] };
    if (result.kind === 'ignore') throw new Error(`click on ${ref} ignored for "${option.label}"`);
    picked = result.picked;
  }
  return { sent: null, remaining: narrow(options, picked) };
}

describe('UI options cover the engine’s legal commands', () => {
  it(`in ${GAMES} random games, every legal command is labelled, on the table, and reachable`, () => {
    let decisions = 0;
    const kinds = new Set<string>();
    for (let g = 0; g < GAMES; g++) {
      const random = rng(g + 1);
      let { state } = newGame({ players: ([2, 3, 4] as const)[g % 3]!, seed: `coverage-${g}`, marksToWin: 2 });
      for (let step = 0; step < 2000 && state.phase !== 'game-over'; step++) {
        const deciders = ([0, 1, 2, 3] as Seat[]).filter((s) => viewFor(state, s).legal.length > 0);
        if (deciders.length === 0) break;
        const me = deciders[Math.floor(random() * deciders.length)]!;
        const view = viewFor(state, me);
        const options = describeOptions(view, makeNames(names, me));
        const where = `game ${g}, step ${step}, seat ${me}`;
        expect(options, where).toHaveLength(view.legal.length);
        const shown = new Set((shownCards(view, makeNames(names, me))?.cards ?? []).flatMap((c) => (c.ref ? [c.ref] : [])));
        const starts = clickable(options, []);
        const panel = panelItems(options, []);

        for (const option of options) {
          const what = `${where}: "${option.label}"`;
          decisions++;
          const command = option.command;
          kinds.add(command.type === 'answer' ? command.answer.kind : command.type);
          expect(option.label, what).toMatch(/\S/);
          expect(option.label, what).not.toMatch(/undefined|null|NaN|\[object/);
          for (const ref of option.refs) expect(onTable(view, me, ref, shown), `${what} → ${ref} is not on the table`).toBe(true);

          // In the panel: listed, or inside a group whose element leads to it.
          const listed = panel.some((i) => (i.kind === 'option' ? i.option === option : narrow(options, [i.ref]).includes(option)));
          expect(listed, `${what} is not in the side panel`).toBe(true);

          if (option.refs.length === 0) continue;
          expect(starts.has((option.starts ?? option.refs)[0]!), `${what} can't be started on the table`).toBe(true);
          const { sent, remaining } = clickThrough(options, option);
          if (sent) expect(sent, `${what}: clicking its elements sent a different command`).toBe(command);
          else expect(remaining, `${what}: clicking its elements lost it`).toContain(option);
        }

        const command = view.legal[Math.floor(random() * view.legal.length)]!;
        const result = apply(state, me, command);
        if (!result.ok) throw new Error(`${where}: ${result.error.message}`);
        state = result.state;
      }
    }
    // The games went through a broad range of decisions, not just draws.
    expect(kinds.size).toBeGreaterThanOrEqual(18);
    expect(decisions).toBeGreaterThan(10_000);
  }, 120_000);
});
