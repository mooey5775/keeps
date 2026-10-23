"""Summarize disagreements: vrpo1's choice minus e1's choice, in the decider's win rate, per continuation."""
import collections, glob, json, math, sys
rows = [json.loads(l) for f in sorted(glob.glob('dis-*.jsonl')) for l in open(f) if l.strip()]
min_n = int(sys.argv[1]) if len(sys.argv) > 1 else 20

def edge(r, cont):
  return r['results'][cont]['vrpo'] - r['results'][cont]['e1']

def stats(sel):
  out = []
  for cont in ('e1', 'vrpo'):
    d = [edge(r, cont) for r in sel]
    m = sum(d) / len(d)
    sd = math.sqrt(sum((x - m) ** 2 for x in d) / max(1, len(d) - 1))
    out.append((m, 1.96 * sd / math.sqrt(len(d))))
  return out

def line(label, sel):
  (a, ca), (b, cb) = stats(sel)
  both = 'vrpo1 better' if a - ca > 0 and b - cb > 0 else 'e1 better' if a + ca < 0 and b + cb < 0 else ''
  return f'{label:52s} n {len(sel):5d}   e1 plays on {a:+6.1%} ±{ca:4.1%}   vrpo1 plays on {b:+6.1%} ±{cb:4.1%}  {both}'

print(f'{len(rows)} disagreements in {len({r["game"] for r in rows})} games; edge = vrpo1 choice minus e1 choice, decider win rate\n')
print(line('all', rows))
for who in ('vrpo', 'e1'):
  print(line(f'  when {who} was the one to move', [r for r in rows if r['mover'] == who]))
conf = [r for r in rows if r['pV']['vrpoChoice'] >= 0.8 and r['pE']['e1Choice'] >= 0.8]
print(line('  both confident (≥80% on their own choice)', conf))
print('\nby decision kind:')
for kind, sel in sorted(collections.Counter(r['kind'] for r in rows).items(), key=lambda kv: -kv[1]):
  s = [r for r in rows if r['kind'] == kind]
  if len(s) >= min_n: print(line(f'  {kind}', s))
print('\nby swap (e1 choice -> vrpo1 choice), kind:')
groups = collections.defaultdict(list)
for r in rows: groups[(r['kind'], r['e1Choice'], r['vrpoChoice'])].append(r)
for (kind, a, b), s in sorted(groups.items(), key=lambda kv: -len(kv[1])):
  if len(s) >= min_n: print(line(f'  {kind}: {a} -> {b}', s))
