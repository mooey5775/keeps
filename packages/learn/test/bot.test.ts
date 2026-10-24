import { apply, legalCommands, newGame, viewFor, type GameState, type Seat, type TraceEvent } from '@keeps/engine';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encode } from '../src/actions.ts';
import { BotPlayer } from '../src/bot.ts';
import { RoundEnv } from '../src/env.ts';
import { Policy } from '../src/policy.ts';

const policy = Policy.load(readFileSync(new URL('../weights/bot.bin', import.meta.url)));

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('bot', () => {
  it('sees exactly what the training environment showed it', () => {
    // Player 0 is the bot; the environment computes the mover's observation at
    // every id, as training's self-play does. Every observation must match.
    let compared = 0;
    for (let g = 0; g < 30; g++) {
      const random = rng(g + 1);
      const env = RoundEnv.start(`bot-env-${g}`);
      const bot = new BotPlayer(policy, 0, random);
      let seen: Float32Array[] = [];
      bot.onObservation = (obs) => seen.push(obs);
      while (!env.terminal) {
        if (env.currentPlayer === 0) {
          seen = [];
          const command = bot.choose(env.state, env.events);
          const ids = encode(command, viewFor(env.state, 0));
          expect(seen).toHaveLength(ids.length);
          ids.forEach((id, i) => {
            expect(env.observation(0), `round ${g}: observation ${i} of the bot's move`).toEqual(seen[i]);
            env.step(id);
            compared++;
          });
        } else {
          env.observation(1);
          const legal = env.legalActions();
          env.step(legal[Math.floor(random() * legal.length)]!);
        }
      }
    }
    expect(compared).toBeGreaterThan(500);
  });

  it('suggests moves for a seat it advises: every legal command, ranked, probabilities summing to 1', () => {
    for (let g = 0; g < 4; g++) {
      const random = rng(300 + g);
      let { state, events } = newGame({ players: 2, seed: `advice-${g}`, marksToWin: 2 }) as { state: GameState; events: TraceEvent[] };
      const bot = new BotPlayer(policy, 2, random);
      const advisor = new BotPlayer(policy, 0);
      let advised = 0;
      for (let step = 0; state.phase !== 'game-over'; step++) {
        expect(step).toBeLessThan(5000);
        let seat: Seat;
        let command;
        if (bot.wantsToMove(state)) {
          seat = 2;
          command = bot.choose(state, events);
        } else if (advisor.wantsToMove(state)) {
          seat = 0;
          const advice = advisor.suggest(state, events);
          expect(advice.length).toBeGreaterThan(0);
          expect(advice.reduce((sum, a) => sum + a.probability, 0)).toBeCloseTo(1, 5);
          for (let i = 1; i < advice.length; i++) expect(advice[i]!.probability).toBeLessThanOrEqual(advice[i - 1]!.probability);
          const legal = legalCommands(state, 0).map((c) => JSON.stringify(c));
          // Every legal command is advised on (a pile reorder, which lists none, gets the network's own order).
          if (legal.length > 0) expect(advice.map((a) => JSON.stringify(a.command)).sort()).toEqual([...legal].sort());
          // The human follows the advice half the time, otherwise plays at random.
          command = random() < 0.5 ? advice[0]!.command : advice[Math.floor(random() * advice.length)]!.command;
          advised++;
        } else {
          seat = 0; // starting the next round
          command = legalCommands(state, 0)[0]!;
        }
        const result = apply(state, seat, command);
        if (!result.ok) throw new Error(result.error.message);
        state = result.state;
        events = [...events, ...result.events];
      }
      expect(advised).toBeGreaterThan(20);
    }
  });

  it('plays whole games of several rounds without trouble', () => {
    for (let g = 0; g < 6; g++) {
      const random = rng(100 + g);
      let { state, events } = newGame({ players: 2, seed: `bot-game-${g}`, marksToWin: 3 }) as { state: GameState; events: TraceEvent[] };
      const bot = new BotPlayer(policy, 2, random);
      for (let step = 0; state.phase !== 'game-over'; step++) {
        expect(step).toBeLessThan(5000);
        let seat: Seat;
        let command;
        if (bot.wantsToMove(state)) {
          seat = 2;
          command = bot.choose(state, events);
        } else {
          // The human (seat 0) plays randomly and starts the next round.
          seat = 0;
          const legal = legalCommands(state, 0);
          command = legal[Math.floor(random() * legal.length)]!;
        }
        const result = apply(state, seat, command);
        if (!result.ok) throw new Error(result.error.message);
        state = result.state;
        events = [...events, ...result.events];
      }
      expect(state.round).toBeGreaterThanOrEqual(3);
    }
  });

  it('beats a random player', () => {
    let wins = 0;
    const rounds = 100;
    for (let g = 0; g < rounds; g++) {
      const random = rng(1000 + g);
      const env = RoundEnv.start(`bot-strength-${g}`, { checked: false });
      const botPlayer = g % 2; // both seats
      const bot = new BotPlayer(policy, botPlayer === 0 ? 0 : 2, random);
      while (!env.terminal) {
        if (env.currentPlayer === botPlayer) {
          for (const id of encode(bot.choose(env.state, env.events), env.view(botPlayer))) env.step(id);
        } else {
          const legal = env.legalActions();
          env.step(legal[Math.floor(random() * legal.length)]!);
        }
      }
      if (env.returns()[botPlayer] === 1) wins++;
    }
    expect(wins / rounds).toBeGreaterThan(0.6);
  });
});
