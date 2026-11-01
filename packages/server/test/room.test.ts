import type { ActionChoice, Command, ReplayLog, Seat } from '@keeps/engine';
import { PROTOCOL, type ClientMessage, type ServerMessage, type Settings } from '@keeps/protocol';
import { describe, expect, it } from 'vitest';
import { Room, type RoomDeps, type Send } from '../src/room.ts';

type GameMessage = Extract<ServerMessage, { t: 'game' }>;

function makeRoom(overrides: Partial<RoomDeps> = {}) {
  let n = 0;
  const saved: ReplayLog[] = [];
  const deps: RoomDeps = {
    token: () => `token-${++n}`,
    id: () => `p${++n}`,
    seed: () => 'seed',
    random: () => 0,
    now: () => 1000,
    saveReplay: (_code, _at, log) => saved.push(structuredClone(log)),
    ...overrides,
  };
  return { room: new Room('ABCD', deps), saved };
}

class Client {
  messages: ServerMessage[] = [];
  send: Send = (m) => this.messages.push(structuredClone(m));
  id = '';
  token = '';

  last<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }> {
    const found = this.messages.findLast((m) => m.t === t);
    if (!found) throw new Error(`no ${t} message; got ${this.messages.map((m) => m.t).join(', ')}`);
    return found as Extract<ServerMessage, { t: T }>;
  }

  game(): GameMessage {
    return this.last('game');
  }

  get seat(): Seat {
    const seat = this.last('room').room.players.find((p) => p.id === this.id)!.seat;
    if (seat === null) throw new Error('not seated');
    return seat;
  }

  errors(): string[] {
    return this.messages.flatMap((m) => (m.t === 'error' ? [m.message] : []));
  }
}

function join(room: Room, name: string): Client {
  const client = new Client();
  const player = room.join(name, client.send);
  client.id = player.id;
  client.token = client.last('welcome').token;
  return client;
}

function startedGame(players = 2) {
  const { room, saved } = makeRoom();
  const clients = Array.from({ length: players }, (_, i) => join(room, `P${i + 1}`));
  room.handle(clients[0]!.id, { t: 'start' });
  return { room, clients, saved };
}

/** The client whose action prompt is open. */
function active(clients: Client[]): Client {
  const found = clients.find((c) => c.game().view.prompts.some((p) => p.mine && p.kind === 'action'));
  if (!found) throw new Error('nobody has an action prompt');
  return found;
}

/** Sends the first legal command of whoever can act; returns who acted. */
function step(room: Room, clients: Client[]): Client {
  const actor = clients.find((c) => c.game().view.legal.length > 0);
  if (!actor) throw new Error('nobody can act');
  room.handle(actor.id, { t: 'command', command: actor.game().view.legal[0]! });
  expect(actor.errors()).toEqual([]);
  return actor;
}

function actionCommand(client: Client, choice: ActionChoice): Command {
  const prompt = client.game().view.prompts.find((p) => p.mine && p.kind === 'action')!;
  return { type: 'answer', promptId: prompt.id, answer: { kind: 'action', choice } };
}

function send(room: Room, client: Client, message: ClientMessage) {
  room.handle(client.id, message);
}

describe('joining', () => {
  it('welcomes players; the first is host', () => {
    const { room } = makeRoom();
    const a = join(room, 'Ada');
    const b = join(room, 'Bo');
    expect(a.last('welcome')).toEqual({ t: 'welcome', code: 'ABCD', token: a.token, playerId: a.id, protocol: PROTOCOL });
    const players = b.last('room').room.players;
    expect(players.map((p) => [p.name, p.host, p.connected])).toEqual([
      ['Ada', true, true],
      ['Bo', false, true],
    ]);
    // Everyone hears about new arrivals.
    expect(a.last('room').room.players).toHaveLength(2);
  });

  it('cleans up names and keeps them unique', () => {
    const { room } = makeRoom();
    join(room, '  Ada  ');
    const b = join(room, 'ada');
    const c = join(room, '   ');
    const d = join(room, 'x'.repeat(50));
    const names = d.last('room').room.players.map((p) => p.name);
    expect(names).toEqual(['Ada', 'ada 2', 'Player', 'x'.repeat(20)]);
    expect(b.id).not.toBe(c.id);
  });
});

