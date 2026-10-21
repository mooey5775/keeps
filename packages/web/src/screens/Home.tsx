import { NAME_MAX } from '@keeps/protocol';
import { useEffect, useState } from 'react';
import { roomStore, useRoomState } from '../net/store.ts';
import { navigate } from '../router.ts';

const NAME_KEY = 'keeps:name';

export const KEEPS_SITE = 'https://www.keepsgame.com';
// The buy link from keepsgame.com, with the creators' Amazon attribution tags
// kept, so sales through it are credited to them. Price as listed there (2026-10).
export const AMAZON_LINK =
  'https://www.amazon.com/Keeps-an-Elegant-Game/dp/B0H7TBLY5X?maas=maas_adg_FEBF1A30E62A19690ED26156C54DC749_afap_abs&ref_=aa_maas&tag=maas';

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
      <div className="buy-row">
        <a className="buy" href={AMAZON_LINK} target="_blank" rel="noreferrer">
          $9.99 on Amazon →
        </a>
        <a className="link" href={KEEPS_SITE} target="_blank" rel="noreferrer">
          keepsgame.com
        </a>
      </div>

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
      <p className="credit">
        Keeps is by{' '}
        <a href={KEEPS_SITE} target="_blank" rel="noreferrer">
          David &amp; Elaina Buffkin
        </a>
        . Card art © their respective owners. Get your own copy to play at the table.
      </p>
    </main>
  );
}
