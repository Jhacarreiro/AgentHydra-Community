"""Per-model results for the console's overview charts: thumbs up/down, cost per successful task, edit survival, daily volume.

Pure aggregation over the ledger (one line per finished task) and the survival log (edit scores per checkpoint). The ledger
runs to ~140 MB, so only the window's tail is parsed (ledger._window_start), and model_stats() answers from a cache it
refreshes on a thread (see there): a range switch in the console reads nothing.
"""
from __future__ import annotations

import datetime as dt
import json
import threading
import time
from pathlib import Path

from . import config, ledgerstore
from .ledger import money_kind, window_lines

TOP_DAILY = 6
# A cached answer younger than this is served as it is, even when the ledger has grown since.
MAX_AGE_S = 60.0
# The console's ranges, read on a thread after the first call so a switch between them never waits.
WARM_DAYS = (14, 30)
# The console's All: every task the ledger and its archives hold.
ALL_DAYS = 3650
_CACHE: dict = {}  # days -> (files key, monotonic time it was computed, answer)
_BUSY: set[int] = set()  # days with a refresh running
_LOCK = threading.Lock()
_DONE = threading.Condition(_LOCK)  # notified when a refresh ends
# How long a call for a range waits for the refresh already reading it before it reads the files itself.
WAIT_S = 30.0


def _sig(p: Path) -> tuple[int, int] | None:
    try:
        st = p.stat()
    except OSError:
        return None
    return st.st_size, st.st_mtime_ns


def _survival_1d(path: Path, since: dt.datetime) -> dict[tuple, float]:
    """(job, task) -> four_gram of the task's newest 1d score. The log is small next to the ledger: read whole."""
    out: dict[tuple, float] = {}
    try:
        f = path.open("rb")
    except OSError:
        return out
    with f:
        for line in f:
            try:
                r = json.loads(line)
                if r.get("checkpoint") != "1d" or dt.datetime.fromisoformat(r["ts"]) < since - dt.timedelta(days=2):
                    continue
                out[(r.get("job"), r.get("task"))] = float(r["four_gram"])
            except (ValueError, KeyError, TypeError):
                continue
    return out


def _unjudged(r: dict) -> bool:
    """A non-ok line that says nothing about the model: the caller or a server stop cancelled it, the caller's own job
    budget ended it, or its failure was a dead key (`unjudged`). Old lines have only the `cancelled` status."""
    return r.get("status") != "ok" and (r.get("status") == "cancelled" or r.get("error_kind") in ("cancelled", "job_budget")
                                        or bool(r.get("unjudged")))


def _add_task(m: dict, r: dict) -> None:
    """One ledger line's task, status, spend, time and tokens into its model's tally. A free_miss line is a Free try
    HSwarm did not accept, not a task: it counts as a failure (a thumbs-down) and nothing else. A cancelled,
    job-budget or unjudged line is a task that is neither a success nor a failure."""
    if r.get("free_miss"):
        m["failed"] += 1
        return
    m["tasks"] += 1
    if r.get("status") == "ok":
        m["ok"] += 1
    elif _unjudged(r):
        m["unjudged"] += 1
    else:
        m["failed"] += 1
    m["cost_usd"] += float(r.get("cost_usd") or 0.0)
    m[money_kind(r) + "_usd"] += float(r.get("cost_usd") or 0.0)
    m["seconds"] += float(r.get("seconds") or 0.0)
    m["tokens"] += sum(r.get(k) or 0 for k in ("in_hit", "in_miss", "out", "reasoning") if isinstance(r.get(k), int))


def _summary(m: dict) -> dict:
    """A model's tally as the console shows it: rounded, with its rates and averages."""
    s = m.pop("_surv")
    return {**m, "success_rate": round(m["ok"] / (m["ok"] + m["failed"]), 4) if m["ok"] + m["failed"] else None, "cost_usd": round(m["cost_usd"], 6),
            "value_usd": round(m["cost_usd"], 6), "spent_usd": round(m["spent_usd"], 6),
            "free_usd": round(m["free_usd"], 6), "unknown_usd": round(m["unknown_usd"], 6),
            "cost_per_ok": round(m["cost_usd"] / m["ok"], 6) if m["ok"] else None,
            "tokens_per_ok": round(m["tokens"] / m["ok"]) if m["ok"] else None,
            "avg_seconds": round(m["seconds"] / m["tasks"], 2) if m["tasks"] else 0.0, "seconds": round(m["seconds"], 1),
            "survival": round(s / m["scored"], 4) if m["scored"] else None}


