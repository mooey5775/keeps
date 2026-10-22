import { apply, eventsFor, newGame, viewFor, type Command, type GameState, type ReplayLog, type Seat, type TraceEvent } from '@keeps/engine';
import { useMemo, useState } from 'react';
import { DisputeButton } from '../game/Dispute.tsx';
import { GameTable } from '../game/GameTable.tsx';
import { navigate } from '../router.ts';

// Pass-and-play on one device: the engine runs in the browser, and the table
// shows whoever has a decision to make, behind a "pass the device" curtain.
// When the decision moves to someone else, the player who just acted keeps
// seeing their cards (read-only) until they hand the device over, so they can
// see what their last move did (the card they drew, say).

interface Local {
  state: GameState;
  events: TraceEvent[];
  names: (string | null)[];
  /** The game's options and moves, for a rule dispute to reproduce it. */
  log: ReplayLog;
}

function start(players: 2 | 3 | 4, names: string[]): Local {
  const options = { players, seed: crypto.randomUUID(), marksToWin: 3 };
  const { state, events } = newGame(options);
  const seats = state.config.seats.flatMap((kind, seat) => (kind === 'player' ? [seat] : []));
  const bySeat: (string | null)[] = [null, null, null, null];
  seats.forEach((seat, i) => (bySeat[seat] = names[i] ?? `Player ${i + 1}`));
  return { state, events, names: bySeat, log: { options, commands: [] } };
}

/** Who should be looking at the screen: whoever must decide something. */
function decider(state: GameState): Seat {
  return state.prompts[0]?.seat ?? state.turn?.seat ?? state.startingSeat ?? 0;
}

export function Hotseat() {
  const [game, setGame] = useState<Local | null>(null);
  const [setup, setSetup] = useState(['', '']);
  /** Whose cards are on screen; null behind the curtain. */
  const [shown, setShown] = useState<Seat | null>(null);

  const seat = game ? decider(game.state) : 0;
  const over = game?.state.phase === 'round-over' || game?.state.phase === 'game-over';
  // Someone else must decide now, but the last player hasn't handed over yet.
  const reviewing = shown !== null && shown !== seat && !over;
  const viewer = reviewing ? shown : seat;
  const view = useMemo(() => {
    if (!game) return null;
    const full = viewFor(game.state, viewer);
    return reviewing ? { ...full, legal: [] } : full;
  }, [game, viewer, reviewing]);

  if (!game || !view) {
    return (
      <main className="home">
        <h2>Pass and play</h2>
        <p>Everyone plays on this device, passing it around. Each player only sees their own hand.</p>
        {setup.map((name, i) => (
          <label key={i} className="field">
            <span>Player {i + 1}</span>
            <input value={name} onChange={(e) => setSetup(setup.map((n, j) => (j === i ? e.target.value : n)))} />
          </label>
        ))}
        <div className="row">
          <button type="button" disabled={setup.length >= 4} onClick={() => setSetup([...setup, ''])}>
            Add player
          </button>
          <button type="button" disabled={setup.length <= 2} onClick={() => setSetup(setup.slice(0, -1))}>
            Remove player
          </button>
        </div>
        <button
          type="button"
          className="primary"
          onClick={() => setGame(start(setup.length as 2 | 3 | 4, setup.map((n, i) => n.trim() || `Player ${i + 1}`)))}
        >
          Start
        </button>
        <button type="button" className="link" onClick={() => navigate('/')}>
          Back home
        </button>
      </main>
    );
  }

  const onCommand = (command: Command) => {
    const result = apply(game.state, seat, command);
    if (!result.ok) return alert(result.error.message);
    // A new round starts behind the curtain, for whoever goes first.
    if (command.type === 'next-round') setShown(null);
    setGame({
      ...game,
      state: result.state,
      events: [...game.events, ...result.events],
      log: { ...game.log, commands: [...game.log.commands, { seat, command }] },
    });
  };

  if (shown === null && !over) {
    return (
      <main className="home curtain">
        <h2>Pass to {game.names[seat]}</h2>
        <button type="button" className="primary" onClick={() => setShown(seat)}>
          I’m {game.names[seat]}: show my cards
        </button>
      </main>
    );
  }

  return (
    <GameTable
      view={view}
      log={eventsFor(game.events, viewer)}
      names={game.names}
      onCommand={onCommand}
      side={
        <>
          {reviewing && (
            <div className="handoff">
              <p>
                {game.state.turn?.seat === seat && game.state.prompts[0]?.kind === 'action' && view.frame?.kind === 'turn'
                  ? 'Your turn is over.'
                  : `${game.names[seat]} must decide now.`}
              </p>
              <button type="button" className="primary" onClick={() => setShown(null)}>
                Hide my cards and pass to {game.names[seat]}
              </button>
            </div>
          )}
          <DisputeButton context={() => ({ mode: 'hotseat', replay: game.log })} />
        </>
      }
      header={
        <div className="table-header">
          <span>Pass and play · {game.names[viewer]}’s view</span>
          <button type="button" className="link" onClick={() => setGame(null)}>
            Quit
          </button>
        </div>
      }
    />
  );
}
