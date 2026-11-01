import { abilityCost, acquisitionOrder, CARDS, rotatedFrom, rotatedTo, type CardId, type Command, type PlayerView, type Seat } from '@keeps/engine';

// Labels describe moves; they never re-derive a rule. Anything a label
// predicts (which pile you'll get, what an ability costs) comes from an
// engine helper that the rules themselves use.

// Turns the view's legal commands into things the table can show and click.
//
// Every command lists the table elements it involves ("refs"): a card in your
// hand, a pile, a keep, a card in a keep, a player. Clicking elements narrows
// the options to the commands involving everything clicked so far; when one
// option remains and every element it needs has been clicked, it is sent.
// The side panel always lists the remaining options as buttons, so every
// command is reachable even without clicking the table. When there are many,
// options that start with the same element fold into one button ("Play
// Dagger…") that picks that element, exactly like clicking it on the table.
//
// Cards on display for a decision (the pile you're looking through, the
// discard, revealed hands) are listed by `shownCards`; the table shows them at
// readable size, and the ones that are choices carry their own refs.
//
// A move can also say how it's made by carrying something across the table
// (`drags`): what's picked up is what moves (a card from your hand to where
// it's played, a card leaving your keep, a pile to your hand to draw from it),
// so a card used where it lies (Sanction, Acquisition) is touched, not carried.
// Tables that drag (the app's) need no rules of their own: only these.

export type Ref =
  | `hand:${CardId}`
  | `pile:${Seat}`
  | `keep:${Seat}`
  | `keepcard:${Seat}:${number}`
  | `discard:${CardId}`
  | `player:${Seat}`
  /** The n-th card in `shownCards` (one with no other place on the table). */
  | `shown:${number}`;

/**
 * Where a carried thing is let go: an element, the table's middle (`table`: a card played on its own, or discarded),
 * or your hand (`hand`: a card drawn into it).
 */
export type DropTarget = Ref | 'table' | 'hand';

/** A way to make a move by carrying something: pick up `from`, let it go on `to`. */
export interface Drag {
  from: Ref;
  to: DropTarget;
}

export interface Option {
  command: Command;
  refs: Ref[];
  label: string;
  /** How the move is made by carrying something (none: only by touching). */
  drags?: Drag[];
  /** Cards to picture on the option's button. */
  cards: CardId[];
  /** Elements that can begin a selection (default: the first ref). Providence's two cards are equal. */
  starts?: Ref[];
  /**
   * For folding options into groups: `groups[i]` labels the group of options
   * that share refs[i] as their next element ("Play Dagger…"). Missing: never grouped there.
   */
  groups?: string[];
}

export interface Names {
  /**
   * Display name per seat: "you" for the viewer, the player's name, or a ghost's
   * by where it sits on the table ("left ghost"; "the ghost" if it is the only one).
   */
  seat: (seat: Seat) => string;
  possessive: (seat: Seat) => string;
}

const TABLE_POSITIONS = ['bottom', 'left', 'top', 'right'] as const;

