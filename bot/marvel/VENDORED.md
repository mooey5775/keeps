# Vendored: MARVEL, from Ataraxos's Dou Dizhu code

The `marvel/` package of https://github.com/AtaraxosAI/doudizhu at commit
`acdcf199cf422e2b683cb22142b8e7cb33b14460` (2026-05-25). MIT license (`LICENSE`).
It is the training code behind VRPO (arXiv 2605.19235) and Ataraxos's Dou Dizhu policy
(arXiv 2511.07312, Supplementary S7).

We train the Keeps bot with it (`keeps_bot/vrpo/`) and change it only where Keeps
plugs in. `UPSTREAM.sha256` holds the upstream files' hashes. `bot/tests/test_vrpo.py`
checks that every file except the three below still matches them, and that each of the
three marks its change `# Keeps:`.

| File | Change |
|---|---|
| `game_identity.py` | `game_name='keeps'` resolves to `keeps_bot/vrpo/game.py`; `nanopokerlib` (their C++ game library) is imported only for its own games |
| `model/__init__.py` | `Agent` and `CentralCritic` are our entity-network policy and critic (`keeps_bot/vrpo/models.py`), not their transformers |
| `buffer.py` | a game can define its own trajectory fields (ours are float observation rows, not tokens) |

Not changed, and used as is:
- the VRPO trainer (`training/vrpo.py`);
- its losses and its Q(λ)/expected-SARSA advantage (`training/losses.py`, `training/gae.py`);
- the Muon optimizer and the EMA (`optim/`), and the schedules (`training/trainer.py`);
- the replay buffer (`buffer.py`, apart from the hook above);
- the workflow, checkpointing and metrics (`runtime/`, `training/workflow.py`).

`keeps_bot/vrpo/workflow.py` subclasses their workflow. It changes only the sampler,
adds TensorBoard, and saves the policies.
