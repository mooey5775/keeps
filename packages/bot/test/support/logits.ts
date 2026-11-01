// The TypeScript network's logits (what the deployed bot runs) for observations, so a Python test can hold them to
// the PyTorch network that trained them (bot/tests/test_parity.py).
//   node logits.ts <policy.bin> <obs.f32> <out.f32>   (obs: float32 [N, observationSize]; out: float32 [N, numActions])
import { readFileSync, writeFileSync } from 'node:fs';
import { Policy } from '../../src/policy.ts';

const [weights, obsPath, outPath] = process.argv.slice(2);
const policy = Policy.load(readFileSync(weights!));
const bytes = readFileSync(obsPath!);
const obs = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
const { observationSize, numActions } = policy.info;
const rows = obs.length / observationSize;
const out = new Float32Array(rows * numActions);
for (let r = 0; r < rows; r++) out.set(policy.logits(obs.subarray(r * observationSize, (r + 1) * observationSize)), r * numActions);
writeFileSync(outPath!, out);
