"""Offline: the savings tiles' honesty - history re-priced by the per-task cap on each row's own profile, a per-row est_tokens,
a profile where every day weighs the same, the measured model mix, CliMayte and unsized tasks, a lossless record(), and the
stats payload's zero days, by_label and basis."""
from __future__ import annotations

import datetime as dt
import json
import sqlite3

import pytest

from hswarm import claude_usage, config, stats, taskstore, utilization

PROFILE = {"id": "p-old", "ts": "2026-10-01T00:00:00+00:00", "machine": utilization.MACHINE, "basis": "Sonnet", "sample": 9, "pool_days": 14,
           "input": 1000, "cache_read": 200_000, "cache_5m": 20_000, "cache_1h": 0, "output": 4000, "requests": 6}
PROF_TOKENS = 225_000
MODEL = "claude-opus-5-5"
DAY = "2026-10-05"
TS = "2026-10-05T12:00:00+00:00"


def _store_profile(c, prof=PROFILE):
    utilization._upsert(c, "profiles", utilization.PROFILE_COLUMNS, prof)


def _old_row(rid, kind="ask", machine=None, label="ask", ok=1, tasks=1, ts=TS, model=MODEL, task_tokens=None, worker_usd=0.0):
    """A row as the median-per-task method left it: no method, no est_tokens, priced a whole median sub-agent."""
    per = claude_usage.price_tokens(model, PROFILE)
    return {"id": rid, "ts": ts, "kind": kind, "machine": machine or utilization.MACHINE, "label": label, "orchestrator_model": model,
            "backend": "api", "worker_model": "deepseek-flash", "tasks": tasks, "ok": ok, "failed": tasks - ok, "worker_usd": worker_usd,
            "worker_tokens": 0, "est_model": model, "per_agent_usd": per, "est_usd": per * ok, "est_low_usd": per, "saved_usd": per * ok - worker_usd,
            "saved_low_usd": per, "basis": "old", "profile_id": PROFILE["id"], "task_tokens": task_tokens}


def _put(c, row):
    row = row | {"seq": utilization.next_seq(c, row)}
    utilization._upsert(c, "utilizations", utilization.COLUMNS, row)


def _ledger(*lines):
    config.LEDGER.parent.mkdir(parents=True, exist_ok=True)
    config.LEDGER.write_text("".join(json.dumps(x) + "\n" for x in lines), encoding="utf-8")


def _tasks_db(rows):
    con = taskstore.connect()
    for job, task, status, i, o in rows:
        con.execute("INSERT INTO tasks (job_id, task_id, status, in_tokens, out_tokens) VALUES (?,?,?,?,?)", (job, task, status, i, o))
    con.commit()
    con.close()


def test_reprice_history_caps_each_row_on_its_own_profile_from_ledger_and_task_history():
    _ledger({"ts": TS, "job": "ask", "task": "ask", "model": "deepseek-flash", "provider": "deepseek", "status": "ok", "in_hit": 2000, "in_miss": 400, "out": 100},
            {"ts": TS, "job": "decide", "task": "decide", "model": "jev-1", "provider": "typesafe", "status": "ok", "in_hit": 0, "in_miss": 500, "out": 50},
            {"ts": TS, "job": "ask", "task": "ask", "model": "x", "provider": "free", "status": "error", "free_miss": True, "in_hit": 0, "in_miss": 0, "out": 0})
    _tasks_db([("job-1", "a", "ok", 3000, 200), ("job-1", "b", "error", 9, 9)])
    c = utilization.connect()
    _store_profile(c)
    _put(c, _old_row("ask-1"))
    _put(c, _old_row("ask-2", label="decide") | {"worker_model": "jev-1"})
    _put(c, _old_row("job-1", kind="run", label="x", tasks=2, ok=1))
    _put(c, _old_row("other-1", machine="elsewhere"))  # another machine: only that machine can re-price it
    median = claude_usage.price_tokens(MODEL, PROFILE)

    dry = utilization.reprice_history(dry_run=True, c=c)
    assert dry["rows"] == 3 and dry["old_method"] == {"rows": 1, "saved_usd": pytest.approx(median, abs=1e-3)}
    assert c.execute("SELECT COUNT(*) FROM utilizations WHERE method IS NOT NULL").fetchone()[0] == 0  # a dry run writes nothing

    rep = utilization.reprice_history(c=c)
    rows = {r["id"]: dict(r) for r in c.execute("SELECT * FROM utilizations")}
    own_ask = utilization.task_usd(MODEL, [2000, 400, 100])
    assert own_ask < median / 10
    assert rows["ask-1"]["est_usd"] == pytest.approx(own_ask, abs=1e-6) and rows["ask-1"]["method"] == utilization.METHOD
    assert rows["ask-1"]["profile_id"] == "p-old"  # its own profile, not today's
    assert rows["ask-1"]["est_tokens"] == 2500  # the task's own tokens, not the profile's 225,000
    assert rows["ask-2"]["est_usd"] == pytest.approx(utilization.task_usd(MODEL, [0, 500, 50]), abs=1e-6)  # the decide, from its own ledger line
    assert rows["job-1"]["est_tokens"] == 3200 and rows["job-1"]["est_usd"] < median  # one answered task out of two, from tasks.sqlite
    assert rows["other-1"]["method"] is None and rows["other-1"]["est_usd"] == pytest.approx(median)  # untouched
    assert rep["saved_usd_after"] < rep["saved_usd_before"] / 10

    again = utilization.reprice_history(c=c)
    assert again["rows"] == 0  # already on this method


