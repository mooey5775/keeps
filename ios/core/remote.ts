// A connection of the app's to a game server elsewhere (the website's: playkeeps.online, midstrike.playkeeps.online),
// over a WebSocket, as a browser's (web/src/net/store.ts): the same protocol as the core's own server, so the app
// plays there as it plays here. A connection that drops comes back by itself and takes its seat again (`resume`, with
// the seat's token), as the website's does; one the server ends (`gone`, or `replaced` by another connection to the
// seat) stays closed.
import { PROTOCOL, type ClientMessage, type ServerMessage } from '../../packages/protocol/src/index.ts';

/** What the app is told about the connection itself. */
export type LinkState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface RemoteOptions {
  /** The server's WebSocket address (wss://host/ws). */
  url: string;
  /** The server's messages. */
  receive: (message: ServerMessage) => void;
  /** The connection's state, as it changes. */
  state: (state: LinkState) => void;
  /** Makes the socket (tests give their own). */
  socket?: (url: string) => WebSocket;
  /** How long to wait before the `n`th attempt to come back (from 0). */
  backoff?: (n: number) => number;
}

/** The longest wait between attempts to come back. */
const MAX_WAIT_MS = 10_000;

export function remoteConnection(options: RemoteOptions): { receive(message: ClientMessage): void; close(): void } {
  const open = options.socket ?? ((url: string) => new WebSocket(url));
  const backoff = options.backoff ?? ((n: number) => Math.min(MAX_WAIT_MS, 500 * 2 ** n));
  let socket: WebSocket | null = null;
  /** The first message on each connection: create or join; once welcomed, resume (the seat, by its token). */
  let hello: ClientMessage | null = null;
  /** What's said before the first socket opens goes once it does. */
  let pending: ClientMessage[] = [];
  /** Dropped, and coming back. */
  let away = false;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const connect = () => {
    const s = open(options.url);
    socket = s;
    s.onopen = () => {
      if (socket !== s) return;
      attempts = 0;
      options.state('open');
      // Coming back: the seat, by its token (the server sends the room and the game afresh).
      for (const m of away ? [hello!] : pending) s.send(JSON.stringify(m));
      away = false;
      pending = [];
    };
    s.onmessage = (event) => {
      if (socket !== s) return;
      const message = JSON.parse(String(event.data)) as ServerMessage;
      // A server that speaks another version of the protocol: stopped here, saying which side is behind (rather than
      // messages the app can't read).
      if (message.t === 'welcome' && message.protocol !== PROTOCOL) {
        const host = new URL(options.url).host;
        const theirs = message.protocol ?? 0;
        stop();
        options.receive({
          t: 'error',
          message: theirs < PROTOCOL ? `${host} runs an older Keeps than this app: it can't be played on until it's updated.` : `${host} runs a newer Keeps: update this app to play there.`,
        });
        return;
      }
      // Welcomed: from now on, coming back means taking this seat again.
      if (message.t === 'welcome') hello = { t: 'resume', code: message.code, token: message.token };
      if (message.t === 'gone' || message.t === 'replaced') stop();
      options.receive(message);
    };
    s.onclose = () => {
      if (socket !== s || closed) return;
      socket = null;
      // Never welcomed (the server was unreachable, or refused the room): nothing to come back to.
      if (hello?.t !== 'resume') {
        stop();
        options.receive({ t: 'error', message: `Couldn't reach ${new URL(options.url).host}.` });
        return;
      }
      away = true;
      options.state('reconnecting');
      timer = setTimeout(connect, backoff(attempts++));
    };
  };

  const stop = () => {
    closed = true;
    if (timer) clearTimeout(timer);
    const s = socket;
    socket = null;
    s?.close();
    options.state('closed');
  };

  options.state('connecting');
  connect();
  return {
    receive: (message) => {
      if (closed) return;
      if (!hello && (message.t === 'create' || message.t === 'join' || message.t === 'resume')) hello = message;
      if (socket?.readyState === WebSocket.OPEN) return socket.send(JSON.stringify(message));
      // While away, nothing is held for later (the game may well have moved on): said so at once.
      if (away) return options.receive({ t: 'error', message: "Not connected: that wasn't sent (reconnecting…)." });
      pending.push(message);
    },
    close: () => {
      if (closed) return;
      // Leaving: said to the server (a seated player keeps their seat to come back to), then gone.
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'leave' } satisfies ClientMessage));
      stop();
    },
  };
}