/** `bottom`: the seat drawn at the bottom of the table (default: the viewer's, or seat 0). */
export function makeNames(names: (string | null)[], viewer: Seat | 'spectator', bottom?: Seat): Names {
  const anchor = bottom ?? (viewer === 'spectator' ? 0 : viewer);
  const ghosts = names.filter((n) => n === null).length;
  const ghost = (s: Seat) => (ghosts === 1 ? 'the ghost' : `${TABLE_POSITIONS[(s - anchor + 4) % 4]} ghost`);
  const seat = (s: Seat) => (s === viewer ? 'you' : (names[s] ?? ghost(s)));
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

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function describeOptions(view: PlayerView, names: Names): Option[] {
  const me = view.viewer === 'spectator' ? null : view.viewer;
  const prompts = new Map(view.prompts.filter((p) => p.mine).map((p) => [p.id, p]));
  /** "your pile", "Bo's pile". */
  const pileOf = (s: Seat) => `${names.possessive(s)} pile`;
  /** "Bo's pile (3 cards)". */
  const pile = (s: Seat) => `${pileOf(s)} (${plural(view.piles[s]!.size, 'card')})`;
  const shownIndex = shownRefs(view);

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
            return {
              command,
              refs: me === null ? [] : [`pile:${me}`],
              label: 'Draw from your pile',
              cards: [],
              ...(me === null ? {} : { drags: [{ from: `pile:${me}`, to: 'hand' }] }),
            };
          case 'pass':
            return { command, refs: [], label: 'Pass (skip Last Laugh’s action)', cards: [] };
          case 'play':
            if (choice.copy) {
              return {
                command,
                refs: [`hand:${choice.card}`, `hand:${choice.copy}`],
                label: `Play Joker as ${name(choice.copy)}`,
                cards: ['joker', choice.copy],
                groups: ['Play Joker…'],
                drags: [{ from: `hand:${choice.card}`, to: `hand:${choice.copy}` }],
              };
            }
            if (choice.target !== undefined) {
              return {
                command,
                refs: [`hand:${choice.card}`, `keep:${choice.target}`],
                label: `Play ${name(choice.card)} into ${names.possessive(choice.target)} keep`,
                cards: [choice.card],
                groups: [`Play ${name(choice.card)}…`],
                drags: [{ from: `hand:${choice.card}`, to: `keep:${choice.target}` }],
              };
            }
            return {
              command,
              refs: [`hand:${choice.card}`],
              label: `Play ${name(choice.card)}`,
              cards: [choice.card],
              drags: [{ from: `hand:${choice.card}`, to: 'table' }],
            };
          case 'ability': {
            const source = me === null ? [] : abilityRef(view, me, choice.card);
            switch (choice.card) {
              case 'juggling':
                return {
                  command,
                  refs: [...source, `pile:${choice.piles[0]}`, `pile:${choice.piles[1]}`],
                  label: `Juggling: swap ${pile(choice.piles[0])} with ${pile(choice.piles[1])}`,
                  cards: ['juggling'],
                  groups: ['Juggling: swap two piles…', `Juggling: swap ${pileOf(choice.piles[0])} with…`],
                  // Either pile onto the other.
                  drags: [
                    { from: `pile:${choice.piles[0]}`, to: `pile:${choice.piles[1]}` },
                    { from: `pile:${choice.piles[1]}`, to: `pile:${choice.piles[0]}` },
                  ],
                };
              case 'sanction':
                return {
                  command,
                  refs: [...source, `pile:${choice.from}`],
                  label: `Sanction: draw from ${pile(choice.from)}`,
                  cards: ['sanction'],
                  groups: ['Sanction: draw from any pile…'],
                  // Your own pile carried to your hand is a plain draw.
                  ...(choice.from === me ? {} : { drags: [{ from: `pile:${choice.from}` as const, to: 'hand' as const }] }),
                };
              case 'acquisition': {
                // Name the piles: "left" and "right" mean little when the seats aren't
                // drawn around a table (phones).
                const [first, second] = acquisitionOrder(me ?? (0 as Seat), choice.first);
                return {
                  command,
                  refs: [...source, `hand:${choice.discard}`],
                  label: `Acquisition: discard ${name(choice.discard)}, draw from ${pileOf(first)} first, then ${pileOf(second)}`,
                  cards: ['acquisition', choice.discard],
                  groups: ['Acquisition: discard a card, draw two…', `Acquisition: discard ${name(choice.discard)}…`],
                };
              }
              case 'shackles':
                return {
                  command,
                  refs: source,
                  label: 'Discard Shackles from your keep',
                  cards: ['shackles'],
                  drags: source.map((from) => ({ from, to: 'table' as const })),
                };
              case 'tithes':
                return { command, refs: source, label: 'Tithes: discard your Coin cards and reorder your pile', cards: ['tithes'] };
              case 'blunder':
                return {
                  command,
                  refs: [...source, `pile:${choice.pile}`],
                  label: `Blunder (${plural(abilityCost(choice), 'action')}): put it face up on ${pileOf(choice.pile)}`,
                  cards: ['blunder'],
                  groups: [`Blunder (${plural(abilityCost(choice), 'action')}): put it on a pile…`],
                  drags: source.map((from) => ({ from, to: `pile:${choice.pile}` as const })),
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
          refs: [`shown:${answer.index}`],
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
        const refs: Ref[] = [`keepcard:${answer.a.seat}:${answer.a.index}`, `keepcard:${answer.b.seat}:${answer.b.index}`];
        return {
          command,
          refs,
          label: `Swap ${describe(answer.a)} with ${describe(answer.b)}`,
          cards: [],
          // Either card can be picked first.
          starts: refs,
          groups: [`Swap ${describe(answer.a)} with…`],
        };
      }
      case 'choose-direction': {
        // Say what each choice does for you, not which way it turns: "left" and
        // "right" mean little when the seats aren't drawn around a table (phones).
        const seat = me ?? (0 as Seat);
        const from = rotatedFrom(seat, answer.direction);
        const to = rotatedTo(seat, answer.direction);
        const size = view.piles[from]!.size;
        const yours = me === null ? `${names.possessive(seat)} pile goes` : 'yours goes';
        return {
          command,
          refs: [],
          label: `Pass every pile ${answer.direction} (${answer.direction === 'left' ? 'on, in play order' : 'back'}): ${me === null ? names.seat(seat) : 'you'} get${me === null ? 's' : ''} ${names.possessive(from)} pile (${size} card${size === 1 ? '' : 's'}), ${yours} to ${names.seat(to)}`,
          cards: [],
        };
      }
      case 'order-pile':
        return { command, refs: [], label: 'Keep this order', cards: [] };
      case 'choose-player': {
        const count = view.hands[answer.seat]!.count;
        return {
          command,
          refs: [`player:${answer.seat}`],
          label: `Choose ${names.seat(answer.seat)} (${plural(count, 'card')} in hand)`,
          cards: [],
        };
      }
      case 'choose-hand-card':
        return {
          command,
          refs: [shownIndex(answer.card, answer.seat)],
          label: `Take ${name(answer.card)} from ${names.possessive(answer.seat)} hand`,
          cards: [answer.card],
        };
      case 'give-card': {
        const to = prompt?.kind === 'give-card' ? prompt.to : null;
        return {
          command,
          refs: [`hand:${answer.card}`],
          label: `Give ${name(answer.card)}`,
          cards: [answer.card],
          ...(to === null ? {} : { drags: [{ from: `hand:${answer.card}`, to: `player:${to}` }] }),
        };
      }
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
          groups: [`Hide ${name(answer.card)}…`],
          drags: [{ from: `hand:${answer.card}`, to: `keep:${answer.target}` }],
        };
      case 'reveal-window':
        return { command, refs: [], label: answer.reveal ? 'Reveal the face-down card' : 'Keep it hidden', cards: [] };
      default:
        return answer satisfies never;
    }
  });
}

