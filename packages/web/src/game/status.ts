import { CARDS, type PlayerView, type PromptView } from '@keeps/engine';
import type { Names } from './options.ts';

// One-line descriptions of what's happening: what you need to decide, or
// whom everyone is waiting on.

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function promptText(prompt: PromptView, view: PlayerView, names: Names): string {
  const who = names.seat(prompt.seat);
  if (!prompt.mine) return `Waiting for ${who}: ${othersPhrase(prompt.kind, view)}`;
  switch (prompt.kind) {
    case 'action': {
      const frame = view.frame;
      const n = frame?.remaining ?? 0;
      switch (frame?.kind) {
        case 'retribution':
          return `Retribution! Take ${plural(n, 'action')} now.`;
        case 'hocus-pocus':
          return `Hocus Pocus: ${plural(n, 'extra action')} left.`;
        case 'last-laugh':
          return 'Last Laugh: take one action before scoring, or pass.';
        default:
          return `Your turn: ${plural(n, 'action')} left.`;
      }
    }
    case 'hot-target':
      return `HOT! Choose a keep for ${CARDS[prompt.card].name}.`;
    case 'choose-pile':
      return {
        requisition: 'Requisition: choose a pile to look through.',
        prayer: 'Prayer: choose a pile to look at the top card of.',
        revelation: 'Revelation: choose a pile to flip upside down.',
        invocation: 'Invocation: choose a pile to draw from.',
      }[prompt.purpose];
    case 'choose-pile-card':
      return 'Requisition: take any card from this pile.';
    case 'choose-top-card':
      return 'Epiphany: take one of these top cards.';
    case 'take-or-discard':
      return `Prayer: take ${CARDS[prompt.card].name}, or discard it and draw the next card.`;
    case 'choose-discard-card':
      return 'Resurrection: take a card from the discard.';
    case 'choose-keep-pair':
      return 'Providence: choose two played Keep cards to swap.';
    case 'choose-direction':
      return 'Pandemonium: pass every pile left (on, in play order) or right (back).';
    case 'order-pile':
      return 'Tithes: put your pile in any order (top first).';
    case 'choose-player':
      return prompt.purpose === 'legerdemain'
        ? 'Legerdemain: choose a player to steal a random card from.'
        : 'Pickpocket: choose a player to take every Coin card from.';
    case 'choose-hand-card':
      return 'Pluck: take one card from another player’s hand.';
    case 'give-card':
      return `Offering: choose a card to give to ${names.seat(prompt.to)}.`;
    case 'joker-copy':
      return 'Joker: choose a card in your hand to reveal and copy.';
    case 'claim-pile':
      return prompt.claimant === prompt.seat
        ? 'Fiat: claim a pile from the center.'
        : `Fiat: choose the pile for ${names.seat(prompt.claimant)}.`;
    case 'duplicity-hide':
      return 'Duplicity: hide another Keep card face down in any keep.';
    case 'reveal-window':
      return 'Duplicity: reveal the face-down card now?';
    default:
      return prompt satisfies never;
  }
}

function othersPhrase(kind: PromptView['kind'], view: PlayerView): string {
  switch (kind) {
    case 'action':
      return view.frame?.kind === 'retribution' ? 'retaliating (Retribution)' : view.frame?.kind === 'last-laugh' ? 'Last Laugh' : 'taking an action';
    case 'hot-target':
      return 'placing a HOT card';
    case 'reveal-window':
      return 'deciding whether to reveal (Duplicity)';
    case 'give-card':
      return 'choosing a card to give (Offering)';
    case 'claim-pile':
      return 'claiming a pile (Fiat)';
    default:
      return 'deciding';
  }
}

export function headline(view: PlayerView, names: Names): string | null {
  if (view.phase === 'game-over') {
    const winner = view.marks.findIndex((m) => m >= view.marksToWin);
    return `${capital(names.seat(winner as 0))} won the game!`;
  }
  if (view.phase === 'round-over' && view.lastRoundWinner !== null) {
    const how = view.roundEnd?.kind === 'tokens' ? 'by collecting all three Tokens' : 'with the most coins';
    return `${capital(names.seat(view.lastRoundWinner))} won round ${view.round} ${how}.`;
  }
  if (view.phase === 'post-round') return 'The round is over. Last chances before scoring…';
  return null;
}

export const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
