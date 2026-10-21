import { buildPosition, type CardSpec, type PileCardSpec, type PositionSpec } from './builders.ts';
import type { CardId } from './cards.ts';
import type { GameState, Seat } from './state.ts';

// The 25 official puzzles from keepsgame.com/puzzles, as positions.
// Positions were read from the puzzle pages (rules/puzzle-positions.json);
// the texts come from rules/PUZZLES.md.
//
// Seats: you = 0, the player to your left = 1, the upper player = 2, the
// player to your right = 3. It's your turn with two actions (one if Shackled).
// Unknown pile cards are filled quietly (no HOT cards), and opponents hold
// no cards unless the puzzle says otherwise.

export const YOU: Seat = 0;
export const PUZZLE_SEAT_NAMES = ['You', 'Left', 'Upper', 'Right'] as const;

export interface Puzzle {
  id: string;
  title: string;
  difficulty: 'easy' | 'medium' | 'hard';
  /** The puzzle's flavor text and hints. */
  text: string;
  /** The official solution. */
  solution: string;
  url: string;
  spec: PositionSpec;
  /** Where this position departs from the printed puzzle, and why. */
  adaptation?: string;
}

/** A pile of `size` cards, optionally with a known card face up on top. */
function pile(size: number, top?: CardId): PileCardSpec[] {
  const unknown: PileCardSpec[] = Array.from({ length: size - (top ? 1 : 0) }, () => '?' as CardSpec);
  return top ? [{ id: top, faceUp: true }, ...unknown] : unknown;
}

interface Layout {
  piles: [number | [number, CardId], number | [number, CardId], number | [number, CardId], number | [number, CardId]];
  keeps: [CardId[], CardId[], CardId[], CardId[]];
  hand: CardId[];
  discard: CardId[];
  /** Opponents' hands, where the puzzle tells us. */
  hands?: Partial<Record<1 | 2 | 3, CardId[]>>;
}

function position({ piles, keeps, hand, discard, hands }: Layout): PositionSpec {
  const pileSpec = (p: Layout['piles'][number]) => (typeof p === 'number' ? pile(p) : pile(p[0], p[1]));
  return {
    piles: { 0: pileSpec(piles[0]), 1: pileSpec(piles[1]), 2: pileSpec(piles[2]), 3: pileSpec(piles[3]) },
    keeps: { 0: keeps[0], 1: keeps[1], 2: keeps[2], 3: keeps[3] },
    hands: { 0: hand, ...hands },
    discard,
    turn: YOU,
    fill: 'quiet',
    seed: 'puzzle',
  };
}

const page = (slug: string) => `https://www.keepsgame.com/items/${slug}`;

