// The app's own game server: rooms (packages/server/src/room.ts) held here, one connection per client, speaking the
// same protocol as the website's server (packages/server/src/server.ts handles a WebSocket the same way). Offline
// games against Midstrike run on it; the app talks to it exactly as a browser talks to the site.
import type { ClientMessage, ServerMessage } from '../../packages/protocol/src/index.ts';
import { Room, type RoomDeps, type SavedGame } from '../../packages/server/src/room.ts';

// Unambiguous letters for room codes (no I, O, L), as the website's.
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';

export class LocalServer {
  private readonly rooms = new Map<string, Room>();
  private readonly deps: RoomDeps;

  constructor(deps: RoomDeps) {
    this.deps = deps;
  }

  /** The game running in room `code`, saved to be taken up again (and whether it's over); null if none. */
  saved(code: string): (SavedGame & { over: boolean }) | null {
    const room = this.rooms.get(code);
    const saved = room?.saved();
    return saved ? { ...saved, over: room!.runningGame!.state.phase === 'game-over' } : null;
  }

  /** Room `code` rebuilt with its saved game (Room.restore); returns each person's token, by seat, to resume with. */
  restore(code: string, saved: SavedGame): Map<number, string> {
    this.rooms.get(code)?.close();
    const { room, tokens } = Room.restore(code, this.deps, saved);
    this.rooms.set(code, room);
    return tokens;
  }

  /** A connection: messages from its client go to receive(); the server's go to `send`. */
  connect(send: (message: ServerMessage) => void): { receive(message: ClientMessage): void; close(): void } {
    let room: Room | null = null;
    let playerId: string | null = null;
    const fail = (message: string) => send({ t: 'error', message });
    return {
      receive: (message) => {
        if (room && playerId) {
          room.handle(playerId, message);
          return;
        }
        switch (message.t) {
          case 'create': {
            const code = this.newCode();
            room = new Room(code, this.deps);
            this.rooms.set(code, room);
            playerId = room.join(message.name, send).id;
            if (message.bot === true) room.handle(playerId, { t: 'add-bot' });
            return;
          }
          case 'join': {
            const found = this.rooms.get(String(message.code ?? '').toUpperCase());
            if (!found) return fail(`No room called ${message.code}.`);
            room = found;
            playerId = found.join(message.name, send).id;
            return;
          }
          case 'resume': {
            const found = this.rooms.get(String(message.code ?? '').toUpperCase());
            const player = found?.resume(String(message.token ?? ''), send);
            if (!found || !player) return send({ t: 'gone' });
            room = found;
            playerId = player.id;
            return;
          }
          default:
            return fail('Join or create a room first.');
        }
      },
      close: () => {
        if (room && playerId) room.disconnect(playerId, send);
      },
    };
  }

  private newCode(): string {
    for (;;) {
      const code = Array.from({ length: 4 }, () => CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)]).join('');
      if (!this.rooms.has(code)) return code;
    }
  }
}
