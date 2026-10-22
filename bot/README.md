# Keeps bot (training)

Python side of the heads-up R-NaD bot. See [`docs/BOT.md`](../docs/BOT.md) for the plan.

- `keeps_bot/game.py`: Keeps as an OpenSpiel game (`python_keeps_heads_up`). The rules live only in the
  TypeScript engine; this runs `packages/learn/src/server.ts` under Node and forwards every state to it.
- `keeps_bot/rnad.py`: R-NaD, vendored from OpenSpiel v1.5 (it's not in later OpenSpiel releases or wheels).
- `keeps_bot/selfplay.py`: fast self-play for training. Node workers (`packages/learn/src/worker.ts`) each
  play many rounds at once and exchange binary frames with the actor; finished rounds become episodes.
- `keeps_bot/train.py`: training. `PYTHONPATH= .venv/bin/python -m keeps_bot.train --run <name>` from `bot/`.
- `keeps_bot/evaluate.py`: duplicate-deal matches between policies (or against the random player); with
  `--watch <run>` it evaluates each policy a training run saves, for the dashboard.
- `keeps_bot/policy.py`: a saved policy (weights only), rebuilt as a function of observation and legal actions.
- `keeps_bot/vrpo/`: VRPO (the learner behind Ataraxos's Dou Dizhu policy), on their trainer, vendored
  unchanged but for three marked seams in `marvel/` (see `marvel/VENDORED.md`). PyTorch, in its own environment.

Training dashboard (from `bot/`, each in its own terminal):

```sh
PYTHONPATH= .venv/bin/python -m keeps_bot.train --run first
PYTHONPATH= .venv/bin/python -m keeps_bot.evaluate --watch first
PYTHONPATH= .venv/bin/tensorboard --logdir runs/first/tb     # http://localhost:6006
```

Setup (Python 3.13, Node 24, from the repo root):

```sh
python3 -m venv bot/.venv
bot/.venv/bin/pip install -r bot/requirements.txt
PYTHONPATH= bot/.venv/bin/python -m unittest discover -s bot/tests -t bot
```

(`PYTHONPATH=` keeps unrelated system packages out of the environment.)

On a machine with an NVIDIA GPU, also install JAX's CUDA support (the network then runs there):

```sh
bot/.venv/bin/pip install "jax[cuda13]==0.12.0.1"
```

## VRPO (PyTorch)

PyTorch gets its own environment (its CUDA libraries would downgrade JAX's):

```sh
python3 -m venv bot/.venv-torch
bot/.venv-torch/bin/pip install -r bot/requirements.txt tyro tqdm
bot/.venv-torch/bin/pip install torch --index-url https://download.pytorch.org/whl/cu130
PYTHONPATH=bot bot/.venv-torch/bin/python -m unittest bot.tests.test_vrpo
```

Train from `bot/` (the defaults are the paper's Dou Dizhu settings; see `keeps_bot/vrpo/train.py`), and evaluate
its saved policies with the JAX environment as usual:

```sh
PYTHONPATH=. .venv-torch/bin/python -m keeps_bot.vrpo.train --run v1
PYTHONPATH= .venv/bin/python -m keeps_bot.evaluate --watch v1 --every 25
```
