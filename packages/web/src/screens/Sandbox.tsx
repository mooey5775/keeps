import { apply, eventsFor, viewFor, type Command, type GameState, type Seat, type TraceEvent } from '@keeps/engine';
import { useMemo, useState } from 'react';
import { GameTable } from '../game/GameTable.tsx';
import { SANDBOX_NAMES, SCENARIOS, scenarioState, type Scenario } from '@keeps/table';
import { navigate } from '../router.ts';

// Unlisted: fixed positions for looking at (and screenshotting) each kind of
// decision on the real table. Moves can be made; whoever must decide is shown.

export function Sandbox({ name }: { name: string | null }) {
  const scenario = SCENARIOS.find((s) => s.name === name);
  if (scenario) return <ScenarioTable key={scenario.name} scenario={scenario} />;
  return (
    <main className="home">
      <h2>Sandbox</h2>
      <ul>
        {SCENARIOS.map((s) => (
          <li key={s.name}>
            <button type="button" className="link" onClick={() => navigate(`/sandbox/${s.name}`)}>
              {s.title}
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}

function ScenarioTable({ scenario }: { scenario: Scenario }) {
  const [state, setState] = useState<GameState>(() => scenarioState(scenario));
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const seat: Seat = state.prompts[0]?.seat ?? state.turn?.seat ?? 0;
  const view = useMemo(() => viewFor(state, seat), [state, seat]);
  const onCommand = (command: Command) => {
    const result = apply(state, seat, command);
    if (!result.ok) return;
    setState(result.state);
    setEvents([...events, ...result.events]);
  };
  return (
    <GameTable
      view={view}
      log={eventsFor(events, 'server')}
      names={SANDBOX_NAMES}
      onCommand={onCommand}
      header={
        <div className="table-header">
          <span>Sandbox · {scenario.title}</span>
          <button type="button" className="link" onClick={() => navigate('/sandbox')}>
            All scenarios
          </button>
        </div>
      }
    />
  );
}
