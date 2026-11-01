// A command-line Keeps game against the bot playing its search (search-bot.ts) as Midstrike does: a move sampled from one
// damped policy-improvement step (SEARCH_MODE=best-q: the best-Q move), heads-up, one round per game.
// The bot: BOT=<name> plays weights/<name>.bin (vrpo1 by default), SEARCH_WORLDS worlds (128), sampled rollouts
// (SEARCH_ROLLOUTS=greedy for the policy's top move; SEARCH=off for no search: the network plays directly).
//
//   node keeps-play.ts new <id> <0|2>   start game <id>; you sit at seat 0 or 2 (the bot takes the other)
//   node keeps-play.ts show <id>        your view, the prompt, your numbered options, the recent log (a bot reply
//                                       cut short goes on first: every move is saved as it is made)
//   node keeps-play.ts move <id> <n>    play option n; the bot answers until it's your decision again
//   node keeps-play.ts log <id>         the whole log so far
//   node keeps-play.ts cards            every card's rules text
//
// Games are saved as replay logs in data/cli-games/<id>.json and rebuilt on each call. The search's log
// (data/cli-search.log) shows the bot's hand: it is not for the player.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  apply,
  CARD_IDS,
  CARDS,
  coinsLabel,
  eventsFor,
  legalCommands,
  newGame,
  viewFor,
  type Command,
  type GameState,
  type PlayerView,
  type Seat,
  type TraceEvent,
} from '../../engine/src/index.ts';
import { BotPlayer } from '../src/bot.ts';
import { Policy } from '../src/policy.ts';
import { availableParallelism } from 'node:os';
import { appendFileSync } from 'node:fs';
import { searchChoose, setSearchLog, setSearchMode, setWorlds } from './search-bot.ts';
import { RolloutPool } from './rollout-pool.ts';
setSearchMode(process.env.SEARCH_MODE === 'best-q' ? 'best-q' : 'damped');
setWorlds(Number(process.env.SEARCH_WORLDS ?? 128));
// The search's reasoning shows the bot's hand: it goes to a file, not the player's screen.
setSearchLog((line) => appendFileSync(join(import.meta.dirname, 'data', 'cli-search.log'), line + '\n'));
import { logLines } from '@keeps/table';
import { describeOptions, makeNames, shownCards } from '@keeps/table';
import { promptText } from '@keeps/table';

const DIR = join(import.meta.dirname, 'data', 'cli-games');
const WEIGHTS = join(import.meta.dirname, 'weights', `${process.env.BOT ?? 'vrpo1'}.bin`);
let pool: RolloutPool | null = null;

interface Saved {
  options: { players: 2; seed: string; marksToWin: 1 };
  human: Seat;
  commands: { seat: Seat; command: Command }[];
  /** How much of the log the human has been shown. */
  shown: number;
}

const coins = (card: (typeof CARD_IDS)[number]) => {
  const c = CARDS[card].coins;
  return c === undefined ? '' : c === 'tithes' ? ' [1 coin per card in its keep]' : ` [${coinsLabel(c)} coins]`;
};
const cardName = (card: (typeof CARD_IDS)[number]) => `${CARDS[card].name}${coins(card)}`;

class Game {
  saved: Saved;
  state: GameState;
  events: TraceEvent[];
  readonly bot: Seat;
  // The website's bot: its belief is rebuilt by replaying its own decisions through it.
  private readonly player: BotPlayer;

  constructor(saved: Saved) {
    this.saved = saved;
    this.bot = (saved.human === 0 ? 2 : 0) as Seat;
    this.player = new BotPlayer(Policy.load(readFileSync(WEIGHTS)), this.bot);
    const start = newGame(saved.options);
    this.state = start.state;
    this.events = [...start.events];
    // Replay, observing at each of the bot's decisions as the bot did.
    for (const { seat, command } of saved.commands) {
      if (seat === this.bot && this.player.wantsToMove(this.state)) this.player.observe(this.state, this.events); // as it did
      this.applyRaw(seat, command);
    }
  }

