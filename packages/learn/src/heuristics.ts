import { CARDS, keepValue, type CardId, type Command, type KeepCard, type PlayerView, type Seat } from '@keeps/engine';

// Rule-based players for benchmarking the bot: better yardsticks than a random
// player. They see only their own view (like the bot, like a person).
//
//   greedy  takes the move with the best immediate value: the exact change in
//           the coin margin for Keep placements and Providence swaps (Tithes,
//           Purity and the Tokens' win included), the best card on offer, and
//           rough fixed values for everything else (a card in hand ≈ 1 coin).
//   timer   greedy, plus judgment: it ends the round (drawing from an empty
//           pile) only when strictly ahead (the ender loses ties) and never when
//           behind, and it doesn't give the opponent a card while their
//           Retribution (two free actions) or Interest (a free draw) is face up.

export type HeuristicKind = 'greedy' | 'timer';

/** Chooses a command from the legal ones, given the player's view. */
export type Chooser = (view: PlayerView, legal: readonly Command[]) => Command;

const TOKENS: readonly CardId[] = ['count-token', 'fool-token', 'friar-token'];
const WIN = 1000; // a Token victory

/** Rough worth of holding a card, in half-coins. */
function handWorth(card: CardId): number {
  const c = CARDS[card];
  if (typeof c.coins === 'number') return Math.max(c.coins, 0) + 1;
  if (c.coins === 'tithes') return 3;
  return ACTION_VALUE[card] ?? 2;
}

/** Rough worth of playing an action card, in half-coins (a draw is worth 2: one card ≈ one coin). */
const ACTION_VALUE: Partial<Record<CardId, number>> = {
  'hocus-pocus': 3,
  pluck: 3,
  epiphany: 3,
  requisition: 3,
  prayer: 2.5,
  invocation: 2,
  legerdemain: 2,
  pickpocket: 1,
  offering: 1,
  resurrection: 1,
  revelation: 0.5,
  pandemonium: 0.5,
};

type Keeps = KeepCard[][];

function keepsOf(view: PlayerView): Keeps {
  // Face-down cards count for nothing until revealed (keepValue skips them).
  return view.keeps.map((k) =>
    k.cards.map((c): KeepCard => (c.faceDown ? { id: (c.id ?? 'purity') as CardId, faceDown: { placedBy: k.seat } } : { id: c.id })),
  );
}

function tokenWin(keep: readonly KeepCard[]): boolean {
  return TOKENS.every((t) => keep.some((c) => c.id === t && !c.faceDown));
}

/** My margin over the opponent, in half-coins (a Token victory dominates). */
function margin(keeps: Keeps, me: Seat, opp: Seat): number {
  if (tokenWin(keeps[me]!)) return WIN;
  if (tokenWin(keeps[opp]!)) return -WIN;
  return keepValue(keeps[me]!) - keepValue(keeps[opp]!);
}

function withCard(keeps: Keeps, seat: Seat, card: CardId): Keeps {
  return keeps.map((k, s) => (s === seat ? [...k, { id: card }] : k));
}

