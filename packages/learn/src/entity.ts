import { NUM_ACTIONS } from './actions.ts';

// The entity network's forward pass (bot/keeps_bot/networks.py, `entity`), for
// one observation v2. It mirrors the Haiku code step by step: shared MLPs over
// card rows and pile rows, pooling by place, a residual trunk, pointer heads.
// Parameters are looked up by their Haiku names (module/parameter).

type Tensor = { shape: number[]; data: Float32Array };

interface Layout {
  blocks: Record<string, { offset: number; rows: number; width: number; columns: Record<string, [number, number]> }>;
  places: string[];
  specialIds: number[];
}

const LAYER_NORM_EPS = 1e-5; // Haiku's default

/** y = x·W + b for one row x (W is [in, out], row-major). */
function linear(x: ArrayLike<number>, w: Tensor, b: Tensor | null): Float32Array {
  const inputs = w.shape[0]!;
  const outputs = w.shape[1]!;
  const out = new Float64Array(outputs);
  for (let i = 0; i < inputs; i++) {
    const xi = x[i]!;
    if (xi === 0) continue;
    const row = i * outputs;
    for (let j = 0; j < outputs; j++) out[j]! += xi * w.data[row + j]!;
  }
  const y = new Float32Array(outputs);
  for (let j = 0; j < outputs; j++) y[j] = out[j]! + (b ? b.data[j]! : 0);
  return y;
}

const relu = (x: Float32Array): Float32Array => x.map((v) => (v > 0 ? v : 0));

function add(...xs: Float32Array[]): Float32Array {
  const out = new Float32Array(xs[0]!.length);
  for (const x of xs) for (let i = 0; i < out.length; i++) out[i]! += x[i]!;
  return out;
}

function concat(...xs: ArrayLike<number>[]): Float32Array {
  const out = new Float32Array(xs.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of xs) {
    out.set(x, at);
    at += x.length;
  }
  return out;
}

export class EntityNetwork {
  private readonly t: Map<string, Tensor>;
  private readonly layout: Layout;

  constructor(tensors: Map<string, Tensor>, layout: Layout) {
    this.t = tensors;
    this.layout = layout;
    for (const name of ['~/card_embedding', 'card_in/w', 'trunk_in/w', 'special/w']) this.get(name);
  }

  private get(name: string): Tensor {
    const tensor = this.t.get(name);
    if (!tensor) throw new Error(`entity network is missing ${name}`);
    return tensor;
  }

  private lin(name: string, x: ArrayLike<number>, bias = true): Float32Array {
    return linear(x, this.get(`${name}/w`), bias ? this.get(`${name}/b`) : null);
  }

  /** hk.nets.MLP: linear layers named `${name}/~/linear_i`, ReLU between (and after the last, if activateFinal). */
  private mlp(name: string, x: ArrayLike<number>, layers: number, activateFinal: boolean): Float32Array {
    let y: Float32Array = Float32Array.from(x);
    for (let i = 0; i < layers; i++) {
      y = this.lin(`${name}/~/linear_${i}`, y);
      if (i < layers - 1 || activateFinal) y = relu(y);
    }
    return y;
  }

  private layerNorm(name: string, x: Float32Array): Float32Array {
    let mean = 0;
    for (const v of x) mean += v;
    mean /= x.length;
    let variance = 0;
    for (const v of x) variance += (v - mean) ** 2;
    variance /= x.length;
    const scale = this.get(`${name}/scale`).data;
    const offset = this.get(`${name}/offset`).data;
    const inv = 1 / Math.sqrt(variance + LAYER_NORM_EPS);
    return x.map((v, i) => (v - mean) * inv * scale[i]! + offset[i]!);
  }

  private rows(obs: Float32Array, name: string): Float32Array[] {
    const b = this.layout.blocks[name]!;
    return Array.from({ length: b.rows }, (_, r) => obs.subarray(b.offset + r * b.width, b.offset + (r + 1) * b.width));
  }

  private column(block: string, row: Float32Array, name: string): Float32Array {
    const [start, width] = this.layout.blocks[block]!.columns[name]!;
    return row.subarray(start, start + width);
  }

