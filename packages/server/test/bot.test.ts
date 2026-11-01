import { readFileSync } from 'node:fs';
import { Policy, type BotPlayer } from '@keeps/learn';
import { replay, viewFor, type Command, type GameState, type ReplayLog, type Seat, type TraceEvent } from '@keeps/engine';
import type { Hint, ServerMessage } from '@keeps/protocol';
import { describe, expect, it } from 'vitest';
import { Room, type BotDeps, type BotTurn, type PlayedMove, type RoomDeps, type RoomMember, type Send } from '../src/room.ts';

const policy = Policy.load(readFileSync(new URL('../../learn/weights/bot.bin', import.meta.url)));

/** A room whose bot moves only when the test runs its scheduled move (`bot`: more of the bot's deps). */
function botRoom(overrides: Partial<RoomDeps> = {}, bot: Partial<BotDeps> = {}) {
  let n = 0;
  const pending: { fn: () => void; cancelled: boolean }[] = [];
  const saved: ReplayLog[] = [];
  let x = 7;
  const deps: RoomDeps = {
    token: () => `token-${++n}`,
    id: () => `p${++n}`,
    seed: () => 'bot-seed',
    random: () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32,
    now: () => 1000,
    saveReplay: (_code, _at, log) => saved.push(structuredClone(log)),
    bot: {
      policy,
      schedule: (fn) => {
        const task = { fn, cancelled: false };
        pending.push(task);
        return () => (task.cancelled = true);
      },
      delay: () => 1000,
      ...bot,
    },
    ...overrides,
  };
  const room = new Room('BOTS', deps);
  /** Runs the bot's scheduled move; false if none is pending. */
  const runBot = (): boolean => {
    const task = pending.find((t) => !t.cancelled);
    if (!task) return false;
    pending.splice(pending.indexOf(task), 1);
    task.fn();
    return true;
  };
  const waiting = () => pending.filter((t) => !t.cancelled).length;
  return { room, runBot, waiting, saved, deps };
}

class Client {
  messages: ServerMessage[] = [];
  send: Send = (m) => this.messages.push(structuredClone(m));
  id = '';

  last<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }> {
    const found = this.messages.findLast((m) => m.t === t);
    if (!found) throw new Error(`no ${t} message`);
    return found as Extract<ServerMessage, { t: T }>;
  }

  errors(): string[] {
    return this.messages.flatMap((m) => (m.t === 'error' ? [m.message] : []));
  }
}

function join(room: Room, name: string): Client {
  const client = new Client();
  client.id = room.join(name, client.send).id;
  return client;
}