  get names() {
    const n: (string | null)[] = [null, null, null, null];
    n[this.saved.human] = 'You';
    n[this.bot] = 'Bot';
    return n;
  }

  private applyRaw(seat: Seat, command: Command): void {
    const result = apply(this.state, seat, command);
    if (!result.ok) throw new Error(result.error.message);
    this.state = result.state;
    this.events.push(...result.events);
  }

  get over(): boolean {
    return this.state.phase === 'round-over' || this.state.phase === 'game-over';
  }

  private waitsOn(seat: Seat): boolean {
    return !this.over && this.state.prompts.some((p) => p.seat === seat);
  }

  /** The bot moves until it's the human's decision or the round is over (`saved` after each move). */
  async botPlays(saved?: () => void): Promise<void> {
    while (this.waitsOn(this.bot) && !this.waitsOn(this.saved.human)) {
      // SEARCH=off: the network plays directly (as its weights' threshold says), like the live site.
      const command =
        process.env.SEARCH === 'off'
          ? this.player.choose(this.state, this.events)
          : await searchChoose(this.player, this.state, this.events, (pool ??= new RolloutPool(Math.max(1, availableParallelism() - 4), WEIGHTS, process.env.SEARCH_ROLLOUTS !== 'greedy')));
      this.saved.commands.push({ seat: this.bot, command });
      this.applyRaw(this.bot, command);
      saved?.();
    }
  }

  humanOptions() {
    if (!this.waitsOn(this.saved.human)) return [];
    const view = viewFor(this.state, this.saved.human);
    return describeOptions(view, makeNames(this.names, this.saved.human));
  }

  humanMove(n: number): void {
    const options = this.humanOptions();
    const option = options[n - 1];
    if (!option) throw new Error(`no option ${n}; choose 1-${options.length} (run "show" to see them)`);
    this.saved.commands.push({ seat: this.saved.human, command: option.command });
    this.applyRaw(this.saved.human, option.command);
  }

  logText(from = 0): string {
    const mine = eventsFor(this.events, this.saved.human);
    return logLines(mine.slice(from), makeNames(this.names, 'spectator', this.saved.human)) // named from the player's side of the table, as the options are
      .map((l) => `${'  '.repeat(l.depth)}${l.text.replace(/\byou\b/g, 'You')}`)
      .join('\n');
  }

