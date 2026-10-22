import { CARD_IDS, type CardId, type Command, type PlayerView, type PromptView, type Seat } from '@keeps/engine';

// A fixed, small action space for learning: 48 integer ids. A move that has
// several parts (play a Keep card into a keep; Acquisition's discard and side;
// Juggling's two piles; Providence's two cards; Tithes' whole pile order)
// becomes a sequence of choices by the same player, each one id.
//
//   CARD(c)    0..35  every "which card": play it from hand, use its ability from
//                     your keep, Joker's copy, Requisition/Pluck/Resurrection/
//                     Offering picks, Providence's cards, Tithes' order. Cards are
//                     unique, and an ability card is never also in your hand
//                     (the ones that start in a hand are HOT), so it's unambiguous.
//   POS(r)     36..39 every seat or pile position: keep targets, piles, players, Fiat claims,
//                     RELATIVE to the player choosing (0 = their own, 1 = their left,
//                     2 = opposite, 3 = their right), like the observation. (Absolute
//                     seats made "my keep" and "their keep" indistinguishable to the
//                     network: it can't tell which seat it's in.)
//   FACE_DOWN  40     the face-down card (Providence); a round has at most one
//   LEFT RIGHT 41 42  Acquisition's first side, Pandemonium
//   YES NO     43 44  Prayer (take?), a Duplicity reveal window (reveal?)
//   DRAW       45
//   PASS       46     declining Last Laugh's action
//   REVEAL     47     Duplicity's free reveal

export const CARD = (card: CardId): number => CARD_IDS.indexOf(card);
export const POS = (position: number): number => 36 + position;

/** The position id of `seat` as `me` sees it. */
export const posOf = (seat: Seat, me: Seat): number => POS((seat - me + 4) % 4);
export const FACE_DOWN = 40;
export const LEFT = 41;
export const RIGHT = 42;
export const YES = 43;
export const NO = 44;
export const DRAW = 45;
export const PASS = 46;
export const REVEAL = 47;
export const NUM_ACTIONS = 48;

export function actionName(id: number): string {
  if (id >= 0 && id < 36) return CARD_IDS[id]!;
  if (id >= 36 && id < 40) return ['at-own', 'at-left', 'at-opposite', 'at-right'][id - 36]!;
  return ['face-down', 'left', 'right', 'yes', 'no', 'draw', 'pass', 'reveal'][id - 40] ?? `?${id}`;
}

type MyPrompt = Extract<PromptView, { mine: true }>;

/** The ids a command is chosen with, in order. `view` is the chooser's view (for the prompt's cards, the keeps, and their seat). */
export function encode(command: Command, view: PlayerView): number[] {
  if (view.viewer === 'spectator') throw new Error('a spectator has no commands');
  const me = view.viewer;
  const at = (seat: Seat) => posOf(seat, me);
  if (command.type === 'reveal-duplicity') return [REVEAL];
  if (command.type !== 'answer') throw new Error(`no encoding for ${command.type}`);
  const answer = command.answer;
  switch (answer.kind) {
    case 'action': {
      const c = answer.choice;
      switch (c.action) {
        case 'draw':
          return [DRAW];
        case 'pass':
          return [PASS];
        case 'play':
          return [CARD(c.card), ...(c.target !== undefined ? [at(c.target)] : []), ...(c.copy ? [CARD(c.copy)] : [])];
        case 'ability':
          switch (c.card) {
            case 'juggling':
              return [CARD('juggling'), at(c.piles[0]), at(c.piles[1])];
            case 'sanction':
              return [CARD('sanction'), at(c.from)];
            case 'acquisition':
              return [CARD('acquisition'), CARD(c.discard), c.first === 'left' ? LEFT : RIGHT];
            case 'blunder':
              return [CARD('blunder'), at(c.pile)];
            case 'shackles':
            case 'tithes':
              return [CARD(c.card)];
            default:
              return c satisfies never;
          }
        default:
          return c satisfies never;
      }
    }
    case 'hot-target':
      return [at(answer.target)];
    case 'choose-pile':
      return [at(answer.pile)];
    case 'choose-pile-card': {
      const prompt = myPrompt(view, command.promptId, 'choose-pile-card');
      return [CARD(prompt.cards[answer.index]!)];
    }
    case 'choose-top-card':
      return [at(answer.pile)];
    case 'take-or-discard':
      return [answer.take ? YES : NO];
    case 'choose-discard-card':
      return [CARD(answer.card)];
    case 'choose-keep-pair':
      return [keepSlot(view, answer.a), keepSlot(view, answer.b)];
    case 'choose-direction':
      return [answer.direction === 'left' ? LEFT : RIGHT];
    case 'order-pile':
      return answer.order.map(CARD);
    case 'choose-player':
      return [at(answer.seat)];
    case 'choose-hand-card':
      return [CARD(answer.card)];
    case 'give-card':
      return [CARD(answer.card)];
    case 'joker-copy':
      return [CARD(answer.card)];
    case 'claim-pile':
      return [at(answer.from)];
    case 'duplicity-hide':
      return [CARD(answer.card), at(answer.target)];
    case 'reveal-window':
      return [answer.reveal ? YES : NO];
    default:
      return answer satisfies never;
  }
}

