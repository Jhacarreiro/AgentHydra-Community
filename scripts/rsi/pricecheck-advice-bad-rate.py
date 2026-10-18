"""How often the price checker's advice went bad, across every project that has advice recorded.

The measure behind `pricecheck.advice.bad_rate` in .rsi/rsi.yaml: each project in the advice log is reconciled and
summarized the way `pricecheck advice` does, and advice counts as bad when it was undone, misled, or marked wrong or
undone by feedback. Lower is better. The price checker lives in the owners' private checkout: PRICECHECK_DIR, else the
sibling sue-dredd/pricecheck. Without it, this prints a skipped result. With no advice recorded it prints issued 0 and a
null bad_rate, not a score. Prints one JSON line.
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[2]
checkout = Path(os.environ.get("PRICECHECK_DIR") or root.parent / "sue-dredd" / "pricecheck")
if not (checkout / "bin" / "pricecheck.mjs").is_file():
    print(json.dumps({"skipped": True, "reason": f"no price checker at {checkout}"}))
    raise SystemExit(0)
log = (checkout / "lib" / "advice" / "log.mjs").as_posix()
reconcile = (checkout / "lib" / "advice" / "reconcile.mjs").as_posix()
js = f"""
import path from 'node:path'
import {{ adviceFile, readRows }} from {json.dumps(log)}
import {{ summarize }} from {json.dumps(reconcile)}
const roots = [...new Set(readRows(adviceFile()).filter((r) => r.type === 'advice' && r.root).map((r) => path.resolve(r.root)))]
let issued = 0
let bad = 0
for (const r of roots) {{
  const s = summarize(r)
  issued += s.issued
  if (s.badRate !== null) bad += Math.round(s.badRate * s.issued)
}}
console.log(JSON.stringify({{ projects: roots.length, issued, bad, bad_rate: issued ? bad / issued : null }}))
"""
out = subprocess.run(["bun", "-e", js], cwd=root, capture_output=True, text=True, encoding="utf-8", check=True).stdout
result = json.loads(out)
if result["issued"] == 0:
    result["note"] = "no advice recorded yet: issued 0, so there is no bad rate to score"
print(json.dumps(result))
