import { CARDS } from '@keeps/engine';
import type { Hint } from '@keeps/protocol';
import type { Option } from './options.ts';

// Training mode's hints in words: each the move as the options name it, and how good the bot thinks it is.

/** The hint's move, labelled as its option is. */
export function hintLabel(hint: Hint, options: Option[]): string {
  const known = options.find((o) => JSON.stringify(o.command) === JSON.stringify(hint.command));
  if (known) return known.label;
  // A pile reorder lists no options: name the order.
  const order = hint.command.type === 'answer' && hint.command.answer.kind === 'order-pile' ? hint.command.answer.order : null;
  return order ? `Put the pile in this order: ${order.map((c) => CARDS[c].name).join(', ')}` : 'A move';
}

/** Its chance of winning the round when the bot searched it, otherwise how likely its network is to play it. */
export const hintChance = (h: Hint) => (h.win === undefined ? `${Math.round(100 * h.probability)}%` : `${Math.round(100 * h.win)}% to win the round`);
