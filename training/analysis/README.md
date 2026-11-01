# Analysis tools (Python)

Investigations that may be worth repeating, not maintained: each ran against the code of its day. Those whose results aren't in docs/BOT.md are kept until they are. Run from `training/` with the right environment: `.venv-torch` for VRPO (PyTorch), `.venv` for evaluation (JAX). Each script's header says what it does.

**VRPO self-play and training: speed, and proof that learning is unchanged:**
- `equiv.py`: two samplers (a saved copy of the old code and the current one) produce bit-identical rollouts from the same seed.
- `train_equiv.sh`, `compare_runs.py`: three deterministic training iterations with two code trees, compared bit for bit (checkpoint tensors, policies, metrics).
- `train_speed.sh`: per-iteration play and train times.
- `sampler_profile_main.py`, `nodespeed.py`: self-play throughput, and the Node workers' ceiling.
- `trainbench.py`, `criticprof.py`, `criticfast.py`, `policybench.py`: the cost of the actor and critic passes, checkpointing, CUDA graphs, bf16 and compile.

**Evaluating vrpo1 against e1:**
- `noise_eval.py`, `sharpen_eval.py`, `sharpen_both.py`: vrpo1 raw against post-processed or sharpened (moves under a threshold dropped).
- `dis_summary.py`, `tdis_summary.py`: summaries of `packages/learn/analysis/disagree*.ts` output.
