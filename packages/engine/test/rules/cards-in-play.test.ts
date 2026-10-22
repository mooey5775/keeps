import { describe, expect, it } from 'vitest';
import { apply, buildPosition, legalCommands } from '../../src/index.ts';
import {
  abilityNames,
  act,
  actionCommand,
  actionsLeft,
  draw,
  hotTarget,
  payloads,
  promptFor,
  respond,
  types,
} from '../helpers.ts';

// Playing cards: HOT cards, Keep and non-Keep cards, and who makes each choice.

describe('HOT cards', () => {
  it('R-05 a drawn HOT Keep card is played immediately, without using an action', () => {
    const start = buildPosition({ piles: { 0: ['juggling', 'chalice'] }, turn: 0 });
    const drawn = draw(start, 0);

    // The only decision now is where Juggling goes; no other action is possible.
    promptFor(drawn.state, 0, 'hot-target');
    expect(drawn.state.hands[0]).toEqual(['juggling']);
    expect(legalCommands(drawn.state, 0).map((c) => c.type === 'answer' && c.answer)).toEqual([
      { kind: 'hot-target', target: 0 },
      { kind: 'hot-target', target: 1 },
      { kind: 'hot-target', target: 2 },
      { kind: 'hot-target', target: 3 },
    ]);

    const played = hotTarget(drawn.state, 0, 2);
    expect(played.state.keeps[2]).toEqual([{ id: 'juggling' }]);
    expect(played.state.hands[0]).toEqual([]);
    expect(actionsLeft(played.state)).toBe(1);
    expect(payloads(played.events, 'play')).toEqual([
      { type: 'play', seat: 0, card: 'juggling', target: 2, hot: true },
    ]);
  });

  it('R-05 a drawn Blunder goes straight into the drawer\'s own keep', () => {
    const start = buildPosition({ piles: { 0: ['blunder'] }, turn: 0 });
    const { state, events } = draw(start, 0);
    expect(state.keeps[0]).toEqual([{ id: 'blunder' }]);
    expect(actionsLeft(state)).toBe(1);
    expect(types(events)).toEqual(['action', 'draw', 'play', 'prompt']);
  });

  it('R-05 a drawn HOT card on the last action is still played before the turn ends', () => {
    const start = buildPosition({ piles: { 0: ['chalice', 'blunder'] }, turn: 0 });
    const { state, events } = draw(draw(start, 0).state, 0);
    expect(state.keeps[0]).toEqual([{ id: 'blunder' }]);
    expect(types(events)).toEqual(['action', 'draw', 'play', 'turn-end', 'turn-start', 'prompt']);
  });

  it('R-05 HOT Keep cards cannot be played into a ghost\'s keep', () => {
    const start = buildPosition({
      seats: ['player', 'ghost', 'player', 'ghost'],
      piles: { 0: ['sanction'] },
      turn: 0,
    });
    const { state } = draw(start, 0);
    expect(legalCommands(state, 0).map((c) => c.type === 'answer' && c.answer)).toEqual([
      { kind: 'hot-target', target: 0 },
      { kind: 'hot-target', target: 2 },
    ]);
  });

  it('traces the HOT play as caused by the draw, which was caused by the action', () => {
    const start = buildPosition({ piles: { 0: ['acquisition'] }, turn: 0 });
    const drawn = draw(start, 0);
    const played = hotTarget(drawn.state, 0, 0);
    const all = [...drawn.events, ...played.events];
    const bySeq = new Map(all.map((e) => [e.seq, e]));
    const chain: string[] = [];
    for (let e = all.find((x) => x.payload.type === 'play'); e; e = e.cause ? bySeq.get(e.cause) : undefined) {
      chain.push(e.payload.type);
    }
    expect(chain).toEqual(['play', 'prompt', 'draw', 'action']);
  });

  it('hides a face-down draw from other players but not from the drawer', () => {
    const start = buildPosition({ piles: { 0: ['chalice'] }, turn: 0 });
    const { events } = draw(start, 0);
    const drawEvent = events.find((e) => e.payload.type === 'draw')!;
    expect(drawEvent.visibility).toEqual([0]);
    expect(drawEvent.redacted).toEqual({ type: 'draw', seat: 0, from: 0, card: null });
  });

  it('shows everyone a draw of a face-up card', () => {
    const start = buildPosition({ piles: { 0: [{ id: 'chalice', faceUp: true }] }, turn: 0 });
    const { events } = draw(start, 0);
    expect(events.find((e) => e.payload.type === 'draw')!.visibility).toBe('all');
  });

  it('Requisition taking Invocation: it is played at once and invokes', () => {
    const start = buildPosition({ hands: { 0: ['requisition'] }, piles: { 2: ['chalice', 'invocation'], 3: ['dagger'] }, turn: 0 });
    const looked = respond(act(start, 0, { action: 'play', card: 'requisition' }).state, 0, { kind: 'choose-pile', pile: 2 });
    const taken = respond(looked.state, 0, { kind: 'choose-pile-card', index: 1 });
    const invoked = respond(taken.state, 0, { kind: 'choose-pile', pile: 3 });
    expect(promptFor(invoked.state, 0, 'hot-target').card).toBe('dagger');
  });

  it('Epiphany taking Revelation from a pile top: it is played at once', () => {
    const start = buildPosition({ hands: { 0: ['epiphany'] }, piles: { 1: ['revelation', 'chalice'] }, turn: 0 });
    const played = act(start, 0, { action: 'play', card: 'epiphany' });
    const taken = respond(played.state, 0, { kind: 'choose-top-card', pile: 1 });
    expect(promptFor(taken.state, 0, 'choose-pile').purpose).toBe('revelation');
  });
});