describe('settings and starting', () => {
  it('only the host changes settings, within limits', () => {
    const { room } = makeRoom();
    const host = join(room, 'H');
    const guest = join(room, 'G');
    send(room, guest, { t: 'settings', settings: { marksToWin: 5, firstPlayer: 'random' } });
    expect(guest.errors()).toEqual(['Only the host can change settings.']);
    send(room, host, { t: 'settings', settings: { marksToWin: 0, firstPlayer: 'random' } });
    expect(host.errors()).toEqual(['Marks to win must be between 1 and 10.']);
    send(room, host, { t: 'settings', settings: { marksToWin: 5, firstPlayer: { player: guest.id } } });
    expect(guest.last('room').room.settings).toEqual({ marksToWin: 5, firstPlayer: { player: guest.id } });
  });

  it('the first player must be random or someone in the room', () => {
    const { room } = makeRoom();
    const host = join(room, 'H');
    for (const firstPlayer of ['host', { player: 'nobody' }, { player: 5 }, null] as unknown as Settings['firstPlayer'][]) {
      send(room, host, { t: 'settings', settings: { marksToWin: 3, firstPlayer } });
    }
    expect(host.errors()).toEqual(Array(4).fill('Invalid first player.'));
    expect(host.last('room').room.settings.firstPlayer).toBe('random');
  });

  it('needs the host and 2 to 4 players', () => {
    const { room } = makeRoom();
    const host = join(room, 'H');
    send(room, host, { t: 'start' });
    expect(host.errors()).toEqual(['Keeps needs 2 to 4 players.']);
    const guest = join(room, 'G');
    send(room, guest, { t: 'start' });
    expect(guest.errors()).toEqual(['Only the host can start the game.']);
  });

  it('seats two players opposite each other and sends each their own view', () => {
    const { clients } = startedGame(2);
    const seats = clients.map((c) => c.seat).sort();
    expect(seats).toEqual([0, 2]);
    for (const c of clients) {
      const game = c.game();
      expect(game.reset).toBe(true);
      expect(game.view.viewer).toBe(c.seat);
      expect(game.names.filter((n) => n !== null).sort()).toEqual(['P1', 'P2']);
    }
    // Exactly one player can act.
    expect(clients.filter((c) => c.game().view.legal.length > 0)).toHaveLength(1);
  });

  it('a chosen first player takes the first turn, whoever they are', () => {
    for (const pick of [0, 1, 2]) {
      const { room } = makeRoom({ random: () => 0.99 });
      const clients = [join(room, 'H'), join(room, 'G'), join(room, 'G2')];
      send(room, clients[0]!, { t: 'settings', settings: { marksToWin: 3, firstPlayer: { player: clients[pick]!.id } } });
      send(room, clients[0]!, { t: 'start' });
      expect(clients[0]!.game().view.turn?.seat).toBe(clients[pick]!.seat);
    }
  });

  it('falls back to a random first player if the chosen one leaves', () => {
    const { room } = makeRoom();
    const host = join(room, 'H');
    const guest = join(room, 'G');
    join(room, 'G2');
    send(room, host, { t: 'settings', settings: { marksToWin: 4, firstPlayer: { player: guest.id } } });
    send(room, guest, { t: 'leave' });
    expect(host.last('room').room.settings).toEqual({ marksToWin: 4, firstPlayer: 'random' });
    // Someone else leaving doesn't change it.
    const g3 = join(room, 'G3');
    send(room, host, { t: 'settings', settings: { marksToWin: 4, firstPlayer: { player: host.id } } });
    send(room, g3, { t: 'leave' });
    expect(host.last('room').room.settings.firstPlayer).toEqual({ player: host.id });
  });

  it('saves a replay log from the start', () => {
    const { saved } = startedGame(3);
    expect(saved.at(-1)).toMatchObject({ options: { players: 3, seed: 'seed', marksToWin: 3 }, commands: [] });
  });
});