def test_a_run_job_missing_from_tasks_sqlite_is_sized_from_the_ledgers_own_ok_lines():
    _ledger({"ts": TS, "job": "job-ledger", "task": "a", "model": "deepseek-flash", "provider": "deepseek", "status": "ok", "in_hit": 2000, "in_miss": 400, "out": 100},
            {"ts": TS, "job": "job-ledger", "task": "b", "model": "x", "provider": "climayte", "status": "ok", "in_hit": 0, "in_miss": 0, "out": 0},
            {"ts": TS, "job": "job-ledger", "task": "c", "model": "deepseek-flash", "provider": "deepseek", "status": "error", "in_hit": 9, "in_miss": 9, "out": 9})
    c = utilization.connect()
    _store_profile(c)
    _put(c, _old_row("job-ledger", kind="run", label="x", tasks=3, ok=2))  # tasks.sqlite holds nothing for this job
    utilization.reprice_history(c=c)
    row = dict(c.execute("SELECT * FROM utilizations WHERE id = 'job-ledger'").fetchone())
    assert row["unsized"] == 0 and row["est_tokens"] == 2500  # task a from its ledger ok line, task b is CliMayte (credited nothing)
    assert row["est_usd"] == pytest.approx(utilization.task_usd(MODEL, [2000, 400, 100]), abs=1e-6)


def test_a_row_with_no_token_source_is_unsized_not_the_median_and_climayte_is_credited_nothing():
    c = utilization.connect()
    _store_profile(c)
    _put(c, _old_row("ask-lost"))
    utilization.reprice_history(c=c)
    lost = dict(c.execute("SELECT * FROM utilizations WHERE id = 'ask-lost'").fetchone())
    assert lost["est_usd"] == 0 and lost["unsized"] == 1 and lost["est_tokens"] == 0

    res = [{"status": "ok", "usage": {"in_hit": 0, "in_miss": 9_000_000, "out": 10}, "selection": {"route": {"provider": "climayte"}}},
           {"status": "ok", "usage": None}, {"status": "ok", "usage": {"in_hit": 10, "in_miss": 20, "out": 5}}]
    row = {"orchestrator_model": MODEL, "tasks": 3, "ok": 3, "worker_usd": 0.0, "task_tokens": utilization._answered_tokens(res)}
    est = utilization.estimate(row, PROFILE)
    assert est["unsized"] == 1
    assert est["est_usd"] == pytest.approx(utilization.task_usd(MODEL, [10, 20, 5]), abs=1e-6)  # the CliMayte task and the unsized one add nothing
    assert est["est_tokens"] == 35


def test_est_tokens_follows_the_same_cap_as_est_usd_and_the_sql_sums_it():
    c = utilization.connect()
    _store_profile(c)
    small = {"id": "s", "ts": TS, "kind": "ask", "machine": utilization.MACHINE, "orchestrator_model": MODEL, "tasks": 1, "ok": 1, "worker_usd": 0.0,
             "task_tokens": json.dumps([[2000, 400, 100]])}
    big = small | {"id": "b", "task_tokens": json.dumps([[0, 2_000_000, 10]])}  # its own cost is over a median sub-agent: the profile stands
    for r in (small, big):
        _put(c, r | utilization.estimate(r, PROFILE))
    c.commit()
    assert c.execute("SELECT est_tokens FROM utilizations WHERE id = 's'").fetchone()[0] == 2500
    assert c.execute("SELECT est_tokens FROM utilizations WHERE id = 'b'").fetchone()[0] == PROF_TOKENS
    assert utilization.totals(c)["est_tokens"] == 2500 + PROF_TOKENS  # tasks x profile would have said 450,000
    from hswarm import report_html

    assert sum(d["est_tokens"] for d in report_html.per_day(c, utilization.plan_rates(c))) == 2500 + PROF_TOKENS


