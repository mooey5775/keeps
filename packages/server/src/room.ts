import {
  apply,
  coinsLabel,
  eventsFor,
  legalCommands,
  newGame,
  playerSeats,
  scores,
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
  type Hint,
  type RoomPlayer,
  type ServerMessage,
  type Settings,
  type UndoState,
} from '@keeps/protocol';
import { BotPlayer, type Policy } from '@keeps/learn';
import type { Tracker } from './analytics.ts';
import type { OnlineDisputeInfo } from './dispute.ts';

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
  /** Product analytics (PostHog in production). */
  tracker?: Tracker;
  /** The site build being served, sent to browsers so an outdated page reloads. */
  build?: string;
  /** The bot, if this server has one. */
  bot?: BotDeps;
}

export interface BotDeps {
  policy: Policy;
  /** Runs `fn` after `ms` milliseconds; returns a function that cancels it. */
  schedule: (fn: () => void, ms: number) => () => void;
  /** How long the bot waits before each move, so people can follow it. */
  delay: () => number;
  /** Its name at the table (default "Bot"). */
  name?: string;
}

/** Analytics id for the bot's own events (one person for every bot game). */
const BOT_ANALYTICS_ID = 'keeps-bot';

/** Where a connection comes from: its IP and the browser's anonymous id. */
export interface ConnectionInfo {
  ip?: string | null;
  client?: string | null;
}

interface Player {
  id: string;
  name: string;
  token: string;
  host: boolean;
  seat: Seat | null;
  send: Send | null;
  /** The IP of the player's latest connection. */
  ip: string | null;
  /** Anonymous id of the player's browser, if it sent one. */
  client: string | null;
  joinedAt: number;
  /** A computer player: never connected, never host. */
  bot: boolean;
  /** Training mode: in games against the bot, the bot's suggestion for each of this player's moves. */
  training: boolean;
}

/** A room as the admin page shows it. */
export interface RoomInfo {
  code: string;
  phase: 'lobby' | 'game';
  createdAt: number;
  lastActivity: number;
  settings: Settings;
  players: { name: string; seat: Seat | null; host: boolean; connected: boolean; ip: string | null; joinedAt: number; bot: boolean }[];
  game: {
    startedAt: number;
    round: number;
    phase: string;
    marks: number[];
    turnSeat: Seat | null;
    commands: number;
  } | null;
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
  roundStartedAt: number;
  /** The bot players at the table (none in an all-human game). */
  bots: BotPlayer[];
  /**
   * In games against the bot, one shadow bot per human seat, for training mode: it follows that seat
   * exactly as if it were playing there (its view, its log, its belief), at every decision whether or
   * not anyone asks for advice. Its latest advice is kept, for the state it was worked out for
   * (empty while it is still being worked out).
   */
  advisors: Map<Seat, { bot: BotPlayer; advice: { state: GameState; hints: Hint[] } | null }>;
}

export class Room {
  readonly code: string;
  private readonly deps: RoomDeps;
  private players: Player[] = [];
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private game: Game | null = null;
  /** Cancels the bot's pending move, if one is scheduled. */
  private botTimer: (() => void) | null = null;
  readonly createdAt: number;
  lastActivity: number;

  constructor(code: string, deps: RoomDeps) {
    this.code = code;
    this.deps = deps;
    this.createdAt = deps.now();
    this.lastActivity = this.createdAt;
  }

  get connectedCount(): number {
    return this.players.filter((p) => p.send).length;
  }

  get playerCount(): number {
    return this.players.length;
  }

  /** When the running game started (it names the game's replay file), or null. */
  get gameStartedAt(): number | null {
    return this.game?.startedAt ?? null;
  }

  /** Adds a player (a spectator, if a game is running) and connects them. */
  join(name: unknown, send: Send, from: ConnectionInfo = {}): Player {
    const player: Player = {
      id: this.deps.id(),
      name: this.uniqueName(name),
      token: this.deps.token(),
      // The first person in (a bot never hosts).
      host: !this.players.some((p) => p.host),
      seat: null,
      send,
      ip: from.ip ?? null,
      client: validClient(from.client),
      joinedAt: this.deps.now(),
      bot: false,
      training: false,
    };
    this.players.push(player);
    this.touch();
    if (player.host) this.track('room_created', player);
    this.track('player_joined', player, { spectator: this.game !== null, players: this.players.length });
    send(this.welcome(player));
    this.broadcastRoom();
    if (this.game) this.sendGame(player, true);
    return player;
  }