  render(): string {
    const me = this.saved.human;
    const view = viewFor(this.state, me);
    const names = makeNames(this.names, me);
    const who = (s: Seat) => (s === me ? 'You' : s === this.bot ? 'Bot' : `${names.seat(s)} (seat ${s})`);
    const out: string[] = [];
    const recent = eventsFor(this.events, me).length;
    out.push(`=== Game ${this.saved.options.seed}: you are seat ${me}, the bot is seat ${this.bot}. Turn ${view.turnNumber}, phase ${view.phase}.`);
    if (view.turn) out.push(`Turn: ${who(view.turn.seat)} (actions taken this turn: ${view.turn.actionsTaken})`);
    out.push('\nPiles (each seat has a pile; ghosts too):');
    const whose = (s: Seat) => (s === me ? 'Your' : `${who(s)}'s`);
    for (const pile of view.piles) out.push(`  ${whose(pile.position)} pile: ${pile.size} cards${pile.top ? `, top face up: ${cardName(pile.top)}` : ''}`);
    out.push('\nKeeps:');
    for (const keep of view.keeps) {
      if (view.seats[keep.seat] !== 'player') continue;
      const cards = keep.cards.map((c) => (c.faceDown ? `face-down card${c.id ? ` (${cardName(c.id)}, yours)` : ''}` : cardName(c.id)));
      const score = view.scores[keep.seat];
      out.push(`  ${who(keep.seat)}: ${cards.length ? cards.join(', ') : '(empty)'}  -> ${score === null || score === undefined ? '?' : coinsLabel(score)} coins`);
    }
    out.push(`\nYour hand: ${(view.hands[me]!.cards ?? []).map(cardName).join(', ') || '(empty)'}`);
    out.push(`Bot's hand: ${view.hands[this.bot]!.count} cards`);
    out.push(`Discard (bottom to top): ${view.discard.map((c) => CARDS[c].name).join(', ') || '(empty)'}`);
    if (view.duplicityHolder !== null) out.push(`Duplicity: ${who(view.duplicityHolder)} may reveal the face-down card.`);
    const shown = shownCards(view, names);
    if (shown) out.push(`\n${shown.title}: ${shown.cards.map((c) => CARDS[c.card].name).join(', ')}`);
    if (this.over) {
      const winner = view.lastRoundWinner;
      out.push(`\n*** ROUND OVER: ${winner === null ? 'no winner' : winner === me ? 'YOU WIN' : 'THE BOT WINS'}. ${view.roundEnd ? JSON.stringify(view.roundEnd) : ''}`);
    } else {
      for (const p of view.prompts.filter((p) => p.mine)) out.push(`\nYour decision: ${promptText(p, view, names)}`);
      const options = this.humanOptions();
      out.push('Options:');
      options.forEach((o, i) => out.push(`  ${i + 1}. ${o.label}`));
    }
    const from = Math.max(0, this.saved.shown, recent - 40);
    out.push(`\nLog since your last look:\n${this.logText(from) || '(nothing new)'}`);
    this.saved.shown = recent;
    return out.join('\n');
  }
}

function load(id: string): Game {
  const path = join(DIR, `${id}.json`);
  if (!existsSync(path)) throw new Error(`no game ${id}; start it with: new ${id} <0|2>`);
  return new Game(JSON.parse(readFileSync(path, 'utf8')) as Saved);
}

function save(game: Game, id: string): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, `${id}.json`), JSON.stringify(game.saved));
}

const [cmd, id, arg] = process.argv.slice(2);
try {
  switch (cmd) {
    case 'new': {
      if (!id || (arg !== '0' && arg !== '2')) throw new Error('usage: new <id> <0|2>');
      if (existsSync(join(DIR, `${id}.json`))) throw new Error(`game ${id} already exists`);
      const game = new Game({ options: { players: 2, seed: id, marksToWin: 1 }, human: Number(arg) as Seat, commands: [], shown: 0 });
      await game.botPlays();
      console.log(game.render());
      save(game, id);
      break;
    }
    case 'show': {
      const game = load(id!);
      // A bot reply cut short (the command timed out) goes on from where it was saved.
      await game.botPlays(() => save(game, id!));
      game.saved.shown = Math.max(0, game.saved.shown - 15); // show some context again
      console.log(game.render());
      save(game, id!);
      break;
    }
    case 'move': {
      const game = load(id!);
      if (game.over) throw new Error('the round is over');
      game.humanMove(Number(arg));
      save(game, id!);
      await game.botPlays(() => save(game, id!));
      console.log(game.render());
      save(game, id!);
      break;
    }
    case 'log':
      console.log(load(id!).logText());
      break;
    case 'cards':
      for (const card of CARD_IDS) {
        const c = CARDS[card];
        const tags = [c.hot ? 'HOT' : '', c.keep ? 'Keep card' : 'action card'].filter(Boolean).join(', ');
        console.log(`${c.name} (${tags})${coins(card)}: ${c.text || '(no ability)'}`);
      }
      break;
    default:
      console.log('commands: new <id> <0|2> | show <id> | move <id> <n> | log <id> | cards');
  }
} catch (error) {
  console.error(`error: ${(error as Error).message}`);
  process.exit(1);
}
process.exit(0);  // the rollout workers would keep the process alive
