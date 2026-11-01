import { describe, expect, it } from 'vitest';
import {
  apply,
  buildPosition,
  CARD_IDS,
  CARDS,
  legalCommands,
  pick,
  playerSeats,
  randomInt,
  seedRng,
  shuffle,
  viewFor,
  type ActionChoice,
  type Answer,
  type CardId,
  type Command,
  type GameState,
  type KeepCard,
  type PerSeat,
  type PlayerView,
  type PositionSpec,
  type Seat,
  type SeatKind,
} from '../../src/index.ts';

// Rotation symmetry: seat numbers mean nothing but their order around the
// table. Rotating a whole position one seat to the left, and every command
// with it, must give the rotated result: same events, same views (rotated).
// This catches seat-arithmetic mistakes anywhere: left vs right, tie-breaks,
// turn order around ghosts, Acquisition's piles, Pandemonium's direction.
//
// Fiat is left out: with two players it asks about the lower-numbered ghost
// first, which isn't rotation-symmetric (harmless: either way the Fiat player
// places both piles). See fiat-ghost-order below.

const r = (s: Seat): Seat => ((s + 1) % 4) as Seat;

function rotateSpec(spec: PositionSpec): PositionSpec {
  const bySeat = <T,>(record: Partial<Record<Seat, T>> | undefined) =>
    record && Object.fromEntries(Object.entries(record).map(([s, v]) => [r(Number(s) as Seat), v]));
  const keeps = spec.keeps &&
    Object.fromEntries(
      Object.entries(spec.keeps).map(([s, cards]) => [
        r(Number(s) as Seat),
        cards.map((c) => (typeof c === 'string' || !c.faceDown ? c : { ...c, faceDown: { placedBy: r(c.faceDown.placedBy) } })),
      ]),
    );
  const seats = spec.seats ?? (['player', 'player', 'player', 'player'] as PerSeat<SeatKind>);
  return {
    ...spec,
    seats: [seats[3], seats[0], seats[1], seats[2]],
    piles: bySeat(spec.piles),
    hands: bySeat(spec.hands),
    keeps,
    ...(spec.turn !== undefined ? { turn: r(spec.turn) } : {}),
  };
}

function rotateChoice(choice: ActionChoice): ActionChoice {
  switch (choice.action) {
    case 'play':
      return choice.target === undefined ? choice : { ...choice, target: r(choice.target) };
    case 'ability':
      switch (choice.card) {
        case 'juggling': {
          const [a, b] = [r(choice.piles[0]), r(choice.piles[1])].sort();
          return { ...choice, piles: [a!, b!] };
        }
        case 'sanction':
          return { ...choice, from: r(choice.from) };
        case 'blunder':
          return { ...choice, pile: r(choice.pile) };
        default:
          return choice;
      }
    default:
      return choice;
  }
}

function rotateAnswer(answer: Answer): Answer {
  switch (answer.kind) {
    case 'action':
      return { ...answer, choice: rotateChoice(answer.choice) };
    case 'hot-target':
    case 'duplicity-hide':
      return { ...answer, target: r(answer.target) };
    case 'choose-pile':
    case 'choose-top-card':
      return { ...answer, pile: r(answer.pile) };
    case 'choose-keep-pair':
      return { ...answer, a: { ...answer.a, seat: r(answer.a.seat) }, b: { ...answer.b, seat: r(answer.b.seat) } };
    case 'choose-player':
    case 'choose-hand-card':
      return { ...answer, seat: r(answer.seat) };
    case 'claim-pile':
      return { ...answer, from: r(answer.from) };
    default:
      return answer;
  }
}

/** The rotated command, pointed at `seat`'s matching prompt in the rotated game. */
function rotateCommand(command: Command, seat: Seat, rotated: GameState): Command | null {
  if (command.type !== 'answer') return command;
  const prompt = rotated.prompts.find((p) => p.seat === seat && p.kind === command.answer.kind);
  return prompt ? { type: 'answer', promptId: prompt.id, answer: rotateAnswer(command.answer) } : null;
}

