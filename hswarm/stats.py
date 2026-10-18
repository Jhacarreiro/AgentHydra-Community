"""Stats from HSwarm's utilization DB, served to the console.

When HSWARM_STATS_DB is set, reads that database (read-only) instead of HSwarm's own, reported as ZSwarm history:
it was for reading ZSwarm's production database while ZSwarm ran. ZSwarm is retired (2026-10-03) and
`hswarm import-zswarm` merged its stats into HSwarm's own DB, so the daemon no longer sets it; a person's own
value is still honoured.
"""
from __future__ import annotations

import datetime as dt
import os
import sqlite3
import time
from pathlib import Path

from . import report_html, utilization

CACHE_TTL = 120.0  # seconds; a live call costs 3-5 s and the web polls it
_cache: dict[tuple[str, int], tuple[float, dict]] = {}


def stats(days: int = 30) -> dict:
    """Stats from the utilization DB (ZSwarm or HSwarm), in the shape the web console consumes.

    Returns {source, generated, empty, total, plan_rates, plan, by_machine, days, claude_by_family,
    accounts, rule_check, recent, today}. A non-empty answer is kept CACHE_TTL seconds per `days` value.
    """
    days = max(1, min(days, 90))
    db_path = _db_path()
    if not db_path or not db_path.exists():
        return _empty()

    key = (str(db_path), days)
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < CACHE_TTL:
        return hit[1]

    answer = _read(db_path, days)
    if not answer["empty"]:
        _cache[key] = (time.monotonic(), answer)
    return answer


def _read(db_path: Path, days: int) -> dict:
    c = _connect(db_path)
    try:
        total = utilization.totals(c)
        if not total or not total.get("n", 0) > 0:
            return _empty()

        rates = utilization.plan_rates(c)
        per_day = report_html.per_day(c, rates)
        mine = utilization.claude_day_rows(c, utilization.MACHINE)
        latest = mine[0] if mine else None
        # The stored check, as the report shows it: recomputing would read this home's routing log, not the DB's.
        rule_check = {**latest["rules"], "day": latest["day"], "partial": bool(latest.get("partial"))} if latest and latest.get("rules") else None
        recent_rows = utilization.recent(c, 50)
        # The last `days` calendar days, oldest first (both sources are newest first). Filled before it is cut: cut first, a
        # day nothing ran pushed the window a day further back.
        window = fill_zero_days(list(reversed(per_day)))[-days:]
        first_day = window[0]["day"] if window else ""

        return {
            "source": _source(),
            "generated": _now(),
            "empty": False,
            "total": total,
            "plan_rates": rates,
            "plan": utilization.plan_view(total, rates),
            "by_machine": [report_html.weigh_row(m, rates) for m in utilization.by_machine(c)],
            "days": window,
            "claude_by_family": [r for r in reversed(report_html.claude_by_family(c, rates)) if r["day"] >= first_day],
            "accounts": report_html.account_view(c),
            "rule_check": rule_check,
            "recent": recent_rows,
            "today": _today_data(per_day, c),
            "basis": basis(c),
            "old_method": old_method(c),
        }
    finally:
        c.close()


def _source() -> str:
    return "zswarm" if os.environ.get("HSWARM_STATS_DB") else "hswarm"


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def _empty() -> dict:
    """The answer when there is no DB, or it holds no runs: a normal answer with every list empty."""
    return {
        "source": _source(),
        "generated": _now(),
        "empty": True,
        "total": None,
        "plan_rates": None,
        "plan": None,
        "by_machine": [],
        "days": [],
        "claude_by_family": [],
        "accounts": {"rows": [], "worked": 0, "open": 0},
        "rule_check": None,
        "recent": [],
        "today": _today_data([]),
        "basis": None,
        "old_method": {"saved_usd": 0.0, "rows": 0},
    }


def _db_path() -> Path | None:
    """The path to the stats DB: HSWARM_STATS_DB when set, else the default hswarm DB."""
    env_path = os.environ.get("HSWARM_STATS_DB", "").strip()
    if env_path:
        return Path(env_path)
    return utilization.db_path()


def _connect(db_path: Path) -> sqlite3.Connection:
    """Open the DB read-only. HSWARM_STATS_DB points to a production database that the hswarm
    sidecar must never write to."""
    c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=15)
    c.row_factory = sqlite3.Row
    return c


