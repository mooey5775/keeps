"""Targeted disagreements (Requisition, Duplicity): vrpo1's choice minus e1's, decider win rate, per continuation."""
import collections, glob, json, math, sys
rows = [json.loads(l) for f in sorted(glob.glob('tdis-*.jsonl')) for l in open(f) if l.strip()]
min_n = int(sys.argv[1]) if len(sys.argv) > 1 else 15

def ci(d):
  m = sum(d) / len(d); sd = math.sqrt(sum((x - m) ** 2 for x in d) / max(1, len(d) - 1))
  return m, 1.96 * sd / math.sqrt(len(d))

def line(label, sel):
  (a, ca), (b, cb) = (ci([r['results'][c]['vrpo'] - r['results'][c]['e1'] for r in sel]) for c in ('e1', 'vrpo'))
  verdict = 'vrpo1 better' if a - ca > 0 and b - cb > 0 else 'e1 better' if a + ca < 0 and b + cb < 0 else ''
  return f'{label:58s} n {len(sel):4d}   e1 plays on {a:+6.1%} ±{ca:4.1%}   vrpo1 plays on {b:+6.1%} ±{cb:4.1%}  {verdict}'

print(f'{len(rows)} targeted disagreements, {rows[0]["playouts"]} playouts per move per continuation\n')
print(line('all', rows))
for t, n in sorted(collections.Counter(r['target'] for r in rows).items()):
  s = [r for r in rows if r['target'] == t]
  print(line(t, s))
  conf = [r for r in s if r['pV']['vrpoChoice'] >= 0.7 and r['pE']['e1Choice'] >= 0.7]
  if len(conf) >= 10: print(line('   both ≥70% sure of their own choice', conf))
print('\nby swap (e1 choice -> vrpo1 choice):')
g = collections.defaultdict(list)
for r in rows: g[(r['target'], r['e1Choice'], r['vrpoChoice'])].append(r)
for (t, a, b), s in sorted(g.items(), key=lambda kv: -len(kv[1])):
  if len(s) >= min_n: print(line(f'  {t.split(":")[0]}: {a} -> {b}', s))
