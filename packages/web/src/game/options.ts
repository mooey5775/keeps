import { CARDS, type CardId, type Command, type PlayerView, type Seat } from '@keeps/engine';

// Turns the view's legal commands into things the table can show and click.
//
// Every command lists the table elements it involves ("refs"): a card in your
// hand, a pile, a keep, a card in a keep, a player. Clicking elements narrows
// the options to the commands involving everything clicked so far; when one
// option remains and every element it needs has been clicked, it is sent.
// The side panel always lists the remaining options as buttons, so every
// command is reachable even without clicking the table.

export type Ref =
  | `hand:${CardId}`
  | `pile:${Seat}`
  | `keep:${Seat}`
  | `keepcard:${Seat}:${number}`
  | `discard:${CardId}`
  | `player:${Seat}`;

export interface Option {
  command: Command;
  refs: Ref[];
  label: string;
  /** Cards to picture on the option's button. */
  cards: CardId[];
}

export interface Names {
  /** Display name per seat: "you" for the viewer, the player's name, or "ghost". */
  seat: (seat: Seat) => string;
  possessive: (seat: Seat) => string;
}

export function makeNames(names: (string | null)[], viewer: Seat | 'spectator'): Names {
  const seat = (s: Seat) => (s === viewer ? 'you' : (names[s] ?? `ghost ${s}`));
  return {
    seat,
    possessive: (s: Seat) => (s === viewer ? 'your' : `${seat(s)}'s`),
  };
}

const name = (card: CardId) => CARDS[card].name;

/** Where an ability card sits in your keep (its keep-card ref). */
function abilityRef(view: PlayerView, seat: Seat, card: CardId): Ref[] {
  const index = view.keeps[seat]!.cards.findIndex((c) => !c.faceDown && c.id === card);
  return index >= 0 ? [`keepcard:${seat}:${index}`] : [];
}

