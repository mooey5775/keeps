import { BOT_LEVELS, NAME_MAX, type BotLevel, type RoomSummary, type RoundReview } from '@keeps/protocol';
import { useEffect, useState } from 'react';
import { DisputeButton } from '../game/Dispute.tsx';
import { GameTable } from '../game/GameTable.tsx';
import { RoundReviewView } from '../game/RoundReview.tsx';
import { natoSpelling } from '@keeps/table';
import { browserToken, otherTabInRoom, roomStore, tabToken, useRoomState, type NetGame } from '../net/store.ts';
import { navigate } from '../router.ts';
import { rememberName, savedName } from './Home.tsx';

const LEVEL_NAMES: Record<BotLevel, string> = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

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
        <OnlineGame room={state.room} game={state.game} reviews={state.reviews} error={state.error} />
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
        className="join-form"
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
  const hostName = room.players.find((p) => p.host)?.name ?? 'the host';
  const link = `${location.origin}/r/${room.code}`;
  const [copied, setCopied] = useState(false);
  const count = room.players.length;
  const hasBot = room.players.some((p) => p.bot);
  // The bot only plays two-player games: no open seats to fill.
  const emptySeats = hasBot ? 0 : Math.max(0, 4 - count);
  const { marksToWin, firstPlayer } = room.settings;
  const botLevel = room.settings.botLevel ?? 'hard';
  const levels = hasBot && room.botLevels;
  const firstName = firstPlayer === 'random' ? null : (room.players.find((p) => p.id === firstPlayer.player)?.name ?? null);

  const copy = () => {
    void navigator.clipboard?.writeText(link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <main className="lobby">
      <section className="invite" aria-label="Invite friends">
        <div className="invite-code">
          <span className="invite-label">Room</span>
          <span className="room-code">{room.code}</span>
        </div>
        <p className="nato" aria-label={`Room code spelled out: ${natoSpelling(room.code)}`}>
          {natoSpelling(room.code)}
        </p>
        <div className="invite-link">
          <button type="button" onClick={copy}>
            {copied ? 'Copied ✓' : 'Copy invite link'}
          </button>
          <span className="invite-url">{link.replace(/^https?:\/\//, '')}</span>
        </div>
      </section>

      <section>
        <h3>
          Players <span className="count">{count} of {hasBot ? 2 : 4}</span>
        </h3>
        <ul className="players">
          {room.players.map((p) => (
            <li key={p.id}>
              <span className={`dot ${p.connected ? 'on' : 'off'}`} title={p.connected ? 'connected' : 'disconnected'} />
              {p.name}
              {p.bot && <span className="badge">bot</span>}
              {p.host && <span className="badge">host</span>}
              {p.id === room.you && <span className="badge">you</span>}
              {p.bot && host && (
                <button type="button" className="link remove-bot" onClick={() => roomStore.send({ t: 'remove-bot' })}>
                  remove
                </button>
              )}
            </li>
          ))}
          {Array.from({ length: emptySeats }, (_, i) => (
            <li key={`empty-${i}`} className="empty-seat">
              <span className="dot" />
              Open seat
            </li>
          ))}
        </ul>
        {host && room.botAvailable && !hasBot && count === 1 && (
          <button type="button" onClick={() => roomStore.send({ t: 'add-bot' })}>
            Add the bot
          </button>
        )}
        {hasBot && <p className="hint">The bot only plays two-player games.{count > 2 ? ' Remove it, or one of the others must leave, to start.' : ''}</p>}
      </section>

      <section>
        <h3>Game</h3>
        {host ? (
          <div className="settings">
            {levels && (
              <label>
                Difficulty{' '}
                <select value={botLevel} onChange={(e) => roomStore.settings({ ...room.settings, botLevel: e.target.value as BotLevel })}>
                  {BOT_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {LEVEL_NAMES[level]}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Marks to win{' '}
              <select value={marksToWin} onChange={(e) => roomStore.settings({ ...room.settings, marksToWin: Number(e.target.value) })}>
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
                value={firstPlayer === 'random' ? 'random' : firstPlayer.player}
                onChange={(e) => roomStore.settings({ ...room.settings, firstPlayer: e.target.value === 'random' ? 'random' : { player: e.target.value } })}
              >
                <option value="random">Random</option>
                {room.players.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.id === room.you ? ' (you)' : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : (
          <p className="settings-summary">
            {levels && `${LEVEL_NAMES[botLevel]} · `}First to {marksToWin} {marksToWin === 1 ? 'mark' : 'marks'} wins · {firstName ? `${firstName} goes first` : 'random first player'}
          </p>
        )}
        <p className="hint">Seats are random. With fewer than four players, the empty seats keep their piles as “ghosts”.</p>
      </section>

      <section className="lobby-start">
        {host ? (
          <>
            <button type="button" className="primary" disabled={count < 2 || count > 4 || (hasBot && count !== 2)} onClick={() => roomStore.send({ t: 'start' })}>
              Start the game
            </button>
            {count < 2 && <p className="hint">Waiting for at least one more player to join.</p>}
            {count > 4 && <p className="hint">Keeps is for at most four players.</p>}
          </>
        ) : (
          <p>Waiting for {hostName} to start the game.</p>
        )}
        {error && <p className="error">{error.message}</p>}
      </section>

      <button
        type="button"
        className="link leave"
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

function OnlineGame({
  room,
  game,
  reviews,
  error,
}: {
  room: RoomSummary;
  game: NetGame;
  reviews: RoundReview[];
  error: { id: number; message: string } | null;
}) {
  const me = room.players.find((p) => p.id === room.you);
  // Games against the bot: each finished round's review, opened from the side panel.
  const [reviewing, setReviewing] = useState<number | null>(null);
  const open = reviews.find((r) => r.round === reviewing) ?? null;
  const roundOver = game.view.phase === 'round-over' || game.view.phase === 'game-over';
  const { undo } = game;
  const proposer = room.players.find((p) => p.id === undo.proposedBy);
  const mustVote = undo.waitingOn.includes(room.you);
  // Training mode: only for a seated player in a game against the bot.
  const bot = room.players.find((p) => p.bot);
  const canTrain = bot !== undefined && me?.seat !== null && me?.seat !== undefined;

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
        {game.view.phase !== 'game-over' && me?.seat !== null && me?.seat !== undefined && (
          <button
            type="button"
            onClick={() => {
              if (window.confirm('Resign this game? You give it up: with one other player left, they win it; otherwise this round ends with no winner, and the game goes on without you.')) {
                roomStore.command({ type: 'resign' });
              }
            }}
          >
            Resign…
          </button>
        )}
        {game.view.phase === 'game-over' && me?.host && (
          <button type="button" className="primary" onClick={() => roomStore.send({ t: 'back-to-lobby' })}>
            Back to lobby
          </button>
        )}
      </div>
      {canTrain && (
        <div className="training-switch">
          <button type="button" className={room.training ? 'primary' : ''} aria-pressed={room.training === true} onClick={() => roomStore.setTraining(!room.training)}>
            Training mode: {room.training ? 'on' : 'off'}
          </button>
          <span className="hint">{room.training ? `Showing what ${bot.name} would play in your seat.` : `See what ${bot.name} would play in your seat.`}</span>
        </div>
      )}
      {reviews.length > 0 && (
        <div className="review-links">
          {[...reviews].reverse().map((r) => (
            <button
              key={r.round}
              type="button"
              className={roundOver && r.round === game.view.round ? 'primary' : ''}
              onClick={() => setReviewing(r.round)}
            >
              Round {r.round} review{r.pending > 0 ? ' (filling in…)' : ''}
            </button>
          ))}
        </div>
      )}
      <DisputeButton
        context={() => {
          const token = tabToken(room.code) ?? browserToken(room.code);
          return token ? { mode: 'online', room: room.code, token } : null;
        }}
      />
    </div>
  );

  return (
    <>
      <GameTable
        view={game.view}
        log={game.log}
        names={game.names}
        botSeats={room.players.flatMap((p) => (p.bot && p.seat !== null ? [p.seat] : []))}
        onCommand={(command) => roomStore.command(command)}
        hints={room.training ? game.hints : null}
        side={side}
        header={
          <div className="table-header">
            <span>
              Room <span className="room-code">{room.code}</span> <span className="nato inline">({natoSpelling(room.code)})</span>
              {game.view.viewer === 'spectator' && ' · watching'}
            </span>
            <span className="players-inline">
              {room.players.map((p) => (
                <span key={p.id} className={p.connected ? '' : 'offline'} title={p.bot ? 'bot' : p.connected ? 'connected' : 'disconnected'}>
                  {p.name}
                  {p.bot && <span className="badge">bot</span>}
                </span>
              ))}
            </span>
          </div>
        }
      />
      {open && <RoundReviewView review={open} names={game.names} onClose={() => setReviewing(null)} />}
    </>
  );
}