/** A card shown for a decision, outside its usual place on the table. */
export interface ShownCard {
  card: CardId;
  /** What clicking it chooses; null if it's only there to look at. */
  ref: Ref | null;
  /** Whose it is, or where it is ("Bo", "Cy's pile"). */
  caption?: string;
}

/** The cards the viewer is choosing between (or looking at), when they have no readable place on the table. */
export function shownCards(view: PlayerView, names: Names): { title: string; cards: ShownCard[] } | null {
  const prompt = view.prompts.find((p) => p.mine);
  if (!prompt) return null;
  const pileOf = (s: Seat) => `${names.possessive(s)} pile`;
  switch (prompt.kind) {
    case 'choose-pile-card':
      return {
        title: `${capitalize(pileOf(prompt.pile))}, top first: take any card`,
        cards: prompt.cards.map((card, i) => ({ card, ref: `shown:${i}`, caption: `${i + 1}` })),
      };
    case 'choose-top-card':
      return {
        title: 'The top cards: take one',
        cards: prompt.options.map((o) => ({ card: o.card, ref: `pile:${o.pile}`, caption: pileOf(o.pile) })),
      };
    case 'take-or-discard':
      return { title: `The top of ${pileOf(prompt.pile)}`, cards: [{ card: prompt.card, ref: null }] };
    case 'choose-discard-card':
      return {
        title: 'The discard pile: take a card',
        cards: [...view.discard].reverse().map((card) => ({ card, ref: `discard:${card}` })),
      };
    case 'choose-hand-card':
      return {
        title: 'Their hands: take one card',
        cards: prompt.options.map((o, i) => ({ card: o.card, ref: `shown:${i}`, caption: capitalize(names.seat(o.seat)) })),
      };
    default:
      return null;
  }
}

