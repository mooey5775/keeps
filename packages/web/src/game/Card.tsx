import { CARDS, type CardId } from '@keeps/engine';
import { createContext, useContext, useState, type ReactNode } from 'react';

// Card images, plus a shared hover preview so small cards stay readable.

const imageBase = (id: CardId) => CARDS[id].image.replace(/\.png$/, '');
export const cardImage = (id: CardId) => `/cards/${imageBase(id)}.webp`;
export const CARD_BACK = '/cards/Card_Back.webp';

const PreviewContext = createContext<(id: CardId | null) => void>(() => {});

export function PreviewProvider({ children }: { children: ReactNode }) {
  const [preview, setPreview] = useState<CardId | null>(null);
  return (
    <PreviewContext.Provider value={setPreview}>
      {children}
      {preview && (
        <div className="card-preview" aria-hidden>
          <img src={cardImage(preview)} alt="" />
        </div>
      )}
    </PreviewContext.Provider>
  );
}

export interface CardProps {
  id?: CardId | null;
  /** Shows the card back (with `id`, only you can see it is this card). */
  faceDown?: boolean;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  clickable?: boolean;
  picked?: boolean;
  onClick?: () => void;
  label?: string;
}

export function Card({ id, faceDown = false, size = 'sm', clickable = false, picked = false, onClick, label }: CardProps) {
  const setPreview = useContext(PreviewContext);
  const known = id ?? null;
  const showFace = known !== null && !faceDown;
  const classes = ['card', `card-${size}`, clickable && 'clickable', picked && 'picked', faceDown && 'face-down']
    .filter(Boolean)
    .join(' ');
  const title = label ?? (known ? `${CARDS[known].name}${faceDown ? ' (face down)' : ''}` : 'Face-down card');
  return (
    <button
      type="button"
      className={classes}
      onClick={onClick}
      disabled={!onClick}
      title={title}
      aria-label={title}
      aria-pressed={picked || undefined}
      onMouseEnter={() => known && setPreview(known)}
      onMouseLeave={() => setPreview(null)}
    >
      <img src={showFace ? cardImage(known) : CARD_BACK} alt="" draggable={false} />
      {faceDown && known && <span className="peek">{CARDS[known].name}</span>}
    </button>
  );
}