  /** Reconnects a player by token. Returns null if the token is unknown. */
  resume(token: string, send: Send, from: ConnectionInfo = {}): Player | null {
    const player = this.players.find((p) => p.token === token);
    if (!player) return null;
    // The seat moves to the new connection; tell the old one so it doesn't sit there stale.
    if (player.send && player.send !== send) player.send({ t: 'replaced' });
    player.send = send;
    if (from.ip) player.ip = from.ip;
    player.client = validClient(from.client) ?? player.client;
    this.touch();
    this.track('player_resumed', player, { in_game: this.game !== null });
    send(this.welcome(player));
    this.broadcastRoom();
    if (this.game) this.sendGame(player, true);
    return player;
  }

  private welcome(player: Player): ServerMessage {
    return { t: 'welcome', code: this.code, token: player.token, playerId: player.id, ...(this.deps.build ? { build: this.deps.build } : {}) };
  }

  /** Ends the room: tells everyone still connected it's gone. */
  close(): void {
    this.cancelBot();
    for (const p of this.players) {
      p.send?.({ t: 'gone' });
      p.send = null;
    }
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
        {
          const first: unknown = message.settings.firstPlayer;
          const chosen =
            typeof first === 'object' && first !== null && 'player' in first && typeof first.player === 'string' ? this.find(first.player) : undefined;
          if (first !== 'random' && !chosen) return 'Invalid first player.';
          this.settings = { marksToWin: message.settings.marksToWin, firstPlayer: chosen ? { player: chosen.id } : 'random' };
        }
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
      case 'training':
        if (!this.deps.bot) return "Training mode needs the bot, and this server doesn't have it.";
        player.training = message.on === true;
        player.send?.({ t: 'room', room: this.summary(player) });
        if (this.game) this.sendGame(player, false);
        return null;
      case 'back-to-lobby':
        if (!player.host) return 'Only the host can do that.';
        if (!this.game) return null;
        if (this.game.state.phase !== 'game-over') return 'The game is still going.';
        this.cancelBot();
        this.game = null;
        for (const p of this.players) p.seat = null;
        this.broadcastRoom();
        return null;
      case 'leave':
        this.leave(player);
        return null;
      case 'add-bot':
        return this.addBot(player);
      case 'remove-bot':
        if (!player.host) return 'Only the host can remove the bot.';
        if (this.game) return 'The game has already started.';
        for (const bot of this.players.filter((p) => p.bot)) this.remove(bot);
        this.broadcastRoom();
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
    if (count !== 2 && this.players.some((p) => p.bot)) return 'The bot only plays two-player games.';

    const seed = this.deps.seed();
    const preview = newGame({ players: count as 2 | 3 | 4, seed, marksToWin: this.settings.marksToWin });
    const seats = playerSeats(preview.state);
    const shuffled = [...this.players];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(this.deps.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    shuffled.forEach((p, i) => (p.seat = seats[i]!));

    // With a chosen first player, deal again with their seat going first.
    // Seating comes from the same seed, so the seats don't change.
    const first = this.settings.firstPlayer;
    const chosen = first === 'random' ? undefined : this.find(first.player);
    const options = {
      players: count as 2 | 3 | 4,
      seed,
      marksToWin: this.settings.marksToWin,
      ...(chosen ? { firstSeat: chosen.seat! } : {}),
    };
    const { state, events } = chosen ? newGame(options) : preview;
    const startedAt = this.deps.now();
    const bots = this.players.filter((p) => p.bot).map((p) => new BotPlayer(this.deps.bot!.policy, p.seat!, this.deps.random));
    const advisors: Game['advisors'] = new Map(
      bots.length ? this.players.filter((p) => !p.bot && p.seat !== null).map((p) => [p.seat!, { bot: new BotPlayer(this.deps.bot!.policy, p.seat!), advice: null }]) : [],
    );
    this.game = { state, events, log: { options, commands: [] }, startedAt, history: [], undo: null, roundStartedAt: startedAt, bots, advisors };
    this.followHumans();
    this.deps.saveReplay?.(this.code, startedAt, this.game.log);
    const seated = this.seatedPlayers();
    this.track('game_started', player, {
      players: count,
      marks_to_win: this.settings.marksToWin,
      first_player: chosen ? 'chosen' : 'random',
      ...(chosen ? { first_player_name: chosen.name } : {}),
      player_names: seated.map((p) => p.name),
      player_ips: seated.map((p) => p.ip),
      ...this.botProperties(),
    });
    this.broadcastRoom();
    for (const p of this.players) this.sendGame(p, true);
    this.scheduleBot();
    return null;
  }

  private command(player: Player, command: Command): string | null {
    const game = this.game;
    if (!game) return 'The game has not started.';
    if (player.seat === null) return 'Spectators cannot play.';
    const result = apply(game.state, player.seat, command);
    if (!result.ok) return result.error.message;

    const before = game.state;
    const newRound = result.state.round !== before.round;
    game.history = newRound ? [] : [...game.history, { state: before, events: game.events.length }];
    game.state = result.state;
    game.events = [...game.events, ...result.events];
    game.log.commands.push({ seat: player.seat, command });
    game.undo = null;
    if (newRound) game.roundStartedAt = this.deps.now();
    this.deps.saveReplay?.(this.code, game.startedAt, game.log);
    this.trackCommand(game, before, result.events);
    this.followHumans();
    for (const p of this.players) this.sendGame(p, false, result.events);
    this.scheduleBot();
    return null;
  }

  // -- The bot ---------------------------------------------------------------

  private addBot(player: Player): string | null {
    if (!player.host) return 'Only the host can add the bot.';
    if (this.game) return 'The game has already started.';
    if (!this.deps.bot) return "The bot isn't available on this server.";
    if (this.players.some((p) => p.bot)) return 'The bot is already here.';
    if (this.players.length >= 2) return 'The bot only plays two-player games.';
    this.players.push({
      id: this.deps.id(),
      name: this.uniqueName(this.deps.bot.name ?? 'Bot'),
      token: this.deps.token(),
      host: false,
      seat: null,
      send: null,
      ip: null,
      client: null,
      joinedAt: this.deps.now(),
      bot: true,
      training: false,
    });
    this.track('bot_added', player);
    this.broadcastRoom();
    return null;
  }

  /** If the game is waiting on the bot, plays its move after a short delay. */
  private scheduleBot(): void {
    const game = this.game;
    const deps = this.deps.bot;
    if (!game || !deps || this.botTimer) return;
    const bot = game.bots.find((b) => b.wantsToMove(game.state));
    if (!bot) return;
    const state = game.state;
    this.botTimer = deps.schedule(() => {
      this.botTimer = null;
      // Something happened meanwhile (e.g. a free Duplicity reveal): look again.
      if (this.game !== game || game.state !== state) return this.scheduleBot();
      this.playBot(game, bot);
    }, deps.delay());
  }

  private playBot(game: Game, bot: BotPlayer): void {
    const player = this.playerAt(bot.seat);
    if (!player) return;
    let error: string | null;
    try {
      error = this.command(player, bot.choose(game.state, game.events));
    } catch (thrown) {
      error = String(thrown instanceof Error ? thrown.stack : thrown);
    }
    if (error === null) return;
    // Never leave the game stuck on the bot: log it and play any legal move.
    console.error(`room ${this.code}: the bot failed (${error}); playing a random legal move`);
    const legal = legalCommands(game.state, bot.seat).filter((c) => c.type !== 'reveal-duplicity' && c.type !== 'next-round');
    const fallback = legal[Math.floor(this.deps.random() * legal.length)];
    if (fallback) this.command(player, fallback);
  }

  private cancelBot(): void {
    this.botTimer?.();
    this.botTimer = null;
  }

  /** Analytics properties naming the bot in a game against it. */
  private botProperties(): Record<string, unknown> {
    if (!this.game?.bots.length) return {};
    const { run, step } = this.deps.bot!.policy.info;
    return { vs_bot: true, bot_policy: `${run}-${step}` };
  }

  /** Analytics for what a command did: cards played, and rounds or the game ending. */
  private trackCommand(game: Game, before: GameState, events: TraceEvent[]): void {
    const now = this.deps.now();
    for (const { payload } of events) {
      if (payload.type !== 'play') continue;
      const actor = this.playerAt(payload.seat);
      if (actor) {
        this.track('card_played', actor, {
          card: payload.card,
          hot: payload.hot,
          ...(payload.copy ? { copied: payload.copy } : {}),
          round: before.round,
        });
      }
    }
    const state = game.state;
    const roundWasLive = before.phase === 'playing' || before.phase === 'post-round';
    const roundOver = state.phase === 'round-over' || state.phase === 'game-over';
    if (!roundWasLive || !roundOver || state.lastRoundWinner === null) return;
    const winner = this.playerAt(state.lastRoundWinner);
    if (!winner) return;
    const values = scores(state);
    const seated = this.seatedPlayers();
    this.track('round_ended', winner, {
      ...this.botProperties(),
      round: state.round,
      reason: state.roundEnd?.kind ?? null,
      players: seated.length,
      scores: Object.fromEntries(seated.map((p) => [p.name, coinsLabel(values[p.seat!] ?? 0)])),
      duration_ms: now - game.roundStartedAt,
    });
    if (state.phase === 'game-over') {
      this.track('game_finished', winner, {
        ...this.botProperties(),
        rounds: state.round,
        players: seated.length,
        player_names: seated.map((p) => p.name),
        marks: Object.fromEntries(seated.map((p) => [p.name, state.marks[p.seat!]])),
        commands: game.log.commands.length,
        duration_ms: now - game.startedAt,
      });
    }
  }

  // -- Undo ------------------------------------------------------------------

  /** Seated, connected players other than the proposer must all accept. */
  private undoVoters(proposer: string): Player[] {
    return this.players.filter((p) => p.seat !== null && p.send && p.id !== proposer);
  }

  private proposeUndo(player: Player): string | null {
    const game = this.game;
    if (!game || player.seat === null) return 'Only players in a game can propose an undo.';
    if (game.bots.length > 0) return 'Undo is off in games against the bot.';
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
    const proposer = this.find(game.undo.proposedBy);
    if (proposer) this.track('undo_applied', proposer, { round: game.state.round });
    game.undo = null;
    this.deps.saveReplay?.(this.code, game.startedAt, game.log);
    for (const p of this.players) this.sendGame(p, true);
  }

  private undoState(player: Player): UndoState {
    const game = this.game!;
    const undo = game.undo;
    return {
      available: player.seat !== null && game.history.length > 0 && !undo && game.bots.length === 0,
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
      this.remove(player);
      // A bot doesn't stay in a lobby without people.
      if (!this.game && this.players.every((p) => p.bot)) for (const bot of [...this.players]) this.remove(bot);
    }
    this.broadcastRoom();
    if (this.game?.undo) this.settleUndo();
  }

  /** Takes a player out of the lobby, passing on the host role and the first-player choice. */
  private remove(player: Player): void {
    this.players = this.players.filter((p) => p !== player);
    const next = this.players.find((p) => !p.bot);
    if (player.host && next) next.host = true;
    // The chosen first player is gone: back to a random one.
    if (this.settings.firstPlayer !== 'random' && this.settings.firstPlayer.player === player.id) {
      this.settings = { ...this.settings, firstPlayer: 'random' };
    }
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

  private playerAt(seat: Seat): Player | undefined {
    return this.players.find((p) => p.seat === seat);
  }

  private seatedPlayers(): Player[] {
    return this.players.filter((p) => p.seat !== null).sort((a, b) => a.seat! - b.seat!);
  }

  private track(event: string, player: Player, properties: Record<string, unknown> = {}): void {
    this.deps.tracker?.capture(
      event,
      { id: player.bot ? BOT_ANALYTICS_ID : (player.client ?? `player:${player.id}`), name: player.name, ip: player.ip },
      { room: this.code, ...properties },
    );
  }

  /** The reporter and their game, for a rule dispute (by seat token). */
  disputeInfo(token: string): OnlineDisputeInfo | null {
    const player = this.players.find((p) => p.token === token);
    if (!player) return null;
    const game = this.game;
    return {
      name: player.name,
      seat: player.seat,
      client: player.client,
      game: game && { round: game.state.round, phase: game.state.phase, log: game.log, events: game.events },
    };
  }

  /** What the admin page shows about this room. */
  info(): RoomInfo {
    const game = this.game;
    return {
      code: this.code,
      phase: game ? 'game' : 'lobby',
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
      settings: { ...this.settings },
      players: this.players.map((p) => ({
        name: p.name,
        seat: p.seat,
        host: p.host,
        connected: p.bot || p.send !== null,
        ip: p.ip,
        joinedAt: p.joinedAt,
        bot: p.bot,
      })),
      game: game && {
        startedAt: game.startedAt,
        round: game.state.round,
        phase: game.state.phase,
        marks: [...game.state.marks],
        turnSeat: game.state.turn?.seat ?? null,
        commands: game.log.commands.length,
      },
    };
  }

  private touch(): void {
    this.lastActivity = this.deps.now();
  }

  // -- Outgoing --------------------------------------------------------------

  private summary(player: Player) {
    const players: RoomPlayer[] = this.players.map((p) => ({
      id: p.id,
      name: p.name,
      // A bot is always there.
      connected: p.bot || p.send !== null,
      host: p.host,
      seat: p.seat,
      ...(p.bot ? { bot: true } : {}),
    }));
    return {
      code: this.code,
      phase: this.game ? ('game' as const) : ('lobby' as const),
      players,
      settings: this.settings,
      you: player.id,
      botAvailable: this.deps.bot !== undefined,
      training: player.training,
    };
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
      ...(player.training && player.seat !== null && game.advisors.has(player.seat) ? { hints: this.hints(game, player.seat) } : {}),
    });
  }