/** For Pluck: the `shown:` ref of a card in a revealed hand. */
function shownRefs(view: PlayerView): (card: CardId, seat: Seat) => Ref {
  const prompt = view.prompts.find((p) => p.mine && p.kind === 'choose-hand-card');
  const options = prompt?.kind === 'choose-hand-card' ? prompt.options : [];
  return (card, seat) => `shown:${options.findIndex((o) => o.card === card && o.seat === seat)}`;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Options still possible after clicking `picked` (each must be involved). */
export function narrow(options: Option[], picked: Ref[]): Option[] {
  return options.filter((o) => picked.every((r) => o.refs.includes(r)));
}

/** A button in the side panel: one option, or a group of options that share their next element. */
export type PanelItem = { kind: 'option'; option: Option } | { kind: 'group'; ref: Ref; label: string; count: number };

/** Fold options into groups once there are more than this many. */
export const GROUP_ABOVE = 6;

/**
 * The side panel's buttons for the options still possible. With many, options
 * whose next element is the same (and that say how to label it) fold into one
 * group button; choosing it picks that element, like clicking it on the table.
 */
export function panelItems(options: Option[], picked: Ref[]): PanelItem[] {
  if (options.length <= GROUP_ABOVE) return options.map((option) => ({ kind: 'option', option }));
  const next = (o: Option) => {
    const ref = o.refs.find((r) => !picked.includes(r));
    const label = ref === undefined ? undefined : o.groups?.[o.refs.indexOf(ref)];
    return ref !== undefined && label !== undefined ? { ref, label } : null;
  };
  const sizes = new Map<Ref, number>();
  for (const o of options) {
    const n = next(o);
    if (n) sizes.set(n.ref, (sizes.get(n.ref) ?? 0) + 1);
  }
  const items: PanelItem[] = [];
  const seen = new Set<Ref>();
  for (const option of options) {
    const n = next(option);
    if (!n || (sizes.get(n.ref) ?? 0) < 2) {
      items.push({ kind: 'option', option });
    } else if (!seen.has(n.ref)) {
      seen.add(n.ref);
      items.push({ kind: 'group', ref: n.ref, label: n.label, count: sizes.get(n.ref)! });
    }
  }
  return items;
}

export type ClickResult =
  | { kind: 'send'; command: Command }
  | { kind: 'pick'; picked: Ref[] }
  | { kind: 'ignore' };

/**
 * Handles a click on a table element. Sends a command once exactly one option
 * remains and all its elements have been clicked; otherwise extends the picks.
 * A first click also sends the one option it completes when that option starts
 * at the clicked element and every other option involving it starts elsewhere:
 * your pile draws, though Sanction could draw from it too (Sanction's options
 * start at Sanction); a card played on its own is played, though Joker could
 * copy it (Joker's start at Joker).
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
  if (next.length === 1) {
    const startingHere = remaining.filter((o) => (o.starts ?? o.refs.slice(0, 1)).includes(ref));
    const [move] = startingHere;
    if (startingHere.length === 1 && move!.refs.every((r) => next.includes(r))) return { kind: 'send', command: move!.command };
  }
  return { kind: 'pick', picked: next };
}

/**
 * Elements worth clicking next. Before anything is picked, only the elements
 * an option can start from (the card to play, the pile to draw from, the
 * ability card; either card of a Providence swap), so targets light up only
 * once you've chosen what to do.
 */
export function clickable(options: Option[], picked: Ref[]): Set<Ref> {
  const set = new Set<Ref>();
  for (const o of narrow(options, picked)) {
    if (picked.length === 0) {
      for (const r of o.starts ?? o.refs.slice(0, 1)) set.add(r);
    } else {
      for (const r of o.refs) if (!picked.includes(r)) set.add(r);
    }
  }
  return set;
}