def test_one_burst_day_does_not_move_the_profile_median():
    quiet = [{"input": 100, "cache_read": 100_000, "cache_5m": 0, "cache_1h": 0, "output": 1000, "requests": 3}] * 6
    burst = [{"input": 100, "cache_read": 2_000_000, "cache_5m": 0, "cache_1h": 0, "output": 1000, "requests": 3}] * 300
    days = [{"day": f"2026-10-0{i}", "agent_tokens": {"sonnet": quiet}} for i in range(1, 5)] + [{"day": "2026-10-05", "agent_tokens": {"sonnet": burst}}]
    prof = utilization.refresh_profile(days)
    assert prof["cache_read"] == 100_000  # a plain median over 324 agents would be 2,000,000


def test_a_row_is_priced_at_the_models_measured_that_day_before_the_callers_model():
    c = utilization.connect()
    c.execute("INSERT INTO claude_days (machine, day, by_model) VALUES (?,?,?)",
              (utilization.MACHINE, DAY, json.dumps({"claude-sonnet-5": {"agents": 3}, "claude-opus-5-5": {"agents": 1}})))
    mix = utilization.day_mix(c, utilization.MACHINE, DAY)
    assert mix == {"claude-sonnet-5": 3, "claude-opus-5-5": 1}
    row = {"orchestrator_model": "claude-fable-5-1", "tasks": 1, "ok": 1, "task_tokens": json.dumps([[0, 2_000_000, 10]])}
    got = utilization.estimate(row, PROFILE, mix)["est_usd"]
    want = 0.75 * claude_usage.price_tokens("claude-sonnet-5", PROFILE) + 0.25 * claude_usage.price_tokens("claude-opus-5-5", PROFILE)
    assert got == pytest.approx(want, abs=1e-6)
    assert utilization.estimate(row, PROFILE, {})["est_model"] == "claude-fable-5-1"  # no mix measured: the caller's model
    assert utilization.estimate(row | {"orchestrator_model": ""}, PROFILE, {})["est_model"] == utilization.FLOOR_MODEL


# Regression: 2026-10-13, an unpriced leg on a ranked route was priced by its model's name, which no Claude price knows once
# it carries an effort ('claude-sonnet-5-5-low') and no GPT route matches at all: it came to $0.
def test_a_leg_with_no_reported_cost_is_priced_from_its_tokens_at_its_routes_price():
    usage = {"in_hit": 0, "in_miss": 1_000_000, "out": 0}
    for route in ("rank:claude-sonnet-5-5-low:direct", "rank:gpt-6-sol:openai"):
        want = config.cost_usd(route, 0, 1_000_000, 0, prompt_tokens=1_000_000)
        assert want and utilization.leg_cost(route, None, usage) == pytest.approx(want), route
    assert utilization.leg_cost("claude-sonnet-5", None, usage) == pytest.approx(utilization.task_usd("claude-sonnet-5", [0, 1_000_000, 0]))
    assert utilization.leg_cost("claude-sonnet-5", 0.5, usage) == 0.5
    assert utilization.leg_cost("claude-sonnet-5", None, None) == 0.0


# Contract: re-pricing history adds what each answered leg that reported no cost comes to at its route's price to its row's
# worker cost, once. Regression: 2026-10-13, 3,416 Claude- and GPT-API answers had run while their routes had no price, and
# every row they went into counted them as $0, so the saving was overstated.
def test_reprice_adds_the_route_price_of_answers_that_reported_no_cost_to_the_worker_cost():
    route = "rank:claude-sonnet-5-5-low:direct"
    line = {"ts": TS, "model": route, "provider": "anthropic", "status": "ok", "in_hit": 0, "cost_usd": None}
    _ledger(line | {"job": "ask", "task": "ask", "in_miss": 100_000, "out": 2_000},
            line | {"job": "job-1", "task": "a", "in_miss": 50_000, "out": 1_000},
            line | {"job": "job-1", "task": "b", "in_miss": 9, "out": 9, "cost_usd": 0.25})
    c = utilization.connect()
    _store_profile(c)
    ask_id = utilization._ask_id(0, {"ts": TS})
    _put(c, _old_row(ask_id) | {"worker_model": route})
    _put(c, _old_row("job-1", kind="run", label="x", tasks=2, ok=2, worker_usd=0.25) | {"worker_model": route})
    rep = utilization.reprice_history(c=c)
    rows = {r["id"]: dict(r) for r in c.execute("SELECT * FROM utilizations")}
    when = dt.datetime.fromisoformat(TS)
    ask_usd = config.cost_usd(route, 0, 100_000, 2_000, when, prompt_tokens=100_000)
    run_usd = config.cost_usd(route, 0, 50_000, 1_000, when, prompt_tokens=50_000)
    assert ask_usd > 0 and run_usd > 0
    assert rows[ask_id]["worker_usd"] == pytest.approx(ask_usd, abs=1e-6)
    assert rows["job-1"]["worker_usd"] == pytest.approx(0.25 + run_usd, abs=1e-6)  # the priced answer's own cost stays
    assert rows[ask_id]["saved_usd"] == pytest.approx(rows[ask_id]["est_usd"] - ask_usd, abs=1e-6)
    assert rep["unbilled_usd"] == pytest.approx(ask_usd + run_usd, abs=1e-4)
    utilization.reprice_history(c=c)  # once: a re-priced row is not re-priced
    assert c.execute("SELECT worker_usd FROM utilizations WHERE id = ?", (ask_id,)).fetchone()[0] == pytest.approx(ask_usd, abs=1e-6)