/** What should match between a view and its rotated twin, with seats in `a` mapped through r. */
function projection(view: PlayerView, map: (s: Seat) => Seat) {
  const at = <T,>(items: T[], seatOf: (item: T) => Seat) => {
    const out: T[] = new Array(4);
    for (const item of items) out[map(seatOf(item))] = item;
    return out;
  };
  const perSeat = <T,>(values: T[]) => {
    const out: T[] = new Array(4);
    values.forEach((v, s) => (out[map(s as Seat)] = v));
    return out;
  };
  return {
    seats: perSeat(view.seats),
    marks: perSeat(view.marks),
    scores: perSeat(view.scores),
    phase: view.phase,
    round: view.round,
    turnNumber: view.turnNumber,
    turn: view.turn && map(view.turn.seat),
    frame: view.frame && { ...view.frame, seat: map(view.frame.seat) },
    roundEnd:
      view.roundEnd &&
      (view.roundEnd.kind === 'tokens'
        ? { kind: 'tokens', winner: map(view.roundEnd.winner) }
        : view.roundEnd.kind === 'resign'
          ? { kind: 'resign', seat: map(view.roundEnd.seat) }
          : { kind: 'empty-pile', ender: map(view.roundEnd.enderSeat) }),
    lastRoundWinner: view.lastRoundWinner === null ? null : map(view.lastRoundWinner),
    piles: at(view.piles, (p) => p.position).map((p) => ({ size: p.size, top: p.top })),
    hands: at(view.hands, (h) => h.seat).map((h) => ({ count: h.count, cards: h.cards ? [...h.cards].sort() : null })),
    keeps: at(view.keeps, (k) => k.seat).map((k) => k.cards.map((c) => (c.faceDown ? 'face-down' : c.id))),
    discard: view.discard,
    prompts: view.prompts.map((p) => `${map(p.seat)}:${p.kind}`).sort(),
    duplicityHolder: view.duplicityHolder === null ? null : map(view.duplicityHolder),
    legalCount: view.legal.length,
  };
}

function randomSpec(seed: number): PositionSpec {
  const rng = seedRng(`rotation-${seed}`);
  const seats: PerSeat<SeatKind>[] = [
    ['player', 'player', 'player', 'player'],
    ['player', 'ghost', 'player', 'player'],
    ['player', 'ghost', 'player', 'ghost'],
  ];
  const layout = seats[randomInt(rng, 3)]!;
  const players = ([0, 1, 2, 3] as Seat[]).filter((s) => layout[s] === 'player');
  const cards = shuffle(rng, CARD_IDS.filter((c) => c !== 'fiat'));
  const piles: Record<number, CardId[]> = { 0: [], 1: [], 2: [], 3: [] };
  const hands: Record<number, CardId[]> = { 0: [], 1: [], 2: [], 3: [] };
  const keeps: Record<number, (CardId | KeepCard)[]> = { 0: [], 1: [], 2: [], 3: [] };
  const discard: CardId[] = [];
  for (const card of cards) {
    const roll = randomInt(rng, 10);
    const seat = players[randomInt(rng, players.length)]!;
    if (roll < 4) piles[randomInt(rng, 4)]!.push(card);
    else if (roll < 6 && !CARDS[card].hot) hands[seat]!.push(card);
    else if (roll < 8 && CARDS[card].keep && card !== 'duplicity') keeps[seat]!.push(card);
    else discard.push(card);
  }
  return { seats: layout, piles, hands, keeps, discard, turn: players[randomInt(rng, players.length)]!, seed };
}

