"""Offline: per-model results for the overview charts, from a small temp ledger and survival log."""
from __future__ import annotations

import datetime as dt
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from hswarm.model_stats import compute  # noqa: E402

NOW = dt.datetime(2026, 10, 3, 12, 0, tzinfo=dt.timezone.utc)


def _ts(days_ago: float) -> str:
    return (NOW - dt.timedelta(days=days_ago)).isoformat()


def _write(path: Path, rows: list[dict]) -> Path:
    path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    return path


def test_counts_cost_days_and_survival(tmp_path):
    ledger = _write(tmp_path / "ledger.jsonl", [
        {"ts": _ts(40), "job": "j0", "task": "t", "model": "a", "status": "ok", "cost_usd": 9.0},  # outside the window
        {"ts": _ts(1), "job": "j1", "task": "t1", "model": "a", "status": "ok", "cost_usd": 0.10, "seconds": 2, "out": 100},
        {"ts": _ts(1), "job": "j1", "task": "t2", "model": "a", "status": "ok", "cost_usd": 0.30, "seconds": 4, "in_miss": 50},
        {"ts": _ts(1), "job": "j1", "task": "t3", "model": "a", "status": "timeout", "cost_usd": 0.20, "seconds": 6},
        {"ts": _ts(2), "job": "j2", "task": "t1", "model": "b", "status": "error", "cost_usd": 0.0},
    ])
    surv = _write(tmp_path / "survival.jsonl", [
        {"ts": _ts(1), "job": "j1", "task": "t1", "model": "a", "checkpoint": "5m", "four_gram": 0.1},
        {"ts": _ts(1), "job": "j1", "task": "t1", "model": "a", "checkpoint": "1d", "four_gram": 0.8},
        {"ts": _ts(1), "job": "j1", "task": "t2", "model": "a", "checkpoint": "1d", "four_gram": 0.6},
        {"ts": _ts(1), "job": "j1", "task": "t3", "model": "a", "checkpoint": "1h", "four_gram": 0.0},
    ])
    out = compute(30, ledger, surv, now=NOW)
    a, b = out["models"]
    assert (a["model"], a["tasks"], a["ok"], a["failed"]) == ("a", 3, 2, 1)
    assert a["success_rate"] == round(2 / 3, 4)
    assert a["cost_usd"] == 0.6 and a["cost_per_ok"] == 0.3  # the failed task's spend counts against the ok ones
    assert a["avg_seconds"] == 4.0 and a["tokens"] == 150
    assert a["scored"] == 2 and a["survival"] == 0.7  # 1d rows only: the 5m and 1h rows are ignored
    assert (b["model"], b["ok"], b["failed"], b["cost_per_ok"], b["survival"]) == ("b", 0, 1, None, None)
    assert out["daily"]["top"] == ["a", "b"] and len(out["daily"]["days"]) == 30
    assert sum(d["models"]["a"] for d in out["daily"]["days"]) == 3


def test_cached_answer_is_served_at_once_and_refreshed_behind(tmp_path, monkeypatch):
    """The console's range switch never waits on the ledger: a cached answer comes back as it is, a stale one too while
    a thread reads the grown ledger for the next call (owner, 2026-10-10: the switch was "very slow and laggy")."""
    from hswarm import config
    from hswarm import model_stats as ms

    now = dt.datetime.now(dt.timezone.utc).isoformat()
    ledger = _write(tmp_path / "ledger.jsonl", [{"ts": now, "job": "j", "task": "a", "model": "m", "status": "ok"}])
    monkeypatch.setattr(config, "LEDGER", ledger)
    monkeypatch.setattr(config, "HOME", tmp_path)
    monkeypatch.setattr(ms, "_CACHE", {})
    monkeypatch.setattr(ms, "_BUSY", set())
    reads: list[int] = []
    real = ms.compute

    def counted(days, ledger_path, log, now=None):
        reads.append(days)
        return real(days, ledger_path, log, now)

    monkeypatch.setattr(ms, "compute", counted)
    tasks = lambda: ms.model_stats(14)["models"][0]["tasks"]  # noqa: E731
    assert tasks() == 1
    with ledger.open("a", encoding="utf-8") as f:
        f.write(json.dumps({"ts": now, "job": "j", "task": "b", "model": "m", "status": "ok"}) + "\n")
    assert tasks() == 1  # younger than MAX_AGE_S: served as it is, nothing read
    monkeypatch.setattr(ms, "MAX_AGE_S", 0.0)
    assert tasks() == 1  # stale and the ledger grew: still served at once, a thread reads it
    deadline = time.monotonic() + 5
    while tasks() != 2 and time.monotonic() < deadline:
        time.sleep(0.02)
    assert tasks() == 2
    assert reads.count(14) == 2  # the first call and the one refresh; 30 days was warmed on its own thread
    while ms._BUSY and time.monotonic() < deadline:  # let the warm-up finish inside the test's patches
        time.sleep(0.02)


def test_days_filter(tmp_path):
    ledger = _write(tmp_path / "ledger.jsonl", [
        {"ts": _ts(10), "job": "j", "task": "old", "model": "a", "status": "ok"},
        {"ts": _ts(1), "job": "j", "task": "new", "model": "a", "status": "ok"},
    ])
    none = tmp_path / "missing.jsonl"
    assert compute(14, ledger, none, now=NOW)["models"][0]["tasks"] == 2
    assert compute(5, ledger, none, now=NOW)["models"][0]["tasks"] == 1
