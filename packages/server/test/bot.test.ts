import { readFileSync } from 'node:fs';
import { Policy } from '@keeps/learn';
import type { ReplayLog } from '@keeps/engine';
import type { ServerMessage } from '@keeps/protocol';
import { describe, expect, it } from 'vitest';
import { Room, type RoomDeps, type Send } from '../src/room.ts';

const policy = Policy.load(readFileSync(new URL('../../learn/weights/bot.bin', import.meta.url)));

/** A room whose bot moves only when the test runs its scheduled move. */
function botRoom(overrides: Partial<RoomDeps> = {}) {
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
  return { room, runBot, waiting, saved };
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