describe('playing cards', () => {
  it("R-06 Keep cards are played face-up into any player's keep", () => {
    const start = buildPosition({ hands: { 0: ['dagger', 'chalice'] }, turn: 0 });
    const one = act(start, 0, { action: 'play', card: 'dagger', target: 3 });
    const two = act(one.state, 0, { action: 'play', card: 'chalice', target: 0 });
    expect(two.state.keeps[3]).toEqual([{ id: 'dagger' }]);
    expect(two.state.keeps[0]).toEqual([{ id: 'chalice' }]);
    expect(two.state.hands[0]).toEqual([]);
  });

  it("R-06 Keep cards cannot be played into a ghost's keep", () => {
    const start = buildPosition({
      seats: ['player', 'ghost', 'player', 'ghost'],
      hands: { 0: ['dagger'] },
      turn: 0,
    });
    const result = apply(start, 0, actionCommand(start, 0, { action: 'play', card: 'dagger', target: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('illegal');
  });

  it('R-06 non-Keep cards are discarded face up when played', () => {
    const start = buildPosition({ hands: { 0: ['hocus-pocus'] }, discard: ['pluck'], turn: 0 });
    const { state } = act(start, 0, { action: 'play', card: 'hocus-pocus' });
    expect(state.discard).toEqual(['pluck', 'hocus-pocus']);
    expect(state.hands[0]).toEqual([]);
  });
});

describe('who decides', () => {
  it("a HOT Keep card drawn by another player's trigger is placed by that player", () => {
    // S0 plays Chalice into S1's keep; S1's Interest draws Juggling, so S1 chooses its keep.
    const start = buildPosition({
      hands: { 0: ['chalice'] },
      keeps: { 1: ['interest'] },
      piles: { 1: ['juggling'] },
      turn: 0,
    });
    const { state } = act(start, 0, { action: 'play', card: 'chalice', target: 1 });
    expect(state.prompts.map((p) => [p.seat, p.kind])).toEqual([[1, 'hot-target']]);
    const placed = hotTarget(state, 1, 3);
    expect(placed.state.keeps[3]).toEqual([{ id: 'juggling' }]);
    // Back to S0's turn.
    promptFor(placed.state, 0, 'action');
  });

  it('a Keep card stolen with Legerdemain is placed by the thief, into any keep', () => {
    const start = buildPosition({ hands: { 0: ['legerdemain'], 3: ['duplicity'], }, turn: 0 });
    const stolen = respond(act(start, 0, { action: 'play', card: 'legerdemain' }).state, 0, { kind: 'choose-player', seat: 3 });
    expect(promptFor(stolen.state, 0, 'hot-target').card).toBe('duplicity');
  });

  it('a stolen Duplicity, played as HOT, still makes its player hide a Keep card', () => {
    const start = buildPosition({ hands: { 0: ['legerdemain', 'chalice'], 3: ['duplicity'] }, turn: 0 });
    const stolen = respond(act(start, 0, { action: 'play', card: 'legerdemain' }).state, 0, { kind: 'choose-player', seat: 3 });
    const placed = hotTarget(stolen.state, 0, 0);
    expect(promptFor(placed.state, 0, 'duplicity-hide').options).toEqual(['chalice']);
  });

  it('an invoked Fiat starts the pile claims with the player who invoked it', () => {
    const start = buildPosition({ piles: { 0: ['invocation'], 2: ['fiat'] }, turn: 0 });
    const invoked = respond(draw(start, 0).state, 0, { kind: 'choose-pile', pile: 2 });
    const placed = hotTarget(invoked.state, 0, 3);
    expect(placed.state.keeps[3]).toEqual([{ id: 'fiat' }]);
    expect(promptFor(placed.state, 0, 'claim-pile').claimant).toBe(0);
  });

  it('extra actions reached through a trigger belong to the trigger’s owner, not the turn player', () => {
    // S0's Chalice → S1's Interest draws Invocation (HOT) → S1 invokes Hocus Pocus: S1 gets two actions.
    const start = buildPosition({
      hands: { 0: ['chalice'] },
      keeps: { 1: ['interest', 'sanction'] },
      piles: { 1: ['invocation'], 2: ['hocus-pocus'], 3: ['dagger'] },
      turn: 0,
    });
    const played = act(start, 0, { action: 'play', card: 'chalice', target: 1 });
    const invoked = respond(played.state, 1, { kind: 'choose-pile', pile: 2 });
    expect(invoked.state.stack.at(-1)).toMatchObject({ op: 'action-frame', seat: 1, kind: 'hocus-pocus', remaining: 2 });
    // It's still S0's turn, so S1's Sanction ("on your turn") can't be used.
    expect(abilityNames(invoked.state, 1)).toEqual([]);
  });
});
