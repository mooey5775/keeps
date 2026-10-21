import { CARDS, coinsLabel, type CardId, type Command, type PlayerView, type PromptView, type Seat, type TraceEvent } from '@keeps/engine';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Card } from './Card.tsx';
import { logLines } from './log.ts';
import { click, clickable, describeOptions, makeNames, narrow, type Option, type Ref } from './options.ts';
import { capital, headline, promptText } from './status.ts';

// The game table: four seats around the center, your hand at the bottom,
// and a side panel with what to do, the options, and the log. It only needs
// a view and a way to send commands, so it serves online games, hotseat
// games, and puzzles alike.

export interface GameTableProps {
  view: PlayerView;
  log: readonly TraceEvent[];
  /** Player names by seat (null for ghosts). */
  names: (string | null)[];
  onCommand: (command: Command) => void;
  /** Extra controls for the side panel (undo, leave, …). */
  side?: ReactNode;
  /** Shown above the board (room code, puzzle title, …). */
  header?: ReactNode;
  /** The seat drawn at the bottom of the table. Default: the viewer's. */
  bottom?: Seat;
}

type Position = 'bottom' | 'left' | 'top' | 'right';
const POSITIONS: Position[] = ['bottom', 'left', 'top', 'right'];

export function GameTable({ view, log, names, onCommand, side, header, bottom }: GameTableProps) {
  const me: Seat = view.viewer === 'spectator' ? 0 : view.viewer;
  const anchor = bottom ?? me;
  const uiNames = useMemo(() => makeNames(names, view.viewer), [names, view.viewer]);
  const logNames = useMemo(() => makeNames(names, 'spectator'), [names]);
  const options = useMemo(() => describeOptions(view, uiNames), [view, uiNames]);
  const [picked, setPicked] = useState<Ref[]>([]);
  const [showDiscard, setShowDiscard] = useState(false);

  // Any new decision clears a half-made selection.
  const optionsKey = JSON.stringify(view.legal);
  useEffect(() => {
    setPicked([]);
  }, [optionsKey]);

  const glow = clickable(options, picked);
  const send = (command: Command) => {
    setPicked([]);
    setShowDiscard(false);
    onCommand(command);
  };
  const onRef = (ref: Ref) => {
    const result = click(options, picked, ref);
    if (result.kind === 'send') send(result.command);
    else if (result.kind === 'pick') setPicked(result.picked);
  };
  const ref = (r: Ref) => ({ clickable: glow.has(r), picked: picked.includes(r), onClick: glow.has(r) || picked.includes(r) ? () => onRef(r) : undefined });

  const seatAt = (position: Position) => ((anchor + POSITIONS.indexOf(position)) % 4) as Seat;
  const remaining = narrow(options, picked);
  const myPrompts = view.prompts.filter((p) => p.mine);
  const otherPrompts = view.prompts.filter((p) => !p.mine);
  const title = headline(view, uiNames);
  const discardChoices = options.some((o) => o.refs.some((r) => r.startsWith('discard:')));

  return (
    <div className="game">
      <div className="board-wrap">
        {header}
        <div className="board">
          {POSITIONS.map((position) => (
            <SeatArea key={position} seat={seatAt(position)} position={position} view={view} names={uiNames} refProps={ref} />
          ))}
          <div className="center">
            <div className="round-info">
              Round {view.round} · first to {view.marksToWin} {view.marksToWin === 1 ? 'mark' : 'marks'}
            </div>
            <div className="discard">
              <span className="label">Discard ({view.discard.length})</span>
              {view.discard.length > 0 ? (
                <Card
                  id={view.discard.at(-1)!}
                  size="sm"
                  clickable={discardChoices}
                  onClick={() => setShowDiscard(true)}
                  label="Show the discard pile"
                />
              ) : (
                <div className="empty-slot">empty</div>
              )}
            </div>
            {title && <div className="headline">{title}</div>}
          </div>
        </div>
        {view.viewer !== 'spectator' && (
          <div className="hand">
            <span className="label">{me === anchor ? 'Your hand' : `${capital(uiNames.possessive(me))} hand`}</span>
            <div className="hand-cards">
              {(view.hands[me]!.cards ?? []).map((card, i) => (
                <Card key={`${card}-${i}`} id={card} size="lg" {...ref(`hand:${card}`)} />
              ))}
              {(view.hands[me]!.cards ?? []).length === 0 && <div className="empty-slot">no cards</div>}
            </div>
          </div>
        )}
      </div>

      <aside className="side">
        <div className="status">
          {myPrompts.map((p) => (
            <p key={p.id} className="you-decide">
              {promptText(p, view, uiNames)}
            </p>
          ))}
          {otherPrompts.map((p) => (
            <p key={p.id} className="waiting">
              {promptText(p, view, uiNames)}
            </p>
          ))}
        </div>
        <OptionsPanel view={view} options={remaining} picked={picked} onSend={send} onClear={() => setPicked([])} />
        {side}
        <Log events={log} names={logNames} />
      </aside>

      {showDiscard && (
        <div className="overlay" onClick={() => setShowDiscard(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Discard pile (top last)</h3>
            <div className="card-grid">
              {view.discard.map((card, i) => (
                <Card key={`${card}-${i}`} id={card} size="md" {...ref(`discard:${card}`)} />
              ))}
            </div>
            <button type="button" onClick={() => setShowDiscard(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

type RefProps = (r: Ref) => { clickable: boolean; picked: boolean; onClick: (() => void) | undefined };

function SeatArea({ seat, position, view, names, refProps }: { seat: Seat; position: Position; view: PlayerView; names: ReturnType<typeof makeNames>; refProps: RefProps }) {
  const ghost = view.seats[seat] === 'ghost';
  const pile = view.piles[seat]!;
  const keep = view.keeps[seat]!;
  const hand = view.hands[seat]!;
  const active = view.prompts.some((p) => p.seat === seat);
  const player = refProps(`player:${seat}`);
  const pileRef = refProps(`pile:${seat}`);
  const keepRef = refProps(`keep:${seat}`);
  const score = view.scores[seat];
  const turn = view.turn?.seat === seat;

  return (
    <section className={`seat seat-${position}${active ? ' active' : ''}${ghost ? ' ghost' : ''}`}>
      <header>
        <button
          type="button"
          className={`seat-name${player.clickable ? ' clickable' : ''}${player.picked ? ' picked' : ''}`}
          disabled={!player.onClick}
          onClick={player.onClick}
        >
          {ghost ? 'Ghost pile' : capital(names.seat(seat))}
          {turn && <span className="turn-dot" title="Their turn" />}
        </button>
        {!ghost && (
          <span className="seat-stats">
            <span className="marks" title={`${view.marks[seat]} victory marks`}>
              {Array.from({ length: view.marksToWin }, (_, i) => (i < view.marks[seat] ? '●' : '○')).join('')}
            </span>
            <span className="coins" title="Coins in keep">
              {coinsLabel(score ?? 0)}¢
            </span>
            {position !== 'bottom' && (
              <span className="hand-count" title="Cards in hand">
                ✋{hand.count}
              </span>
            )}
          </span>
        )}
      </header>
      <div className="seat-row">
        <div className="pile" title={`${pile.size} cards`}>
          {pile.size === 0 ? (
            <button
              type="button"
              className={`empty-slot pile-empty${pileRef.clickable ? ' clickable' : ''}${pileRef.picked ? ' picked' : ''}`}
              disabled={!pileRef.onClick}
              onClick={pileRef.onClick}
              aria-label={`${capital(names.possessive(seat))} pile, empty`}
              title={`${capital(names.possessive(seat))} pile, empty`}
            >
              empty
            </button>
          ) : (
            <Card
              id={pile.top}
              faceDown={pile.top === null}
              size="sm"
              {...pileRef}
              label={`${capital(names.possessive(seat))} pile, ${pile.size} card${pile.size === 1 ? '' : 's'}${pile.top ? `, ${CARDS[pile.top].name} face up` : ''}`}
            />
          )}
          <span className="pile-count">{pile.size}</span>
        </div>
        {!ghost && (
          <div
            className={`keep${keepRef.clickable ? ' clickable' : ''}${keepRef.picked ? ' picked' : ''}`}
            onClick={keepRef.onClick}
            role={keepRef.onClick ? 'button' : undefined}
            aria-label={`${capital(names.possessive(seat))} keep`}
          >
            {keep.cards.length === 0 && <span className="keep-empty">keep</span>}
            {keep.cards.map((c, i) => {
              const r = refProps(`keepcard:${seat}:${i}`);
              return (
                <span key={i} onClick={(e) => r.onClick && e.stopPropagation()}>
                  <Card id={c.id ?? null} faceDown={c.faceDown} size="sm" {...r} />
                </span>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function OptionsPanel({ view, options, picked, onSend, onClear }: { view: PlayerView; options: Option[]; picked: Ref[]; onSend: (c: Command) => void; onClear: () => void }) {
  const order = view.prompts.find((p): p is Extract<PromptView, { kind: 'order-pile'; mine: true }> => p.mine && p.kind === 'order-pile');
  if (order) return <OrderPile prompt={order} onSend={onSend} />;
  if (options.length === 0) return null;
  return (
    <div className="options">
      {picked.length > 0 && (
        <button type="button" className="link" onClick={onClear}>
          ← Cancel selection
        </button>
      )}
      {options.map((o, i) => (
        <button key={i} type="button" className="option" onClick={() => onSend(o.command)}>
          {o.cards.map((c, j) => (
            <Card key={j} id={c} size="xs" />
          ))}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

function OrderPile({ prompt, onSend }: { prompt: Extract<PromptView, { kind: 'order-pile'; mine: true }>; onSend: (c: Command) => void }) {
  const [order, setOrder] = useState<CardId[]>(prompt.cards);
  const move = (i: number, by: number) => {
    const next = [...order];
    const [card] = next.splice(i, 1);
    next.splice(i + by, 0, card!);
    setOrder(next);
  };
  return (
    <div className="options order-pile">
      <p className="hint">Top of the pile first.</p>
      {order.map((card, i) => (
        <div key={card} className="order-row">
          <Card id={card} size="xs" />
          <span>{i + 1}.</span>
          <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
            ↑
          </button>
          <button type="button" disabled={i === order.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
            ↓
          </button>
        </div>
      ))}
      <button type="button" className="primary" onClick={() => onSend({ type: 'answer', promptId: prompt.id, answer: { kind: 'order-pile', order } })}>
        Confirm order
      </button>
    </div>
  );
}

function Log({ events, names }: { events: readonly TraceEvent[]; names: ReturnType<typeof makeNames> }) {
  const lines = useMemo(() => logLines(events, names), [events, names]);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [lines.length]);
  return (
    <div className="log">
      {lines.map((l) => (
        <div key={l.seq} className={l.heading ? 'log-heading' : 'log-line'} style={{ paddingLeft: `${l.depth * 0.8}em` }}>
          {l.text}
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}