describe('playing', () => {
  it('applies a legal command and updates everyone', () => {
    const { room, clients, saved } = startedGame(2);
    const mover = active(clients);
    const other = clients.find((c) => c !== mover)!;
    send(room, mover, { t: 'command', command: actionCommand(mover, { action: 'draw' }) });
    expect(mover.errors()).toEqual([]);
    for (const c of clients) expect(c.game().reset).toBe(false);
    expect(saved.at(-1)!.commands).toHaveLength(1);
    // The mover sees what they drew; the other player sees only that a card was drawn
    // (unless it was HOT and got played face up, which everyone then sees).
    const mine = mover.game().log.find((e) => e.payload.type === 'draw')!;
    const theirs = other.game().log.find((e) => e.payload.type === 'draw')!;
    expect(mine.payload).toMatchObject({ type: 'draw', seat: mover.seat });
    expect((mine.payload as { card: string | null }).card).not.toBeNull();
    expect(theirs.payload).toMatchObject({ type: 'draw', card: null });
  });

  it("never sends another player's hidden cards", () => {
    const { room, clients } = startedGame(4);
    for (let i = 0; i < 40; i++) step(room, clients);
    for (const c of clients) {
      // Views: only your own hand's cards.
      for (const m of c.messages) {
        if (m.t !== 'game') continue;
        for (const h of m.view.hands) expect(h.cards === undefined).toBe(h.seat !== c.seat);
      }
      // Logs: another player's draw is either hidden, or was public (a face-up card).
      const othersDraws = c.messages
        .flatMap((m) => (m.t === 'game' ? m.log : []))
        .filter((e) => e.payload.type === 'draw' && e.payload.seat !== c.seat);
      expect(othersDraws.length).toBeGreaterThan(0);
      for (const e of othersDraws) {
        if ((e.payload as { card: string | null }).card !== null) expect(e.visibility).toBe('all');
      }
    }
  });

  it('rejects commands out of turn, with the engine\'s reason', () => {
    const { room, clients } = startedGame(2);
    const mover = active(clients);
    const other = clients.find((c) => c !== mover)!;
    send(room, other, { t: 'command', command: actionCommand(mover, { action: 'draw' }) });
    expect(other.errors()).toHaveLength(1);
    expect(other.errors()[0]).toMatch(/prompt/);
  });

  it('spectators who join mid-game see the public view and cannot play', () => {
    const { room, clients } = startedGame(2);
    const mover = active(clients);
    send(room, mover, { t: 'command', command: actionCommand(mover, { action: 'draw' }) });
    const spectator = join(room, 'Watcher');
    const game = spectator.game();
    expect(game.view.viewer).toBe('spectator');
    expect(game.view.legal).toEqual([]);
    expect(game.log.find((e) => e.payload.type === 'draw')!.payload).toMatchObject({ card: null });
    send(room, spectator, { t: 'command', command: { type: 'next-round' } });
    expect(spectator.errors()).toEqual(['Spectators cannot play.']);
  });
});

describe('reconnecting', () => {
  it('resumes a seat by token, with the full game and log', () => {
    const { room, clients } = startedGame(2);
    const [a] = clients;
    room.disconnect(a!.id, a!.send);
    expect(clients[1]!.last('room').room.players.find((p) => p.id === a!.id)!.connected).toBe(false);
    const fresh = new Client();
    const player = room.resume(a!.token, fresh.send);
    expect(player?.id).toBe(a!.id);
    expect(fresh.game().reset).toBe(true);
    expect(fresh.game().log.length).toBeGreaterThan(0);
  });

  it('ignores an unknown token', () => {
    const { room } = startedGame(2);
    expect(room.resume('nope', new Client().send)).toBeNull();
  });

  it('ignores a stale socket closing after the player reconnected', () => {
    const { room, clients } = startedGame(2);
    const [a, b] = clients;
    const fresh = new Client();
    room.resume(a!.token, fresh.send);
    room.disconnect(a!.id, a!.send);
    expect(b!.last('room').room.players.find((p) => p.id === a!.id)!.connected).toBe(true);
  });
});

