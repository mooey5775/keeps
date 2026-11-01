import { coinsLabel, type Seat } from '@keeps/engine';
import type { RoundReview } from '@keeps/protocol';
import { useMemo, useState } from 'react';
import { logLines } from '@keeps/table';
import { makeNames, type Names } from '@keeps/table';

// After a round against the bot: your chance of winning it after every move (as it really was, as you
// could tell, as the bot could tell), and every decision of the round ranked by the bot, as training
// mode would have shown it, with each option played out with every card known.

const pct = (v: number | null) => (v === null ? '…' : `${Math.round(100 * v)}%`);

const VERDICTS: Record<NonNullable<RoundReview['decisions'][number]['verdict']>, { label: string; tone: string }> = {
  best: { label: 'Best', tone: 'good' },
  mistake: { label: 'Mistake', tone: 'warn' },
  'mistake-worked-out': { label: 'Mistake, worked out', tone: 'warn' },
  blunder: { label: 'Blunder', tone: 'bad' },
  unlucky: { label: 'Unlucky', tone: 'info' },
};

export function RoundReviewView({ review, names, onClose }: { review: RoundReview; names: (string | null)[]; onClose: () => void }) {
  const me = review.seat;
  const botSeat = ([0, 1, 2, 3] as Seat[]).find((s) => s !== me && names[s] !== null) ?? null;
  const bot = botSeat === null ? 'The bot' : (names[botSeat] ?? 'The bot');
  const logNames = useMemo(() => makeNames(names, 'spectator', me), [names, me]);
  const decisionAt = useMemo(() => new Map(review.decisions.map((d) => [d.move, d])), [review]);
  const mine = review.decisions.filter((d) => d.seat === me);
  const top = mine.filter((d) => d.options[0]?.played).length;
  const flags = (
    [
      ['blunder', 'blunder', 'blunders'],
      ['mistake', 'mistake', 'mistakes'],
      ['mistake-worked-out', 'mistake that worked out', 'mistakes that worked out'],
      ['unlucky', 'unlucky move', 'unlucky moves'],
    ] as const
  ).flatMap(([v, one, many]) => {
    const n = mine.filter((d) => d.verdict === v).length;
    return n ? [`${n} ${n === 1 ? one : many}`] : [];
  });
  const turns = useMemo(() => {
    const out: { turn: number; seat: Seat; moves: number[] }[] = [];
    review.moves.forEach((m, i) => {
      const last = out.at(-1);
      if (last && last.turn === m.turn) last.moves.push(i);
      else out.push({ turn: m.turn, seat: m.seat, moves: [i] });
    });
    return out;
  }, [review]);
  const myScore = review.scores[me] ?? 0;
  const theirScore = botSeat === null ? null : review.scores[botSeat];
  // Scores are kept in half-coins.
  const coins = (n: number) => `${n < 0 ? '−' : ''}${coinsLabel(Math.abs(n))}`;
  const result =
    review.winner === me ? 'You won' : review.winner === null ? 'Nobody won' : `${bot} won`;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal review" role="dialog" aria-label={`Round ${review.round} review`} onClick={(e) => e.stopPropagation()}>
        <header className="review-head">
          <h3>Round {review.round} review</h3>
          <span className={review.winner === me ? 'won' : 'lost'}>
            {result}
            {theirScore !== null && theirScore !== undefined && `, ${coins(myScore)} coins to ${coins(theirScore)}`}
          </span>
          <button type="button" className="close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        {review.pending > 0 && <p className="review-pending">{bot} is still working through the round. This fills in as it goes.</p>}
        {mine.length > 0 && (
          <p>
            You played {bot}'s first choice at {top} of your {mine.length} decisions
            {flags.length > 0 && ` (${flags.join(', ')})`}.
          </p>
        )}
        <Chart review={review} bot={bot} logNames={logNames} />
        <p className="note">
          At each decision, the options as {bot} ranked them from what the deciding player knew, with each one's chance of winning the round for that
          player: as they could tell, and played out with every card known. By each turn: your chance at its end, as it really was, as you could tell, and
          as {bot} could tell.
        </p>
        {turns.map((t) => {
          const end = review.moves[t.moves.at(-1)!]!;
          return (
            <section key={`${t.turn}-${t.moves[0]}`} className={`review-turn ${t.seat === me ? 'mine' : 'theirs'}`}>
              <header>
                <h4>
                  Turn {t.turn} · {t.seat === me ? 'You' : bot}
                </h4>
                <span className="review-nums">
                  <span className="truth">{pct(end.truth)}</span> · <span className="you">{pct(end.mine)}</span> · <span className="bot">{pct(end.theirs)}</span>
                </span>
              </header>
              {t.moves.map((i) => {
                const d = decisionAt.get(i);
                return (
                  <div key={i} className="review-move">
                    {d && <Ranking decision={d} mine={d.seat === me} bot={bot} />}
                    {logLines(review.moves[i]!.events, logNames)
                      .filter((l) => !l.heading)
                      .map((l) => (
                        <p key={l.seq} className="review-line" style={{ paddingLeft: `${0.9 * Math.max(0, l.depth - 1)}em` }}>
                          {l.text}
                        </p>
                      ))}
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** One decision: the top three options as the bot ranked them, and the move played if it isn't among them. */
function Ranking({ decision, mine, bot }: { decision: RoundReview['decisions'][number]; mine: boolean; bot: string }) {
  const [open, setOpen] = useState(false);
  const opts = decision.options;
  const played = opts.find((o) => o.played);
  const shown = open ? opts : [...opts.slice(0, 3), ...(played && !opts.slice(0, 3).includes(played) ? [played] : [])];
  const verdict = mine && decision.verdict ? VERDICTS[decision.verdict] : null;
  return (
    <div className={`training review-rank${mine ? '' : ' theirs'}`}>
      <div className="review-rank-head">
        <span>{mine ? `${bot} would play` : `${bot} ranked its options`}</span>
        {verdict && <span className={`chip ${verdict.tone}`}>{verdict.label}</span>}
      </div>
      <ol>
        <li className="cols">
          <span />
          <span />
          <span>{mine ? 'you knew' : 'it knew'}</span>
          <span>all cards</span>
        </li>
        {shown.map((o) => (
          <li key={o.label} className={o.played ? 'played' : ''}>
            <span className="rank">{opts.indexOf(o) + 1}</span>
            <span className="opt">
              {o.label}
              {o.played && <span className="tag">{mine ? 'you played' : 'played'}</span>}
            </span>
            <span className="num">{pct(o.known)}</span>
            <span className="num muted">{pct(o.truth)}</span>
          </li>
        ))}
      </ol>
      {opts.length > shown.length && (
        <button type="button" className="link" onClick={() => setOpen(true)}>
          {opts.length - shown.length} more
        </button>
      )}
    </div>
  );
}

/** Your chance of winning the round after every move: as it really was, as you could tell, as the bot could tell. */
function Chart({ review, bot, logNames }: { review: RoundReview; bot: string; logNames: Names }) {
  const [at, setAt] = useState<number | null>(null);
  const moves = review.moves;
  if (moves.length < 2) return null;
  const W = 860, H = 280, L = 44, R = 12, T = 12, B = 30;
  const x = (i: number) => L + (i / (moves.length - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - v) * (H - T - B);
  const line = (key: 'truth' | 'mine' | 'theirs') => {
    // Gaps where a value isn't worked out yet.
    let d = '';
    let pen = false;
    moves.forEach((m, i) => {
      const v = m[key];
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const turnStarts = moves.flatMap((m, i) => (i === 0 || moves[i - 1]!.turn !== m.turn ? [i] : []));
  const pick = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((((e.clientX - box.left) / box.width) * W - L) / (W - L - R)) * (moves.length - 1));
    setAt(Math.max(0, Math.min(moves.length - 1, i)));
  };
  return (
    <div className="review-chart">
      <div className="legend">
        <span>
          <i className="key truth" />
          Your real chance (every card known)
        </span>
        <span>
          <i className="key you" />
          As you could tell
        </span>
        <span>
          <i className="key bot" />
          As {bot} could tell
        </span>
      </div>
      <div className="review-plot">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Your chance of winning the round after every move" onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => setAt(null)}>
          {[0, 0.25, 0.5, 0.75, 1].map((v) => (
            <g key={v}>
              <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className={v === 0.5 ? 'mid' : 'grid'} />
              <text x={L - 8} y={y(v) + 4} textAnchor="end">
                {v * 100}%
              </text>
            </g>
          ))}
          {turnStarts.map((i) => (
            <text key={i} x={x(i)} y={H - 10} textAnchor="middle">
              {moves[i]!.turn}
            </text>
          ))}
          <path d={line('theirs')} className="bot" />
          <path d={line('mine')} className="you" />
          <path d={line('truth')} className="truth" />
          {at !== null && (
            <g>
              <line x1={x(at)} x2={x(at)} y1={T} y2={H - B} className="cursor" />
              {(['theirs', 'mine', 'truth'] as const).map((key) => {
                const v = moves[at]![key];
                return v === null ? null : <circle key={key} cx={x(at)} cy={y(v)} r={4.5} className={`dot ${key === 'truth' ? 'truth' : key === 'mine' ? 'you' : 'bot'}`} />;
              })}
            </g>
          )}
        </svg>
        {at !== null && <ChartTip review={review} at={at} bot={bot} logNames={logNames} left={x(at) / W} />}
      </div>
    </div>
  );
}

/** What the hovered move was and did, the three chances after it and how each moved, and the decision it made. */
function ChartTip({ review, at, bot, logNames, left }: { review: RoundReview; at: number; bot: string; logNames: Names; left: number }) {
  const me = review.seat;
  const move = review.moves[at]!;
  const before = at > 0 ? review.moves[at - 1]! : null;
  const lines = logLines(move.events, logNames).filter((l) => !l.heading);
  const decision = review.decisions.find((d) => d.move === at);
  const change = (key: 'truth' | 'mine' | 'theirs') => {
    const now = move[key];
    const was = before?.[key] ?? null;
    if (now === null || was === null) return null;
    const d = Math.round(100 * (now - was));
    return d === 0 ? null : <span className={d > 0 ? 'up' : 'down'}>{d > 0 ? `+${d}` : `−${-d}`}</span>;
  };
  const mine = decision?.seat === me;
  const played = decision?.options.find((o) => o.played);
  const first = decision?.options[0];
  const verdict = mine && decision?.verdict ? VERDICTS[decision.verdict] : null;
  const both = (o: { known: number | null; truth: number | null }) =>
    `${mine ? 'Your' : 'Its'} chance: ${pct(o.known)} as ${mine ? 'you' : 'it'} knew · ${pct(o.truth)} with every card`;
  return (
    <div className={`review-tip${left > 0.55 ? ' flip' : ''}`} style={left > 0.55 ? { right: `${(1 - left) * 100 + 1.5}%` } : { left: `${left * 100 + 1.5}%` }}>
      <p className="tip-head">
        Turn {move.turn} · {move.seat === me ? 'You' : bot}
        {verdict && <span className={`chip ${verdict.tone}`}>{verdict.label}</span>}
      </p>
      {lines.length > 0 && (
        <ul className="tip-log">
          {lines.slice(0, 5).map((l) => (
            <li key={l.seq}>{l.text}</li>
          ))}
          {lines.length > 5 && <li>…</li>}
        </ul>
      )}
      {decision && played && (
        <div className="tip-decision">
          <p>
            {mine ? 'You played' : `${bot} played`}: <strong>{played.label}</strong>
            <span className="tip-nums">{both(played)}</span>
          </p>
          {mine && first && first !== played && (
            <p>
              {bot} would play: <strong>{first.label}</strong>
              <span className="tip-nums">{both(first)}</span>
            </p>
          )}
        </div>
      )}
      <table className="tip-values">
        <tbody>
          <tr>
            <th>
              <i className="key truth" />
              Your real chance
            </th>
            <td>{pct(move.truth)}</td>
            <td>{change('truth')}</td>
          </tr>
          <tr>
            <th>
              <i className="key you" />
              As you could tell
            </th>
            <td>{pct(move.mine)}</td>
            <td>{change('mine')}</td>
          </tr>
          <tr>
            <th>
              <i className="key bot" />
              As {bot} could tell
            </th>
            <td>{pct(move.theirs)}</td>
            <td>{change('theirs')}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