def compute(days: int, ledger: Path, survival_log: Path, now: dt.datetime | None = None) -> dict:
    """Per-model tallies for ledger lines newer than `days` days. Failed = any status but "ok"; a `cached` line (a resume
    reusing an answer) is no new task. Cost per ok task = the model's whole spend over its ok tasks (failures are paid for)."""
    now = now or dt.datetime.now(dt.timezone.utc)
    since = now - dt.timedelta(days=days)
    models: dict[str, dict] = {}
    day_counts: dict[str, dict[str, int]] = {}
    rows: list[tuple[str, tuple]] = []
    for line in window_lines(ledger, since):
        try:
            r = json.loads(line)
            at = dt.datetime.fromisoformat(r["ts"])
        except (ValueError, KeyError, TypeError):
            continue
        if at < since or r.get("cached"):
            continue
        name = str(r.get("model") or "other")
        m = models.setdefault(name, {"model": name, "tasks": 0, "ok": 0, "failed": 0, "unjudged": 0, "cost_usd": 0.0, "seconds": 0.0,
                                     "spent_usd": 0.0, "free_usd": 0.0, "unknown_usd": 0.0, "tokens": 0, "scored": 0, "_surv": 0.0})
        _add_task(m, r)
        if r.get("free_miss"):
            continue  # not a task: no day count, no survival score
        day = at.astimezone().date().isoformat()
        day_counts.setdefault(name, {}).setdefault(day, 0)
        day_counts[name][day] += 1
        rows.append((name, (r.get("job"), r.get("task"))))
    scores = _survival_1d(survival_log, since) if rows else {}
    for name, key in rows:
        if key in scores:
            models[name]["scored"] += 1
            models[name]["_surv"] += scores[key]
    out = [_summary(m) for m in sorted(models.values(), key=lambda m: (-m["tasks"], m["model"]))]
    top = [m["model"] for m in out[:TOP_DAILY]]
    today = now.astimezone().date()
    dates = [(today - dt.timedelta(days=i)).isoformat() for i in range(days - 1, -1, -1)]
    daily = [{"date": d, "models": {n: day_counts.get(n, {}).get(d, 0) for n in top},
              "other": sum(c.get(d, 0) for n, c in day_counts.items() if n not in top)} for d in dates]
    return {"days": days, "models": out, "daily": {"top": top, "days": daily}}


def _key(days: int, ledger: Path, log: Path) -> tuple:
    return (str(ledger), str(log), days, _sig(ledger), _sig(log), tuple((m, _sig(p)) for m, p in sorted(ledgerstore.archives(ledger).items())))


def _refresh(days: int, ledger: Path, log: Path) -> dict:
    """compute() into the cache. The paths are the caller's, so a refresh in the background reads the files it was asked about."""
    try:
        out = compute(days, ledger, log)
        with _LOCK:
            _CACHE[days] = (_key(days, ledger, log), time.monotonic(), out)
        return out
    finally:
        with _LOCK:
            _BUSY.discard(days)
            _DONE.notify_all()


def _refresh_later(days: int, ledger: Path, log: Path, seen: tuple | None = None) -> None:
    """_refresh() on a daemon thread, unless one is already running for these days or `seen`, the cache entry the caller
    judged stale, has been replaced since: a call that read the entry just before a running refresh stored its answer
    started a second full read of the ledger (2026-10-13: 2 of 20 runs of the refresh test read it three times)."""
    with _LOCK:
        if days in _BUSY or (seen is not None and _CACHE.get(days) is not seen):
            return
        _BUSY.add(days)
    threading.Thread(target=_refresh, args=(days, ledger, log), name=f"model-stats-{days}", daemon=True).start()


def model_stats(days: int = 14) -> dict:
    """compute() for the live files, answered from the cache whenever there is one (owner, 2026-10-10: switching the
    range was "very slow and laggy"). The ledger grows with every finished task, so a cache keyed on its size missed
    almost every call and re-read ~140 MB (5 to 7 s a range). Now a cached answer is served at once; one older than
    MAX_AGE_S whose files changed is refreshed on a thread for the next call. Only a range never read waits, and the
    first read warms the console's other ranges. `days` up to ALL_DAYS: the console's All."""
    days = max(1, min(ALL_DAYS, int(days)))
    ledger, log = config.LEDGER, config.HOME / "survival.jsonl"
    with _LOCK:
        missing = [d for d in WARM_DAYS if d != days and d not in _CACHE and d not in _BUSY]
        # A warm-up already reading this range is waited for, not read twice.
        deadline = time.monotonic() + WAIT_S
        while days not in _CACHE and days in _BUSY and time.monotonic() < deadline:
            _DONE.wait(timeout=deadline - time.monotonic())
        hit = _CACHE.get(days)
        if hit is None:
            _BUSY.add(days)
    for d in missing:
        _refresh_later(d, ledger, log)
    if hit is None:
        return _refresh(days, ledger, log)
    key, at, out = hit
    if time.monotonic() - at >= MAX_AGE_S and key != _key(days, ledger, log):
        _refresh_later(days, ledger, log, hit)
    return out
