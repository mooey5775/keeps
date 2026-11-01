"""Midstrike's network on a GPU, for the batched search (packages/bot/src/search/batch-search.ts).

Loads an exported policy file (KPNN, as the TypeScript bot reads it) into the PyTorch agent VRPO trains
(keeps_bot/vrpo/models.py, ported line for line from networks.entity) and answers batches of observations with
the network's logits over a Unix socket; the protocol is in packages/bot/src/search/inference.ts. Requests from every
connection that arrive while the GPU is busy go through together, in one forward. Float32 throughout (no TF32),
so the logits match the TypeScript forward's to float rounding.

  .venv-torch/bin/python -m keeps_bot.serve <policy.bin> <socket> [--device cuda:0]
"""
import argparse
import asyncio
import json
import os
import struct
import time

import numpy as np
import torch

from keeps_bot import kpnn

MAX_ROWS = 16384  # observations per forward, at most (a batch bigger than this goes through in parts)
BUCKETS = [2 ** k for k in range(4, 15)]  # batch sizes with a CUDA graph each (16 … 16384), a batch padded up to the next


def quantize_weights(agent, bits=8, smallest=2048):
  """Each linear layer's weights rounded to `bits`-bit integers, symmetric, one scale per output channel, then back
  to floats: the network as a phone runs it with quantized weights. As Core ML's linear_quantize_weights does by
  default, layers with fewer than `smallest` weights (the one-output heads, the card embedding) stay as they are:
  one scale for a whole small layer costs the most precision for the least memory."""
  top = 2 ** (bits - 1) - 1
  with torch.no_grad():
    for module in agent.modules():
      if isinstance(module, torch.nn.Linear) and module.weight.numel() >= smallest:
        w = module.weight  # [out, in]
        scale = w.abs().amax(1, keepdim=True).clamp(min=1e-12) / top
        w.copy_(torch.round(w / scale).clamp(-top, top) * scale)


def load(path, device, precision='float32'):
  """The policy file's header and its network as the PyTorch agent, on `device`, in `precision`: float32 (the
  network as trained and as the TypeScript bot runs it), float16 (as Apple's Neural Engine runs it) or int8 (int8
  weights, float16 arithmetic: the Neural Engine with quantized weights)."""
  header, agent = kpnn.load_agent(path)
  if precision == 'int8':
    quantize_weights(agent)
  agent = agent.to(device).eval()
  return header, (agent.half() if precision in ('float16', 'int8') else agent)