function myPrompt<K extends MyPrompt['kind']>(view: PlayerView, id: string, kind: K): Extract<MyPrompt, { kind: K }> {
  const prompt = view.prompts.find((p) => p.mine && p.id === id);
  if (!prompt || prompt.kind !== kind) throw new Error(`prompt ${id} is not my ${kind}`);
  return prompt as Extract<MyPrompt, { kind: K }>;
}

/** A played Keep card, by its card (face up) or as the face-down card. */
function keepSlot(view: PlayerView, ref: { seat: Seat; index: number }): number {
  const card = view.keeps[ref.seat]!.cards[ref.index];
  if (!card) throw new Error(`no keep card at ${ref.seat}:${ref.index}`);
  return card.faceDown ? FACE_DOWN : CARD(card.id);
}

/**
 * One decision: the legal commands of the player to move, chosen one id at a
 * time. `next(prefix)` lists the ids that continue some legal command;
 * `complete(prefix)` is the command once the prefix spells one out.
 */
export class Decision {
  private readonly options: { ids: number[]; command: Command }[];
  /** Tithes: any order of these cards (the engine accepts every order, but lists only two). */
  private readonly order: { promptId: string; cards: CardId[] } | null;

  constructor(view: PlayerView, legal: readonly Command[]) {
    const ordering = view.prompts.find((p): p is Extract<MyPrompt, { kind: 'order-pile' }> => p.mine && p.kind === 'order-pile');
    this.order = ordering ? { promptId: ordering.id, cards: [...ordering.cards] } : null;
    this.options = this.order ? [] : legal.map((command) => ({ ids: encode(command, view), command }));
  }

  next(prefix: readonly number[]): number[] {
    // Ascending, as OpenSpiel requires.
    if (this.order) return this.order.cards.map(CARD).filter((id) => !prefix.includes(id)).sort((a, b) => a - b);
    const ids = new Set<number>();
    for (const o of this.options) if (startsWith(o.ids, prefix) && o.ids.length > prefix.length) ids.add(o.ids[prefix.length]!);
    return [...ids].sort((a, b) => a - b);
  }

  complete(prefix: readonly number[]): Command | null {
    if (this.order) {
      if (prefix.length !== this.order.cards.length) return null;
      return { type: 'answer', promptId: this.order.promptId, answer: { kind: 'order-pile', order: prefix.map((id) => CARD_IDS[id]!) } };
    }
    const found = this.options.find((o) => o.ids.length === prefix.length && startsWith(o.ids, prefix));
    return found?.command ?? null;
  }

  /** Every legal command's ids (Tithes: none listed; any order of its cards is legal). */
  encodings(): number[][] {
    return this.options.map((o) => o.ids);
  }
}

function startsWith(ids: readonly number[], prefix: readonly number[]): boolean {
  return prefix.every((id, i) => ids[i] === id);
}
