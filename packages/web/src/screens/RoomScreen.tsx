import { NAME_MAX, type RoomSummary } from '@keeps/protocol';
import { useEffect, useState } from 'react';
import { GameTable } from '../game/GameTable.tsx';
import { natoSpelling } from '../game/nato.ts';
import { browserToken, otherTabInRoom, roomStore, tabToken, useRoomState, type NetGame } from '../net/store.ts';
import { navigate } from '../router.ts';
import { rememberName, savedName } from './Home.tsx';

export function RoomScreen({ code }: { code: string }) {
  const state = useRoomState();
  const here = state.code === code && (state.status === 'connecting' || state.status === 'open' || state.status === 'reconnecting');
  // How this tab gets into the room when it isn't in it yet.
  const [entry, setEntry] = useState<'checking' | 'other-tab' | 'join' | null>(null);

  useEffect(() => {
    if (here || state.status === 'gone' || state.status === 'replaced' || entry === 'join' || entry === 'other-tab') return;
    // This tab's own seat (e.g. after a reload): take it back.
    if (tabToken(code)) {
      roomStore.resume(code);
      return;
    }
    // No seat in this browser: join as a new player.
    if (!browserToken(code)) {
      setEntry('join');
      return;
    }
    // A seat from another tab: ask first if that tab is still using it.
    let cancelled = false;
    setEntry('checking');
    void otherTabInRoom(code).then((busy) => {
      if (cancelled) return;
      if (busy) setEntry('other-tab');
      else roomStore.resume(code);
    });
    return () => {
      cancelled = true;
    };
  }, [code, here, state.status, entry]);

  if (state.status === 'gone') {
    return (
      <main className="home">
        <h2>Room {code} is gone</h2>
        <p>It may have closed after everyone left.</p>
        <button type="button" className="primary" onClick={() => navigate('/')}>
          Back home
        </button>
      </main>
    );
  }
  if (state.status === 'replaced' && state.code === code) {
    return (
      <main className="home">
        <h2>You’re playing in another tab</h2>
        <p>Your seat in room {code} was opened in another tab or on another device, so this one stopped updating.</p>
        <div className="row">
          <button type="button" className="primary" onClick={() => roomStore.resume(code)}>
            Play in this tab instead
          </button>
          <button type="button" className="link" onClick={() => navigate('/')}>
            Back home
          </button>
        </div>
      </main>
    );
  }
  if (!here) {
    if (entry === 'other-tab') {
      return (
        <main className="home">
          <h2>Room {code} is open in another tab</h2>
          <p>This browser is already playing in this room in another tab.</p>
          <div className="row">
            <button type="button" className="primary" onClick={() => roomStore.resume(code)}>
              Play here instead
            </button>
            <button type="button" onClick={() => setEntry('join')}>
              Join as a new player
            </button>
          </div>
        </main>
      );
    }
    if (entry === 'join') return <JoinForm code={code} error={state.error?.message ?? null} />;
    return <main className="home">Connecting…</main>;
  }
  if (!state.room) return <main className="home">Connecting…</main>;

  return (
    <>
      {state.status === 'reconnecting' && <div className="banner">Connection lost. Reconnecting…</div>}
      {state.room.phase === 'lobby' || !state.game ? (
        <Lobby room={state.room} error={state.error} />
      ) : (
        <OnlineGame room={state.room} game={state.game} error={state.error} />
      )}
    </>
  );
}

function JoinForm({ code, error }: { code: string; error: string | null }) {
  const [name, setName] = useState(savedName);
  const trimmed = name.trim();
  return (
    <main className="home">
      <h2>Join room {code}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!trimmed) return;
          rememberName(trimmed);
          roomStore.join(code, trimmed);
        }}
      >
        <label className="field">
          <span>Your name</span>
          <input value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <button type="submit" className="primary" disabled={!trimmed}>
          Join
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      <button type="button" className="link" onClick={() => navigate('/')}>
        Back home
      </button>
    </main>
  );
}