ZERO_DAY = {"n": 0, "tasks": 0, "worker_usd": 0.0, "worker_tokens": 0, "unpriced": 0, "unsized": 0, "est_usd": 0.0, "est_low_usd": 0.0,
            "saved_usd": 0.0, "saved_low_usd": 0.0, "est_tokens": 0, "claude_usd": None, "claude_tokens": None, "plan_cost_usd": None,
            "plan_est_usd": None, "plan_saved_usd": None, "plan_saved_low_usd": None, "plan_claude_usd": None, "partial": False,
            "rate": None, "machines": 0, "share": None, "token_share": None, "plan_share": None}


def fill_zero_days(days: list[dict], today: dt.date | None = None) -> list[dict]:
    """Oldest-first days with every missing calendar day, from the first day that has rows through today, as a ZERO day:
    nothing ran, so exactly nothing was saved (a gap would read as 'not measured' and a 7-day window would reach back
    past the week)."""
    if not days:
        return days
    have = {d["day"]: d for d in days}
    day = dt.date.fromisoformat(days[0]["day"])
    end = max(today or dt.date.today(), dt.date.fromisoformat(days[-1]["day"]))
    out = []
    while day <= end:
        iso = day.isoformat()
        out.append(have.get(iso) or {**ZERO_DAY, "day": iso})
        day += dt.timedelta(1)
    return out


# The label a row counts under: a decide is an ask whose label is 'decide' (grouping on the kind column cannot tell them apart).
_LABEL_SQL = ("SELECT CASE WHEN label = 'decide' THEN 'decide' WHEN kind = 'ask' THEN 'ask' ELSE 'run' END AS bucket, "
              "COALESCE(SUM(tasks), 0) AS tasks, COALESCE(SUM(ok), 0) AS ok FROM utilizations WHERE day = ? GROUP BY bucket")


def by_label(c: sqlite3.Connection | None, today_iso: str) -> dict:
    """Today's tasks and how many answered, per label (run / ask / decide). Free misses are not rows of this table (they are not tasks)."""
    out = {k: {"tasks": 0, "ok": 0} for k in ("run", "ask", "decide")}
    if c is not None:
        for r in c.execute(_LABEL_SQL, (today_iso,)):
            out[r["bucket"]] = {"tasks": int(r["tasks"]), "ok": int(r["ok"])}
    return out


def basis(c: sqlite3.Connection) -> dict:
    """What 'saved' is priced against: the method, since when, and the measured sub-agent profile (list price) behind it."""
    prof = utilization.current_profile(c)
    row = c.execute("SELECT est_model FROM utilizations WHERE machine = ? AND method = ? AND est_model IS NOT NULL ORDER BY ts DESC LIMIT 1",
                    (utilization.MACHINE, utilization.METHOD)).fetchone()
    model = row["est_model"] if row else utilization.FLOOR_MODEL
    tokens = sum(int(prof.get(k) or 0) for k in utilization.TOKEN_KEYS) if prof else None
    return {"method": utilization.METHOD, "method_since": utilization.METHOD_SINCE, "profile_model": model,
            "profile_usd": utilization.claude_usage.price_tokens(model, prof) if prof else None,
            "profile_tokens": tokens, "profile_updated": prof["ts"] if prof else None}


def old_method(c: sqlite3.Connection) -> dict:
    """Rows still priced by an older method (another machine's, which only that machine can re-price) and what they add to 'saved'."""
    r = c.execute("SELECT COUNT(*) AS rows, COALESCE(SUM(saved_usd), 0) AS saved_usd FROM utilizations WHERE COALESCE(method, 0) < ?",
                  (utilization.METHOD,)).fetchone()
    return {"saved_usd": round(r["saved_usd"], 4), "rows": r["rows"]}


def _today_data(per_day: list[dict], c: sqlite3.Connection | None = None) -> dict:
    """The summary for today's local day, from per_day; zeros when there is none."""
    today_iso = dt.date.today().isoformat()
    row = next((d for d in per_day if d.get("day") == today_iso), None)
    labels = by_label(c, today_iso)
    if not row:
        return {"runs": 0, "tasks": 0, "est_usd": None, "saved_usd": None, "worker_usd": 0.0, "est_tokens": None, "by_label": labels}
    return {
        "runs": row.get("n", 0),
        "tasks": row.get("tasks", 0),
        "est_usd": row.get("est_usd"),
        "saved_usd": row.get("saved_usd"),
        "worker_usd": row.get("worker_usd", 0.0),
        "est_tokens": row.get("est_tokens"),
        "by_label": labels,
    }