describe('undo', () => {
  function afterOneMove() {
    const game = startedGame(2);
    const mover = active(game.clients);
    const before = mover.game().view;
    send(game.room, mover, { t: 'command', command: actionCommand(mover, { action: 'draw' }) });
    const other = game.clients.find((c) => c !== mover)!;
    return { ...game, mover, other, before };
  }

  it('is only available once there is a move to undo', () => {
    const { clients } = startedGame(2);
    expect(clients.every((c) => !c.game().undo.available)).toBe(true);
    const { room, mover } = afterOneMove();
    expect(mover.game().undo.available).toBe(true);
    void room;
  });

  it('needs every other player to accept, then restores the previous state and log', () => {
    const { room, mover, other, before } = afterOneMove();
    send(room, other, { t: 'propose-undo' });
    expect(mover.game().undo).toMatchObject({ proposedBy: other.id, waitingOn: [mover.id] });
    send(room, mover, { t: 'vote-undo', accept: true });
    const after = mover.game();
    expect(after.reset).toBe(true);
    expect(after.view).toEqual(before);
    expect(after.undo).toMatchObject({ proposedBy: null, available: false });
    expect(after.log.some((e) => e.payload.type === 'draw')).toBe(false);
  });

  it('is cancelled by a rejection', () => {
    const { room, mover, other } = afterOneMove();
    const moved = other.game().view;
    send(room, mover, { t: 'propose-undo' });
    send(room, other, { t: 'vote-undo', accept: false });
    expect(other.game().undo.proposedBy).toBeNull();
    expect(other.game().view).toEqual(moved);
  });

  it('is cancelled by any new move', () => {
    const { room, clients, other } = afterOneMove();
    send(room, other, { t: 'propose-undo' });
    step(room, clients);
    expect(other.game().undo.proposedBy).toBeNull();
  });

  it("doesn't wait for disconnected players", () => {
    const { room, mover, other, before } = afterOneMove();
    room.disconnect(other.id, other.send);
    send(room, mover, { t: 'propose-undo' });
    expect(mover.game().reset).toBe(true);
    expect(mover.game().view).toEqual(before);
  });

  it('only voters may vote, and only during a vote', () => {
    const { room, mover, other } = afterOneMove();
    send(room, other, { t: 'vote-undo', accept: true });
    expect(other.errors()).toEqual(['There is no undo vote open.']);
    send(room, other, { t: 'propose-undo' });
    send(room, other, { t: 'vote-undo', accept: true });
    expect(other.errors().at(-1)).toBe('Your vote is not needed.');
    void mover;
  });

  it('updates the replay log', () => {
    const { room, mover, other, saved } = afterOneMove();
    send(room, other, { t: 'propose-undo' });
    send(room, mover, { t: 'vote-undo', accept: true });
    expect(saved.at(-1)!.commands).toEqual([]);
  });
});

describe('whole games', () => {
  function playUntil(room: Room, clients: Client[], done: () => boolean) {
    for (let i = 0; !done(); i++) {
      if (i > 3000) throw new Error('game did not finish');
      step(room, clients);
    }
  }

  it('undo history is cleared when a new round starts', () => {
    const { room, clients } = startedGame(2);
    playUntil(room, clients, () => clients[0]!.game().view.phase === 'round-over');
    expect(clients[0]!.game().undo.available).toBe(true);
    step(room, clients); // next-round
    expect(clients[0]!.game().view.round).toBe(2);
    expect(clients.every((c) => !c.game().undo.available)).toBe(true);
  });

  it('after the game ends, the host can take everyone back to the lobby for a rematch', () => {
    const { room } = makeRoom();
    const host = join(room, 'H');
    const guest = join(room, 'G');
    send(room, host, { t: 'settings', settings: { marksToWin: 1, firstPlayer: 'random' } });
    send(room, host, { t: 'start' });
    playUntil(room, [host, guest], () => host.game().view.phase === 'game-over');
    send(room, guest, { t: 'back-to-lobby' });
    expect(guest.errors()).toEqual(['Only the host can do that.']);
    send(room, host, { t: 'back-to-lobby' });
    expect(host.last('room').room).toMatchObject({ phase: 'lobby' });
    expect(host.last('room').room.players.every((p) => p.seat === null)).toBe(true);
    send(room, host, { t: 'start' });
    expect(host.game().view.round).toBe(1);
  });
});

