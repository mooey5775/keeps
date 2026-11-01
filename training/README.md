# Training (Python)

How Midstrike's network is trained, exported and served. Midstrike is **vrpo1 at 40,000 iterations**: VRPO (the
learner behind Ataraxos's Dou Dizhu policy) with the entity network and observation v2. R-NaD came first (`e1` and the
`g` runs) and is kept, as is everything learned along the way: see [`docs/BOT.md`](../docs/BOT.md).

The rules live only in the TypeScript engine: Python drives it through Node (`packages/learn/src/server.ts` for single
games, `worker.ts` for self-play), never a copy of its own.

## What's here

- **VRPO** (`keeps_bot/vrpo/`, PyTorch): Ataraxos's trainer, vendored unchanged but for three marked seams in
  `marvel/` (see `marvel/VENDORED.md`), with Keeps' game, a fast self-play sampler and the entity network ported from
  JAX. `keeps_bot.vrpo.train`.
- **R-NaD** (`keeps_bot/rnad.py`, JAX): vendored from OpenSpiel v1.5 (it's not in later releases), with Keeps as an
  OpenSpiel game (`game.py`) and batched self-play (`selfplay.py`). `keeps_bot.train`.
- **Evaluation** (`evaluate.py`): duplicate-deal matches between policies, or against the random and heuristic
  players; `--watch <run>` evaluates each policy a run saves, for its TensorBoard.
- **Export** (`export.py`): a saved policy as the TypeScript bot's weights file, with a parity fixture its tests check
  against. A network that goes into use is copied to `packages/bot/weights/` (Midstrike's is `midstrike.bin`).
- **For Midstrike's search:**
  - `serve.py` runs the network on a GPU for the batched search (gpu03's `midstrike-inference` service).
  - `coreml.py` makes the iOS app's Core ML model (`ios/sync.sh` runs it on the Mac).
- `analysis/`: speed and equivalence checks of the training code, and old evaluations (its README).

## Setup

Python 3.13 and Node 24, from the repository's root. JAX (R-NaD, evaluation) and PyTorch (VRPO, serving) get their own
environments, as PyTorch's CUDA libraries would downgrade JAX's:

```sh
python3 -m venv training/.venv
training/.venv/bin/pip install -r training/requirements.txt
training/.venv/bin/pip install "jax[cuda13]==0.12.0.1"          # with an NVIDIA GPU
PYTHONPATH= training/.venv/bin/python -m unittest discover -s training/tests -t training

python3 -m venv training/.venv-torch
training/.venv-torch/bin/pip install -r training/requirements.txt tyro tqdm
training/.venv-torch/bin/pip install torch --index-url https://download.pytorch.org/whl/cu130
PYTHONPATH=training training/.venv-torch/bin/python -m unittest training.tests.test_vrpo
```

(`PYTHONPATH=` keeps unrelated system packages out of the environment.)

## Training and evaluating

From `training/`, each in its own terminal:

```sh
PYTHONPATH=. .venv-torch/bin/python -m keeps_bot.vrpo.train --run v2               # VRPO (see vrpo/train.py)
PYTHONPATH= .venv/bin/python -m keeps_bot.evaluate --watch v2 --every 25
PYTHONPATH= .venv/bin/tensorboard --logdir runs/v2/tb                              # http://localhost:6006
```

R-NaD the same way, with `keeps_bot.train --run <name>`. Runs go in `training/runs/` (not committed).

## A new network for Midstrike

1. Export it: `PYTHONPATH= .venv/bin/python -m keeps_bot.export runs/<run>/policy-<step>.pkl`.
2. Hold it to Midstrike: `packages/learn/tools/match.ts` (a match between the two, with search), and the Providence
   benchmark (`packages/learn/tools/providence.ts`).
3. Copy it to `packages/bot/weights/midstrike.bin`, deploy the website, copy it to gpu03's deployed tree and restart
   its services (the worker refuses jobs stamped with another network), and sync the app.
