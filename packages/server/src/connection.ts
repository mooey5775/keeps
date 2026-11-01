// One client's connection to a server's rooms, whatever carries it: the website's WebSockets (server.ts) or the app's
// own server (ios/core/local-server.ts). Its first message makes a room, joins one by its code, or resumes a seat by
// its token; every later one goes to that room.
import { ROOM_CODE, type ClientMessage } from '@keeps/protocol';
import { Room, type ConnectionInfo, type RoomDeps, type Send } from './room.ts';

// Unambiguous letters for room codes (no I, O, L).
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';

/** A new room code, not one of `rooms`', from `random` in [0, 1). */
export function newCode(rooms: ReadonlyMap<string, Room>, random: () => number): string {
  for (;;) {
    const code = Array.from({ length: 4 }, () => CODE_LETTERS[Math.floor(random() * CODE_LETTERS.length)]).join('');
    if (!rooms.has(code)) return code;
  }
}

export interface Connection {
  /** A message from the client (parsed, and not yet checked: it's what the client sent). */
  receive(message: ClientMessage): void;
  /** The client went away (its seat kept, to resume). */
  close(): void;
  /** The room it's in, once it's in one. */
  readonly room: Room | null;
}

/**
 * A connection to `rooms`, a room made in it with `deps`; `send` reaches its client. `from` is what the room records
 * of where it comes from; `seated`, told of each player it becomes (the website keeps a log of its visitors); `random`,
 * what new rooms' codes are drawn from (not the rooms' own: a seeded game's draws stay the same however many are made).
 */
export function connection(
  rooms: Map<string, Room>,
  deps: RoomDeps,
  send: Send,
  {
    from = {},
    seated,
    random = Math.random,
  }: { from?: ConnectionInfo; seated?: (player: { id: string; name: string }) => void; random?: () => number } = {},
): Connection {
  let room: Room | null = null;
  let playerId: string | null = null;
  const fail = (message: string) => send({ t: 'error', message });
  const sit = (found: Room, player: { id: string; name: string }) => {
    room = found;
    playerId = player.id;
    seated?.(player);
  };
  return {
    get room() {
      return room;
    },
    receive(message) {
      if (room && playerId) {
        try {
          room.handle(playerId, message);
        } catch (error) {
          // An engine bug must not take down every room on the server.
          console.error(`room ${room.code}: error handling ${JSON.stringify(message).slice(0, 200)}`, error);
          fail('Something went wrong handling that. Please try again.');
        }
        return;
      }
      if (!message || typeof message !== 'object') return fail('Malformed message.');
      switch (message.t) {
        case 'create': {
          const code = newCode(rooms, random);
          const made = new Room(code, deps);
          rooms.set(code, made);
          const player = made.join(message.name, send, { ...from, client: message.client ?? null });
          sit(made, player);
          if (message.bot === true) made.handle(player.id, { t: 'add-bot' });
          return;
        }
        case 'join': {
          const code = String(message.code ?? '').toUpperCase();
          const found = ROOM_CODE.test(code) ? rooms.get(code) : undefined;
          if (!found) return fail(`No room called ${code}.`);
          sit(found, found.join(message.name, send, { ...from, client: message.client ?? null }));
          return;
        }
        case 'resume': {
          const found = rooms.get(String(message.code ?? '').toUpperCase());
          const player = found?.resume(String(message.token ?? ''), send, { ...from, client: message.client ?? null });
          if (!found || !player) return send({ t: 'gone' });
          sit(found, player);
          return;
        }
        default:
          return fail('Join or create a room first.');
      }
    },
    close() {
      if (room && playerId) room.disconnect(playerId, send);
    },
  };
}