describe('leaving and the lobby', () => {
  it('leaving the lobby passes host to the next player', () => {
    const { room } = makeRoom();
    const host = join(room, 'H');
    const guest = join(room, 'G');
    send(room, host, { t: 'leave' });
    expect(guest.last('room').room.players.map((p) => [p.name, p.host])).toEqual([['G', true]]);
  });

  it('a seated player who leaves a running game keeps their seat', () => {
    const { room, clients } = startedGame(2);
    send(room, clients[0]!, { t: 'leave' });
    const players = clients[1]!.last('room').room.players;
    expect(players).toHaveLength(2);
    expect(players.find((p) => p.id === clients[0]!.id)!.connected).toBe(false);
  });

  it('only returns to the lobby when the game is over', () => {
    const { room, clients } = startedGame(2);
    send(room, clients[0]!, { t: 'back-to-lobby' });
    expect(clients[0]!.errors()).toEqual(['The game is still going.']);
  });

  it('rejects room-level messages from players already in a room', () => {
    const { room, clients } = startedGame(2);
    send(room, clients[0]!, { t: 'join', code: 'ABCD', name: 'again' });
    expect(clients[0]!.errors()).toEqual(['You are already in a room.']);
  });
});

describe('malformed input', () => {
  it('rejects junk messages without throwing', () => {
    const { room, clients } = startedGame(2);
    const [a] = clients;
    const junk = [
      { t: 'settings', settings: null },
      { t: 'command', command: null },
      { t: 'command', command: { type: 'answer', promptId: 5, answer: [] } },
      { t: 'vote-undo' },
      { t: 'nonsense' },
    ] as unknown as ClientMessage[];
    for (const message of junk) expect(() => room.handle(a!.id, message)).not.toThrow();
    expect(a!.errors()).toHaveLength(junk.length);
  });

  it('accepts any name value, turning it into a string', () => {
    const { room } = makeRoom();
    const client = new Client();
    room.join(42 as unknown as string, client.send);
    expect(client.last('room').room.players[0]!.name).toBe('42');
  });
});

describe('one seat, two connections', () => {
  it('tells the old connection when the seat is resumed elsewhere, and stops updating it', () => {
    const { room, clients } = startedGame(2);
    const [a, b] = clients;
    const tab2 = new Client();
    room.resume(a!.token, tab2.send);
    expect(a!.messages.at(-1)).toEqual({ t: 'replaced' });
    const before = a!.messages.length;
    step(room, [tab2, b!].map((c, i) => (i === 0 ? Object.assign(c, { id: a!.id }) : c)));
    expect(a!.messages.length).toBe(before);
    expect(tab2.messages.some((m) => m.t === 'game')).toBe(true);
  });
});

