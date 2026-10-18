"""Offline: the ledger line fields the stats-honesty contract adds (id, error_kind, unjudged, free_miss, token_basis,
failover_errors) and the counters that honour them."""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_decisions import FakeJev, FakeMgr, _item  # noqa: E402
from test_free_route import _consult, _task, fake  # noqa: E402,F401 - the fake daemon fixture

from hswarm import booking, commands, config, free_route, ledger  # noqa: E402
from hswarm import decisions as d  # noqa: E402
from hswarm import typesafe  # noqa: E402
from hswarm.jobs import JobManager  # noqa: E402
from hswarm.model_stats import compute  # noqa: E402
from hswarm.spec import Result  # noqa: E402


def _ledger() -> list[dict]:
    return [json.loads(x) for x in config.LEDGER.read_text(encoding="utf-8").splitlines()]


def _note(model: str = "free:gpt-5-6-mini") -> dict:
    return {"via": "api", "fallback": "free account failed", "free_miss": True, "free_model": model, "free_status": "error",
            "free_kind": "unavailable", "ts": "2026-10-12T10:00:00+00:00"}


def test_every_new_ledger_line_carries_a_unique_id():
    res = Result(id="ask", status="ok", model="deepseek-flash", finished=dt.datetime.now(dt.timezone.utc).isoformat())
    ledger.append_row(ledger.ask_row(res, None))
    ledger.append_row(ledger.ask_row(res, None))
    ids = [r["id"] for r in _ledger()]
    assert len(ids) == 2 and len(set(ids)) == 2 and all(len(i) == 32 for i in ids)


def test_a_non_ok_line_says_why():
    kind = ledger.error_kind_of
    assert kind("ok", None) is None
    assert kind("cancelled", "cancelled") == "cancelled"
    assert kind("cancelled", "job budget spent: $1 of $1") == "job_budget"
    assert kind("error", "API 402: no credit") == "key"
    assert kind("error", "PoolSaturated: gemini") == "unavailable"
    assert kind("timeout", "") == "timeout"
    assert kind("error", "InvalidStructuredAnswer: not json") == "model"


def test_a_free_try_that_failed_becomes_a_free_miss_row(fake):
    fake(state="failed")
    res, note = _consult(_task())
    assert res is None and note["free_miss"] and note["free_model"] == "free:gpt-5-6-mini"
    row = ledger.free_miss_row(note, "j1", "t0")
    assert (row["free_miss"], row["provider"], row["status"], row["cost_usd"], row["model"]) == (True, "free", "error", 0.0, "free:gpt-5-6-mini")
    assert row["error_kind"] == "unavailable" and row["job"] == "j1" and row["task"] == "t0"


def test_a_refused_send_names_the_model_from_the_account_provider(fake, monkeypatch):
    async def refused(name, arguments, timeout):
        if name == "free_chat":
            return {}  # no batch: refused after the status read
        return {"ready": True, "accounts": [{"account": "a1", "signedIn": True, "busy": False, "provider": "claude"}]}

    fake()
    monkeypatch.setattr(free_route, "_call", refused)
    res, note = _consult(_task())  # profile general: Haiku
    assert res is None and note["free_miss"] and note["free_model"] == "free:claude-haiku-5-5"


def test_the_job_path_books_the_miss_as_an_extra_row():
    JobManager._book_free_miss(_note(), "j9", "t3", None)
    JobManager._book_free_miss(None, "j9", "t4", None)  # nothing to book
    rows = _ledger()
    assert len(rows) == 1 and rows[0]["free_miss"] is True and rows[0]["task"] == "t3" and rows[0]["id"]


def test_the_ask_path_books_the_miss_instead_of_discarding_it(monkeypatch):
    from hswarm import dispatch

    async def consult(job_id, task):
        return None, _note("free:claude-haiku-5-5")

    async def api_ask(mgr, prompt, **kw):
        return Result(id="ask", status="ok", model="deepseek-flash")

    monkeypatch.setattr(free_route, "consult", consult)
    monkeypatch.setattr(dispatch, "ask_selected", api_ask)
    res = asyncio.run(JobManager()._ask_selected("hi", "general", "", True, {}))
    assert res.status == "ok"
    miss = [r for r in _ledger() if r.get("free_miss")]
    assert len(miss) == 1 and miss[0]["job"] == "ask" and miss[0]["model"] == "free:claude-haiku-5-5"


def test_a_free_job_row_counts_one_call_and_marks_its_tokens_estimated(fake):
    fake()
    res, note = _consult(_task())
    assert note is None and res.turns == 1
    row = ledger.ask_row(res, None)
    assert row["token_basis"] == "chars/4" and row["calls"] == 1


