// Midstrike's host (host.ts): its round reviews, switched off and on (the app's setting, to save the phone's battery).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Policy } from '@keeps/bot';
import type { ReviewJobs } from '@keeps/bot/review/review.ts';
import type { Move } from '@keeps/engine';
import type { ServerMessage } from '@keeps/protocol';
import { describe, expect, it } from 'vitest';
import { midstrikeHost } from '../src/host.ts';
import { Room } from '../src/room.ts';

const policy = Policy.load(readFileSync(join(import.meta.dirname, '../../bot/weights/bot.bin')));

/** A room against the bot at Easy, its review jobs counted (never run); `move()` makes the person's next move, the bot answering. */
function game() {
  const submitted: string[] = [];
  const cancelled: string[] = [];
  const reviews: ReviewJobs = {
    submit: (group) => void submitted.push(group),
    cancel: (group) => (cancelled.push(group), 0),
    setAside: () => [],
    drop: () => 0,
  };
  const never = { evaluate: () => new Promise<number[][]>(() => {}) };
  const host = midstrikeHost({ name: 'Bot', search: { hard: never, medium: never }, reviews });
  const pending: (() => void)[] = [];
  let n = 0;
  const room = new Room('HOST', {
    token: () => `t${n++}`,
    id: () => `p${n++}`,
    seed: () => `host-${n}`,
    random: () => 0.3,
    now: Date.now,
    bot: { policy, schedule: (fn) => (pending.push(fn), () => {}), delay: () => 0, ...host.bot },
    hooks: host.hooks,
  });
  let last: Extract<ServerMessage, { t: 'game' }> | null = null;
  const me = room.join('Ana', (m) => {
    if (m.t === 'game') last = m;
  });
  room.handle(me.id, { t: 'add-bot' });
  room.handle(me.id, { t: 'settings', settings: { marksToWin: 3, firstPlayer: { player: me.id }, botLevel: 'easy' } });
  room.handle(me.id, { t: 'start' });
  /** The person's next move (and the bot's, until it's theirs again). */
  const move = () => {
    for (let i = 0; i < 200 && pending.length; i++) pending.shift()!();
    const legal = last!.view.legal.filter((c: Move) => c.type !== 'reveal-duplicity');
    room.handle(me.id, { t: 'command', command: legal[0]! });
    for (let i = 0; i < 200 && pending.length; i++) pending.shift()!();
  };
  return { host, room, me, move, submitted, cancelled };
}

describe("Midstrike's round reviews, switched", () => {
  it('stop the games under review at once, and pick up again with the next game (not mid-round)', () => {
    const { host, room, me, move, submitted, cancelled } = game();
    move();
    expect(submitted.length).toBeGreaterThan(0);
    host.setReviewing(false);
    expect(cancelled).toHaveLength(1);
    const before = submitted.length;
    move();
    expect(submitted).toHaveLength(before);
    // Back on, mid-game: this game stays unreviewed (its review would start mid-round)...
    host.setReviewing(true);
    move();
    expect(submitted).toHaveLength(before);
    // ...and the next one is reviewed.
    room.handle(me.id, { t: 'back-to-lobby' });
    room.handle(me.id, { t: 'start' });
    move();
    expect(submitted.length).toBeGreaterThan(before);
  });

  it('review no game started while they are off', () => {
    const { host, move, submitted } = game();
    host.setReviewing(false);
    // (The game started before the switch, with nothing reviewed yet: it's stopped, and stays so.)
    move();
    move();
    expect(submitted).toHaveLength(0);
  });
});