export function describeOptions(view: PlayerView, names: Names): Option[] {
  const me = view.viewer === 'spectator' ? null : view.viewer;
  const prompts = new Map(view.prompts.filter((p) => p.mine).map((p) => [p.id, p]));
  const pile = (s: Seat) => `the pile in front of ${names.seat(s)}`;

  return view.legal.map((command): Option => {
    if (command.type === 'next-round') return { command, refs: [], label: 'Start the next round', cards: [] };
    if (command.type === 'reveal-duplicity') return { command, refs: [], label: 'Reveal the face-down card (Duplicity)', cards: [] };
    const prompt = prompts.get(command.promptId);
    const answer = command.answer;
    switch (answer.kind) {
      case 'action': {
        const choice = answer.choice;
        switch (choice.action) {
          case 'draw':
            return { command, refs: me === null ? [] : [`pile:${me}`], label: 'Draw from your pile', cards: [] };
          case 'pass':
            return { command, refs: [], label: 'Pass (skip Last Laugh’s action)', cards: [] };
          case 'play':
            if (choice.copy) {
              return {
                command,
                refs: [`hand:${choice.card}`, `hand:${choice.copy}`],
                label: `Play Joker as ${name(choice.copy)}`,
                cards: ['joker', choice.copy],
              };
            }
            if (choice.target !== undefined) {
              return {
                command,
                refs: [`hand:${choice.card}`, `keep:${choice.target}`],
                label: `Play ${name(choice.card)} into ${names.possessive(choice.target)} keep`,
                cards: [choice.card],
              };
            }
            return { command, refs: [`hand:${choice.card}`], label: `Play ${name(choice.card)}`, cards: [choice.card] };
          case 'ability': {
            const source = me === null ? [] : abilityRef(view, me, choice.card);
            switch (choice.card) {
              case 'juggling':
                return {
                  command,
                  refs: [...source, `pile:${choice.piles[0]}`, `pile:${choice.piles[1]}`],
                  label: `Juggling: swap ${pile(choice.piles[0])} with ${pile(choice.piles[1])}`,
                  cards: ['juggling'],
                };
              case 'sanction':
                return { command, refs: [...source, `pile:${choice.from}`], label: `Sanction: draw from ${pile(choice.from)}`, cards: ['sanction'] };
              case 'acquisition':
                return {
                  command,
                  refs: [...source, `hand:${choice.discard}`],
                  label: `Acquisition: discard ${name(choice.discard)}, draw ${choice.first} pile first`,
                  cards: ['acquisition', choice.discard],
                };
              case 'shackles':
                return { command, refs: source, label: 'Discard Shackles from your keep', cards: ['shackles'] };
              case 'tithes':
                return { command, refs: source, label: 'Tithes: discard your Coin cards and reorder your pile', cards: ['tithes'] };
              case 'blunder':
                return {
                  command,
                  refs: [...source, `pile:${choice.pile}`],
                  label: `Blunder (2 actions): put it face up on ${pile(choice.pile)}`,
                  cards: ['blunder'],
                };
              default:
                return choice satisfies never;
            }
          }
          default:
            return choice satisfies never;
        }
      }
      case 'hot-target': {
        const card = prompt?.kind === 'hot-target' ? prompt.card : null;
        return {
          command,
          refs: [`keep:${answer.target}`],
          label: `Put ${card ? name(card) : 'it'} into ${names.possessive(answer.target)} keep`,
          cards: card ? [card] : [],
        };
      }
      case 'choose-pile':
        return { command, refs: [`pile:${answer.pile}`], label: `Choose ${pile(answer.pile)}`, cards: [] };
      case 'choose-pile-card': {
        const card = prompt?.kind === 'choose-pile-card' ? prompt.cards[answer.index]! : null;
        return {
          command,
          refs: [],
          label: card ? `Take ${name(card)} (card ${answer.index + 1} from the top)` : `Take card ${answer.index + 1}`,
          cards: card ? [card] : [],
        };
      }
      case 'choose-top-card': {
        const option = prompt?.kind === 'choose-top-card' ? prompt.options.find((o) => o.pile === answer.pile) : undefined;
        return {
          command,
          refs: [`pile:${answer.pile}`],
          label: `Take ${option ? name(option.card) : 'the top card'} from ${pile(answer.pile)}`,
          cards: option ? [option.card] : [],
        };
      }
      case 'take-or-discard': {
        const card = prompt?.kind === 'take-or-discard' ? prompt.card : null;
        const n = card ? name(card) : 'it';
        return {
          command,
          refs: [],
          label: answer.take ? `Take ${n} into your hand` : `Discard ${n}, then draw from that pile`,
          cards: card ? [card] : [],
        };
      }
      case 'choose-discard-card':
        return { command, refs: [`discard:${answer.card}`], label: `Take ${name(answer.card)} from the discard`, cards: [answer.card] };
      case 'choose-keep-pair': {
        const describe = (ref: { seat: Seat; index: number }) => {
          const card = view.keeps[ref.seat]!.cards[ref.index];
          const what = !card ? 'a card' : card.faceDown ? (card.id ? `face-down ${name(card.id)}` : 'the face-down card') : name(card.id);
          return `${what} (${names.possessive(ref.seat)} keep)`;
        };
        return {
          command,
          refs: [`keepcard:${answer.a.seat}:${answer.a.index}`, `keepcard:${answer.b.seat}:${answer.b.index}`],
          label: `Swap ${describe(answer.a)} with ${describe(answer.b)}`,
          cards: [],
        };
      }
      case 'choose-direction':
        return {
          command,
          refs: [],
          label: answer.direction === 'left' ? 'Rotate every pile one seat to the left' : 'Rotate every pile one seat to the right',
          cards: [],
        };
      case 'order-pile':
        return { command, refs: [], label: 'Keep this order', cards: [] };
      case 'choose-player':
        return { command, refs: [`player:${answer.seat}`], label: `Choose ${names.seat(answer.seat)}`, cards: [] };
      case 'choose-hand-card':
        return {
          command,
          refs: [`player:${answer.seat}`],
          label: `Take ${name(answer.card)} from ${names.possessive(answer.seat)} hand`,
          cards: [answer.card],
        };
      case 'give-card':
        return { command, refs: [`hand:${answer.card}`], label: `Give ${name(answer.card)}`, cards: [answer.card] };
      case 'joker-copy':
        return { command, refs: [`hand:${answer.card}`], label: `Joker copies ${name(answer.card)}`, cards: [answer.card] };
      case 'claim-pile': {
        const claimant = prompt?.kind === 'claim-pile' ? prompt.claimant : null;
        const who = claimant === null || claimant === me ? 'Claim' : `Give ${names.seat(claimant)}`;
        return { command, refs: [`pile:${answer.from}`], label: `${who} the pile that was in front of ${names.seat(answer.from)}`, cards: [] };
      }
      case 'duplicity-hide':
        return {
          command,
          refs: [`hand:${answer.card}`, `keep:${answer.target}`],
          label: `Hide ${name(answer.card)} face down in ${names.possessive(answer.target)} keep`,
          cards: [answer.card],
        };
      case 'reveal-window':
        return { command, refs: [], label: answer.reveal ? 'Reveal the face-down card' : 'Keep it hidden', cards: [] };
      default:
        return answer satisfies never;
    }
  });
}

/** Options still possible after clicking `picked` (each must be involved). */
export function narrow(options: Option[], picked: Ref[]): Option[] {
  return options.filter((o) => picked.every((r) => o.refs.includes(r)));
}

export type ClickResult =
  | { kind: 'send'; command: Command }
  | { kind: 'pick'; picked: Ref[] }
  | { kind: 'ignore' };

/**
 * Handles a click on a table element. Sends a command once exactly one option
 * remains and all its elements have been clicked; otherwise extends the picks.
 */
export function click(options: Option[], picked: Ref[], ref: Ref): ClickResult {
  if (picked.includes(ref)) return { kind: 'pick', picked: picked.filter((r) => r !== ref) };
  let next = [...picked, ref];
  let remaining = narrow(options, next);
  if (remaining.length === 0) {
    // Start over from this element if it works on its own.
    next = [ref];
    remaining = narrow(options, next);
    if (remaining.length === 0) return { kind: 'ignore' };
  }
  const [only] = remaining;
  if (remaining.length === 1 && only!.refs.every((r) => next.includes(r))) return { kind: 'send', command: only!.command };
  return { kind: 'pick', picked: next };
}

/**
 * Elements worth clicking next. Before anything is picked, only each option's
 * first element (the card to play, the pile to draw from, the ability card),
 * so targets light up only once you've chosen what to do. Clicking any
 * involved element still works.
 */
export function clickable(options: Option[], picked: Ref[]): Set<Ref> {
  const set = new Set<Ref>();
  for (const o of narrow(options, picked)) {
    if (picked.length === 0) {
      if (o.refs[0]) set.add(o.refs[0]);
    } else {
      for (const r of o.refs) if (!picked.includes(r)) set.add(r);
    }
  }
  return set;
}