export const PUZZLES: readonly Puzzle[] = [
  {
    id: 'P-01',
    title: 'Humble Beginnings',
    difficulty: 'easy',
    text: "Welcome to your first Keeps puzzle. Let's start things off easy. Remember, you must win in two actions.",
    solution: 'You are already in the lead, and your pile has only one card. Draw twice: the second draw, from your empty pile, ends the round with you ahead.',
    url: page('humble-beginnings'),
    spec: position({
      piles: [1, 3, 2, 0],
      keeps: [['faberge-egg'], ['blunder', 'chalice'], ['friar-token', 'royal-favor'], ['sanction']],
      hand: ['medallion'],
      discard: ['pandemonium', 'legerdemain', 'offering'],
    }),
  },
  {
    id: 'P-02',
    title: 'Divine Intervention',
    difficulty: 'easy',
    text: 'You have -8 coins, and you can still win. Let that sink in.',
    solution:
      'The upper player has 5 coins (Tithes is worth one per card in its keep). Play Providence to swap your Blunder with their Medallion (or Tithes): you have 4 coins and they go negative. The left player has 3, so you lead. Then draw from your empty pile to end the round.',
    url: page('divine-intervention'),
    spec: position({
      piles: [0, 3, 0, 1],
      keeps: [['blunder', 'medallion'], ['faberge-egg', 'duplicity'], ['juggling', 'tithes', 'scepter'], []],
      hand: ['providence', 'shackles'],
      discard: ['epiphany', 'pickpocket', 'joker'],
    }),
    adaptation:
      'The printed puzzle shows a Medallion in both your keep and the upper keep, but the deck has only one. The upper keep has a Scepter instead, also worth 2 coins.',
  },
  {
    id: 'P-03',
    title: 'Rags to Riches',
    difficulty: 'easy',
    text: 'What secrets lurk in your heart?',
    solution:
      'With Sanction in your keep, you can end the round with one action by drawing from any empty pile. First play Purity into your keep (0 to 10 coins), then use Sanction on the empty right pile.',
    url: page('rags-to-riches'),
    spec: position({
      piles: [2, 4, 5, 0],
      keeps: [['sanction'], ['acquisition', 'dagger', 'timepiece'], ['retribution'], ['shackles']],
      hand: ['hocus-pocus', 'purity'],
      discard: ['requisition', 'pluck', 'epiphany'],
    }),
  },
  {
    id: 'P-04',
    title: 'This Looks Familiar',
    difficulty: 'medium',
    text: 'I mean, did you even watch the tutorial?? Notice that the Fabergé Egg is worth three coins…',
    solution:
      'Use Juggling to swap the left (empty) and upper piles. Then play the Fool Token on the upper player: they have Interest, so they must draw from their newly empty pile, ending the round. You tie on coins, but since they drew to end it, you win the tie.',
    url: page('a-twist-of-fate'),
    spec: position({
      piles: [3, 0, 2, 3],
      keeps: [['juggling', 'medallion'], ['chalice', 'shackles'], ['faberge-egg', 'interest'], ['retribution']],
      hand: ['epiphany', 'fool-token'],
      discard: ['tithes', 'prayer', 'invocation'],
    }),
  },
  {
    id: 'P-05',
    title: 'Better Than Two Pair',
    difficulty: 'medium',
    text: 'Our opponents have 6, 7, and 10 coins. We have -11. Uh oh…',
    solution:
      'Collect all three Tokens. Play Hocus Pocus (one action for two), then play the Fool Token into your keep, draw the Friar Token, and play it too: all three Tokens are in your keep, an immediate win.',
    url: page('better-than-two-pair'),
    spec: position({
      piles: [[1, 'friar-token'], 4, 3, 1],
      keeps: [['blunder', 'count-token'], ['juggling', 'tithes', 'acquisition', 'timepiece'], ['dagger', 'faberge-egg', 'interest', 'medallion'], ['purity', 'retribution']],
      hand: ['hocus-pocus', 'fool-token'],
      discard: ['requisition', 'joker', 'revelation'],
    }),
  },
  {
    id: 'P-06',
    title: 'Best Served Cold',
    difficulty: 'hard',
    text: 'You have deduced that the upper player has a card that can steal a card from your hand, and the left and right players both are empty-handed. Hint: it starts with Providence.',
    solution:
      'Use Providence to swap your Retribution with the left player’s Dagger, making your Purity worth 10. Then play Last Laugh on the left player, triggering their Retribution. Wherever they play the Count Token, you win.',
    url: page('best-served-cold'),
    spec: position({
      piles: [3, [1, 'count-token'], 0, 3],
      keeps: [['purity', 'friar-token', 'retribution', 'fool-token'], ['dagger', 'faberge-egg'], ['interest', 'scepter'], ['blunder']],
      hand: ['last-laugh', 'providence'],
      discard: ['pickpocket', 'fiat', 'prayer'],
      hands: { 2: ['legerdemain'] },
    }),
    adaptation: 'The upper player’s stealing card is unspecified; here it is Legerdemain.',
  },
  {
    id: 'P-07',
    title: 'Nothing Doing',
    difficulty: 'hard',
    text: 'The other players have 5.5, 4, and 10 coins. The piles are all empty save one card, and there are only three cards in the discard. Any correct solution must account for the Last Laugh messing you up in any possible way. There are two unique solutions. Find them both!',
    solution:
      'Solution 1: Pluck the Fool Token, play Hocus Pocus, play Duplicity hiding the Fool Token in your keep, reveal it, then use Providence to swap Duplicity with the Count Token for the win. Solution 2: Pluck Joker, play Hocus Pocus, play Joker as Providence to swap your Friar Token and the upper Last Laugh, draw to end the round, then with Last Laugh use Providence to swap Last Laugh and Purity.',
    url: page('nothing-doing'),
    spec: position({
      piles: [0, 0, [1, 'blunder'], 0],
      keeps: [['friar-token'], ['sanction', 'dagger', 'faberge-egg', 'royal-favor'], ['chalice', 'last-laugh', 'acquisition', 'scepter'], ['count-token', 'purity', 'tithes', 'shackles']],
      hand: ['hocus-pocus', 'duplicity', 'pluck', 'providence'],
      discard: ['invocation', 'fiat', 'pandemonium'],
      hands: { 1: ['fool-token', 'joker'] },
    }),
    adaptation: 'The page doesn’t show the opponents’ hands; here the left player holds the Fool Token and Joker.',
  },
  {
    id: 'P-08',
    title: 'Last Laugh 1',
    difficulty: 'easy',
    text: 'Yeah, the solution probably involves Last Laugh. Take a look at your keep.',
    solution: 'Play either card into your keep, then draw from your empty pile to end the round. With Last Laugh’s action, play your other card into your keep.',
    url: page('last-laugh-1'),
    spec: position({
      piles: [0, 3, 2, 5],
      keeps: [['last-laugh'], ['faberge-egg'], ['blunder'], ['sanction']],
      hand: ['timepiece', 'dagger'],
      discard: ['scepter', 'pandemonium', 'fiat'],
    }),
  },
  {
    id: 'P-09',
    title: 'Last Laugh 2',
    difficulty: 'medium',
    text: 'The left player has 10 coins to your 3… You don’t have to outrun the bear, you just have to outrun your opponents.',
    solution: 'Draw from your pile, then draw from your now-empty pile to end the round. With Last Laugh, play your Medallion into the left player’s keep: Purity is now worthless.',
    url: page('last-laugh-2'),
    spec: position({
      piles: [1, 3, 4, 7],
      keeps: [['faberge-egg', 'last-laugh'], ['purity'], ['sanction', 'chalice'], ['juggling']],
      hand: ['requisition', 'medallion'],
      discard: ['fool-token', 'shackles', 'invocation'],
    }),
  },
  {
    id: 'P-10',
    title: 'Last Laugh 3',
    difficulty: 'hard',
    text: 'The player to your left has no cards in their hand. Maybe you can use that somehow…',
    solution:
      'Use Sanction to draw Last Laugh and play it into your keep. Your turn ends, and the empty-handed left player must draw from their empty pile, ending the round. With Last Laugh: play Hocus Pocus, Resurrection to take Providence, and Providence to swap Sanction and Purity.',
    url: page('last-laugh-3'),
    spec: position({
      piles: [4, 0, 3, [1, 'last-laugh']],
      keeps: [['sanction'], ['purity'], ['scepter', 'acquisition', 'faberge-egg', 'timepiece'], ['count-token', 'fool-token']],
      hand: ['resurrection', 'hocus-pocus'],
      discard: ['epiphany', 'interest', 'providence'],
    }),
  },
  {
    id: 'P-11',
    title: 'Royal Favor 1',
    difficulty: 'easy',
    text: 'Your pile was revealed to show Royal Favor. It’s HOT! Remember that Keep cards can be played into anyone’s keep…',
    solution: 'Play Shackles on the upper player. Then draw Royal Favor; it’s HOT, so play it at once on the right player, who must draw from their empty pile, ending the round.',
    url: page('royal-favor-1'),
    spec: position({
      piles: [[3, 'royal-favor'], 2, 4, 0],
      keeps: [['scepter'], ['acquisition', 'juggling'], ['timepiece', 'dagger', 'friar-token'], []],
      hand: ['shackles'],
      discard: ['pandemonium', 'offering', 'providence'],
    }),
  },
  {
    id: 'P-12',
    title: 'Royal Favor 2',
    difficulty: 'medium',
    text: 'The upper player has 11 coins. Even Purity can’t top that. But they seem to be in a precarious position…',
    solution: 'Play Providence, swapping Royal Favor with Tithes or the Fabergé Egg. The upper player must draw Blunder. Then use Sanction to draw from the empty left pile, ending the round.',
    url: page('royal-favor-2'),
    spec: position({
      piles: [1, 0, [3, 'blunder'], 3],
      keeps: [['purity', 'royal-favor', 'sanction'], ['juggling', 'shackles'], ['tithes', 'chalice', 'faberge-egg', 'medallion'], ['fool-token']],
      hand: ['providence'],
      discard: ['resurrection', 'requisition', 'pickpocket'],
    }),
  },
  {
    id: 'P-13',
    title: 'Royal Favor 3',
    difficulty: 'hard',
    text: 'You are Shackled: you only get ONE action this turn. Remember that ties go to the tied player most directly left of whoever draws to end the round.',
    solution:
      'Play Resurrection to take Royal Favor; it’s HOT, so put it in the right player’s keep. Their Interest makes them draw Blunder (HOT, into their own keep), and Interest makes them draw again from their empty pile, ending the round. You tie with the left player but win the tie-break.',
    url: page('royal-favor-3'),
    spec: position({
      piles: [4, 3, 4, [1, 'blunder']],
      keeps: [['medallion', 'faberge-egg', 'shackles'], ['chalice', 'sanction'], ['tithes', 'count-token'], ['scepter', 'dagger', 'interest']],
      hand: ['offering', 'resurrection'],
      discard: ['friar-token', 'royal-favor', 'joker'],
    }),
  },
  {
    id: 'P-14',
    title: 'Purity 1',
    difficulty: 'easy',
    text: 'Have you ever gone from Hero to Zero? What about Hero to Negative One?',
    solution: 'Play the Friar Token into the upper player’s keep (10 to -1 coins). Then draw from your empty pile to end the round.',
    url: page('purity-1'),
    spec: position({
      piles: [0, 2, 2, 0],
      keeps: [['medallion'], ['fool-token', 'count-token'], ['purity', 'juggling'], ['acquisition']],
      hand: ['friar-token'],
      discard: ['invocation', 'interest', 'hocus-pocus'],
    }),
  },
  {
    id: 'P-15',
    title: 'Purity 2',
    difficulty: 'medium',
    text: 'Some decisions may seem terrible on the surface.',
    solution: 'Play Shackles into your own keep, so it adds up to zero coins and Purity is worth 10. Then draw from your empty pile.',
    url: page('purity-2'),
    spec: position({
      piles: [0, 0, 3, 0],
      keeps: [['purity', 'faberge-egg'], ['acquisition'], ['interest', 'duplicity'], ['timepiece', 'royal-favor', 'retribution', 'scepter']],
      hand: ['shackles'],
      discard: ['offering', 'fool-token', 'pluck'],
    }),
  },
  {
    id: 'P-16',
    title: 'Purity 3',
    difficulty: 'hard',
    text: 'Sometimes it takes money to take money. You might have to read closely for this one!',
    solution: 'Use Resurrection to take Tithes, and play it into your keep: Interest forces a draw from your empty pile, ending the round. With Last Laugh, use Tithes to discard your Coin cards. Purity is worth 10.',
    url: page('purity-3'),
    spec: position({
      piles: [0, 2, 0, 1],
      keeps: [['last-laugh', 'interest', 'purity', 'chalice'], ['retribution', 'sanction', 'royal-favor'], ['fool-token', 'duplicity'], ['medallion', 'faberge-egg', 'timepiece']],
      hand: ['count-token', 'resurrection', 'joker'],
      discard: ['pandemonium', 'tithes', 'requisition'],
    }),
  },
  {
    id: 'P-17',
    title: 'Blunder 1',
    difficulty: 'easy',
    text: 'The only real mistakes are the ones we don’t learn from. Negative seven coins?',
    solution: 'Play Hocus Pocus (now three actions). Use two to put Blunder on any pile but your own, then draw from your empty pile to end the round.',
    url: page('blunder-1'),
    spec: position({
      piles: [0, 1, 2, 1],
      keeps: [['faberge-egg', 'blunder'], ['medallion'], ['dagger'], ['fool-token', 'friar-token']],
      hand: ['hocus-pocus'],
      discard: ['epiphany', 'interest', 'prayer'],
    }),
  },
  {
    id: 'P-18',
    title: 'Blunder 2',
    difficulty: 'medium',
    text: 'The left player has only a single card in their hand, which you have deduced to be Hocus Pocus.',
    solution: 'Play Scepter into your keep, and the Count Token into the upper player’s keep. The left player is then forced to draw Blunder (Hocus Pocus and Tithes don’t avoid it), and their Interest makes them draw from their empty pile.',
    url: page('blunder-2'),
    spec: position({
      piles: [3, [1, 'blunder'], 3, 0],
      keeps: [['sanction'], ['tithes', 'interest', 'faberge-egg', 'medallion'], ['timepiece'], ['shackles', 'acquisition']],
      hand: ['count-token', 'scepter'],
      discard: ['offering', 'fiat', 'pickpocket'],
      hands: { 1: ['hocus-pocus'] },
    }),
  },
  {
    id: 'P-19',
    title: 'Blunder 3',
    difficulty: 'hard',
    text: 'There’s more than one way to fix a mistake.',
    solution: 'Play Purity into your keep. Draw Blunder: it goes into your keep, and Interest makes you draw from your empty pile, ending the round. With Last Laugh, use Tithes to discard every Coin card in your keep. You are pure again.',
    url: page('blunder-3'),
    spec: position({
      piles: [[1, 'blunder'], 2, 4, 2],
      keeps: [['fool-token', 'tithes', 'last-laugh', 'interest'], ['sanction', 'duplicity'], ['royal-favor', 'faberge-egg'], ['timepiece', 'scepter', 'juggling']],
      hand: ['shackles', 'purity', 'retribution'],
      discard: ['legerdemain', 'revelation', 'pandemonium'],
    }),
  },
  {
    id: 'P-20',
    title: 'Resurrection 1',
    difficulty: 'easy',
    text: 'Are you feeling HOT! HOT! HOT!?',
    solution: 'Play Resurrection, taking Pandemonium. It’s HOT: rotate the piles so the empty right pile comes to you. Then draw from it to end the round.',
    url: page('resurrection-1'),
    spec: position({
      piles: [3, 4, 2, 0],
      keeps: [['tithes', 'faberge-egg'], ['purity', 'shackles'], ['medallion', 'count-token'], ['sanction']],
      hand: ['resurrection'],
      discard: ['epiphany', 'last-laugh', 'pandemonium'],
    }),
  },
  {
    id: 'P-21',
    title: 'Resurrection 2',
    difficulty: 'medium',
    text: 'Good thing Keeps is not a zero sum game.',
    solution: 'Play Resurrection, taking Prayer. Use Prayer on the right pile: discard its card, then draw from it (now empty) to end the round. With Last Laugh, play the Friar Token into your keep: zero coins, so Purity is worth 10.',
    url: page('resurrection-2'),
    spec: position({
      piles: [5, 3, 3, 1],
      keeps: [['medallion', 'last-laugh', 'purity', 'count-token'], ['acquisition', 'blunder', 'royal-favor'], ['interest', 'tithes', 'timepiece'], ['faberge-egg', 'retribution']],
      hand: ['friar-token', 'resurrection'],
      discard: ['invocation', 'prayer', 'providence'],
    }),
  },
  {
    id: 'P-22',
    title: 'Resurrection 3',
    difficulty: 'hard',
    text: 'Does this count as necromancy?',
    solution: 'Play Joker as Resurrection to take Invocation, and Invoke Hocus Pocus. Play Shackles on the left player and Medallion on yourself. Then play Resurrection, taking Invocation again, and Invoke from the empty pile to end the round.',
    url: page('resurrection-3'),
    spec: position({
      piles: [4, 0, 3, [7, 'hocus-pocus']],
      keeps: [['chalice'], ['juggling', 'tithes', 'scepter'], ['faberge-egg'], ['retribution', 'blunder']],
      hand: ['medallion', 'shackles', 'joker', 'resurrection'],
      discard: ['invocation', 'epiphany', 'dagger'],
    }),
  },
  {
    id: 'P-23',
    title: 'Tokens 1',
    difficulty: 'easy',
    text: '“Blunder does not scare me!” Said the Count Token.',
    solution: 'Play Hocus Pocus: three actions. Play the three Tokens into your keep. No Last Laugh, no nothing: even at -13 coins, the round is yours.',
    url: page('tokens-1'),
    spec: position({
      piles: [3, 5, 3, 2],
      keeps: [['blunder'], ['purity'], ['scepter', 'last-laugh'], ['faberge-egg', 'tithes']],
      hand: ['hocus-pocus', 'count-token', 'fool-token', 'friar-token'],
      discard: ['pickpocket', 'pluck', 'fiat'],
    }),
  },
  {
    id: 'P-24',
    title: 'Tokens 2',
    difficulty: 'medium',
    text: 'Once is luck, and twice is skill. But the third Token’s the charm.',
    solution: 'Use Acquisition, discarding Providence, to draw the Friar Token and some other card. Play one Token into your keep: Interest triggers, ending the round. With Last Laugh, play the other Token into your keep.',
    url: page('tokens-2'),
    spec: position({
      piles: [0, [2, 'friar-token'], 1, 3],
      keeps: [['acquisition', 'last-laugh', 'interest', 'fool-token'], ['faberge-egg', 'juggling'], ['dagger', 'timepiece', 'sanction'], ['shackles']],
      hand: ['providence', 'count-token'],
      discard: ['offering', 'revelation', 'chalice'],
    }),
  },
  {
    id: 'P-25',
    title: 'Tokens 3',
    difficulty: 'hard',
    text: 'So you think you can dance? The other three players are all empty-handed.',
    solution: 'Play Hocus Pocus. Play Joker as Providence to swap Interest and Scepter. Play Providence to swap Scepter and Juggling: Interest makes the upper player draw the Count Token. Play Legerdemain on them and play their only card, the Count Token, into your keep.',
    url: page('tokens-3'),
    spec: position({
      piles: [0, 2, [3, 'count-token'], 0],
      keeps: [['fool-token', 'friar-token'], ['dagger', 'faberge-egg', 'medallion', 'tithes'], ['juggling', 'scepter'], ['interest', 'purity']],
      hand: ['providence', 'hocus-pocus', 'joker', 'legerdemain'],
      discard: ['requisition', 'pluck', 'prayer'],
    }),
  },
];

export function puzzleById(id: string): Puzzle | undefined {
  return PUZZLES.find((p) => p.id === id);
}

export function puzzleState(puzzle: Puzzle): GameState {
  return buildPosition(puzzle.spec);
}

/**
 * won: the round ended and you won it. lost: it ended otherwise, or play came
 * back around to your next turn without the round ending.
 */
export function puzzleOutcome(state: GameState, startTurn: number): 'won' | 'lost' | 'playing' {
  if (state.phase === 'round-over' || state.phase === 'game-over') return state.lastRoundWinner === YOU ? 'won' : 'lost';
  if (state.turn?.seat === YOU && state.turnNumber > startTurn) return 'lost';
  return 'playing';
}