describe('analytics events', () => {
  interface Captured {
    event: string;
    who: { id: string; name: string; ip: string | null };
    props: Record<string, unknown>;
  }

  function tracked() {
    const captured: Captured[] = [];
    const { room } = makeRoom({
      tracker: {
        capture: (event, who, props = {}) => captured.push({ event, who, props }),
        shutdown: async () => {},
      },
    });
    const join = (name: string, ip: string, client?: string) => {
      const c = new Client();
      c.id = room.join(name, c.send, { ip, client: client ?? null }).id;
      return c;
    };
    return { room, captured, join, events: (name: string) => captured.filter((c) => c.event === name) };
  }

  it("tags every event with the player's name and IP", () => {
    const { join, captured } = tracked();
    join('Ada', '203.0.113.7', 'browser-ada-1');
    join('Bo', '198.51.100.2');
    expect(captured.map((c) => [c.event, c.who.name, c.who.ip])).toEqual([
      ['room_created', 'Ada', '203.0.113.7'],
      ['player_joined', 'Ada', '203.0.113.7'],
      ['player_joined', 'Bo', '198.51.100.2'],
    ]);
    // A browser id identifies the person across rooms; without one, the room player id.
    expect(captured[0]!.who.id).toBe('browser-ada-1');
    expect(captured[2]!.who.id).toMatch(/^player:/);
    for (const c of captured) expect(c.props.room).toBe('ABCD');
  });

  it('ignores a malformed browser id', () => {
    const { join, captured } = tracked();
    join('Ada', '203.0.113.7', '<script>');
    expect(captured[0]!.who.id).toMatch(/^player:/);
  });

  it('records a whole game: start, cards played by whom, each round, and the finish', () => {
    const { room, join, events } = tracked();
    const ada = join('Ada', '203.0.113.7');
    const bo = join('Bo', '198.51.100.2');
    room.handle(ada.id, { t: 'settings', settings: { marksToWin: 2, firstPlayer: 'random' } });
    room.handle(ada.id, { t: 'start' });
    expect(events('game_started')[0]!.props).toMatchObject({ players: 2, marks_to_win: 2 });
    expect([...(events('game_started')[0]!.props.player_names as string[])].sort()).toEqual(['Ada', 'Bo']);

    for (let i = 0; ada.game().view.phase !== 'game-over'; i++) {
      if (i > 3000) throw new Error('game did not finish');
      step(room, [ada, bo]);
    }
    const plays = events('card_played');
    expect(plays.length).toBeGreaterThan(0);
    for (const p of plays) {
      expect(['Ada', 'Bo']).toContain(p.who.name);
      expect(typeof p.props.card).toBe('string');
    }
    const rounds = events('round_ended');
    expect(rounds.length).toBeGreaterThanOrEqual(2);
    for (const r of rounds) expect(Object.keys(r.props.scores as object).sort()).toEqual(['Ada', 'Bo']);
    const [finished] = events('game_finished');
    expect(finished).toBeDefined();
    expect(finished!.props.marks).toEqual(expect.objectContaining({ [finished!.who.name]: 2 }));
  });

  it('records an undo that went through, against who asked for it', () => {
    const { room, join, events } = tracked();
    const ada = join('Ada', '203.0.113.7');
    const bo = join('Bo', '198.51.100.2');
    room.handle(ada.id, { t: 'start' });
    const mover = step(room, [ada, bo]);
    const other = mover === ada ? bo : ada;
    room.handle(mover.id, { t: 'propose-undo' });
    room.handle(other.id, { t: 'vote-undo', accept: true });
    expect(events('undo_applied').map((e) => e.who.name)).toEqual([mover === ada ? 'Ada' : 'Bo']);
  });

  it('shows names, IPs and game progress on the admin snapshot', () => {
    const { room, join } = tracked();
    const ada = join('Ada', '203.0.113.7');
    join('Bo', '198.51.100.2');
    room.handle(ada.id, { t: 'start' });
    const info = room.info();
    expect(info.players.map((p) => [p.name, p.ip, p.connected])).toEqual([
      ['Ada', '203.0.113.7', true],
      ['Bo', '198.51.100.2', true],
    ]);
    expect(info.game).toMatchObject({ round: 1, phase: 'playing', commands: 0 });
  });
});

describe('closing', () => {
  it('closing a room tells everyone connected that it is gone', () => {
    const { room, clients } = startedGame(2);
    room.disconnect(clients[1]!.id, clients[1]!.send);
    const before = clients[1]!.messages.length;
    room.close();
    expect(clients[0]!.messages.at(-1)).toEqual({ t: 'gone' });
    expect(clients[1]!.messages).toHaveLength(before);
    expect(room.connectedCount).toBe(0);
  });

  it('knows when its running game started, which names the replay file', () => {
    const { room } = makeRoom({ now: () => 4242 });
    expect(room.gameStartedAt).toBeNull();
    const a = join(room, 'A');
    join(room, 'B');
    room.handle(a.id, { t: 'start' });
    expect(room.gameStartedAt).toBe(4242);
  });
});
