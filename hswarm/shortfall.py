"""What more of the capacity that costs nothing extra would have done (owner, 2026-10-13: "if we had six more, this
would have helped"). A task the owner's Free web accounts or CliMayte could have taken, but that found no account with
room and ran on a paid API route, carries `short_pool` and `short_why` on its ledger line (ledger.short_fields). Only the
turn-aways more accounts would have fixed are counted: every account busy, paced or resting (Free) or every account busy
or at its ceiling (CliMayte). A cap HSwarm set itself, signed-out accounts, or a PC too busy to start a CliMayte worker
are reported apart, as `not_counted`.

For each kind of account the report replays the counted turn-aways against k more accounts of that kind: an extra
account takes a task only when it is free at the moment the task was routed (the routing never queues), and is then
busy for the median time that kind took per task in the same window. `more` is the number of accounts worth adding: the
last k whose own account still takes at least MIN_GAIN of the counted turn-aways (and at least one task); `would_take`
is how many k = `more` accounts would have taken. A ChatGPT account's pacing (so many new chats per 30 minutes,
AgentHydra's mcp-free.ts) is not replayed, only its time per task: where pacing binds, `more` is a floor."""
from __future__ import annotations

import datetime as dt
import heapq
import statistics

from . import ledger

COUNTED = {"free": ("busy", "paced", "resting"), "climayte": ("accounts",)}
MIN_GAIN = 0.05
MAX_MORE = 50
MIN_SERVED = 3  # fewer served tasks than this in the window: no time per task to replay with


def _kind(row: dict) -> str | None:
    """The kind of account that served a row, or None for a row no account of a counted pool served."""
    if row.get("status") != "ok" or row.get("free_miss"):
        return None
    if row.get("provider") == "climayte":
        return "climayte"
    if row.get("provider") == "free":
        model = str(row.get("model") or "")
        return "chatgpt" if "gpt" in model else "claude" if "claude" in model else None
    return None


def _start(row: dict) -> float | None:
    """When the row's task was routed, as epoch seconds: its finish less its run time."""
    try:
        return dt.datetime.fromisoformat(row["ts"]).timestamp() - float(row.get("seconds") or 0)
    except (KeyError, TypeError, ValueError):
        return None


def taken(starts: list[float], busy_s: float, k: int) -> int:
    """How many tasks routed at `starts` (sorted) k more accounts would have taken, each busy `busy_s` per task."""
    free_at = [float("-inf")] * k
    n = 0
    for t in starts:
        if free_at[0] <= t:
            heapq.heapreplace(free_at, t + busy_s)
            n += 1
    return n


def _more(starts: list[float], busy_s: float) -> tuple[int, int]:
    """(accounts worth adding, how many tasks that many would have taken)."""
    floor = max(1.0, MIN_GAIN * len(starts))
    best, prev = 0, 0
    for k in range(1, MAX_MORE + 1):
        got = taken(starts, busy_s, k)
        if got - prev < floor:
            break
        best, prev = k, got
    return best, prev


def report(days: float = 1.0) -> dict:
    """The shortfall over the last `days`: per pool, the counted turn-aways, the rest by reason, and per kind of
    account how many more would have been worth having and how many tasks they would have taken. No account's name
    is in it, only counts."""
    rows = ledger.ledger_rows(days)
    turned: dict[str, list[float]] = {pool: [] for pool in COUNTED}
    skipped: dict[str, dict[str, int]] = {pool: {} for pool in COUNTED}
    secs: dict[str, list[float]] = {}
    accounts: dict[str, set] = {}
    for r in rows:
        pool = r.get("short_pool")
        if pool in COUNTED:
            why = str(r.get("short_why") or "unknown")
            if why in COUNTED[pool] and (t := _start(r)) is not None:
                turned[pool].append(t)
            elif why not in COUNTED[pool]:
                skipped[pool][why] = skipped[pool].get(why, 0) + 1
            continue
        kind = _kind(r)
        if kind and float(r.get("seconds") or 0) > 0:
            secs.setdefault(kind, []).append(float(r["seconds"]))
            if r.get("free_account") is not None:
                accounts.setdefault(kind, set()).add(r["free_account"])
    pools = []
    for pool, starts in turned.items():
        starts.sort()
        kinds = []
        for kind in (("chatgpt", "claude") if pool == "free" else ("climayte",)):
            served = secs.get(kind) or []
            entry = {"kind": kind, "accounts": len(accounts[kind]) if kind in accounts else None, "served": len(served),
                     "per_hour": None, "more": None, "would_take": None}
            if len(served) >= MIN_SERVED:
                busy_s = statistics.median(served)
                entry["per_hour"] = round(3600 / busy_s, 1)
                entry["more"], entry["would_take"] = _more(starts, busy_s) if starts else (0, 0)
            if served or pool != "free":
                kinds.append(entry)
        pools.append({"pool": pool, "turned_away": len(starts), "not_counted": skipped[pool], "kinds": kinds})
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)
    return {"days": days, "since": since.isoformat(timespec="seconds"), "pools": pools}