class Server:

  def __init__(self, header, agent, device):
    self.header, self.agent, self.device = header, agent, device
    self.size = header['observationSize']
    self.dtype = next(agent.parameters()).dtype
    self.pending = []  # (rows, rowEnds, values, indices, future), in arrival order
    self.wake = asyncio.Event()
    self.stats = {'requests': 0, 'rows': 0, 'forwards': 0, 'busy': 0.0, 'connections': 0}
    self.graphs = {}  # bucket → (input, logits, CUDA graph)
    if self.device.startswith('cuda'):
      for rows in BUCKETS:
        self.graphs[rows] = self.capture(rows)

  def capture(self, rows):
    """The forward for `rows` observations as a CUDA graph: one launch instead of one per layer (eager
    PyTorch spends milliseconds a forward launching kernels; the arithmetic is a small part). The same
    kernels, so the same numbers."""
    x = torch.zeros(rows, self.size, device=self.device, dtype=self.dtype)
    side = torch.cuda.Stream()
    side.wait_stream(torch.cuda.current_stream())
    with torch.cuda.stream(side), torch.inference_mode():
      for _ in range(3):
        self.agent.logits(x)
    torch.cuda.current_stream().wait_stream(side)
    graph = torch.cuda.CUDAGraph()
    with torch.cuda.graph(graph), torch.inference_mode():
      out = self.agent.logits(x)
    return x, out, graph

  def refusal(self, hello):
    for key in ('fingerprint', 'step', 'observationSize', 'numActions'):
      if hello.get(key) != self.header[key]:
        return f'{key}: the client has {hello.get(key)!r}, the server {self.header[key]!r}'
    return None

  async def connection(self, reader, writer):
    replies = asyncio.Queue()
    sender = None
    try:
      head = await reader.readexactly(8)
      if head[:4] != b'KPI1':
        return
      hello = json.loads(await reader.readexactly(struct.unpack('<I', head[4:])[0]))
      problem = self.refusal(hello)
      answer = json.dumps({'error': problem} if problem else {'ok': True}).encode()
      writer.write(struct.pack('<I', len(answer)) + answer)
      await writer.drain()
      if problem:
        print(f'refused a client: {problem}', flush=True)
        return
      self.stats['connections'] += 1
      sender = asyncio.create_task(self.send(replies, writer))
      loop = asyncio.get_running_loop()
      while True:
        rows, nonzeros = struct.unpack('<II', await reader.readexactly(8))
        body = await reader.readexactly(4 * rows + 6 * nonzeros)
        ends = np.frombuffer(body, '<u4', rows, 0)
        values = np.frombuffer(body, '<f4', nonzeros, 4 * rows)
        indices = np.frombuffer(body, '<u2', nonzeros, 4 * rows + 4 * nonzeros)
        future = loop.create_future()
        self.pending.append((rows, ends, values, indices, future))
        self.wake.set()
        await replies.put(future)
    except (asyncio.IncompleteReadError, ConnectionError):
      pass
    finally:
      if sender:
        sender.cancel()
      writer.close()

  async def send(self, replies, writer):
    """Each request's logits, in the order the connection sent them."""
    while True:
      future = await replies.get()
      writer.write(await future)
      await writer.drain()

  async def run(self):
    while True:
      await self.wake.wait()
      self.wake.clear()
      batch, self.pending = self.pending, []
      while batch:
        part, rows = [], 0
        while batch and (not part or rows + batch[0][0] <= MAX_ROWS):
          rows += batch[0][0]
          part.append(batch.pop(0))
        try:
          outs = await asyncio.to_thread(self.forward, part)
          for request, out in zip(part, outs):
            request[4].set_result(out)
        except Exception as error:  # a failed forward fails its requests (the clients fall back to the CPU), not the server
          print(f'forward failed: {error!r}', flush=True)
          for request in part:
            request[4].set_exception(error)

  def forward(self, part):
    """The logits for each request in `part`, as the bytes of its reply."""
    started = time.perf_counter()
    counts = [request[0] for request in part]
    total = sum(counts)
    per_row = np.concatenate([np.diff(request[1], prepend=np.uint32(0)) for request in part]).astype(np.int64)
    rows = torch.from_numpy(np.repeat(np.arange(total, dtype=np.int64), per_row)).to(self.device)
    columns = torch.from_numpy(np.concatenate([request[3] for request in part]).astype(np.int64)).to(self.device)
    values = torch.from_numpy(np.concatenate([request[2] for request in part])).to(self.device)
    with torch.inference_mode():
      bucket = next((b for b in BUCKETS if b >= total), None)
      if bucket in self.graphs:
        # Rows don't mix in this network, so the padding rows past `total` (whatever they hold) change nothing.
        x, out, graph = self.graphs[bucket]
        x[:total].zero_()
        x[rows, columns] = values.to(self.dtype)
        graph.replay()
        logits = out[:total]
      else:
        x = torch.zeros(total, self.size, device=self.device, dtype=self.dtype)
        x[rows, columns] = values.to(self.dtype)
        logits = self.agent.logits(x)
      logits = logits.float().cpu().numpy().astype('<f4')
    self.stats['requests'] += len(part)
    self.stats['rows'] += total
    self.stats['forwards'] += 1
    self.stats['busy'] += time.perf_counter() - started
    bounds = np.cumsum([0] + counts)
    return [logits[a:b].tobytes() for a, b in zip(bounds[:-1], bounds[1:])]

  async def report(self, every):
    last = dict(self.stats)
    while True:
      await asyncio.sleep(every)
      now = dict(self.stats)
      d = {k: now[k] - last[k] for k in now}
      if d['forwards']:
        print(f'{time.strftime("%Y-%m-%dT%H:%M:%S")} {d["forwards"]} forwards, {d["rows"]} observations '
              f'({d["rows"] / d["forwards"]:.0f} per forward, {d["requests"] / d["forwards"]:.1f} requests), '
              f'GPU thread busy {d["busy"]:.1f} s; {now["connections"]} connections so far', flush=True)
      last = now


async def main():
  parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  parser.add_argument('policy')
  parser.add_argument('socket')
  parser.add_argument('--device', default='cuda:0' if torch.cuda.is_available() else 'cpu')
  parser.add_argument('--precision', choices=['float32', 'float16', 'int8'], default='float32',
                      help='float32: as trained; float16 and int8 (weights): as a phone\'s Neural Engine would run it')
  parser.add_argument('--stats-every', type=float, default=600, help='seconds between the log\'s usage lines')
  args = parser.parse_args()
  torch.backends.cuda.matmul.allow_tf32 = False
  torch.backends.cudnn.allow_tf32 = False
  torch.set_float32_matmul_precision('highest')
  header, agent = load(args.policy, args.device, args.precision)
  server = Server(header, agent, args.device)  # captures its CUDA graphs (seconds) before the first search waits on them
  if os.path.exists(args.socket):
    os.unlink(args.socket)
  listener = await asyncio.start_unix_server(server.connection, path=args.socket, limit=1 << 24)
  os.chmod(args.socket, 0o600)
  print(f'serving {args.policy} (step {header["step"]}, fingerprint {header["fingerprint"]}) on {args.device} in {args.precision} at {args.socket}', flush=True)
  async with listener:
    await asyncio.gather(server.run(), server.report(args.stats_every), listener.serve_forever())


if __name__ == '__main__':
  asyncio.run(main())
