#!/bin/bash
# Status of the search-vs-search match on gpu01 (vrpo1 = A against e1 = B, both searching 512 worlds).
#   bot/runs/analysis/searchmatch-status.sh
ssh gpu01 'cat ~/keeps-search/out/r-*.jsonl; echo "#running $(pgrep -fc "^node searchmatch.ts")"; cat ~/keeps-search/out/r-*.err' 2>/dev/null | python3 -c '
import json, math, sys
rows, running, errors = [], "?", []
for line in sys.stdin:
    line = line.strip()
    if line.startswith("{"): rows.append(json.loads(line))
    elif line.startswith("#running"): running = line.split()[1]
    elif line: errors.append(line)
n, w = len(rows), sum(r["aWon"] for r in rows)
print(f"{n} of 100 rounds done, {running} processes running")
if n:
    print(f"vrpo1 won {w}/{n} = {w / n:.1%} (95% interval ±{1.96 * math.sqrt(w / n * (1 - w / n) / n) if 0 < w < n else 1.96 * math.sqrt(0.25 / n):.1%})")
    for seat in (0, 2):
        s = [r for r in rows if r["aSeat"] == seat]
        won = sum(r["aWon"] for r in s)
        if s: print(f"  vrpo1 in seat {seat}: won {won}/{len(s)}")
    minutes = sum(r["seconds"] for r in rows) / n / 60
    print(f"  {minutes:.1f} min per round on average")
if errors: print("errors:\n  " + "\n  ".join(errors[:5]))
'
