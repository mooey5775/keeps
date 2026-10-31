// The core's side of its bridge to the app: a connection per client of the core's local server, and each game
// message sent with what the web client works out for itself (web/src/game/options.ts, log.ts). The app's core
// (main.ts) wires it to the web view's message handler; tools/swift-types/goldens.ts drives it from Node, recording
// what the app would get.
import { CARD_IDS, CARDS, coinsLabel, type CardId, type Seat, type TraceEvent } from '../../packages/engine/src/index.ts';
import type { ClientMessage, ServerMessage } from '../../packages/protocol/src/index.ts';
import { hintChance, hintLabel } from '../../packages/web/src/game/hints.ts';
import { logLines, type LogLine } from '../../packages/web/src/game/log.ts';
import { describeOptions, makeNames, shownCards, type Names, type Option, type ShownCard } from '../../packages/web/src/game/options.ts';
import { capital, headline, promptText } from '../../packages/web/src/game/status.ts';
import type { LocalServer } from './local-server.ts';

export type FromApp =
  | { t: 'connect'; id: number }
  | { t: 'client'; id: number; message: ClientMessage }
  | { t: 'close'; id: number }
  /**
   * How long Midstrike waits before each move, so a person can follow it (0 for tests); and, for tests, a seed that
   * makes every game the same (the deal, the seating, Midstrike's draws from its network).
   */
  | { t: 'config'; botDelayMs: number; seed?: string };

/** A card as the app shows it: its name, its text, and its picture (a file in the app's cards folder). */
export interface CardInfo {
  id: CardId;
  name: string;
  text: string;
  image: string;
}

/** The cards, in the game's order. */
export const cardCatalog = (): CardInfo[] =>
  CARD_IDS.map((id) => ({ id, name: CARDS[id].name, text: CARDS[id].text, image: CARDS[id].image.replace(/\.png$/, '.webp') }));

/** What the web client's table says about a game message, worked out as it does (web/src/game/status.ts, options.ts, hints.ts). */
export interface TableText {
  /** Each seat's name as the table shows it ("You", "Midstrike", "Left ghost"), and its possessive ("Your", "Midstrike's"). */
  names: string[];
  possessive: string[];
  /** Each seat's coins in its keep ("3½"). */
  coins: string[];
  /** The game's or the round's end, or the last chances before scoring; null while playing. */
  headline: string | null;
  /** One line per open prompt: what you decide, or whom everyone is waiting on. */
  prompts: { seat: Seat; mine: boolean; text: string }[];
  /** The cards on display for your decision (the pile you're looking through, the discard, revealed hands). */
  shown: { title: string; cards: ShownCard[] } | null;
  /** Training mode's hints, labelled as the options are (the first is the move the bot would play). */
  hints: { label: string; chance: string }[] | null;
}

export type ToApp =
  | { t: 'ready'; workers: number; network: string; cards: CardInfo[] }
  | { t: 'server'; id: number; message: ServerMessage; options?: Option[]; lines?: LogLine[]; table?: TableText }
  /** A game's replay log so far (engine/src/replay.ts, as the website's server keeps it), after each move: the app keeps it as `file`. */
  | { t: 'saved'; file: string; text: string }
  /** Each of Midstrike's searches, as it finishes. */
  | { t: 'search'; room: string; seat: number; turn: number; worlds: number; moves: number; ms: number }
  | { t: 'failed'; message: string };

/** Each connection's game log so far, for the log's lines (they're worked out from the whole log, as the web client does). */
type Connection = { receive(m: ClientMessage): void; close(): void; events: TraceEvent[] };

/**
 * The app's messages (JSON, FromApp) to `receive`; the core's to `post`. `configure`: the app's settings (Midstrike's
 * botDelayMs; a seed for tests). A message that fails to be handled is posted back as `failed`.
 */
export function coreBridge(server: LocalServer, post: (m: ToApp) => void, configure: (botDelayMs: number, seed?: string) => void): (json: string) => void {
  const connections = new Map<number, Connection>();
  const deliver = (id: number, message: ServerMessage) => {
    const connection = connections.get(id);
    if (message.t !== 'game' || !connection) return post({ t: 'server', id, message });
    connection.events = message.reset ? [...message.log] : [...connection.events, ...message.log];
    const viewer = message.view.viewer;
    const anchor = (viewer === 'spectator' ? 0 : viewer) as Seat;
    const names = makeNames(message.names, viewer, anchor);
    const options = viewer === 'spectator' ? [] : describeOptions(message.view, names);
    const lines = logLines(connection.events, makeNames(message.names, 'spectator', anchor));
    post({ t: 'server', id, message, options, lines, table: tableText(message, names, options) });
  };
  return (json: string) => {
    try {
      const m = JSON.parse(json) as FromApp;
      if (m.t === 'config') configure(m.botDelayMs, m.seed);
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

function tableText(message: Extract<ServerMessage, { t: 'game' }>, names: Names, options: Option[]): TableText {
  const { view } = message;
  const seats = [0, 1, 2, 3] as Seat[];
  return {
    names: seats.map((s) => capital(names.seat(s))),
    possessive: seats.map((s) => capital(names.possessive(s))),
    coins: seats.map((s) => coinsLabel(view.scores[s] ?? 0)),
    headline: headline(view, names),
    prompts: view.prompts.map((p) => ({ seat: p.seat, mine: p.mine, text: promptText(p, view, names) })),
    shown: shownCards(view, names),
    hints: message.hints ? message.hints.map((h) => ({ label: hintLabel(h, options), chance: hintChance(h) })) : null,
  };
}
