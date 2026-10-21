import type { Command, ReplayLog, Seat } from '@keeps/engine';
import { useState } from 'react';
import { clientId } from '../net/store.ts';
import { savedName } from '../screens/Home.tsx';

// Reporting a rule the engine got wrong. This is feedback for the site's
// maintainer, not a way to change the game in progress: the report carries the
// game's moves so the ruling can be reproduced and the engine fixed.

export type DisputeContext =
  | { mode: 'online'; room: string; token: string }
  | { mode: 'puzzle'; puzzle: string; commands: { seat: Seat; command: Command }[] }
  | { mode: 'hotseat'; replay: ReplayLog };

const TEXT_MAX = 4000;

export function DisputeButton({ context }: { context: () => DisputeContext | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="link dispute-link" onClick={() => setOpen(true)}>
        Think a rule was applied wrong? Tell the developer
      </button>
      {open && <DisputeForm context={context} onClose={() => setOpen(false)} />}
    </>
  );
}

function DisputeForm({ context, onClose }: { context: () => DisputeContext | null; onClose: () => void }) {
  const [text, setText] = useState('');
  const [contact, setContact] = useState('');
  const [status, setStatus] = useState<'editing' | 'sending' | 'sent'>('editing');
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    const ctx = context();
    if (!ctx) return setError('There’s no game to report on.');
    setStatus('sending');
    setError(null);
    try {
      const res = await fetch('/dispute', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, contact, name: savedName(), client: clientId(), context: ctx }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `The server said ${res.status}.`);
      setStatus('sent');
    } catch (e) {
      setStatus('editing');
      setError(e instanceof Error ? e.message : 'Couldn’t send the report.');
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal dispute" role="dialog" aria-labelledby="dispute-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="dispute-title">Report a rules problem to the developer</h3>
        {status === 'sent' ? (
          <>
            <p>Thanks! Your report and this game’s moves were sent to the developer.</p>
            <p className="hint">Your game carries on unchanged. If the engine is wrong, the fix applies to future games.</p>
            <button type="button" className="primary" onClick={onClose}>
              Back to the game
            </button>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) void send();
            }}
          >
            <div className="dispute-notice">
              <p>
                <strong>This won’t change the game you’re playing.</strong> The game continues with the engine’s ruling, and
                nobody else at the table is notified.
              </p>
              <p>
                It sends a note to the person who built this site, along with this game’s moves, so they can check the rules
                and fix the engine for future games. To redo a move now, use <em>Undo last move</em> instead (online games).
              </p>
            </div>
            <label className="field">
              <span>What happened, and what should the rules have done? Card names help.</span>
              <textarea
                value={text}
                maxLength={TEXT_MAX}
                rows={6}
                autoFocus
                onChange={(e) => setText(e.target.value)}
                placeholder="e.g. My opponent played Retribution after I stole Hocus Pocus, and I think…"
              />
            </label>
            <label className="field">
              <span>How to reach you, if you’d like a reply (optional)</span>
              <input value={contact} maxLength={200} onChange={(e) => setContact(e.target.value)} placeholder="email, Discord, …" />
            </label>
            {error && <p className="error">{error}</p>}
            <div className="row">
              <button type="submit" className="primary" disabled={!text.trim() || status === 'sending'}>
                {status === 'sending' ? 'Sending…' : 'Send to the developer'}
              </button>
              <button type="button" onClick={onClose}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