function Lobby({ room, error }: { room: RoomSummary; error: { message: string } | null }) {
  const me = room.players.find((p) => p.id === room.you);
  const host = me?.host ?? false;
  const link = `${location.origin}/r/${room.code}`;
  const [copied, setCopied] = useState(false);
  const count = room.players.length;

  return (
    <main className="lobby">
      <h2>
        Room <span className="room-code">{room.code}</span>
      </h2>
      <p className="nato" aria-label={`Room code spelled out: ${natoSpelling(room.code)}`}>
        {natoSpelling(room.code)}
      </p>
      <p>
        Share this link:{' '}
        <button
          type="button"
          className="link"
          onClick={() => {
            void navigator.clipboard?.writeText(link).then(() => setCopied(true));
          }}
        >
          {link} {copied ? '✓ copied' : '(copy)'}
        </button>
      </p>

      <h3>Players ({count}/4)</h3>
      <ul className="players">
        {room.players.map((p) => (
          <li key={p.id}>
            <span className={`dot ${p.connected ? 'on' : 'off'}`} />
            {p.name}
            {p.host && <span className="badge">host</span>}
            {p.id === room.you && <span className="badge">you</span>}
          </li>
        ))}
      </ul>

      <h3>Settings</h3>
      <div className="settings">
        <label>
          Marks to win{' '}
          <select
            value={room.settings.marksToWin}
            disabled={!host}
            onChange={(e) => roomStore.settings({ ...room.settings, marksToWin: Number(e.target.value) })}
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          First player{' '}
          <select
            value={room.settings.firstPlayer}
            disabled={!host}
            onChange={(e) => roomStore.settings({ ...room.settings, firstPlayer: e.target.value as 'random' | 'host' })}
          >
            <option value="random">Random</option>
            <option value="host">The host</option>
          </select>
        </label>
      </div>

      {host ? (
        <button type="button" className="primary" disabled={count < 2 || count > 4} onClick={() => roomStore.send({ t: 'start' })}>
          {count < 2 ? 'Waiting for players…' : 'Start the game'}
        </button>
      ) : (
        <p>Waiting for the host to start the game.</p>
      )}
      {error && <p className="error">{error.message}</p>}
      <p className="hint">Seats are random. With fewer than four players, the empty seats keep their piles as “ghosts”.</p>
      <button
        type="button"
        className="link"
        onClick={() => {
          roomStore.leave();
          navigate('/');
        }}
      >
        Leave room
      </button>
    </main>
  );
}

function OnlineGame({ room, game, error }: { room: RoomSummary; game: NetGame; error: { id: number; message: string } | null }) {
  const me = room.players.find((p) => p.id === room.you);
  const { undo } = game;
  const proposer = room.players.find((p) => p.id === undo.proposedBy);
  const mustVote = undo.waitingOn.includes(room.you);

  const side = (
    <div className="room-controls">
      {error && (
        <p className="error" key={error.id}>
          {error.message}{' '}
          <button type="button" className="link" onClick={() => roomStore.dismissError()}>
            dismiss
          </button>
        </p>
      )}
      {undo.proposedBy && (
        <div className="undo-vote">
          <p>
            {proposer?.id === room.you ? 'You' : proposer?.name} asked to undo the last move.
            {!mustVote && undo.waitingOn.length > 0 && ` Waiting on ${undo.waitingOn.map((id) => room.players.find((p) => p.id === id)?.name).join(', ')}.`}
          </p>
          {mustVote && (
            <div className="row">
              <button type="button" className="primary" onClick={() => roomStore.send({ t: 'vote-undo', accept: true })}>
                Allow undo
              </button>
              <button type="button" onClick={() => roomStore.send({ t: 'vote-undo', accept: false })}>
                Refuse
              </button>
            </div>
          )}
        </div>
      )}
      <div className="row">
        {undo.available && (
          <button type="button" onClick={() => roomStore.send({ t: 'propose-undo' })}>
            Undo last move…
          </button>
        )}
        {game.view.phase === 'game-over' && me?.host && (
          <button type="button" className="primary" onClick={() => roomStore.send({ t: 'back-to-lobby' })}>
            Back to lobby
          </button>
        )}
      </div>
    </div>
  );

  return (
    <GameTable
      view={game.view}
      log={game.log}
      names={game.names}
      onCommand={(command) => roomStore.command(command)}
      side={side}
      header={
        <div className="table-header">
          <span>
            Room <span className="room-code">{room.code}</span> <span className="nato inline">({natoSpelling(room.code)})</span>
            {game.view.viewer === 'spectator' && ' · watching'}
          </span>
          <span className="players-inline">
            {room.players.map((p) => (
              <span key={p.id} className={p.connected ? '' : 'offline'} title={p.connected ? 'connected' : 'disconnected'}>
                {p.name}
              </span>
            ))}
          </span>
        </div>
      }
    />
  );
}