describe('the bot in a room', () => {
  it('plays at a difficulty the host chooses, where the server offers one', () => {
    const { room } = botRoom({ bot: { policy, schedule: () => () => {}, delay: () => 0, levels: true } });
    const host = join(room, 'Ana');
    room.handle(host.id, { t: 'add-bot' });
    expect(host.last('room').room.botLevels).toBe(true);
    room.handle(host.id, { t: 'settings', settings: { marksToWin: 3, firstPlayer: 'random', botLevel: 'easy' } });
    expect(host.errors()).toEqual([]);
    expect(host.last('room').room.settings.botLevel).toBe('easy');
    room.handle(host.id, { t: 'settings', settings: { marksToWin: 3, firstPlayer: 'random', botLevel: 'expert' as never } });
    expect(host.errors()).toEqual(['Invalid difficulty.']);
    expect(host.last('room').room.settings.botLevel).toBe('easy');
  });

  it('has no difficulty to choose where the server offers none', () => {
    const { room } = botRoom();
    const host = join(room, 'Ana');
    room.handle(host.id, { t: 'add-bot' });
    expect(host.last('room').room.botLevels).toBeUndefined();
    room.handle(host.id, { t: 'settings', settings: { marksToWin: 3, firstPlayer: 'random', botLevel: 'easy' } });
    expect(host.errors()).toEqual(['Invalid difficulty.']);
    expect(host.last('room').room.settings.botLevel).toBeUndefined();
  });

  it('can be added by the host to a room for two, and shows as a connected bot', () => {
    const { room } = botRoom();
    const host = join(room, 'Ana');
    room.handle(host.id, { t: 'add-bot' });
    expect(host.errors()).toEqual([]);
    const summary = host.last('room').room;
    expect(summary.botAvailable).toBe(true);
    expect(summary.players).toEqual([
      expect.objectContaining({ name: 'Ana', host: true }),
      expect.objectContaining({ name: 'Bot', bot: true, connected: true, host: false }),
    ]);
    room.handle(host.id, { t: 'add-bot' });
    expect(host.errors()).toEqual(['The bot is already here.']);
    room.handle(host.id, { t: 'remove-bot' });
    expect(host.last('room').room.players.map((p) => p.name)).toEqual(['Ana']);
  });

  it('sits at the table under the name the server gives it', () => {
    const { room } = botRoom({ bot: { policy, schedule: () => () => {}, delay: () => 1000, name: 'Midstrike' } });
    const host = join(room, 'Ana');
    room.handle(host.id, { t: 'add-bot' });
    expect(host.last('room').room.players.map((p) => p.name)).toEqual(['Ana', 'Midstrike']);
  });

  it('only plays two-player games', () => {
    const { room } = botRoom();
    const host = join(room, 'Ana');
    const guest = join(room, 'Ben');
    room.handle(guest.id, { t: 'add-bot' });
    expect(guest.errors()).toEqual(['Only the host can add the bot.']);
    room.handle(host.id, { t: 'add-bot' });
    expect(host.errors()).toEqual(['The bot only plays two-player games.']);

    // Someone joins after the bot: the game can't start until one of them goes.
    const solo = botRoom();
    const a = join(solo.room, 'Ana');
    solo.room.handle(a.id, { t: 'add-bot' });
    join(solo.room, 'Ben');
    solo.room.handle(a.id, { t: 'start' });
    expect(a.errors()).toEqual(['The bot only plays two-player games.']);
  });

  it('leaves with the last person in the lobby, and never hosts', () => {
    const { room } = botRoom();
    const host = join(room, 'Ana');
    room.handle(host.id, { t: 'add-bot' });
    room.handle(host.id, { t: 'leave' });
    const next = join(room, 'Ben');
    const players = next.last('room').room.players;
    expect(players).toEqual([expect.objectContaining({ name: 'Ben', host: true })]);
  });

  it('plays a whole game against a person, only on its own turns, with no undo', () => {
    const { room, runBot, waiting, saved } = botRoom();
    const human = join(room, 'Ana');
    room.handle(human.id, { t: 'settings', settings: { marksToWin: 2, firstPlayer: 'random' } });
    room.handle(human.id, { t: 'add-bot' });
    room.handle(human.id, { t: 'start' });
    let undoTried = false;
    for (let step = 0; human.last('game').view.phase !== 'game-over'; step++) {
      expect(step).toBeLessThan(5000);
      const legal = human.last('game').view.legal;
      const prompted = human.last('game').view.prompts.some((p) => p.mine);
      if (prompted || legal.some((c) => c.type === 'next-round')) {
        // The person's move (nothing of the bot's is pending meanwhile).
        expect(waiting()).toBe(0);
        const command = legal.find((c) => c.type !== 'reveal-duplicity') ?? legal[0]!;
        room.handle(human.id, { t: 'command', command });
        expect(human.errors()).toEqual([]);
        if (!undoTried && human.last('game').view.phase === 'playing') {
          undoTried = true;
          expect(human.last('game').undo.available).toBe(false);
          room.handle(human.id, { t: 'propose-undo' });
          expect(human.errors()).toEqual(['Undo is off in games against the bot.']);
          human.messages = human.messages.filter((m) => m.t !== 'error');
        }
      } else {
        expect(runBot(), `step ${step}: neither the person nor the bot can move`).toBe(true);
      }
    }
    const log = saved.at(-1)!;
    const seats = new Set(log.commands.map((c) => c.seat));
    expect(seats.size).toBe(2); // both played
    expect(human.last('game').view.marks.some((m) => m >= 2)).toBe(true);
  });

  it('training mode: the bot suggests each of the person\'s moves, to them alone, only while it is on', () => {
    const { room, runBot } = botRoom();
    const human = join(room, 'Ana');
    room.handle(human.id, { t: 'settings', settings: { marksToWin: 1, firstPlayer: 'random' } });
    room.handle(human.id, { t: 'add-bot' });
    room.handle(human.id, { t: 'start' });
    const watcher = join(room, 'Wes'); // a spectator
    // Off by default: no hints at all.
    expect(human.last('room').room.training).toBe(false);
    expect('hints' in human.last('game')).toBe(false);
    room.handle(human.id, { t: 'training', on: true });
    expect(human.errors()).toEqual([]);
    expect(human.last('room').room.training).toBe(true);
    let advised = 0;
    for (let step = 0; human.last('game').view.phase === 'playing' || human.last('game').view.phase === 'post-round'; step++) {
      expect(step).toBeLessThan(5000);
      const game = human.last('game');
      const mine = game.view.prompts.some((p) => p.mine);
      if (mine) {
        // Every legal move, the most likely first, probabilities adding up to 1.
        const hints = game.hints!;
        expect(hints.length).toBeGreaterThan(0);
        expect(hints.reduce((sum, h) => sum + h.probability, 0)).toBeCloseTo(1, 5);
        if (game.view.legal.length > 0) expect(hints.map((h) => JSON.stringify(h.command)).sort()).toEqual(game.view.legal.map((c) => JSON.stringify(c)).sort());
        advised++;
        room.handle(human.id, { t: 'command', command: hints[0]!.command });
        expect(human.errors()).toEqual([]);
      } else {
        expect(game.hints).toBeNull(); // not the person's decision
        expect(runBot()).toBe(true);
      }
    }
    expect(advised).toBeGreaterThan(5);
    // The spectator never gets hints.
    expect(watcher.messages.some((m) => m.t === 'game' && 'hints' in m)).toBe(false);
    // Switched off, they stop.
    room.handle(human.id, { t: 'training', on: false });
    expect('hints' in human.last('game')).toBe(false);
  });

  it("training mode with advice that takes time (a search): 'thinking' until it's ready, then sent; stale advice dropped", async () => {
    const asked: { state: GameState; resolve: (hints: Hint[]) => void; reject: (e: Error) => void; bot: BotPlayer; events: readonly TraceEvent[] }[] = [];
    const advise = ({ bot, state, events }: BotTurn) => new Promise<Hint[]>((resolve, reject) => asked.push({ state, resolve, reject, bot, events }));
    const { room, runBot } = botRoom({}, { advise });
    const human = join(room, 'Ana');
    room.handle(human.id, { t: 'settings', settings: { marksToWin: 1, firstPlayer: 'random' } });
    room.handle(human.id, { t: 'add-bot' });
    room.handle(human.id, { t: 'start' });
    room.handle(human.id, { t: 'training', on: true });
    while (!human.last('game').view.prompts.some((p) => p.mine)) expect(runBot()).toBe(true);
    // Asked once for this decision, however often the game is sent meanwhile.
    expect(human.last('game').hints).toEqual([]);
    room.handle(human.id, { t: 'training', on: true });
    expect(asked).toHaveLength(1);
    const ask = asked[0]!;
    const sent = human.messages.length;
    ask.resolve([{ command: human.last('game').view.legal[0]!, probability: 0.5, win: 0.7 }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(human.messages.length).toBe(sent + 1);
    expect(human.last('game').hints).toEqual([{ command: human.last('game').view.legal[0], probability: 0.5, win: 0.7 }]);
    // A move made before the advice arrives: the late advice is dropped.
    const legal = human.last('game').view.legal;
    room.handle(human.id, { t: 'command', command: legal[0]! });
    while (!human.last('game').view.prompts.some((p) => p.mine)) expect(runBot()).toBe(true);
    const next = asked.at(-1)!;
    expect(next).not.toBe(ask);
    room.handle(human.id, { t: 'command', command: human.last('game').view.legal[0]! });
    const before = human.messages.length;
    next.resolve([{ command: legal[0]!, probability: 1 }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(human.messages.slice(before).some((m) => m.t === 'game' && m.hints?.length)).toBe(false);
    // A failed search: the network's own suggestion instead.
    while (!human.last('game').view.prompts.some((p) => p.mine) && human.last('game').view.phase === 'playing') expect(runBot()).toBe(true);
    if (human.last('game').view.phase === 'playing') {
      asked.at(-1)!.reject(new Error('the search broke'));
      await new Promise((r) => setTimeout(r, 0));
      const hints = human.last('game').hints!;
      expect(hints.length).toBeGreaterThan(0);
      expect(hints[0]!.win).toBeUndefined();
    }
  });

  it('plays the move its server works out (a search) when it comes, waits when told to, and otherwise plays its network', async () => {
    const asked: { turn: BotTurn; resolve: (c: { command: Command } | { retryAfter: number }) => void; reject: (e: Error) => void }[] = [];
    const choose = (turn: BotTurn) => new Promise<{ command: Command } | { retryAfter: number }>((resolve, reject) => asked.push({ turn, resolve, reject }));
    const { room, runBot, waiting, saved } = botRoom({}, { choose });
    const human = join(room, 'Ana');
    room.handle(human.id, { t: 'settings', settings: { marksToWin: 1, firstPlayer: 'random' } });
    room.handle(human.id, { t: 'add-bot' });
    room.handle(human.id, { t: 'start' });
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const botsTurn = async () => {
      for (let step = 0; human.last('game').view.prompts.some((p) => p.mine) || human.last('game').view.legal.some((c) => c.type === 'next-round'); step++) {
        expect(step).toBeLessThan(500);
        const legal = human.last('game').view.legal;
        room.handle(human.id, { t: 'command', command: legal.find((c) => c.type !== 'reveal-duplicity') ?? legal[0]! });
      }
      expect(runBot()).toBe(true);
      await tick();
      return asked.at(-1)!;
    };
    const commands = () => saved.at(-1)?.commands.length ?? 0;

    // The move it works out: played when it comes (nothing else is scheduled meanwhile).
    let ask = await botsTurn();
    expect(ask.turn.level).toBe('hard');
    expect(waiting()).toBe(0);
    let before = commands();
    ask.resolve({ command: ask.turn.bot.choose(ask.turn.state, ask.turn.events) });
    await tick();
    expect(commands()).toBe(before + 1);
    expect(saved.at(-1)!.commands.at(-1)!.seat).toBe(ask.turn.bot.seat);

    // Told to wait: nothing played; asked again when the wait is over.
    ask = await botsTurn();
    before = commands();
    ask.resolve({ retryAfter: 15_000 });
    await tick();
    expect(commands()).toBe(before);
    expect(waiting()).toBe(1);
    expect(runBot()).toBe(true); // the wait is over: the bot's turn is scheduled again, as usual
    expect(waiting()).toBe(1);
    expect(runBot()).toBe(true);
    await tick();
    expect(asked.at(-1)).not.toBe(ask);
    ask = asked.at(-1)!;

    // A failed search, or a move that doesn't play: its network's own move instead.
    const errors = console.error;
    console.error = () => {};
    try {
      before = commands();
      ask.reject(new Error('the search broke'));
      await tick();
      expect(commands()).toBe(before + 1);
      if (human.last('game').view.phase === 'playing') {
        ask = await botsTurn();
        before = commands();
        ask.resolve({ command: { type: 'answer', promptId: 'nonsense', answer: { kind: 'action', choice: { action: 'pass' } } } as Command });
        await tick();
        expect(commands()).toBe(before + 1);
      }
    } finally {
      console.error = errors;
    }
    expect(human.errors()).toEqual([]);
  });

  it('lets a person resign against the bot, who wins the game: nothing more is scheduled', () => {
    const { room, runBot, waiting } = botRoom();
    const human = join(room, 'Ana');
    room.handle(human.id, { t: 'add-bot' });
    room.handle(human.id, { t: 'start' });
    room.handle(human.id, { t: 'command', command: { type: 'resign' } });
    expect(human.errors()).toEqual([]);
    const view = human.last('game').view;
    expect(view.phase).toBe('game-over');
    expect(view.roundEnd).toEqual({ kind: 'resign', seat: view.viewer });
    expect(view.lastRoundWinner).not.toBe(view.viewer);
    // (A bot move scheduled before is dropped: the game it was for has moved on.)
    while (waiting() > 0) runBot();
    expect(human.last('game').view.phase).toBe('game-over');
    // (Out: their seat a ghost now, they can't resign again.)
    room.handle(human.id, { t: 'command', command: { type: 'resign' } });
    expect(human.errors()).toEqual(['seat 0 is not a player'.replace('0', String(view.viewer))]);
  });

  it("tells a search when it's no longer wanted: advice once the decision is made, the bot's move once the game moved on", async () => {
    const asked: BotTurn[] = [];
    // Asked at once, too: a pool asks before its first chunk, while the room is still starting the search.
    const wantedAtOnce: boolean[] = [];
    const never = () => new Promise<never>(() => {});
    const ask = (turn: BotTurn) => (asked.push(turn), wantedAtOnce.push(turn.wanted()), never());
    const { room, runBot } = botRoom({}, { choose: ask, advise: ask });
    const human = join(room, 'Ana');
    room.handle(human.id, { t: 'settings', settings: { marksToWin: 1, firstPlayer: { player: human.id } } });
    room.handle(human.id, { t: 'add-bot' });
    room.handle(human.id, { t: 'start' });
    room.handle(human.id, { t: 'training', on: true });
    // Advice for your first decision: wanted until you make it.
    const advice = asked.at(-1)!;
    expect(advice.bot.seat).toBe(human.last('game').view.viewer);
    expect(advice.wanted()).toBe(true);
    const play = () => {
      const legal = human.last('game').view.legal.filter((c) => c.type !== 'reveal-duplicity');
      room.handle(human.id, { t: 'command', command: legal[0]! });
    };
    play();
    expect(advice.wanted()).toBe(false);
    // The bot's move: wanted while its turn waits for it.
    for (let step = 0; human.last('game').view.prompts.some((p) => p.mine); step++) {
      expect(step).toBeLessThan(10);
      play();
    }
    expect(runBot()).toBe(true);
    const move = asked.at(-1)!;
    expect(move.bot.seat).not.toBe(human.last('game').view.viewer);
    expect(move.wanted()).toBe(true);
    room.close();
    expect(move.wanted()).toBe(false);
    expect(wantedAtOnce.every((w) => w)).toBe(true);
  });

  it('takes a saved game up again where it was: the bot, and training mode at your seat, as if it never stopped', async () => {
    const tick = () => new Promise((r) => setTimeout(r, 0));
    /**
     * What a bot knew at each decision (by the game's events so far): its own log (what the search samples worlds
     * from) and its belief (what the network reads), for the bot's decisions and training mode's at yours.
     */
    type Seen = Map<string, { log: unknown; belief: unknown }>;
    const knows = (bot: BotPlayer) => {
      const inside = bot as unknown as { log: TraceEvent[]; belief: { clone(): unknown } };
      return { log: structuredClone(inside.log), belief: inside.belief.clone() };
    };
    // The bot plays `next()`'s command if it gives one (the saved game's), else its own; either way it works its own out.
    const deps = (seen: Seen, next: () => Command | undefined): Partial<BotDeps> => ({
      choose: async (turn) => {
        const own = turn.bot.choose(turn.state, turn.events);
        seen.set(`bot ${turn.events.length}`, knows(turn.bot));
        return { command: next() ?? own };
      },
      advise: async (turn) => {
        const hints = turn.bot.suggest(turn.state, turn.events);
        seen.set(`you ${turn.events.length}`, knows(turn.bot));
        return hints;
      },
    });

    for (const seed of ['restore-1', 'restore-2', 'restore-3']) {
      // The game, played through: your moves at random (seeded), training mode on.
      const seen: Seen = new Map();
      const { room, runBot, saved } = botRoom({ seed: () => seed }, deps(seen, () => undefined));
      const human = join(room, 'Ana');
      room.handle(human.id, { t: 'settings', settings: { marksToWin: 2, firstPlayer: 'random' } });
      room.handle(human.id, { t: 'add-bot' });
      room.handle(human.id, { t: 'start' });
      room.handle(human.id, { t: 'training', on: true });
      let x = seed.length;
      const pick = (n: number) => (x = (Math.imul(x, 48271) + 11) >>> 0) % n;
      for (let step = 0; human.last('game').view.phase !== 'game-over'; step++) {
        expect(step).toBeLessThan(5000);
        const legal = human.last('game').view.legal.filter((c) => c.type !== 'reveal-duplicity');
        if (human.last('game').view.prompts.some((p) => p.mine) || legal.some((c) => c.type === 'next-round')) {
          room.handle(human.id, { t: 'command', command: legal[pick(legal.length)]! });
        } else {
          expect(runBot()).toBe(true);
        }
        // (The bot's move, and training mode's advice, come once worked out.)
        await tick();
        expect(human.errors()).toEqual([]);
      }
      const log = saved.at(-1)!;
      const seat = human.last('game').view.viewer as Seat;
      const botSeat = log.commands.find((c) => c.seat !== seat)!.seat;
      // What the room saves is the game as played, its people in their seats.
      expect(room.saved()).toEqual({
        log,
        startedAt: 1000,
        settings: { marksToWin: 2 },
        seats: expect.arrayContaining([{ seat, name: 'Ana', training: true }, { seat: botSeat, name: 'Bot', bot: true }]),
      });

      // Taken up again after k commands, and played on as it was: each bot knowing at each decision what it knew.
      for (let k = 0; k < log.commands.length; k += 9) {
        const again: Seen = new Map();
        let at = k;
        const rest = botRoom({ seed: () => seed }, deps(again, () => log.commands[at]!.command));
        const { room: restored, tokens } = Room.restore('BOTS', rest.deps, {
          log: { options: log.options, commands: log.commands.slice(0, k) },
          startedAt: 1000,
          settings: { marksToWin: 2 },
          seats: [
            { seat, name: 'Ana', training: true },
            { seat: botSeat, name: 'Bot', bot: true },
          ],
        });
        const you = new Client();
        you.id = restored.resume(tokens.get(seat)!, you.send)!.id;
        expect(you.last('game').view).toEqual(viewFor(replay({ options: log.options, commands: log.commands.slice(0, k) }).state, seat));
        for (; at < log.commands.length; at++) {
          await tick();
          const { seat: mover, command } = log.commands[at]!;
          if (mover === seat) restored.handle(you.id, { t: 'command', command });
          else expect(rest.runBot(), `game ${seed}, from ${k}: the bot's move ${at}`).toBe(true);
          expect(you.errors()).toEqual([]);
        }
        await tick();
        expect(again.size).toBeGreaterThan(0);
        for (const [moment, knew] of again) expect(knew, `game ${seed}, from ${k}: ${moment}`).toEqual(seen.get(moment));
      }
    }
  });

  it('drops a move worked out after the room closed, and schedules nothing more', async () => {
    const asked: { resolve: (c: { command: Command }) => void; turn: BotTurn }[] = [];
    const { room, runBot, waiting, saved } = botRoom({}, { choose: (turn) => new Promise((resolve) => asked.push({ resolve, turn })) });
    const human = join(room, 'Ana');
    room.handle(human.id, { t: 'add-bot' });
    room.handle(human.id, { t: 'start' });
    while (!asked.length) {
      const game = human.last('game');
      if (game.view.prompts.some((p) => p.mine)) room.handle(human.id, { t: 'command', command: game.view.legal.find((c) => c.type !== 'reveal-duplicity')! });
      else expect(runBot()).toBe(true);
      await new Promise((r) => setTimeout(r, 0));
    }
    const before = saved.at(-1)?.commands.length ?? 0;
    room.close();
    asked[0]!.resolve({ command: asked[0]!.turn.bot.choose(asked[0]!.turn.state, asked[0]!.turn.events) });
    await new Promise((r) => setTimeout(r, 0));
    expect(saved.at(-1)?.commands.length ?? 0).toBe(before);
    expect(waiting()).toBe(0);
  });

  it('tells its hooks what happens in the room, each move as played', () => {
    const calls: string[] = [];
    const moves: PlayedMove[] = [];
    const who = (p: RoomMember) => `${p.name}${p.connected ? '' : ' (away)'}`;
    const { room, runBot } = botRoom({
      hooks: {
        sent: (_room, p, reset) => calls.push(`sent ${who(p)}${reset ? ' reset' : ''}`),
        commanded: (r, move) => {
          moves.push(move);
          expect(r.runningGame!.state).toBe(move.after);
        },
        trainingChanged: (_room, p) => calls.push(`training ${who(p)} ${p.training}`),
        left: (_room, p) => calls.push(`left ${who(p)}`),
        disconnected: (_room, p) => calls.push(`disconnected ${who(p)}`),
        closing: (r) => calls.push(`closing ${r.code}`),
      },
    });
    const human = join(room, 'Ana');
    room.handle(human.id, { t: 'add-bot' });
    room.handle(human.id, { t: 'start' });
    expect(calls).toContain('sent Ana reset');
    expect(calls).toContain('sent Bot (away) reset');
    room.handle(human.id, { t: 'training', on: true });
    room.handle(human.id, { t: 'training', on: true });
    expect(calls.filter((c) => c.startsWith('training'))).toEqual(['training Ana true']);
    for (let step = 0; step < 40 && human.last('game').view.phase === 'playing'; step++) {
      const game = human.last('game');
      if (game.view.prompts.some((p) => p.mine)) room.handle(human.id, { t: 'command', command: game.view.legal.find((c) => c.type !== 'reveal-duplicity')! });
      else expect(runBot()).toBe(true);
    }
    // Each move: the game it was played on is the one the move before left, and its events are the log's last ones.
    expect(moves.length).toBeGreaterThan(10);
    moves.forEach((m, i) => {
      if (i > 0) expect(m.before).toBe(moves[i - 1]!.after);
      expect(m.events.slice(m.events.length - m.newEvents.length)).toEqual(m.newEvents);
    });
    expect(new Set(moves.map((m) => m.seat)).size).toBe(2);
    room.disconnect(human.id, human.send);
    room.close();
    expect(calls.slice(-2)).toEqual(['disconnected Ana (away)', `closing ${room.code}`]);
  });

  it('training mode gives nothing in a game without the bot, and needs a server with the bot', () => {
    const { room } = botRoom();
    const a = join(room, 'Ana');
    const b = join(room, 'Ben');
    room.handle(a.id, { t: 'training', on: true });
    room.handle(a.id, { t: 'start' });
    expect(a.errors()).toEqual([]);
    expect(a.messages.some((m) => m.t === 'game' && 'hints' in m)).toBe(false);
    expect(b.messages.some((m) => m.t === 'game' && 'hints' in m)).toBe(false);
    const { room: plain } = botRoom({ bot: undefined });
    const c = join(plain, 'Cy');
    plain.handle(c.id, { t: 'training', on: true });
    expect(c.errors()).toEqual(["Training mode needs the bot, and this server doesn't have it."]);
  });

  it("isn't offered without weights", () => {
    const { room } = botRoom({ bot: undefined });
    const host = join(room, 'Ana');
    expect(host.last('room').room.botAvailable).toBe(false);
    room.handle(host.id, { t: 'add-bot' });
    expect(host.errors()).toEqual(["The bot isn't available on this server."]);
  });

  it('drops its pending move when the room closes', () => {
    const { room, waiting } = botRoom({ seed: () => 'any' });
    const human = join(room, 'Ana');
    room.handle(human.id, { t: 'add-bot' });
    const bot = human.last('room').room.players.find((p) => p.bot)!;
    room.handle(human.id, { t: 'settings', settings: { marksToWin: 1, firstPlayer: { player: bot.id } } });
    room.handle(human.id, { t: 'start' });
    expect(waiting()).toBe(1);
    room.close();
    expect(waiting()).toBe(0);
  });
});