  /** Each human seat's shadow bot observes that seat's decision, as it would if it were playing it. */
  private followHumans(): void {
    const game = this.game;
    if (!game) return;
    for (const { bot } of game.advisors.values()) {
      if (!bot.wantsToMove(game.state)) continue;
      try {
        bot.observe(game.state, game.events);
      } catch (error) {
        console.error(`room ${this.code}: training mode could not follow seat ${bot.seat}:`, error);
      }
    }
  }

  /**
   * Training mode's advice for `seat` now: the bot's suggestion, null when the seat has no decision, or
   * empty while advice that takes time (a search) is worked out: it is sent when it is ready.
   */
  private hints(game: Game, seat: Seat): Hint[] | null {
    const advisor = game.advisors.get(seat)!;
    if (!advisor.bot.wantsToMove(game.state)) return null;
    if (advisor.advice?.state !== game.state) {
      const state = game.state;
      let advice: Hint[] | Promise<Hint[]>;
      try {
        advice = this.advise(advisor.bot, state, game.events);
      } catch (error) {
        console.error(`room ${this.code}: training mode could not advise seat ${seat}:`, error);
        return null;
      }
      advisor.advice = { state, hints: Array.isArray(advice) ? advice : [] };
      if (!Array.isArray(advice)) {
        advice
          .catch((error: unknown) => {
            console.error(`room ${this.code}: training mode's search failed for seat ${seat} (the network advises instead):`, error);
            return advisor.bot.suggest(state, game.events);
          })
          .then((hints) => {
            if (this.game !== game || game.state !== state || advisor.advice?.state !== state) return; // the moment has passed
            advisor.advice = { state, hints };
            for (const p of this.players) if (p.training && p.seat === seat) this.sendGame(p, false);
          })
          .catch((error: unknown) => console.error(`room ${this.code}: training mode could not advise seat ${seat}:`, error));
      }
    }
    return advisor.advice.hints;
  }

  /** The advice itself: the network's suggestion, at once. (A server that searches replaces this with its search.) */
  private advise(bot: BotPlayer, state: GameState, events: readonly TraceEvent[]): Hint[] | Promise<Hint[]> {
    return bot.suggest(state, events);
  }
}

/** A browser's anonymous id: short, plain text only. */
function validClient(client: unknown): string | null {
  return typeof client === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(client) ? client : null;
}
