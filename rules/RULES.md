# Keeps — Rules Reference

Sources (fetched 2026-10-20):
- Official rules card: `Rules_front.png`, `Rules_back.png` (from keepsgame.com/how-to-play)
- Official clarifications: keepsgame.com/clarify
- Card text transcribed from `../cards/*.png`
- Tutorial video: https://www.youtube.com/watch?v=VKnJIA9AqsY (not transcribed)

## Components

36 cards: 12 per character (Count, Fool, Friar). Card IDs below match filenames in `../cards/`.

## Setup

1. Separate the 36 cards into the 3 character piles (Count, Fool, Friar). Shuffle each pile face-down.
2. Take the top 3 cards from each pile, combine them into a new pile, and shuffle it. You now have 4 piles of 9 cards: the Count, the Fool, the Friar, and the **Mask** (an equal mix of the first three).
3. With no one looking, randomize the positions of the piles.
4. While *you* are not looking, another player distributes the piles randomly to the players. With fewer than 4 players, the leftover piles go to **"ghost" players**, who have no keeps, hands, or actions. Their piles are still part of the game.
   - Nobody knows which character's pile is which. That's hidden information you figure out during play.
   - With 2 players, the players sit at opposite piles, not adjacent ones (clarification).

Table layout: 4 seats. Each seat has a **PILE** (face-down stack) and a **KEEP** (face-up cards in front of the player). There is one shared **DISCARD** in the center.

## Gameplay

- Each player has a PILE and a KEEP. The PILE is a stack you draw from. The KEEP holds cards in front of you that provide effects. It starts empty.
- On your turn you **MUST take exactly TWO actions**. Each action is one of:
  - **DRAW** a card from your pile into your hand, or
  - **PLAY** a card from your hand.
- The first player is whoever won the last round (otherwise "the wisest player"). Play continues to the **left**.

## Card types

- **HOT!** (flame icon): playing it uses NO action, but it MUST be played AS SOON AS it enters your hand. Never held. Applies however it entered your hand (draw, steal, Resurrection, etc.).
- **Keep cards** (chest icon): played from hand face-up into **ANY** player's keep. They do nothing until they're in a keep.
- **Coin value**: some Keep cards have one. Whoever has the MOST coins in their keep when the round ends wins the round.
- **Non-Keep cards** are discarded FACE UP to the center when played.

## Round end and scoring

- Empty piles still count as piles. They can be moved, and "drawn" from.
- **The round ENDS whenever any player draws from an empty pile.**
- **Tie:** the win goes to the tied player who is most directly left of the player who drew to end the round. ("Don't end the round if you are tied!")
- The round winner earns a **Victory Mark**. The first to **3 marks** wins the game (adjustable).
- **Token victory:** having all three Tokens (Count, Fool, Friar) face-up in one keep wins the round immediately (see clarifications).

## Public information (always visible to all)

- The number of cards in each pile
- Every played Keep card
- All discarded cards
- The number of cards in each player's hand

## Card list

Char = character (pile of origin). Coins = coin value if it's a Coin card.

