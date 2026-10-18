"""What AgentHydra's own pages cost the person reading them, in price check points.

The measure behind `pricecheck.own_pages.points` in .rsi/rsi.yaml: a static price check scan of this repo (Desk, the
HSwarm console, the orchestrator) summed over every page. The price checker lives in the owners' private checkout:
PRICECHECK_DIR, else the sibling sue-dredd/pricecheck. Without it, this prints a skipped result. The scan skips what the
repo gitignores and reads no clock or network, so two runs on one commit print the same number. Prints one JSON line.
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[2]
checkout = Path(os.environ.get("PRICECHECK_DIR") or root.parent / "sue-dredd" / "pricecheck")
cli = checkout / "bin" / "pricecheck.mjs"
if not cli.is_file():
    print(json.dumps({"skipped": True, "reason": f"no price checker at {checkout}"}))
    raise SystemExit(0)
out = subprocess.run(["bun", str(cli), "scan", "--json"], cwd=root, capture_output=True,
                     text=True, encoding="utf-8", check=True).stdout
pages = json.loads(out)["pages"]
print(json.dumps({"points": sum(p["points"] for p in pages), "pages": len(pages)}))
