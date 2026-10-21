import { apply, eventsFor, newGame, viewFor, type Command, type GameState, type Seat, type TraceEvent } from '@keeps/engine';
import { useMemo, useState } from 'react';
import { GameTable } from '../game/GameTable.tsx';
import { navigate } from '../router.ts';

// Pass-and-play on one device: the engine runs in the browser, and the table
// shows whoever has a decision to make, behind a "pass the device" curtain.

interface Local {
  state: GameState;
  events: TraceEvent[];
  names: (string | null)[];
}

function start(players: 2 | 3 | 4, names: string[]): Local {
  const { state, events } = newGame({ players, seed: crypto.randomUUID(), marksToWin: 3 });
  const seats = state.config.seats.flatMap((kind, seat) => (kind === 'player' ? [seat] : []));
  const bySeat: (string | null)[] = [null, null, null, null];
  seats.forEach((seat, i) => (bySeat[seat] = names[i] ?? `Player ${i + 1}`));
  return { state, events, names: bySeat };
}

/** Who should be looking at the screen: whoever must decide something. */
function decider(state: GameState): Seat {
  return state.prompts[0]?.seat ?? state.turn?.seat ?? state.startingSeat ?? 0;
}

export function Hotseat() {
  const [game, setGame] = useState<Local | null>(null);
  const [setup, setSetup] = useState(['', '']);
  const [shown, setShown] = useState<Seat | null>(null);

  const seat = game ? decider(game.state) : 0;
  const view = useMemo(() => (game ? viewFor(game.state, seat) : null), [game, seat]);

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
    setGame({ ...game, state: result.state, events: [...game.events, ...result.events] });
  };

  if (shown !== seat && game.state.phase !== 'round-over' && game.state.phase !== 'game-over') {
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
      log={eventsFor(game.events, seat)}
      names={game.names}
      onCommand={onCommand}
      header={
        <div className="table-header">
          <span>Pass and play · {game.names[seat]}’s view</span>
          <button type="button" className="link" onClick={() => setGame(null)}>
            Quit
          </button>
        </div>
      }
    />
  );
}
