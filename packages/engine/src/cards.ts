// Static card data. Text and values are transcribed from the card images in
// /cards and verified against rules/RULES.md.

export const CHARACTERS = ['count', 'fool', 'friar'] as const;
export type Character = (typeof CHARACTERS)[number];

/** All 36 cards, in printed card-number order (01–36). */
export const CARD_IDS = [
  'count-token',
  'acquisition',
  'fiat',
  'royal-favor',
  'requisition',
  'interest',
  'chalice',
  'dagger',
  'medallion',
  'scepter',
  'timepiece',
  'faberge-egg',
  'fool-token',
  'juggling',
  'pandemonium',
  'blunder',
  'joker',
  'hocus-pocus',
  'legerdemain',
  'pickpocket',
  'pluck',
  'duplicity',
  'last-laugh',
  'shackles',
  'friar-token',
  'sanction',
  'invocation',
  'revelation',
  'epiphany',
  'offering',
  'prayer',
  'providence',
  'resurrection',
  'purity',
  'retribution',
  'tithes',
] as const;
export type CardId = (typeof CARD_IDS)[number];

export interface CardDef {
  id: CardId;
  /** Printed card number, 1–36. */
  number: number;
  name: string;
  character: Character;
  hot: boolean;
  keep: boolean;
  /**
   * Coin value in HALF-coins (Royal Favor = 1, Chalice = 4, Blunder = -20).
   * 'tithes' = 2 per card in its keep. Absent means not a Coin card
   * (Purity scores, but is explicitly not a Coin card).
   */
  coins?: number | 'tithes';
  text: string;
  /** Image filename in /cards. */
  image: string;
}

type Flags = { hot?: true; keep?: true; coins?: number | 'tithes' };

function def(id: CardId, name: string, image: string, flags: Flags, text: string): CardDef {
  const number = CARD_IDS.indexOf(id) + 1;
  const character = CHARACTERS[Math.floor((number - 1) / 12)]!;
  return {
    id,
    number,
    name,
    character,
    hot: flags.hot ?? false,
    keep: flags.keep ?? false,
    ...(flags.coins !== undefined ? { coins: flags.coins } : {}),
    text,
    image,
  };
}

const TOKEN_TEXT = (a: string, b: string) =>
  `If the ${a} and the ${b} are also in your keep, you immediately win the round.`;

