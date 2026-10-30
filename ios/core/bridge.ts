// The core's side of its bridge to the app: a connection per client of the core's local server, and each game
// message sent with what the web client works out for itself (web/src/game/options.ts, log.ts). The app's core
// (main.ts) wires it to the web view's message handler; tools/swift-types/goldens.ts drives it from Node, recording
// what the app would get.
import type { Seat, TraceEvent } from '../../packages/engine/src/index.ts';
import type { ClientMessage, ServerMessage } from '../../packages/protocol/src/index.ts';
import { logLines, type LogLine } from '../../packages/web/src/game/log.ts';
import { describeOptions, makeNames, type Option } from '../../packages/web/src/game/options.ts';
import type { LocalServer } from './local-server.ts';

export type FromApp =
  | { t: 'connect'; id: number }
  | { t: 'client'; id: number; message: ClientMessage }
  | { t: 'close'; id: number }
  /** How long Midstrike waits before each move, so a person can follow it (0 for tests). */
  | { t: 'config'; botDelayMs: number };

export type ToApp =
  | { t: 'ready'; workers: number; network: string }
  | { t: 'server'; id: number; message: ServerMessage; options?: Option[]; lines?: LogLine[] }
  /** Each of Midstrike's searches, as it finishes. */
  | { t: 'search'; room: string; seat: number; turn: number; worlds: number; moves: number; ms: number }
  | { t: 'failed'; message: string };

/** Each connection's game log so far, for the log's lines (they're worked out from the whole log, as the web client does). */
type Connection = { receive(m: ClientMessage): void; close(): void; events: TraceEvent[] };

/**
 * The app's messages (JSON, FromApp) to `receive`; the core's to `post`. `configure`: the app's settings for Midstrike
 * (botDelayMs). A message that fails to be handled is posted back as `failed`.
 */
export function coreBridge(server: LocalServer, post: (m: ToApp) => void, configure: (botDelayMs: number) => void): (json: string) => void {
  const connections = new Map<number, Connection>();
  const deliver = (id: number, message: ServerMessage) => {
    const connection = connections.get(id);
    if (message.t !== 'game' || !connection) return post({ t: 'server', id, message });
    connection.events = message.reset ? [...message.log] : [...connection.events, ...message.log];
    const viewer = message.view.viewer;
    const anchor = (viewer === 'spectator' ? 0 : viewer) as Seat;
    const options = viewer === 'spectator' ? [] : describeOptions(message.view, makeNames(message.names, viewer, anchor));
    const lines = logLines(connection.events, makeNames(message.names, 'spectator', anchor));
    post({ t: 'server', id, message, options, lines });
  };
  return (json: string) => {
    try {
      const m = JSON.parse(json) as FromApp;
      if (m.t === 'config') configure(m.botDelayMs);
      else if (m.t === 'connect') connections.set(m.id, { ...server.connect((message) => deliver(m.id, message)), events: [] });
      else if (m.t === 'client') connections.get(m.id)?.receive(m.message);
      else if (m.t === 'close') {
        connections.get(m.id)?.close();
        connections.delete(m.id);
      }
    } catch (error) {
      post({ t: 'failed', message: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) });
    }
  };
}
