// Every rule the engine must implement, with its source. spec-coverage.test.ts
// requires a test whose name starts with each id (e.g. `it('C-01 …')`).
//
// R-*: rules card (rules/Rules_front.png, Rules_back.png)
// C-*: official clarifications (keepsgame.com/clarify)
// Q-*: our rulings on open questions (docs/ENGINE.md, "Rulings and open questions")
// K-*: card behaviors we explicitly want pinned down by a test
// P-*: official puzzles (rules/PUZZLES.md)

export interface SpecItem {
  id: string;
  text: string;
}

export const SPEC: readonly SpecItem[] = [
  // Rules card
  { id: 'R-01', text: 'Setup: 3 character piles of 12; the top 3 of each form the shuffled Mask; 4 piles of 9; random positions.' },
  { id: 'R-02', text: 'With fewer than 4 players, ghost seats keep their piles but have no keep, hand, or actions.' },
  { id: 'R-03', text: 'Exactly two actions per turn: draw from your pile, or play a card from your hand. No passing.' },
  { id: 'R-04', text: "The last round's winner plays first; play continues to the left, skipping ghosts." },
  { id: 'R-05', text: 'HOT! cards use no action and must be played as soon as they enter a hand, by any means.' },
  { id: 'R-06', text: "Keep cards are played face-up into ANY player's keep; non-Keep cards are discarded face up." },
  { id: 'R-07', text: 'The round ends whenever any player draws from an empty pile (by any means).' },
  { id: 'R-08', text: 'Most coins wins; a tie goes to the tied player most directly left of whoever drew to end the round.' },
  { id: 'R-09', text: 'The round winner earns a Victory Mark; the first to three (configurable) wins the game.' },
  { id: 'R-10', text: "Always public: pile sizes, played Keep cards, discarded cards, each player's hand size." },

  // Clarifications
  { id: 'C-01', text: "Simultaneous triggers resolve in order: Legerdemain's HOT! card, Retribution, Interest, Royal Favor." },
  { id: 'C-02', text: 'After an empty pile is drawn from, no more actions happen except Last Laugh and whatever it triggers.' },
  { id: 'C-03', text: 'Duplicity can reveal its face-down card after round end, before or after Last Laugh.' },
  { id: 'C-04', text: 'Three Tokens face-up in one keep after round end is still a token victory; only that player gets a mark.' },
  { id: 'C-05', text: 'Any number of actions may be used to draw from an empty pile after round end.' },
  { id: 'C-06', text: 'With two players, players sit at opposing piles, not adjacent ones.' },
  { id: 'C-07', text: "Acquisition can't be used for Retribution or Last Laugh actions." },
  { id: 'C-08', text: 'Any two consecutive player actions can be used to remove Blunder.' },
  { id: 'C-09', text: 'All three Tokens in a keep ends the round instantly (even after round end): no Last Laugh, no Retribution; that player gets the mark.' },
  { id: 'C-10', text: 'With Duplicity, all three Tokens must be face-up for a token victory.' },
  { id: 'C-11', text: "Revealing Duplicity's face-down card uses no action and can happen any time, even after Last Laugh." },
  { id: 'C-12', text: 'A face-down Last Laugh can be revealed at the very end to get its action.' },
  { id: 'C-13', text: 'A face-down Retribution can be revealed as soon as the triggering card is played, to get the two actions.' },
  { id: 'C-14', text: "A face-down Shackles can be revealed after a player's first action, ending their turn." },
  { id: 'C-15', text: 'A face-down Interest can be revealed as soon as a coin card enters the keep, forcing the draw.' },
  { id: 'C-16', text: 'When Duplicity is played, it or its face-down card can trigger Retribution, not both; revealing never triggers Retribution.' },
  { id: 'C-17', text: 'Placing or revealing the face-down card never triggers Interest.' },
  { id: 'C-18', text: "The face-down card counts as a card for Tithes, but Tithes' discard never removes it." },
  { id: 'C-19', text: 'Fiat: only real players claim a pile (ghosts are skipped).' },
  { id: 'C-20', text: 'Fiat with two players: whoever played Fiat chooses the positions of the remaining two piles.' },
  { id: 'C-21', text: 'Interest does not trigger when Providence swaps it with a Coin card.' },
  { id: 'C-22', text: 'Last Laugh does not trigger when the round ends by token victory.' },
  { id: 'C-23', text: "Acquisition, Sanction, and Juggling can't be used with Last Laugh's action." },
  { id: 'C-24', text: "Duplicity: Last Laugh can be revealed after round end for its action; the face-down card can be revealed after Last Laugh's action." },
  { id: 'C-25', text: 'Legerdemain may target yourself, but the card is still chosen randomly.' },
  { id: 'C-26', text: 'Legerdemain may target ghost players.' },
  { id: 'C-27', text: 'Legerdemain from a Retribution owner: the stolen card is played first; if it also affects that player, Retribution triggers twice (4 actions).' },
  { id: 'C-28', text: 'Pickpocket may target ghost players.' },
  { id: 'C-29', text: 'Providence can swap two cards in the same keep.' },
  { id: 'C-30', text: 'Providence swapping Retribution out of a keep still triggers it for that player.' },
  { id: 'C-31', text: 'Purity is worth 10 if the other Coin cards in the keep total zero (e.g. Dagger and two Tokens).' },
  { id: 'C-32', text: 'Resurrection can resurrect Resurrection.' },
  { id: 'C-33', text: "Acquisition, Sanction, and Juggling can't be used with Retribution's actions." },
  { id: 'C-34', text: "Sanction can't be used for Retribution or Last Laugh actions." },
  { id: 'C-35', text: "Juggling can't be used for Retribution or Last Laugh actions." },
  { id: 'C-36', text: 'Discarding Coin cards with Tithes also discards Tithes itself.' },

  // Our rulings (docs/ENGINE.md)
  { id: 'Q-01', text: 'Fiat (HOT + Keep): its effect happens when played; it then sits in the keep with no effect.' },
  { id: 'Q-02', text: 'Triggers caused while resolving a trigger resolve before its remaining siblings (depth-first).' },
  { id: 'Q-03', text: "Blunder's two actions may span contiguous same-seat action frames, but not separate turns." },
  { id: 'Q-04', text: 'Only the player who placed a face-down card knows it; a different Duplicity holder reveals it blind.' },
  { id: 'Q-05', text: 'Providence can swap a face-down card; it stays face-down.' },
  { id: 'Q-06', text: 'Revealing a face-down Royal Favor does not count as it entering the keep.' },
  { id: 'Q-07', text: 'Shackles revealed mid-turn zeroes only the turn frame; already-granted Hocus Pocus actions remain.' },
  { id: 'Q-08', text: "Acquisition's left and right piles are determined at the time of each draw." },
  { id: 'Q-09', text: "Joker can't be played from hand without a non-Keep card to reveal; played as HOT with none, it has no effect." },
  { id: 'Q-10', text: 'Revelation on an already-flipped pile flips it back.' },
  { id: 'Q-11', text: 'Legerdemain and Pickpocket may target yourself (Pickpocket on yourself does nothing).' },
  { id: 'Q-12', text: 'The first player of the first round is chosen by the host, or at random.' },
  { id: 'Q-13', text: 'Retribution triggers only from played cards, not keep abilities like Juggling or Tithes.' },
  { id: 'Q-14', text: 'Royal Favor entering a keep via a Providence swap triggers its draw.' },
  { id: 'Q-15', text: 'Retribution triggers only for a player who had it face-up when the play started; receiving it in that play (e.g. via Providence) does not trigger it.' },

  // Card behaviors
  {
    id: 'K-01',
    text:
      'Invocation: the card it draws is played as if HOT!, so that play uses no action. ' +
      'Invocation is itself HOT!, so the whole chain costs no action ' +
      '(e.g. Resurrection 3: Invocation reached via Joker-Resurrection invokes Hocus Pocus for free).',
  },
  {
    id: 'K-02',
    text: 'Legerdemain: the stolen card is played as if HOT!, using no action beyond the one spent on Legerdemain.',
  },

  // Official puzzles
  { id: 'P-01', text: 'Humble Beginnings' },
  { id: 'P-02', text: 'Divine Intervention' },
  { id: 'P-03', text: 'Rags to Riches' },
  { id: 'P-04', text: 'This Looks Familiar' },
  { id: 'P-05', text: 'Better Than Two Pair' },
  { id: 'P-06', text: 'Best Served Cold' },
  { id: 'P-07', text: 'Nothing Doing' },
  { id: 'P-08', text: 'Last Laugh 1' },
  { id: 'P-09', text: 'Last Laugh 2' },
  { id: 'P-10', text: 'Last Laugh 3' },
  { id: 'P-11', text: 'Royal Favor 1' },
  { id: 'P-12', text: 'Royal Favor 2' },
  { id: 'P-13', text: 'Royal Favor 3' },
  { id: 'P-14', text: 'Purity 1' },
  { id: 'P-15', text: 'Purity 2' },
  { id: 'P-16', text: 'Purity 3' },
  { id: 'P-17', text: 'Blunder 1' },
  { id: 'P-18', text: 'Blunder 2' },
  { id: 'P-19', text: 'Blunder 3' },
  { id: 'P-20', text: 'Resurrection 1' },
  { id: 'P-21', text: 'Resurrection 2' },
  { id: 'P-22', text: 'Resurrection 3' },
  { id: 'P-23', text: 'Tokens 1' },
  { id: 'P-24', text: 'Tokens 2' },
  { id: 'P-25', text: 'Tokens 3' },
];
