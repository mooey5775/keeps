import { NAME_MAX } from '@keeps/protocol';
import { useEffect, useState } from 'react';
import { roomStore, useRoomState } from '../net/store.ts';
import { navigate } from '../router.ts';

const NAME_KEY = 'keeps:name';

export function savedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export function rememberName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // ignore
  }
}

export function Home() {
  const state = useRoomState();
  const [name, setName] = useState(savedName);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  // Once the server has put us in a room, go there.
  useEffect(() => {
    if (busy && state.status === 'open' && state.code) navigate(`/r/${state.code}`);
    if (busy && state.status === 'idle') setBusy(false);
  }, [busy, state.status, state.code]);

  const trimmed = name.trim();
  const create = () => {
    rememberName(trimmed);
    setBusy(true);
    roomStore.create(trimmed);
  };
  const join = () => {
    rememberName(trimmed);
    navigate(`/r/${code.trim().toUpperCase()}`);
  };

  return (
    <main className="home">
      <h1>KEEPS</h1>
      <p className="tagline">An elegant game, for two to four players.</p>

      <label className="field">
        <span>Your name</span>
        <input value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} placeholder="Name" autoFocus />
      </label>

      <div className="home-actions">
        <button type="button" className="primary" disabled={!trimmed || busy} onClick={create}>
          {busy ? 'Creating…' : 'Create a room'}
        </button>
        <form
          className="join"
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmed && code.trim().length === 4) join();
          }}
        >
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
            maxLength={4}
            placeholder="CODE"
            aria-label="Room code"
            className="code-input"
          />
          <button type="submit" disabled={!trimmed || code.length !== 4}>
            Join
          </button>
        </form>
      </div>
      {state.error && <p className="error">{state.error.message}</p>}

      <nav className="home-links">
        <button type="button" className="link" onClick={() => navigate('/hotseat')}>
          Pass-and-play on this device
        </button>
        <button type="button" className="link" onClick={() => navigate('/puzzles')}>
          Puzzles
        </button>
        <a className="link" href="https://www.keepsgame.com/how-to-play" target="_blank" rel="noreferrer">
          Rules
        </a>
      </nav>
      <p className="credit">Keeps is by David &amp; Elaina Buffkin. Card art © their respective owners.</p>
    </main>
  );
}