| # | Name | Char | HOT | Keep | Coins | Text |
|---|------|------|-----|------|-------|------|
| 01 | Count Token | Count | | ✓ | −1 | If the FOOL TOKEN and the FRIAR TOKEN are also in your keep, you immediately win the round. |
| 02 | Acquisition | Count | ✓ | ✓ | | Once per turn (on your turn), if your hand is not empty, you may use one action to discard a card from it. Then, draw from both the pile to your left and the pile to your right, in either order. |
| 03 | Fiat | Count | ✓ | ✓ | | All players push their piles to the center. Then, in play order starting with you, players claim a pile from the center. |
| 04 | Royal Favor | Count | ✓ | ✓ | 0.5 | When this card enters your keep, draw a card from your pile. |
| 05 | Requisition | Count | | | | Choose any pile. Without disturbing its order, look through that pile and choose one card to put into your hand. |
| 06 | Interest | Count | | ✓ | | If this card is in your keep when a Coin card enters your keep, draw a card from your pile. |
| 07 | Chalice | Count | | ✓ | 2 | — |
| 08 | Dagger | Count | | ✓ | 2 | — |
| 09 | Medallion | Count | | ✓ | 2 | — |
| 10 | Scepter | Count | | ✓ | 2 | — |
| 11 | Timepiece | Count | | ✓ | 2 | — |
| 12 | Fabergé Egg | Count | | ✓ | 3 | — |
| 13 | Fool Token | Fool | | ✓ | −1 | If the COUNT TOKEN and the FRIAR TOKEN are also in your keep, you immediately win the round. |
| 14 | Juggling | Fool | ✓ | ✓ | | Once per turn (on your turn), you may use one action to swap any two piles. |
| 15 | Pandemonium | Fool | ✓ | | | Rotate all piles by one position to either the left or the right, your choice. |
| 16 | Blunder | Fool | ✓ | ✓ | −10 | This card must be played into your own keep. If BLUNDER is in your keep, you may use two actions to place it face-up onto any **pile**. |
| 17 | Joker | Fool | | | | When playing JOKER, reveal a non-Keep card from your hand. JOKER takes the effect of that card. |
| 18 | Hocus Pocus | Fool | | | | Immediately take two actions. |
| 19 | Legerdemain | Fool | | | | Choose any player. Steal a random card from their hand, then **play it** as if it were HOT!. |
| 20 | Pickpocket | Fool | | | | Choose any player. They must surrender all Coin cards from their hand into yours. |
| 21 | Pluck | Fool | | | | All other players must reveal their hand to you. Choose one card from any player's hand to take into yours. |
| 22 | Duplicity | Fool | | ✓ | | When playing this card, choose another Keep card from your hand to place face down into any keep. If DUPLICITY is in your keep, you may reveal the face-down card at **any** time, but it does not take effect until then. |
| 23 | Last Laugh | Fool | | ✓ | | If this card is in your keep when the round ends, you may take one action right before scoring. |
| 24 | Shackles | Fool | | ✓ | −3 | If this card is in your keep at the start of your turn, take one action on that turn instead of two. You may use one action to discard SHACKLES from your keep. |
| 25 | Friar Token | Friar | | ✓ | −1 | If the COUNT TOKEN and the FOOL TOKEN are also in your keep, you immediately win the round. |
| 26 | Sanction | Friar | ✓ | ✓ | | Once per turn (on your turn), you may use one action to draw from any pile. |
| 27 | Invocation | Friar | ✓ | | | Draw a card from any pile, then **play it** as if it were HOT!. |
| 28 | Revelation | Friar | ✓ | | | Choose any pile and flip it entirely upside down (so that the next card in the pile is always visible). |
| 29 | Epiphany | Friar | | | | Pick up and look at the top card of all non-empty piles. Choose one to put in your hand. |
| 30 | Offering | Friar | | | | Discard your hand. Then, all other players must choose a card from their hand to give to you. |
| 31 | Prayer | Friar | | | | Pick up and look at the top card of any non-empty pile; you may take or discard it. If you discard it, draw from that pile afterward. |
| 32 | Providence | Friar | | | | Swap any two played Keep cards. |
| 33 | Resurrection | Friar | | | | Choose one card from the discard to put into your hand. |
| 34 | Purity | Friar | | ✓ | (10) | This card is worth 10 coins, but only if this keep would otherwise contain a sum of 0 coins. PURITY is not a Coin card. |
| 35 | Retribution | Friar | | ✓ | | If this card is in your keep when another player plays a card that changes your hand or your keep, you must take two actions immediately afterward. |
| 36 | Tithes | Friar | | ✓ | X | This card is worth one coin for each card in this keep, including itself. If TITHES is in your keep, you may use one action to discard **all** Coin cards in your keep, then look through and reorder the cards in your pile. |

Coin cards: Count Token, Royal Favor, Chalice, Dagger, Medallion, Scepter, Timepiece, Fabergé Egg, Fool Token, Blunder, Shackles, Friar Token, Tithes. Purity is explicitly *not* a Coin card.

HOT cards: Acquisition, Fiat, Royal Favor, Juggling, Pandemonium, Blunder, Sanction, Invocation, Revelation.

## Official clarifications (keepsgame.com/clarify)

> "Keeps should be played in whatever way brings the most joy to the lives of the players. The official rules are simply our suggestions."

### General
- **Simultaneous triggers** resolve in this order:
  1. Legerdemain's HOT! card
  2. Retribution
  3. Interest
  4. Royal Favor
- **After round end:** once an empty pile is drawn from, no more actions happen except LAST LAUGH's action and whatever it triggers.
  - DUPLICITY can reveal its face-down card after round end, before or after LAST LAUGH.
  - If all three TOKENS are face-up in one keep after round end, it's still a token victory, and only that player gets a victory mark.
  - Any number of actions may be used to draw from an empty pile after round end.
- **Two players:** sit at opposing piles, not adjacent ones.