def test_a_cancelled_task_is_neither_success_nor_failure_and_a_free_miss_is_a_failure_not_a_task(tmp_path):
    now = dt.datetime(2026, 10, 12, 12, 0, tzinfo=dt.timezone.utc)
    base = {"ts": (now - dt.timedelta(hours=1)).isoformat(), "job": "j", "model": "m", "provider": "x"}
    rows = [{**base, "task": "a", "status": "ok"}, {**base, "task": "b", "status": "cancelled", "error_kind": "cancelled"},
            {**base, "task": "c", "status": "error", "error_kind": "job_budget"}, {**base, "task": "d", "status": "error", "error_kind": "model"},
            {**base, "task": "e", "status": "error", "error_kind": "key", "unjudged": "key"},
            {**base, "task": "f", "status": "error", "free_miss": True, "model": "free:g"}]
    path = tmp_path / "l.jsonl"
    path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    out = {m["model"]: m for m in compute(1, path, tmp_path / "s.jsonl", now)["models"]}
    assert (out["m"]["tasks"], out["m"]["ok"], out["m"]["failed"], out["m"]["unjudged"]) == (5, 1, 1, 3)
    assert out["m"]["success_rate"] == 0.5
    assert (out["free:g"]["tasks"], out["free:g"]["failed"]) == (0, 1)


def test_ledger_summary_does_not_count_a_free_miss_as_a_task():
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    for r in ({"ts": now, "job": "j", "task": "a", "model": "m", "status": "ok"},
              {"ts": now, "job": "j", "task": "a", "model": "free:g", "status": "error", "free_miss": True}):
        ledger.append_row(r)
    assert ledger.ledger_summary(1)["tasks"] == 1


def test_a_decide_whose_every_error_was_a_dead_key_is_unjudged(monkeypatch):
    jev = FakeJev({}, fail={"status": "error", "error": "HTTP 402: no credit", "http": 402})
    off = FakeJev({}, keys=())
    items = [_item("Which team?")]
    raw = asyncio.run(d.decide(items, FakeMgr(), jev=jev, stand_ins={"clef": off, typesafe.MD1: off}, escalate_below=0))

    async def decided(*a, **kw):
        return raw

    monkeypatch.setattr(booking.decisions, "decide", decided)
    asyncio.run(booking.decide(items, FakeMgr(), escalate_below=0))
    line = next(r for r in _ledger() if r["provider"] == "typesafe")
    assert line["status"] == "error" and line["unjudged"] == "key" and line["error_kind"] == "key"


def test_failover_errors_sit_beside_failover():
    res = Result(id="t", status="ok", model="b")
    res.failover = ["a"]
    res.failover_errors = [{"model": "a", "kind": "unavailable"}]
    assert ledger.ask_row(res, None)["failover_errors"] == [{"model": "a", "kind": "unavailable"}]


def test_backfill_adds_each_old_note_once(monkeypatch):
    job = config.JOBS_DIR / dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%S-aaaa")
    job.mkdir(parents=True)
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    line = {"id": "t1", "status": "ok", "started": now,
            "selection": {"profile": "routine", "route": {"via": "api", "fallback": "free account failed", "account": "claude-1"}}}
    (job / "results.jsonl").write_text(json.dumps(line) + "\n", encoding="utf-8")
    monkeypatch.setattr(commands.archive, "job_ids", lambda: [job.name])
    dry = commands.backfill_free_misses(30, dry_run=True)
    assert dry["rows"] == 1 and dry["by_model"] == {"free:claude-haiku-5-5": 1} and not config.LEDGER.exists()
    assert commands.backfill_free_misses(30)["rows"] == 1
    again = commands.backfill_free_misses(30)
    assert again["rows"] == 0 and again["existing"] == 1 and len(_ledger()) == 1


def test_backfill_reads_a_cold_day_in_one_pass(monkeypatch):
    # 2026-10-13: read job by job, every packed job re-read its day's tar.xz up to it; a 30-day dry run ran 10+ min.
    from hswarm import archive, history

    day = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=9)).strftime("%Y%m%d")
    line = {"id": "t1", "status": "ok", "started": f"{day[:4]}-{day[4:6]}-{day[6:]}T10:00:00+00:00",
            "selection": {"profile": "routine", "route": {"via": "api", "fallback": "free account timed out", "account": "gpt-1"}}}
    for jid in (f"{day}-100000-cccc", f"{day}-100001-dddd"):
        job = config.JOBS_DIR / jid
        job.mkdir(parents=True)
        (job / "job.json").write_text(json.dumps({"summary": {"job_id": jid, "state": "done", "tasks": 1}}), encoding="utf-8")
        (job / "results.jsonl").write_text(json.dumps(line) + "\n", encoding="utf-8")
    archive.archive_old(hours=0, apply=True)
    assert history.pack_jobs()["jobs"] == 2
    passes, real = [], history._members
    monkeypatch.setattr(history, "_members", lambda path: passes.append(path) or real(path))

    out = commands.backfill_free_misses(30, dry_run=True)

    assert out["rows"] == 2 and out["by_model"] == {"free:" + free_route.GPT_MODEL: 2}
    assert len(passes) == 1
