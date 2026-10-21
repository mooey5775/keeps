import {
  apply,
  eventsFor,
  PUZZLES,
  puzzleById,
  puzzleOutcome,
  puzzleState,
  viewFor,
  YOU,
  type Command,
  type GameState,
  type Puzzle,
  type Seat,
  type TraceEvent,
} from '@keeps/engine';
import { useMemo, useState } from 'react';
import { GameTable } from '../game/GameTable.tsx';
import { navigate } from '../router.ts';

// The official puzzles, played against the engine in the browser. Each starts
// on your turn and must end with you winning the round. When an opponent has
// a decision (Retribution, a forced turn), you make it for them, so try to
// stop yourself.

const SOLVED_KEY = 'keeps:puzzles:solved';
const NAMES = ['You', 'Left player', 'Upper player', 'Right player'];

function solvedSet(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SOLVED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function markSolved(id: string): void {
  try {
    localStorage.setItem(SOLVED_KEY, JSON.stringify([...solvedSet(), id]));
  } catch {
    // ignore
  }
}

export function Puzzles({ id }: { id: string | null }) {
  const puzzle = id ? puzzleById(id) : undefined;
  if (puzzle) return <PuzzlePlayer key={puzzle.id} puzzle={puzzle} />;
  const solved = solvedSet();
  return (
    <main className="home puzzles">
      <h2>Puzzles</h2>
      <p>
        From <a href="https://www.keepsgame.com/puzzles">keepsgame.com</a>. Each starts on your turn, with two actions, and
        must end with you winning the round.
      </p>
      <ol className="puzzle-list">
        {PUZZLES.map((p) => (
          <li key={p.id}>
            <button type="button" className="link" onClick={() => navigate(`/puzzles/${p.id}`)}>
              {p.title}
            </button>{' '}
            <span className={`difficulty ${p.difficulty}`}>{p.difficulty}</span>
            {solved.has(p.id) && <span className="badge">solved</span>}
          </li>
        ))}
      </ol>
      <button type="button" className="link" onClick={() => navigate('/')}>
        Back home
      </button>
    </main>
  );
}

function PuzzlePlayer({ puzzle }: { puzzle: Puzzle }) {
  const [state, setState] = useState<GameState>(() => puzzleState(puzzle));
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [showSolution, setShowSolution] = useState(false);
  const startTurn = useMemo(() => puzzleState(puzzle).turnNumber, [puzzle]);

  const outcome = puzzleOutcome(state, startTurn);
  const decider: Seat = state.prompts[0]?.seat ?? YOU;
  // A puzzle is a single round: once it's decided, offer no more moves (not
  // even "start the next round"); the side panel offers restart and next puzzle.
  const view = useMemo(() => {
    const full = viewFor(state, decider);
    return outcome === 'playing' ? full : { ...full, legal: [] };
  }, [state, decider, outcome]);
  const index = PUZZLES.indexOf(puzzle);
  const next = PUZZLES[index + 1];

  const restart = () => {
    setState(puzzleState(puzzle));
    setEvents([]);
  };
  const onCommand = (command: Command) => {
    if (outcome !== 'playing') return;
    const result = apply(state, decider, command);
    if (!result.ok) return;
    setState(result.state);
    setEvents([...events, ...result.events]);
    if (puzzleOutcome(result.state, startTurn) === 'won') markSolved(puzzle.id);
  };

  const side = (
    <div className="puzzle-side">
      <p className="puzzle-text">{puzzle.text}</p>
      {puzzle.adaptation && <p className="hint">Note: {puzzle.adaptation}</p>}
      {decider !== YOU && outcome === 'playing' && (
        <p className="banner inline">You are deciding for the {NAMES[decider]!.toLowerCase()}. Try to stop yourself!</p>
      )}
      {outcome === 'won' && <p className="win">Solved! You win the round.</p>}
      {outcome === 'lost' && <p className="error">Not this time: the round didn’t end with you winning.</p>}
      <div className="row">
        <button type="button" onClick={restart}>
          Restart
        </button>
        <button type="button" onClick={() => setShowSolution(!showSolution)}>
          {showSolution ? 'Hide solution' : 'Show solution'}
        </button>
        {next && (
          <button type="button" className={outcome === 'won' ? 'primary' : ''} onClick={() => navigate(`/puzzles/${next.id}`)}>
            Next puzzle
          </button>
        )}
      </div>
      {showSolution && <p className="solution">{puzzle.solution}</p>}
    </div>
  );

  return (
    <GameTable
      view={view}
      log={eventsFor(events, 'server')}
      names={NAMES}
      bottom={YOU}
      onCommand={onCommand}
      side={side}
      header={
        <div className="table-header">
          <span>
            Puzzle {index + 1}: <strong>{puzzle.title}</strong> <span className={`difficulty ${puzzle.difficulty}`}>{puzzle.difficulty}</span>
          </span>
          <button type="button" className="link" onClick={() => navigate('/puzzles')}>
            All puzzles
          </button>
        </div>
      }
    />
  );
}