### By card
- **Acquisition / Juggling / Sanction:** can't be used for RETRIBUTION or LAST LAUGH actions.
- **Blunder:** ANY two consecutive player actions can be used to remove it.
- **Tokens (Count/Fool/Friar):** the instant all three are in one keep (even after round end), the round is *completely* over. No LAST LAUGH, no RETRIBUTION, nothing else. That player gets the victory mark and the next round starts. With DUPLICITY, all three tokens must be face-up to win.
- **Duplicity:**
  - Revealing the face-down card uses no action and can happen *any* time, even after LAST LAUGH.
  - It generally favors whoever owns it:
    - LAST LAUGH can be revealed at the very end to get its action.
    - RETRIBUTION can be revealed to get its two actions as soon as the triggering card is played.
    - SHACKLES can be revealed after a player's first action, which ends their turn.
    - INTEREST can be revealed as soon as a coin card enters the keep, forcing a draw.
  - RETRIBUTION: when DUPLICITY is played, it or the face-down card can each trigger RETRIBUTION, but not both. Revealing the face-down card does not trigger RETRIBUTION.
  - INTEREST: placing or revealing the face-down card never triggers INTEREST.
  - TITHES: the face-down card counts as a card in the keep (+1 coin), but TITHES' discard-all-Coin-cards action can never discard it.
- **Fiat:** only real players claim a pile (skip ghosts). In a 2-player game, whoever played FIAT chooses where the remaining two piles go.
- **Interest:** swapping INTEREST with a Coin card via PROVIDENCE does *not* trigger it.
- **Last Laugh:** doesn't trigger on a token victory. ACQUISITION, SANCTION and JUGGLING can't be used with its action. With DUPLICITY, LAST LAUGH can be revealed after the game ends to get the action, and the face-down card can be revealed after the LAST LAUGH action.
- **Legerdemain:**
  - You may choose yourself, but the card is still chosen randomly.
  - Ghost players may be chosen.
  - Stealing from someone with RETRIBUTION triggers it, but the stolen card is played *first*. If that stolen card also affects the same player (e.g. OFFERING), RETRIBUTION triggers a second time, for four actions total, taken after the stolen card is played.
- **Pickpocket:** ghost players may be chosen.
- **Providence:** two cards in the same keep can be swapped. Swapping RETRIBUTION out of a keep still triggers it for that player. Swapping INTEREST with a Coin card doesn't trigger INTEREST.
- **Purity:** still worth 10 if other Coin cards in the keep sum to zero (e.g. DAGGER and two TOKENS).
- **Resurrection:** can resurrect RESURRECTION.
- **Retribution:** ACQUISITION, SANCTION and JUGGLING can't be used with its actions. See Duplicity, Legerdemain and Providence above.
- **Tithes:** discarding Coin cards with TITHES also discards TITHES itself.

> "If you still cannot find your resolution, the issue is either obvious or contrived. Listen to the voices of those around you!"

## Rulings inferred from the official puzzle solutions (keepsgame.com/puzzles)

- HOT Keep cards drawn mid-turn are played immediately into any keep (Royal Favor 1: drawn Royal Favor played onto another player, who then draws).
- A forced draw from an empty pile (e.g. Royal Favor or Interest triggering on an empty pile) ends the round. The player who drew ends it, which matters for tie-breaks (Royal Favor 3).
- A HOT card gained by Resurrection is played immediately (Resurrection 1, Royal Favor 3).
- Blunder played via Interest chains: Blunder enters a keep → Interest triggers → draw again (Royal Favor 3).
- Hocus Pocus: costs 1 action and grants 2, so a net +1 (Blunder 1, Tokens 1).
- A player with no cards in hand and an empty pile is forced to draw from the empty pile, ending the round (Last Laugh 3).
- Tithes' action can be used as the Last Laugh action (Blunder 3, Purity 3).
- Duplicity: a hidden Fool Token can be revealed immediately (Nothing Doing).

## Open questions for implementation

- **Fiat** is printed as both HOT and Keep, but its text has no "when this enters a keep" trigger. Assumption: the pile redistribution happens when it's played, and it then sits in the keep with no further effect.
- **Joker** copying a HOT card (e.g. Pandemonium, which can't be held anyway): probably irrelevant, since HOT cards never stay in hand.
- **Revelation:** after the pile is flipped, the next card is visible to everyone. Assumption: the pile stays flipped until moved or flipped again.
- **Blunder placed face-up onto a pile:** the next draw from that pile gets Blunder, which is HOT and must go into the drawer's own keep (Blunder 2 puzzle).