def test_record_on_a_locked_db_parks_the_row_and_the_next_record_writes_it(monkeypatch):
    real = utilization.connect
    calls = {"n": 0}

    def locked():
        calls["n"] += 1
        if calls["n"] == 1:
            raise sqlite3.OperationalError("database is locked")
        return real()

    monkeypatch.setattr(utilization, "connect", locked)
    first = {"id": "job-lost", "ts": TS, "kind": "run", "machine": utilization.MACHINE, "orchestrator_model": MODEL, "tasks": 1, "ok": 1,
             "worker_usd": 0.0, "task_tokens": json.dumps([[0, 10, 1]])}
    utilization.record(first)
    assert utilization.pending_path().exists()
    utilization.record(first | {"id": "job-next"})
    monkeypatch.setattr(utilization, "connect", real)
    c = real()
    assert {r[0] for r in c.execute("SELECT id FROM utilizations")} == {"job-lost", "job-next"}
    assert not utilization.pending_path().exists()


def test_the_daily_job_writes_a_parked_row_and_reprices_once():
    utilization.record({"id": "keep", "ts": TS, "kind": "ask", "machine": utilization.MACHINE, "orchestrator_model": MODEL, "tasks": 1, "ok": 1,
                        "worker_usd": 0.0, "task_tokens": json.dumps([[0, 10, 1]])})
    utilization._park({"id": "parked", "ts": TS, "kind": "ask", "machine": utilization.MACHINE, "orchestrator_model": MODEL, "tasks": 1, "ok": 1,
                       "worker_usd": 0.0, "task_tokens": json.dumps([[0, 10, 1]])})
    rep = utilization.daily_maintenance()
    assert rep["drained"] == 1 and rep["repriced"] is not None
    assert utilization.daily_maintenance()["repriced"] is None  # guarded by the stored method version


def test_a_free_miss_ledger_line_is_not_backfilled_as_a_task(tmp_path):
    _ledger({"ts": TS, "job": "ask", "task": "ask", "model": "free:x", "provider": "free", "status": "error", "free_miss": True},
            {"ts": TS, "job": "ask", "task": "ask", "model": "deepseek-flash", "provider": "deepseek", "status": "ok", "in_miss": 5, "out": 1})
    assert utilization.backfill(tmp_path / "nojobs", config.LEDGER)["asks"] == 1


def test_stats_fills_missing_days_with_zero_days_and_splits_today_by_label():
    today = dt.date.today()
    days = [{"day": (today - dt.timedelta(6)).isoformat(), "saved_usd": 5.0}, {"day": (today - dt.timedelta(3)).isoformat(), "saved_usd": 2.0}]
    filled = stats.fill_zero_days(days, today)
    assert [d["day"] for d in filled] == [(today - dt.timedelta(k)).isoformat() for k in range(6, -1, -1)]
    assert [d["saved_usd"] for d in filled] == [5.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0]  # zero, not a gap: nothing ran

    c = utilization.connect()
    _store_profile(c)
    iso = today.isoformat()
    for rid, kind, label, tasks, ok in (("r", "run", "build", 4, 3), ("a", "ask", "ask", 2, 2), ("d", "ask", "decide", 5, 4)):
        _put(c, _old_row(rid, kind=kind, label=label, tasks=tasks, ok=ok, ts=dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")))
    c.commit()
    assert stats.by_label(c, iso) == {"run": {"tasks": 4, "ok": 3}, "ask": {"tasks": 2, "ok": 2}, "decide": {"tasks": 5, "ok": 4}}
    b = stats.basis(c)
    assert b["method"] == utilization.METHOD and b["method_since"] == utilization.METHOD_SINCE
    assert b["profile_usd"] == pytest.approx(claude_usage.price_tokens(b["profile_model"], PROFILE)) and b["profile_tokens"] == PROF_TOKENS
    assert stats.old_method(c)["rows"] == 3  # all three are still on the old method until re-priced