  /** The trunk's output and the entity features the heads read. */
  private features(obs: Float32Array) {
    const cards = this.rows(obs, 'cards');
    const piles = this.rows(obs, 'piles');
    const players = this.rows(obs, 'players');
    const turns = this.rows(obs, 'turns');
    const decision = this.rows(obs, 'decision')[0]!;

    // Cards: the first layer as a sum of the row's and the embedding's linear maps.
    const embedding = this.get('~/card_embedding');
    const embedDim = embedding.shape[1]!;
    const hCard = cards.map((row, c) => {
      const fromEmbedding = linear(embedding.data.subarray(c * embedDim, (c + 1) * embedDim), this.get('card_embed/w'), null);
      return relu(this.lin('card_out', relu(add(this.lin('card_in', row), fromEmbedding))));
    });
    const hPile = piles.map((row) => this.mlp('pile', row, 2, true));
    const hPlayer = players.map((row) => this.mlp('player', row, 2, true));
    const hTurns = add(...turns.map((row) => this.mlp('turn', row, 2, true)));

    const cardDim = hCard[0]!.length;
    const places = this.layout.places.length;
    const pools = Array.from({ length: places }, () => new Float32Array(cardDim));
    const subjectCard = new Float32Array(cardDim);
    cards.forEach((row, c) => {
      const location = this.column('cards', row, 'location');
      for (let p = 0; p < places; p++) {
        if (location[p] === 0) continue;
        for (let d = 0; d < cardDim; d++) pools[p]![d]! += location[p]! * hCard[c]![d]!;
      }
      const weight = this.column('cards', row, 'subject')[0]! + this.column('cards', row, 'chosen')[0]!;
      if (weight !== 0) for (let d = 0; d < cardDim; d++) subjectCard[d]! += weight * hCard[c]![d]!;
    });
    const subjectPile = new Float32Array(hPile[0]!.length);
    piles.forEach((row, r) => {
      const chosen = this.column('piles', row, 'chosen')[0]!;
      if (chosen !== 0) for (let d = 0; d < subjectPile.length; d++) subjectPile[d]! += chosen * hPile[r]![d]!;
    });

    let x = this.lin('trunk_in', concat(...pools, ...hPile, ...hPlayer, hTurns, decision, subjectCard, subjectPile));
    for (let i = 0; this.t.has(`block${i}_a/w`); i++) {
      const y = this.lin(`block${i}_b`, relu(this.lin(`block${i}_a`, relu(this.layerNorm(`block${i}_norm`, x)))));
      x = add(x, y);
    }
    x = relu(this.layerNorm('trunk_norm', x));
    return { x, hCard, hPile, hPlayer, pools, subjectCard, subjectPile, cardDim };
  }

  /**
   * The value head (hk.nets.MLP([128, 1]) on the trunk): the network's estimate of the round's
   * result for the player observing, in [-1, 1] as trained (R-NaD's, from its regularized
   * rewards; policies trained without one export it as zeros).
   */
  value(obs: Float32Array): number {
    return this.mlp('value', this.features(obs).x, 2, false)[0]!;
  }

  /** The 48 logits, in action-id order (cards, positions, special ids). */
  logits(obs: Float32Array): Float32Array {
    const { x, hCard, hPile, hPlayer, pools, subjectCard, subjectPile, cardDim } = this.features(obs);
    const query = this.lin('query', x);
    const cardSubject = this.lin('card_head_subject', subjectCard, false);
    const cardLogits = hCard.map((h) => this.lin('card_head_out', relu(add(this.lin('card_head_candidate', h), query, cardSubject)))[0]!);
    const places_ = this.layout.places;
    const zerosKeep = new Float32Array(cardDim);
    const zerosPlayer = new Float32Array(hPlayer[0]!.length);
    const keepAt = [pools[places_.indexOf('my-keep')]!, zerosKeep, pools[places_.indexOf('opponent-keep')]!, zerosKeep];
    const playerAt = [hPlayer[0]!, zerosPlayer, hPlayer[1]!, zerosPlayer];
    const posDecision = this.lin('pos_head_decision', query, false);
    const posSubject = this.lin('pos_head_subject', concat(subjectCard, subjectPile), false);
    const posLogits = hPile.map(
      (h, r) => this.lin('pos_head_out', relu(add(this.lin('pos_head_candidate', concat(h, playerAt[r]!, keepAt[r]!)), posDecision, posSubject)))[0]!,
    );
    const special = this.lin('special', x);
    const logits = concat(cardLogits, posLogits, special);
    if (logits.length !== NUM_ACTIONS) throw new Error(`entity network gave ${logits.length} logits`);
    return logits;
  }
}
