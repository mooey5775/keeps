import {
  apply,
  eventsFor,
  newGame,
  playerSeats,
  viewFor,
  type Command,
  type GameState,
  type ReplayLog,
  type Seat,
  type TraceEvent,
} from '@keeps/engine';
import {
  DEFAULT_SETTINGS,
  NAME_MAX,
  type ClientMessage,
  type RoomPlayer,
  type ServerMessage,
  type Settings,
  type UndoState,
} from '@keeps/protocol';

// One game room: its players, lobby settings, the running game, and undo
// votes. No sockets here: connections are just `send` callbacks, so the
// whole room is unit-testable. The server wires these to WebSockets.

export type Send = (message: ServerMessage) => void;

export interface RoomDeps {
  /** Unique, unguessable token for resuming a seat. */
  token: () => string;
  /** Short unique player id. */
  id: () => string;
  /** Seed for a new game's RNG. */
  seed: () => string;
  /** [0, 1) — used to seat players randomly. */
  random: () => number;
  now: () => number;
  /** Called with the game's replay log after every change to it. */
  saveReplay?: (code: string, startedAt: number, log: ReplayLog) => void;
}

interface Player {
  id: string;
  name: string;
  token: string;
  host: boolean;
  seat: Seat | null;
  send: Send | null;
}

interface Game {
  state: GameState;
  /** Every event so far, for sending each viewer their filtered log. */
  events: TraceEvent[];
  log: ReplayLog;
  startedAt: number;
  /** One entry per command this round: what to restore if it is undone. */
  history: { state: GameState; events: number }[];
  undo: { proposedBy: string; accepted: string[] } | null;
}

export class Room {
  readonly code: string;
  private readonly deps: RoomDeps;
  private players: Player[] = [];
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private game: Game | null = null;
  lastActivity: number;

  constructor(code: string, deps: RoomDeps) {
    this.code = code;
    this.deps = deps;
    this.lastActivity = deps.now();
  }

  get connectedCount(): number {
    return this.players.filter((p) => p.send).length;
  }

  get playerCount(): number {
    return this.players.length;
  }

  /** Adds a player (a spectator, if a game is running) and connects them. */
  join(name: unknown, send: Send): Player {
    const player: Player = {
      id: this.deps.id(),
      name: this.uniqueName(name),
      token: this.deps.token(),
      host: this.players.length === 0,
      seat: null,
      send,
    };
    this.players.push(player);
    this.touch();
    send({ t: 'welcome', code: this.code, token: player.token, playerId: player.id });
    this.broadcastRoom();
    if (this.game) this.sendGame(player, true);
    return player;
  }

  /** Reconnects a player by token. Returns null if the token is unknown. */
  resume(token: string, send: Send): Player | null {
    const player = this.players.find((p) => p.token === token);
    if (!player) return null;
    player.send = send;
    this.touch();
    send({ t: 'welcome', code: this.code, token: player.token, playerId: player.id });
    this.broadcastRoom();
    if (this.game) this.sendGame(player, true);
    return player;
  }

  disconnect(playerId: string, send: Send): void {
    const player = this.find(playerId);
    // Ignore a stale socket closing after the player already reconnected.
    if (!player || player.send !== send) return;
    player.send = null;
    this.broadcastRoom();
    if (this.game?.undo) this.settleUndo();
  }

  handle(playerId: string, message: ClientMessage): void {
    const player = this.find(playerId);
    if (!player) return;
    this.touch();
    const error = this.dispatch(player, message);
    if (error) player.send?.({ t: 'error', message: error });
  }

  private dispatch(player: Player, message: ClientMessage): string | null {
    switch (message.t) {
      case 'settings':
        if (!player.host) return 'Only the host can change settings.';
        if (this.game) return 'The game has already started.';
        if (typeof message.settings !== 'object' || message.settings === null) return 'Invalid settings.';
        if (!Number.isInteger(message.settings.marksToWin) || message.settings.marksToWin < 1 || message.settings.marksToWin > 10) {
          return 'Marks to win must be between 1 and 10.';
        }
        if (message.settings.firstPlayer !== 'random' && message.settings.firstPlayer !== 'host') return 'Invalid first player.';
        this.settings = { marksToWin: message.settings.marksToWin, firstPlayer: message.settings.firstPlayer };
        this.broadcastRoom();
        return null;
      case 'start':
        return this.start(player);
      case 'command':
        return this.command(player, message.command);
      case 'propose-undo':
        return this.proposeUndo(player);
      case 'vote-undo':
        return this.voteUndo(player, message.accept);
      case 'back-to-lobby':
        if (!player.host) return 'Only the host can do that.';
        if (!this.game) return null;
        if (this.game.state.phase !== 'game-over') return 'The game is still going.';
        this.game = null;
        for (const p of this.players) p.seat = null;
        this.broadcastRoom();
        return null;
      case 'leave':
        this.leave(player);
        return null;
      case 'create':
      case 'join':
      case 'resume':
        return 'You are already in a room.';
      default:
        return 'Unknown message.';
    }
  }

