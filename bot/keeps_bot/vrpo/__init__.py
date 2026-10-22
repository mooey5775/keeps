"""VRPO for Keeps, on the vendored MARVEL trainer (bot/marvel, from github.com/AtaraxosAI/doudizhu).

  game.py      Keeps as MARVEL's game: sizes, and the trajectory fields its buffers hold
  models.py    the policy (our entity network, in PyTorch) and the central Q critic
  sampler.py   self-play on the Node workers, in place of MARVEL's environment sampler
  workflow.py  MARVEL's training workflow with our sampler, TensorBoard, and saved policies
  train.py     the entry point, with the paper's Dou Dizhu settings
"""