export function heuristic(kind: HeuristicKind, random: () => number = Math.random): Chooser {
  const careful = kind === 'timer';
  return (view, legal) => {
    if (view.viewer === 'spectator') throw new Error('a spectator has no moves');
    const me = view.viewer;
    const opp = ((me + 2) % 4) as Seat;
    const keeps = keepsOf(view);
    const now = margin(keeps, me, opp);
    const oppKeep = view.keeps[opp]!.cards;
    const oppHas = (card: CardId) => oppKeep.some((c) => !c.faceDown && c.id === card);
    const myPileEmpty = view.piles[me]!.size === 0;

    /** Value of putting `card` into `seat`'s keep, relative to now. */
    const place = (card: CardId, seat: Seat): number => {
      let v = margin(withCard(keeps, seat, card), me, opp) - now;
      if (careful && seat === opp) {
        if (oppHas('retribution')) v -= 6; // two free actions for them
        if (oppHas('interest') && typeof CARDS[card].coins === 'number') v -= 2; // a free draw for them
      }
      return v;
    };
    /** Ending the round now: good only when strictly ahead (the ender loses ties). */
    const endRound = (): number => (now > 0 ? 500 : -500);

    const value = (c: Command): number => {
      if (c.type === 'reveal-duplicity') return revealValue();
      if (c.type !== 'answer') return 0;
      const a = c.answer;
      switch (a.kind) {
        case 'action': {
          const ch = a.choice;
          switch (ch.action) {
            case 'draw':
              return careful && myPileEmpty ? endRound() : 2;
            case 'pass':
              return 0;
            case 'play': {
              const card = CARDS[ch.card];
              if (ch.target !== undefined) return place(ch.card, ch.target) + (card.keep && !card.coins ? 1 : 0);
              if (ch.card === 'providence') return bestSwap();
              if (ch.card === 'joker') return ch.copy ? (ch.copy === 'providence' ? bestSwap() : (ACTION_VALUE[ch.copy] ?? 1)) : 0;
              return ACTION_VALUE[ch.card] ?? 1;
            }
            case 'ability':
              switch (ch.card) {
                case 'shackles':
                  return 7; // discard our -3 (and get our second action back next turn)
                case 'blunder':
                  return 18; // two actions to be rid of -10
                case 'tithes': {
                  const kept = keeps[me]!.filter((k) => typeof CARDS[k.id].coins !== 'number' || k.faceDown);
                  return keepValue(kept) - keepValue(keeps[me]!);
                }
                case 'sanction':
                  return careful && view.piles[ch.from]!.size === 0 ? endRound() : 2;
                case 'acquisition':
                  return 2;
                case 'juggling':
                  return -1;
                default:
                  return 0;
              }
          }
          return 0;
        }
        case 'hot-target':
          return place(promptCard('hot-target') ?? 'chalice', a.target);
        case 'take-or-discard': {
          const card = promptCard('take-or-discard');
          if (!card) return 0;
          const keepGood = CARDS[card].keep ? place(card, me) >= 0 : true;
          return a.take === keepGood ? 1 : 0;
        }
        case 'choose-pile-card':
        case 'choose-top-card':
        case 'choose-discard-card':
        case 'choose-hand-card':
        case 'joker-copy':
          return handWorth(cardOf(c) ?? 'chalice');
        case 'give-card':
          return -handWorth(a.card);
        case 'choose-keep-pair': {
          const ka = keeps[a.a.seat]![a.a.index]!;
          const kb = keeps[a.b.seat]![a.b.index]!;
          const swapped = keeps.map((k) => [...k]);
          swapped[a.a.seat]![a.a.index] = kb;
          swapped[a.b.seat]![a.b.index] = ka;
          return margin(swapped, me, opp) - now;
        }
        case 'choose-player':
          return a.seat === opp ? 1 : 0;
        case 'duplicity-hide':
          // Hide our worst card in their keep (it counts once revealed).
          return (a.target === opp ? 1 : -1) * -handWorth(a.card);
        case 'reveal-window':
          return a.reveal ? revealValue() : 0;
        case 'claim-pile':
          return view.piles[a.from]!.size + random() * 0.1;
        case 'choose-pile':
          return view.piles[a.pile]!.top ? handWorth(view.piles[a.pile]!.top!) : a.pile === me ? 0.5 : random() * 0.1;
        default:
          return random() * 0.1; // direction, pile order: no opinion
      }
    };

    function promptCard(kind: 'hot-target' | 'take-or-discard'): CardId | null {
      const p = view.prompts.find((q) => q.mine && q.kind === kind);
      return p && p.mine && 'card' in p ? (p.card as CardId) : null;
    }
    function cardOf(c: Command): CardId | null {
      if (c.type !== 'answer') return null;
      const a = c.answer;
      if ('card' in a) return a.card as CardId;
      if (a.kind === 'choose-pile-card') {
        const p = view.prompts.find((q) => q.mine && q.kind === 'choose-pile-card');
        return p && p.mine && p.kind === 'choose-pile-card' ? p.cards[a.index]! : null;
      }
      if (a.kind === 'choose-top-card') return view.piles[a.pile]!.top ?? null;
      return null;
    }
    function bestSwap(): number {
      let best = 0;
      const refs = keeps.flatMap((k, seat) => k.map((_, index) => ({ seat, index })));
      for (const x of refs) {
        for (const y of refs) {
          if (x.seat >= y.seat) continue;
          const swapped = keeps.map((k) => [...k]);
          swapped[x.seat]![x.index] = keeps[y.seat]![y.index]!;
          swapped[y.seat]![y.index] = keeps[x.seat]![x.index]!;
          best = Math.max(best, margin(swapped, me, opp) - now);
        }
      }
      return best;
    }
    function revealValue(): number {
      // We know our own face-down card: reveal it if that helps us now.
      const revealed = view.keeps.map((k) => k.cards.map((c): KeepCard => (c.faceDown && !c.id ? { id: 'purity', faceDown: { placedBy: k.seat } } : { id: c.id! })));
      return margin(revealed, me, opp) - now;
    }

    let best = legal[0]!;
    let bestValue = -Infinity;
    for (const c of legal) {
      const v = value(c) + random() * 1e-3; // break ties at random
      if (v > bestValue) {
        bestValue = v;
        best = c;
      }
    }
    return best;
  };
}