describe('rotation symmetry', () => {
  it('a rotated position plays out as the rotation of the original', () => {
    let steps = 0;
    for (let seed = 0; seed < 100; seed++) {
      const spec = randomSpec(seed);
      let a = buildPosition(spec);
      let b = buildPosition(rotateSpec(spec));
      const rng = seedRng(`rotation-play-${seed}`);
      for (let n = 0; n < 80 && (a.phase === 'playing' || a.phase === 'post-round'); n++) {
        for (const seat of playerSeats(a)) {
          expect(projection(viewFor(b, r(seat)), (s) => s), `seed ${seed} step ${n} S${seat}`).toEqual(
            projection(viewFor(a, seat), r),
          );
        }
        const options = playerSeats(a).flatMap((seat) => legalCommands(a, seat).map((command) => ({ seat, command })));
        const { seat, command } = pick(rng, options);
        const rotated = rotateCommand(command, r(seat), b);
        if (!rotated) expect.fail(`seed ${seed} step ${n}: no matching prompt for the rotated command`);
        const ra = apply(a, seat, command);
        const rb = apply(b, r(seat), rotated);
        if (!ra.ok) throw new Error(ra.error.message);
        if (!rb.ok) expect.fail(`seed ${seed} step ${n}: rotated command rejected: ${rb.error.message} (${JSON.stringify(rotated)})`);
        expect(rb.events.map((e) => e.payload.type), `seed ${seed} step ${n}`).toEqual(ra.events.map((e) => e.payload.type));
        a = ra.state;
        b = rb.state;
        steps++;
      }
      expect(projection(viewFor(b, 'spectator'), (s) => s)).toEqual(projection(viewFor(a, 'spectator'), r));
    }
    expect(steps).toBeGreaterThan(1500);
  });
});

describe('fiat-ghost-order', () => {
  it('C-20 in either 2-player seating, the Fiat player can place the two leftover piles either way round', () => {
    for (const seats of [
      ['player', 'ghost', 'player', 'ghost'],
      ['ghost', 'player', 'ghost', 'player'],
    ] as PerSeat<SeatKind>[]) {
      const actor = seats.indexOf('player') as Seat;
      const other = seats.lastIndexOf('player') as Seat;
      const ghosts = ([0, 1, 2, 3] as Seat[]).filter((s) => seats[s] === 'ghost');
      const piles: Partial<Record<Seat, CardId[]>> = { 0: ['chalice'], 1: ['dagger'], 2: ['scepter'], 3: ['medallion'] };
      piles[actor] = ['fiat', ...piles[actor]!];
      const start = buildPosition({ seats, piles, turn: actor });
      const drawn = apply(start, actor, { type: 'answer', promptId: start.prompts[0]!.id, answer: { kind: 'action', choice: { action: 'draw' } } });
      if (!drawn.ok) throw new Error(drawn.error.message);
      let state = drawn.state;
      const answer = (s: GameState, seat: Seat, a: Answer) => {
        const prompt = s.prompts.find((p) => p.seat === seat && p.kind === a.kind)!;
        const result = apply(s, seat, { type: 'answer', promptId: prompt.id, answer: a });
        if (!result.ok) throw new Error(result.error.message);
        return result.state;
      };
      state = answer(state, actor, { kind: 'hot-target', target: actor });
      // Both players claim the piles that were in front of them.
      state = answer(state, actor, { kind: 'claim-pile', from: actor });
      state = answer(state, other, { kind: 'claim-pile', from: other });
      const placing = state.prompts.find((p) => p.kind === 'claim-pile')!;
      expect(placing.seat).toBe(actor);
      const outcomes = new Set<string>();
      for (const command of legalCommands(state, actor)) {
        const result = apply(state, actor, command);
        if (!result.ok) throw new Error(result.error.message);
        outcomes.add(ghosts.map((g) => result.state.piles[result.state.pileAt[g]].cards[0]?.id).join(','));
      }
      expect(outcomes.size).toBe(2);
      // The two ghost piles are the leftovers, in both orders.
      const leftovers = ghosts.map((g) => piles[g]![0]!).sort();
      expect([...outcomes].map((o) => o.split(',').sort().join(','))).toEqual([leftovers.join(','), leftovers.join(',')]);
    }
  });
});
