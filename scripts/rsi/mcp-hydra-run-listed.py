"""How often agents call a tool they already had listed through hydra_run.

The measure behind `mcp.hydra_run.listed_share` in .rsi/rsi.yaml. Reads the Claude Code transcripts on this PC for
hydra_run tool calls in the last --days days (default 7), and counts the ones whose input.tool is a tool the
agenthydra server lists directly (LISTED_TOOLS, loaded from server/src/mcp.ts at run time). A call routed that way
loses its caller binding. Each transcript's hydra_run calls are cached outside the repo under
~/.agenthydra/rsi-cache/, keyed by path, size and mtime, so a repeat run reads only the bytes appended since.
Prints one JSON line with counts and tool names only, never message text or paths.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
from collections import Counter
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HOME = Path.home()
CACHE = HOME / ".agenthydra" / "rsi-cache" / "mcp-hydra-run-listed.json"
TOOL = "mcp__agenthydra__hydra_run"
NEEDLE = b"hydra_run"


def transcripts() -> list[Path]:
    found = list((HOME / ".agenthydra" / "cli-instances").glob("*/projects/**/*.jsonl"))
    found += (HOME / ".claude" / "projects").glob("**/*.jsonl")
    found += (HOME / ".claude-instances").glob("*/projects/**/*.jsonl")
    return found


def listed_tools() -> set[str]:
    script = "const m = await import('./server/src/mcp.ts'); console.log(JSON.stringify([...m.LISTED_TOOLS]))"
    out = subprocess.run(["bun", "-e", script], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    return set(json.loads(out.strip().splitlines()[-1]))


def calls_in(rec: dict) -> list[list]:
    stamp = rec.get("timestamp")
    content = (rec.get("message") or {}).get("content")
    if not isinstance(stamp, str) or not isinstance(content, list):
        return []
    try:
        epoch = datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return []
    out = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "tool_use" and block.get("name") == TOOL:
            tool = (block.get("input") or {}).get("tool")
            out.append([epoch, block.get("id"), tool if isinstance(tool, str) else "(none)"])
    return out


def scan(path: Path, offset: int) -> tuple[list[list], int]:
    found: list[list] = []
    with path.open("rb") as fh:
        fh.seek(offset)
        for line in fh:
            if not line.endswith(b"\n"):
                break
            offset += len(line)
            if NEEDLE not in line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            found += calls_in(rec)
    return found, offset


def load_cache() -> dict:
    try:
        return json.loads(CACHE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=7)
    days = parser.parse_args().days
    since = time.time() - days * 86400
    listed = listed_tools()
    cache = load_cache()
    fresh: dict[str, dict] = {}
    bytes_read = 0
    seen: set[str] = set()
    calls: Counter[str] = Counter()
    misrouted: Counter[str] = Counter()
    files_read = 0
    for path in transcripts():
        key = str(path)
        try:
            st = path.stat()
        except OSError:
            continue
        entry = cache.get(key)
        if st.st_mtime < since:
            if entry:
                fresh[key] = entry
            continue
        files_read += 1
        if entry and entry["size"] == st.st_size and entry["mtime"] == st.st_mtime:
            cur = entry
        else:
            start = entry["offset"] if entry and st.st_size > entry["size"] else 0
            base = entry["calls"] if start else []
            try:
                found, offset = scan(path, start)
            except OSError:
                continue
            bytes_read += offset - start
            cur = {"size": st.st_size, "mtime": st.st_mtime, "offset": offset, "calls": base + found}
        fresh[key] = cur
        for epoch, call_id, tool in cur["calls"]:
            if epoch < since:
                continue
            if call_id is not None:
                if call_id in seen:
                    continue
                seen.add(call_id)
            calls[tool] += 1
            if tool in listed:
                misrouted[tool] += 1
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    tmp = CACHE.with_suffix(".tmp")
    tmp.write_text(json.dumps(fresh), encoding="utf-8")
    os.replace(tmp, CACHE)
    total = sum(calls.values())
    routed = sum(misrouted.values())
    print(json.dumps({
        "days": days,
        "hydra_run_calls": total,
        "misrouted_calls": routed,
        "listed_share": round(routed / total, 4) if total else None,
        "misrouted_by_tool": dict(misrouted.most_common()),
        "listed_tools": len(listed),
        "transcript_files_in_window": files_read,
        "bytes_read": bytes_read,
    }))


if __name__ == "__main__":
    main()
