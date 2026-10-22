# Keeps bot (training)

Python side of the heads-up R-NaD bot. See [`docs/BOT.md`](../docs/BOT.md) for the plan.

- `keeps_bot/game.py`: Keeps as an OpenSpiel game (`python_keeps_heads_up`). The rules live only in the
  TypeScript engine; this runs `packages/learn/src/server.ts` under Node and forwards every state to it.
- `keeps_bot/rnad.py`: R-NaD, vendored from OpenSpiel v1.5 (it's not in later OpenSpiel releases or wheels).
- `keeps_bot/selfplay.py`: fast self-play for training. Node workers (`packages/learn/src/worker.ts`) each
  play many rounds at once and exchange binary frames with the actor; finished rounds become episodes.
- `keeps_bot/train.py`: training. `PYTHONPATH= .venv/bin/python -m keeps_bot.train --run <name>` from `bot/`.

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
