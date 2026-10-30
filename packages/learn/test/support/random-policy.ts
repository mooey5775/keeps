// A policy for tests whose logic doesn't depend on what the network learned.
import { NUM_ACTIONS } from '../../src/actions.ts';
import { encoderFingerprint } from '../../src/fingerprint.ts';
import { LAYOUT2, OBSERVATION2_SIZE } from '../../src/observation2.ts';
import { Policy } from '../../src/policy.ts';
import { seeded } from '../../demo/random.ts';

/** A small entity network with random weights: the playouts' logic doesn't depend on what the network learned. */
export function randomPolicy(fingerprint = encoderFingerprint(2)): Policy {
  const b = LAYOUT2.blocks as Record<string, { rows: number; width: number }>;
  const [embed, cardHidden, card, pile, player, turn, trunk, head] = [4, 16, 8, 8, 4, 4, 16, 8];
  const trunkIn = LAYOUT2.places.length * card + b.piles!.rows * pile + b.players!.rows * player + turn + b.decision!.width + card + pile;
  const shapes: [string, number[]][] = [
    ['~/card_embedding', [b.cards!.rows, embed]],
    ['card_in/w', [b.cards!.width, cardHidden]], ['card_in/b', [cardHidden]], ['card_embed/w', [embed, cardHidden]],
    ['card_out/w', [cardHidden, card]], ['card_out/b', [card]],
    ['pile/~/linear_0/w', [b.piles!.width, pile]], ['pile/~/linear_0/b', [pile]], ['pile/~/linear_1/w', [pile, pile]], ['pile/~/linear_1/b', [pile]],
    ['player/~/linear_0/w', [b.players!.width, player]], ['player/~/linear_0/b', [player]], ['player/~/linear_1/w', [player, player]], ['player/~/linear_1/b', [player]],
    ['turn/~/linear_0/w', [b.turns!.width, turn]], ['turn/~/linear_0/b', [turn]], ['turn/~/linear_1/w', [turn, turn]], ['turn/~/linear_1/b', [turn]],
    ['trunk_in/w', [trunkIn, trunk]], ['trunk_in/b', [trunk]],
    ['block0_norm/scale', [trunk]], ['block0_norm/offset', [trunk]], ['block0_a/w', [trunk, trunk]], ['block0_a/b', [trunk]], ['block0_b/w', [trunk, trunk]], ['block0_b/b', [trunk]],
    ['trunk_norm/scale', [trunk]], ['trunk_norm/offset', [trunk]],
    ['query/w', [trunk, head]], ['query/b', [head]],
    ['card_head_candidate/w', [card, head]], ['card_head_candidate/b', [head]], ['card_head_subject/w', [card, head]],
    ['card_head_out/w', [head, 1]], ['card_head_out/b', [1]],
    ['pos_head_candidate/w', [pile + player + card, head]], ['pos_head_candidate/b', [head]], ['pos_head_decision/w', [head, head]],
    ['pos_head_subject/w', [card + pile, head]], ['pos_head_out/w', [head, 1]], ['pos_head_out/b', [1]],
    ['special/w', [trunk, NUM_ACTIONS - 40]], ['special/b', [NUM_ACTIONS - 40]],
    ['value/~/linear_0/w', [trunk, 4]], ['value/~/linear_0/b', [4]], ['value/~/linear_1/w', [4, 1]], ['value/~/linear_1/b', [1]],
  ];
  const random = seeded(1, 1);
  const tensors: { name: string; shape: number[]; offset: number }[] = [];
  const data: number[] = [];
  for (const [name, shape] of shapes) {
    tensors.push({ name, shape, offset: data.length });
    const size = shape.reduce((a, c) => a * c, 1);
    const scale = name.endsWith('/scale') ? 0 : 1 / Math.sqrt(shape[0]!);
    for (let i = 0; i < size; i++) data.push(name.endsWith('/scale') ? 1 : (random() * 2 - 1) * scale);
  }
  const header = new TextEncoder().encode(
    JSON.stringify({
      format: 'keeps-policy', version: 1, run: 'test', step: 1, decisions: null, network: 'entity', observationVersion: 2, layers: [],
      observationSize: OBSERVATION2_SIZE, numActions: NUM_ACTIONS, fingerprint, postprocess: { threshold: 0, discretization: 0 }, evals: null,
      layout: LAYOUT2, tensors,
    }),
  );
  const bytes = new Uint8Array(8 + header.length + 4 * data.length);
  bytes.set(new TextEncoder().encode('KPNN'));
  new DataView(bytes.buffer).setUint32(4, header.length, true);
  bytes.set(header, 8);
  bytes.set(new Uint8Array(Float32Array.from(data).buffer), 8 + header.length);
  return Policy.load(bytes);
}