  private start(player: Player): string | null {
    if (!player.host) return 'Only the host can start the game.';
    if (this.game) return 'The game has already started.';
    const count = this.players.length;
    if (count < 2 || count > 4) return 'Keeps needs 2 to 4 players.';

    const seed = this.deps.seed();
    const preview = newGame({ players: count as 2 | 3 | 4, seed, marksToWin: this.settings.marksToWin });
    const seats = playerSeats(preview.state);
    const shuffled = [...this.players];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(this.deps.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    shuffled.forEach((p, i) => (p.seat = seats[i]!));

    // With "host goes first", deal again with the host's seat as the first player.
    // Seating comes from the same seed, so the seats don't change.
    const options = {
      players: count as 2 | 3 | 4,
      seed,
      marksToWin: this.settings.marksToWin,
      ...(this.settings.firstPlayer === 'host' ? { firstSeat: player.seat! } : {}),
    };
    const { state, events } = this.settings.firstPlayer === 'host' ? newGame(options) : preview;
    const startedAt = this.deps.now();
    this.game = { state, events, log: { options, commands: [] }, startedAt, history: [], undo: null };
    this.deps.saveReplay?.(this.code, startedAt, this.game.log);
    this.broadcastRoom();
    for (const p of this.players) this.sendGame(p, true);
    return null;
  }

  private command(player: Player, command: Command): string | null {
    const game = this.game;
    if (!game) return 'The game has not started.';
    if (player.seat === null) return 'Spectators cannot play.';
    const result = apply(game.state, player.seat, command);
    if (!result.ok) return result.error.message;

    const newRound = result.state.round !== game.state.round;
    game.history = newRound ? [] : [...game.history, { state: game.state, events: game.events.length }];
    game.state = result.state;
    game.events = [...game.events, ...result.events];
    game.log.commands.push({ seat: player.seat, command });
    game.undo = null;
    this.deps.saveReplay?.(this.code, game.startedAt, game.log);
    for (const p of this.players) this.sendGame(p, false, result.events);
    return null;
  }

  // -- Undo ------------------------------------------------------------------

  /** Seated, connected players other than the proposer must all accept. */
  private undoVoters(proposer: string): Player[] {
    return this.players.filter((p) => p.seat !== null && p.send && p.id !== proposer);
  }

  private proposeUndo(player: Player): string | null {
    const game = this.game;
    if (!game || player.seat === null) return 'Only players in a game can propose an undo.';
    if (game.history.length === 0) return 'There is nothing to undo this round.';
    if (game.undo) return 'An undo vote is already open.';
    game.undo = { proposedBy: player.id, accepted: [] };
    this.settleUndo();
    return null;
  }

  private voteUndo(player: Player, accept: boolean): string | null {
    const game = this.game;
    if (!game?.undo) return 'There is no undo vote open.';
    if (!this.undoVoters(game.undo.proposedBy).includes(player)) return 'Your vote is not needed.';
    if (!accept) {
      game.undo = null;
      for (const p of this.players) this.sendGame(p, false);
      return null;
    }
    if (!game.undo.accepted.includes(player.id)) game.undo.accepted.push(player.id);
    this.settleUndo();
    return null;
  }

  /** Applies the undo once everyone needed has accepted; otherwise reports the vote. */
  private settleUndo(): void {
    const game = this.game;
    if (!game?.undo) return;
    const waiting = this.undoVoters(game.undo.proposedBy).filter((p) => !game.undo!.accepted.includes(p.id));
    if (waiting.length > 0) {
      for (const p of this.players) this.sendGame(p, false);
      return;
    }
    const previous = game.history.pop()!;
    game.state = previous.state;
    game.events = game.events.slice(0, previous.events);
    game.log.commands.pop();
    game.undo = null;
    this.deps.saveReplay?.(this.code, game.startedAt, game.log);
    for (const p of this.players) this.sendGame(p, true);
  }

  private undoState(player: Player): UndoState {
    const game = this.game!;
    const undo = game.undo;
    return {
      available: player.seat !== null && game.history.length > 0 && !undo,
      proposedBy: undo?.proposedBy ?? null,
      accepted: undo?.accepted ?? [],
      waitingOn: undo ? this.undoVoters(undo.proposedBy).filter((p) => !undo.accepted.includes(p.id)).map((p) => p.id) : [],
    };
  }

  // -- Membership ------------------------------------------------------------

  private leave(player: Player): void {
    if (this.game && player.seat !== null) {
      // A seated player can't leave a running game; they just disconnect and may resume.
      player.send = null;
    } else {
      this.players = this.players.filter((p) => p !== player);
      if (player.host && this.players[0]) this.players[0].host = true;
    }
    this.broadcastRoom();
    if (this.game?.undo) this.settleUndo();
  }

  private uniqueName(raw: unknown): string {
    const base = String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, NAME_MAX) || 'Player';
    let name = base;
    for (let n = 2; this.players.some((p) => p.name.toLowerCase() === name.toLowerCase()); n++) {
      name = `${base.slice(0, NAME_MAX - String(n).length - 1)} ${n}`;
    }
    return name;
  }

  private find(playerId: string): Player | undefined {
    return this.players.find((p) => p.id === playerId);
  }

  private touch(): void {
    this.lastActivity = this.deps.now();
  }

  // -- Outgoing --------------------------------------------------------------

  private summary(player: Player) {
    const players: RoomPlayer[] = this.players.map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.send !== null,
      host: p.host,
      seat: p.seat,
    }));
    return { code: this.code, phase: this.game ? ('game' as const) : ('lobby' as const), players, settings: this.settings, you: player.id };
  }

  private broadcastRoom(): void {
    for (const p of this.players) p.send?.({ t: 'room', room: this.summary(p) });
  }

  /** Sends `player` their view, plus either the new events or (on reset) the whole log. */
  private sendGame(player: Player, reset: boolean, newEvents: TraceEvent[] = []): void {
    const game = this.game;
    if (!game || !player.send) return;
    const viewer = player.seat ?? 'spectator';
    const names = [0, 1, 2, 3].map((s) => this.players.find((p) => p.seat === s)?.name ?? null);
    player.send({
      t: 'game',
      view: viewFor(game.state, viewer),
      log: eventsFor(reset ? game.events : newEvents, viewer),
      reset,
      names,
      undo: this.undoState(player),
    });
  }
}
