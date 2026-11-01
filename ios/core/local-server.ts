// The app's own game server: rooms (packages/server/src/room.ts) held here, one connection per client, as the website's
// server holds them (packages/server/src/connection.ts, the same code). Offline games against Midstrike run on it; the
// app talks to it exactly as a browser talks to the site. A room no one is connected to is closed: the app takes a game
// up again from what it kept (restore), never by a seat's token.
import type { ClientMessage, ServerMessage } from '@keeps/protocol';
import { connection } from '@keeps/server/connection.ts';
import { Room, type RoomDeps, type SavedGame } from '@keeps/server/room.ts';

export class LocalServer {
  private readonly rooms = new Map<string, Room>();
  private readonly deps: RoomDeps;

  constructor(deps: RoomDeps) {
    this.deps = deps;
  }

  /** The rooms open now (for tests). */
  get open(): number {
    return this.rooms.size;
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
    const client = connection(this.rooms, this.deps, send);
    return {
      receive: (message) => client.receive(message),
      close: () => {
        client.close();
        const room = client.room;
        if (room && room.connectedCount === 0 && this.rooms.get(room.code) === room) {
          room.close();
          this.rooms.delete(room.code);
        }
      },
    };
  }
}
