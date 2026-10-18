"""shortfall.report: the tasks the Free accounts or CliMayte turned away for want of an account, and how many more
accounts of each kind would have taken them."""
from __future__ import annotations

import datetime as dt
import json

from hswarm import config, shortfall

T0 = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=2)


def _row(start_s: float, seconds: float, **kw) -> dict:
    """A ledger line for a task routed `start_s` seconds after T0 that ran `seconds`."""
    ts = T0 + dt.timedelta(seconds=start_s + seconds)
    return {"ts": ts.isoformat(), "job": "j", "task": "t", "status": "ok", "seconds": seconds, **kw}


def _pool(rep: dict, name: str) -> dict:
    return next(p for p in rep["pools"] if p["pool"] == name)


# Contract: the report counts only the turn-aways more accounts would have fixed (the rest by reason), within its
# window, and replays them against k more accounts the way the routing works: an account takes a task only when it is
# free at that moment, then is busy for its kind's median time per task. `more` stops where one more account would
# take under 5% of them. Regression: an hourly throughput sum (6 CliMayte tasks an hour each) would call one or two
# accounts enough for a burst of six at once; a count of every turn-away would ask for accounts when the PC held them.
def test_the_report_counts_what_more_accounts_would_have_taken(monkeypatch, tmp_path):
    old = T0 - dt.timedelta(days=3)
    rows = [{"ts": old.isoformat(), "job": "j", "task": "t", "seconds": 5, "short_pool": "free", "short_why": "busy"}]
    # CliMayte: 600 s a task; six turned away at once, two more 700 s later; three held by the PC.
    rows += [_row(0, 600, provider="climayte", climayte_worker=f"w{i}") for i in range(5)]
    rows += [_row(1000, 50, provider="deepseek", short_pool="climayte", short_why="accounts") for _ in range(6)]
    rows += [_row(1700, 50, provider="deepseek", short_pool="climayte", short_why="accounts") for _ in range(2)]
    rows += [_row(1000, 50, provider="deepseek", short_pool="climayte", short_why="machine") for _ in range(3)]
    # Free: ChatGPT 30 s a task (median of 20, 30, 40) on two accounts; one Claude answer; a failed try is not served.
    rows += [_row(0, s, provider="free", model="free:gpt-5-6-mini", free_account=a) for s, a in ((20, "acct-a"), (30, "acct-b"), (40, "acct-a"))]
    rows += [_row(0, 50, provider="free", model="free:claude-haiku-5-5", free_account="acct-c")]
    rows += [_row(0, 0, provider="free", model="free:gpt-5-6-mini", status="error", free_miss=True)]
    # Forty turned away one a second, every account busy; three more turned away for reasons accounts would not fix.
    rows += [_row(3000 + i, 5, provider="deepseek", short_pool="free", short_why="busy") for i in range(40)]
    rows += [_row(3000, 5, provider="deepseek", short_pool="free", short_why=w) for w in ("signed_out", "capped", "capped")]
    monkeypatch.setattr(config, "LEDGER", tmp_path / "ledger.jsonl")
    config.LEDGER.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")

    rep = shortfall.report(days=1)

    climayte = _pool(rep, "climayte")
    assert climayte["turned_away"] == 8 and climayte["not_counted"] == {"machine": 3}
    # k more take min(k, 6) of the burst and min(k, 2) of the pair: 2, 4, 5, 6, 7, 8, then nothing more.
    assert climayte["kinds"] == [{"kind": "climayte", "accounts": None, "served": 5, "per_hour": 6.0, "more": 6, "would_take": 8}]
    free = _pool(rep, "free")
    assert free["turned_away"] == 40 and free["not_counted"] == {"signed_out": 1, "capped": 2}
    # k more take the first k, then (free again 30 s on) min(k, 10) of the last ten: 2 an account up to 10, 1 after.
    assert free["kinds"] == [
        {"kind": "chatgpt", "accounts": 2, "served": 3, "per_hour": 120.0, "more": 10, "would_take": 20},
        {"kind": "claude", "accounts": 1, "served": 1, "per_hour": None, "more": None, "would_take": None},
    ]
    assert "acct-" not in json.dumps(rep)  # counts only, never an account's name