const DEFS: CardDef[] = [
  def('count-token', 'Count Token', '01CountToken.png', { keep: true, coins: -2 },
    TOKEN_TEXT('FOOL TOKEN', 'FRIAR TOKEN')),
  def('acquisition', 'Acquisition', '02Acquisition.png', { hot: true, keep: true },
    'Once per turn (on your turn), if your hand is not empty, you may use one action to discard a card from it. Then, draw from both the pile to your left and the pile to your right, in either order.'),
  def('fiat', 'Fiat', '03Fiat.png', { hot: true, keep: true },
    'All players push their piles to the center. Then, in play order starting with you, players claim a pile from the center.'),
  def('royal-favor', 'Royal Favor', '04RoyalFavor.png', { hot: true, keep: true, coins: 1 },
    'When this card enters your keep, draw a card from your pile.'),
  def('requisition', 'Requisition', '05Requisition.png', {},
    'Choose any pile. Without disturbing its order, look through that pile and choose one card to put into your hand.'),
  def('interest', 'Interest', '06Interest.png', { keep: true },
    'If this card is in your keep when a Coin card enters your keep, draw a card from your pile.'),
  def('chalice', 'Chalice', '07Chalice.png', { keep: true, coins: 4 }, ''),
  def('dagger', 'Dagger', '08Dagger.png', { keep: true, coins: 4 }, ''),
  def('medallion', 'Medallion', '09Medallion.png', { keep: true, coins: 4 }, ''),
  def('scepter', 'Scepter', '10Scepter.png', { keep: true, coins: 4 }, ''),
  def('timepiece', 'Timepiece', '11Timepiece.png', { keep: true, coins: 4 }, ''),
  def('faberge-egg', 'Fabergé Egg', '12FabergeEgg.png', { keep: true, coins: 6 }, ''),
  def('fool-token', 'Fool Token', '13FoolToken.png', { keep: true, coins: -2 },
    TOKEN_TEXT('COUNT TOKEN', 'FRIAR TOKEN')),
  def('juggling', 'Juggling', '14Juggling.png', { hot: true, keep: true },
    'Once per turn (on your turn), you may use one action to swap any two piles.'),
  def('pandemonium', 'Pandemonium', '15Pandemonium.png', { hot: true },
    'Rotate all piles by one position to either the left or the right, your choice.'),
  def('blunder', 'Blunder', '16Blunder.png', { hot: true, keep: true, coins: -20 },
    'This card must be played into your own keep. If BLUNDER is in your keep, you may use two actions to place it face-up onto any pile.'),
  def('joker', 'Joker', '17Joker.png', {},
    'When playing JOKER, reveal a non-Keep card from your hand. JOKER takes the effect of that card.'),
  def('hocus-pocus', 'Hocus Pocus', '18HocusPocus.png', {},
    'Immediately take two actions.'),
  def('legerdemain', 'Legerdemain', '19Legerdemain.png', {},
    'Choose any player. Steal a random card from their hand, then play it as if it were HOT!.'),
  def('pickpocket', 'Pickpocket', '20Pickpocket.png', {},
    'Choose any player. They must surrender all Coin cards from their hand into yours.'),
  def('pluck', 'Pluck', '21Pluck.png', {},
    "All other players must reveal their hand to you. Choose one card from any player's hand to take into yours."),
  def('duplicity', 'Duplicity', '22Duplicity.png', { keep: true },
    'When playing this card, choose another Keep card from your hand to place face down into any keep. If DUPLICITY is in your keep, you may reveal the face-down card at any time, but it does not take effect until then.'),
  def('last-laugh', 'Last Laugh', '23LastLaugh.png', { keep: true },
    'If this card is in your keep when the round ends, you may take one action right before scoring.'),
  def('shackles', 'Shackles', '24Shackles.png', { keep: true, coins: -6 },
    'If this card is in your keep at the start of your turn, take one action on that turn instead of two. You may use one action to discard SHACKLES from your keep.'),
  def('friar-token', 'Friar Token', '25FriarToken.png', { keep: true, coins: -2 },
    TOKEN_TEXT('COUNT TOKEN', 'FOOL TOKEN')),
  def('sanction', 'Sanction', '26Sanction.png', { hot: true, keep: true },
    'Once per turn (on your turn), you may use one action to draw from any pile.'),
  def('invocation', 'Invocation', '27Invocation.png', { hot: true },
    'Draw a card from any pile, then play it as if it were HOT!.'),
  def('revelation', 'Revelation', '28Revelation.png', { hot: true },
    'Choose any pile and flip it entirely upside down (so that the next card in the pile is always visible).'),
  def('epiphany', 'Epiphany', '29Epiphany.png', {},
    'Pick up and look at the top card of all non-empty piles. Choose one to put in your hand.'),
  def('offering', 'Offering', '30Offering.png', {},
    'Discard your hand. Then, all other players must choose a card from their hand to give to you.'),
  def('prayer', 'Prayer', '31Prayer.png', {},
    'Pick up and look at the top card of any non-empty pile; you may take or discard it. If you discard it, draw from that pile afterward.'),
  def('providence', 'Providence', '32Providence.png', {},
    'Swap any two played Keep cards.'),
  def('resurrection', 'Resurrection', '33Resurrection.png', {},
    'Choose one card from the discard to put into your hand.'),
  def('purity', 'Purity', '34Purity.png', { keep: true },
    'This card is worth 10 coins, but only if this keep would otherwise contain a sum of 0 coins. PURITY is not a Coin card.'),
  def('retribution', 'Retribution', '35Retribution.png', { keep: true },
    'If this card is in your keep when another player plays a card that changes your hand or your keep, you must take two actions immediately afterward.'),
  def('tithes', 'Tithes', '36Tithes.png', { keep: true, coins: 'tithes' },
    'This card is worth one coin for each card in this keep, including itself. If TITHES is in your keep, you may use one action to discard all Coin cards in your keep, then look through and reorder the cards in your pile.'),
];

export const CARDS: Readonly<Record<CardId, CardDef>> = Object.fromEntries(
  DEFS.map((d) => [d.id, d]),
) as Record<CardId, CardDef>;

export const TOKENS = ['count-token', 'fool-token', 'friar-token'] as const satisfies readonly CardId[];

export function isCoinCard(id: CardId): boolean {
  return CARDS[id].coins !== undefined;
}

export function cardName(id: CardId): string {
  return CARDS[id].name;
}
