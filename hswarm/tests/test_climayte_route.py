"""Offline: an agentic task goes to an idle CliMayte account first (climayte_route.py), against a fake AgentHydra on a
free local port. Nothing here reaches the real daemon on 7787: conftest blanks AGENTHYDRA_URL for every test."""
from __future__ import annotations

import asyncio
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import climayte_route, config  # noqa: E402
from hswarm.client import ChatResult, Usage  # noqa: E402
from hswarm.jobs import JobManager  # noqa: E402
from hswarm.spec import Task  # noqa: E402


class _Api:
    """The API route: answers 'api route' and counts its calls."""

    def __init__(self):
        self.calls = 0

    async def chat(self, messages, **kw):
        self.calls += 1
        return ChatResult(message={"role": "assistant", "content": "api route"}, finish_reason="stop", usage=Usage(), model="deepseek-flash", seconds=0.01, cost_usd=0.01, peak=False)

    async def aclose(self):
        pass


class _Fake:
    """A fake AgentHydra: GET /api/corch/capacity, POST /api/corch/workers, GET /api/corch/workers/:id."""

    def __init__(self, idle=8, waiting=0, worker=None, delay=0.0, capacity_status=200, enabled=True, running_for=0.0, held=None,
                 running=None, progress=False):
        self.idle, self.waiting, self.delay, self.capacity_status, self.enabled = idle, waiting, delay, capacity_status, enabled
        self.held = held
        self.running_for, self.t0 = running_for, time.monotonic()
        # What a running worker's read carries beside its status; with `progress`, each read shows a new log line and
        # more output, as a worker whose model is replying does.
        self.running, self.progress, self.polls = running or {}, progress, 0
        # Set by _run(hold=): true once every task has taken a route. Workers stay running until then (running_for is
        # only the ceiling), so a slow start on a loaded box cannot free a slot before the last task decides.
        self.until = None
        self.cancelled: list[str] = []
        self.worker = worker or {"status": "done", "result": "worker report", "reportedModel": "claude-sonnet-5-5"}
        self.reads = 0
        self.dispatched: list[dict] = []
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, status, doc):
                data = json.dumps(doc).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                if self.path == "/api/corch/workers":
                    fake.dispatched.append(body)
                    return self._send(200, {"group": body.get("group"), "workers": [{"id": "w1"}]})
                if self.path == "/api/corch/cancel":
                    fake.cancelled.append(body.get("id"))
                    return self._send(200, {"ok": True})
                self._send(404, {})

            def do_GET(self):
                if self.path == "/api/routing/cost-model":
                    return self._send(200, {"settings": {"enabled": fake.enabled}})
                if self.path == "/api/corch/capacity":
                    fake.reads += 1
                    time.sleep(fake.delay)
                    return self._send(fake.capacity_status, {"idle": fake.idle, "accounts": 35, "running": 0, "waiting": fake.waiting,
                                                                  "held": fake.held})
                if self.path == "/api/corch/workers/w1":
                    if time.monotonic() - fake.t0 < fake.running_for and not (fake.until and fake.until()):
                        fake.polls += 1
                        live = {"lastActivity": f"Read f{fake.polls}.txt", "tokens": {"output": 100 * fake.polls}} if fake.progress else {}
                        return self._send(200, {"id": "w1", "status": "running", **fake.running, **live})
                    return self._send(200, {"id": "w1", **fake.worker})
                self._send(404, {})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server.server_port}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def fake(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "JOBS_DIR", tmp_path / "jobs")
    monkeypatch.setattr(config, "LEDGER", tmp_path / "ledger.jsonl")
    monkeypatch.setattr(climayte_route, "POLL_S", 0.01)
    monkeypatch.setattr(climayte_route, "_LOGGED", set())
    monkeypatch.setattr(climayte_route, "_ACTIVE", 0)
    monkeypatch.setattr(climayte_route, "_SENT", [])
    monkeypatch.setattr(climayte_route, "_SWITCH", {"at": -1e9, "on": True})
    made: list[_Fake] = []

    def make(**kw):
        f = _Fake(**kw)
        made.append(f)
        monkeypatch.setenv("AGENTHYDRA_URL", f.url)
        return f

    yield make
    for f in made:
        f.close()


def _run(tmp_path, tools="read", schema=None, timeout_s=30, n=1, hold=None):
    api = _Api()
    if hold is not None:
        hold.until = lambda: len(hold.dispatched) + api.calls >= n
    specs = [{"id": f"t{i}", "prompt": "look at it", "cwd": str(tmp_path), "tools": tools, "model": "deepseek-flash", "timeout_s": timeout_s} for i in range(n)]
    if schema:
        for spec in specs:
            spec["schema"] = schema

    async def go():
        return await JobManager(client=api).run_batch([Task.from_dict(spec, {}, i) for i, spec in enumerate(specs)], concurrency=n)

    job = asyncio.run(go())
    return job, job.results["t0"], api


# Contract: an eligible task goes to an idle CliMayte account before its API route, with no price question, and the
# worker's report is its answer. Regression: 2026-10-13, a price test (POST /api/routing/decide) sent tool tasks to
# paid keys a little cheaper than the plan's share of list price while 16 of 35 accounts sat idle; the owner wants the
# CliMayte accounts, which cost nothing extra, tried first whenever they are available.
def test_an_eligible_task_goes_to_an_idle_climayte_account_with_no_price_question(fake, tmp_path):
    f = fake()
    job, res, api = _run(tmp_path, tools="edit")
    assert res.status == "ok" and res.answer == "worker report" and api.calls == 0
    assert res.model == "claude-sonnet-5-5"
    assert res.selection["route"] == {"provider": "climayte", "decided": "subscription", "why": climayte_route.FREE_FIRST, "worker": "w1", "via": "climayte"}
    sent = f.dispatched[0]["tasks"][0]
    assert sent["kind"] == "code" and sent["cwd"] == str(tmp_path) and "look at it" in sent["prompt"]
    row = json.loads(config.LEDGER.read_text(encoding="utf-8").splitlines()[-1])
    assert row["provider"] == "climayte" and row["climayte_worker"] == "w1" and row["route_why"] == climayte_route.FREE_FIRST


# Contract: a routed task's From names its job and the chat its caller ran under. Only a session id is sent as the chat
# (the server refuses any other form with 400, so a malformed one is left out); the task is never pinged (origin None).
SESSION = "12345678-aaaa-4bbb-8ccc-1234567890ab"


@pytest.mark.parametrize("caller,by", [
    ({"session_id": SESSION}, {"label": "HSwarm job j-1", "sessionId": SESSION}),
    ({"chat_id": "not-a-session"}, {"label": "HSwarm job j-1"}),
    (None, {"label": "HSwarm job j-1"}),
])
def test_a_routed_task_declares_its_job_and_its_callers_chat(fake, tmp_path, caller, by):
    f = fake()
    task = Task.from_dict({"id": "t0", "prompt": "look at it", "cwd": str(tmp_path), "tools": "edit", "model": "deepseek-flash"}, {}, 0)
    asyncio.run(climayte_route.run_worker("j-1", task, {}, caller))
    assert f.dispatched[0]["by"] == by and f.dispatched[0]["origin"] is None


# Contract: with no account idle (or every idle one already spoken for by a queued worker), the task runs on its API
# route at once, never queued behind CliMayte, and its route says why: for want of an account, which the shortfall report
# counts, or because AgentHydra held every start for the PC (`held`), which more accounts would not fix (shortfall.py).
@pytest.mark.parametrize("idle,waiting,held,why", [(0, 0, None, "accounts"), (3, 3, None, "accounts"),
                                                   (0, 0, "88% busy over the last 60 s with 8 workers running", "machine")])
def test_with_no_idle_account_the_task_runs_on_its_api_route_at_once(fake, tmp_path, idle, waiting, held, why):
    f = fake(idle=idle, waiting=waiting, held=held)
    t0 = time.monotonic()
    _, res, api = _run(tmp_path)
    assert f.dispatched == [] and api.calls == 1 and time.monotonic() - t0 < 5
    assert res.selection["route"] == {"via": "api", "decided": "api", "why": climayte_route.NO_ROOM, "short": "climayte", "short_why": why}


# Contract: a burst of tasks that read one idle count takes only that many accounts: a task sent moments before a read
# is subtracted from it, so the rest run on their API route instead of queueing in CliMayte.
def test_a_burst_takes_only_the_idle_accounts(fake, tmp_path):
    f = fake(idle=2, running_for=10)
    job, _, api = _run(tmp_path, n=5, hold=f)
    assert len(f.dispatched) == 2 and api.calls == 3
    assert sorted(r.answer for r in job.results.values()).count("api route") == 3


@pytest.mark.parametrize("extra,tools,kind", [
    ({}, "edit", "code"),
    ({}, "all", "code"),
    ({"role": "review"}, "read", "review"),
    ({"role": "judge"}, "read", "review"),
    ({"role": "refute"}, "read", "review"),
    ({}, "read", "sweep"),
    ({"role": "summarize"}, "read", "sweep"),
])
def test_the_workers_kind_follows_the_task_so_read_only_work_stays_off_opus(fake, tmp_path, extra, tools, kind):
    f = fake()
    api = _Api()
    spec = {"id": "t0", "prompt": "look at it", "cwd": str(tmp_path), "tools": tools, "model": "deepseek-flash", "timeout_s": 30, **extra}
    asyncio.run(JobManager(client=api).run_batch([Task.from_dict(spec, {}, 0)], concurrency=1))
    sent = f.dispatched[0]["tasks"][0]
    assert sent["kind"] == kind
    # A read or edit task runs nothing, so it goes light and never waits behind CliMayte's CPU gate (2026-10-13:
    # 43 workers waited about 50 minutes there); only an `all` task, which may build and test, goes as an ordinary worker.
    assert sent.get("light") is (None if tools == "all" else True)


# Only an AUTO task keeps its profile (a pinned model, as the routed tests use, drops it), so the profile half of
# worker_kind is checked on the task as AUTO leaves it.
@pytest.mark.parametrize("profile,kind", [("critical", "review"), ("decision", "review"), ("research", "sweep"), ("code", "sweep")])
def test_an_auto_tasks_judging_profile_asks_for_review(profile, kind):
    assert climayte_route.worker_kind(Task(prompt="look at it", tools="read", profile=profile)) == kind


def test_a_schema_task_gets_the_workers_report_parsed(fake, tmp_path):
    fake(worker={"status": "done", "result": 'Done:\n```json\n{"n": 3}\n```', "reportedModel": "claude-sonnet-5-5"})
    _, res, api = _run(tmp_path, schema={"type": "object", "properties": {"n": {"type": "integer"}}, "required": ["n"]})
    assert res.status == "ok" and res.data == {"n": 3} and api.calls == 0


def test_a_tool_free_task_never_asks(fake, tmp_path):
    f = fake()
    _, res, api = _run(tmp_path, tools="none")
    assert f.reads == 0 and f.dispatched == [] and res.answer == "api route" and api.calls == 1


def test_inside_a_climayte_worker_it_never_asks(fake, tmp_path, monkeypatch):
    f = fake()
    monkeypatch.setenv("AGENTHYDRA_CLIMAYTE_WORKER", "w9")
    _, res, api = _run(tmp_path)
    assert f.reads == 0 and f.dispatched == [] and res.answer == "api route" and api.calls == 1


def test_the_setting_off_never_asks(fake, tmp_path, monkeypatch):
    f = fake()
    monkeypatch.setattr(config, "ROUTE_VIA_CLIMAYTE", False)
    _, res, api = _run(tmp_path)
    assert f.reads == 0 and f.dispatched == [] and res.answer == "api route" and api.calls == 1


def test_the_setting_reads_from_settings_toml(tmp_path):
    config._apply_settings({"route_via_climayte": False})
    assert config.ROUTE_VIA_CLIMAYTE is False
    config.reload()
    assert config.ROUTE_VIA_CLIMAYTE is True


def test_a_capacity_read_that_times_out_keeps_the_api_route(fake, tmp_path, monkeypatch):
    monkeypatch.setattr(climayte_route, "READ_TIMEOUT_S", 0.2)
    f = fake(delay=1.0)
    _, res, api = _run(tmp_path)
    assert f.reads == 1 and f.dispatched == []
    assert res.status == "ok" and res.answer == "api route" and api.calls == 1


def test_a_capacity_read_that_errors_keeps_the_api_route(fake, tmp_path):
    f = fake(capacity_status=500)
    _, res, api = _run(tmp_path)
    assert f.dispatched == [] and res.answer == "api route" and api.calls == 1


def test_a_failed_worker_falls_back_to_the_api_route_once(fake, tmp_path):
    f = fake(worker={"status": "failed", "result": None})
    _, res, api = _run(tmp_path)
    assert len(f.dispatched) == 1 and api.calls == 1
    assert res.status == "ok" and res.answer == "api route"
    assert res.selection["route"]["via"] == "api" and res.selection["route"]["climayte_failed"] == "w1"


def test_a_request_carrying_the_worker_header_is_never_routed(fake, tmp_path):
    from hswarm import shared

    f = fake()
    tok = shared.REQUEST.set({"climayte_worker": "1"})
    try:
        _, res, api = _run(tmp_path)
    finally:
        shared.REQUEST.reset(tok)
    assert f.reads == 0 and f.dispatched == [] and res.answer == "api route" and api.calls == 1


def test_over_the_cap_a_task_takes_its_api_route_without_asking(fake, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "ROUTE_VIA_CLIMAYTE_MAX", 4)
    f = fake(running_for=10)
    job, _, api = _run(tmp_path, n=5, hold=f)
    assert len(f.dispatched) == 4 and api.calls == 1
    assert sorted(r.answer for r in job.results.values()).count("api route") == 1


def test_a_worker_still_queued_at_the_start_deadline_is_cancelled_and_the_task_falls_back(fake, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "ROUTE_VIA_CLIMAYTE_START_S", 0.05)
    f = fake(worker={"status": "queued"})
    _, res, api = _run(tmp_path)
    assert f.cancelled == ["w1"] and api.calls == 1
    assert res.answer == "api route" and res.selection["route"]["climayte_not_started"] == "w1"


# Contract: a running CliMayte worker whose model gives no reply within QUIET_TASK_S is cancelled and its task runs on the
# API route, the worker named in `failover`; one whose log keeps moving is never cut, and while it works the job's row
# names it and never reads as quiet. Regression: 2026-10-13, a worker's row kept the API leg's name, 0 turns and no
# progress stamp, so status listed two working workers under quiet_running and a chat cancelled both (jobs
# 20261013-222800-34e6, -223522-44f8); and a worker that never replied held its task to timeout_s, the API route untried.
@pytest.mark.parametrize("replies", [False, True])
def test_a_running_worker_fails_over_only_when_its_model_never_replies(fake, tmp_path, monkeypatch, replies):
    # Replies a poll apart (10 ms) against a 1 s bar; the replying worker runs 2.5 s, well past it.
    monkeypatch.setattr(config, "QUIET_TASK_S", 1.0)
    f = fake(running_for=2.5 if replies else 60, running={"model": "claude-haiku-5-5"}, progress=replies)
    api = _Api()
    m = JobManager(client=api)

    async def watch():
        job = m.submit([Task.from_dict({"id": "t", "prompt": "look at it", "cwd": str(tmp_path), "tools": "read",
                                        "model": "deepseek-flash", "timeout_s": 6}, {}, 0)])
        loop = asyncio.get_running_loop()
        start, samples = loop.time(), []
        while job.results["t"].status in ("pending", "running") and loop.time() - start < 20:
            if job.results["t"].status == "running":
                samples.append((loop.time() - start, job.quiet_running(), job.results["t"].model))
            await asyncio.sleep(0.02)
        await asyncio.wait_for(m.wait(job.id, None), 20)
        return job.results["t"], loop.time() - start, samples

    res, took, samples = asyncio.run(watch())
    if replies:
        assert res.answer == "worker report" and api.calls == 0 and f.cancelled == [] and res.failover == []
        assert any(t > 1.2 for t, _, _ in samples), samples  # it ran past QUIET_TASK_S
        assert not any(q for _, q, _ in samples), samples  # replying all the while, it never read as quiet
        assert any(model == "climayte:claude-haiku-5-5" for _, _, model in samples), samples  # status named where it ran
    else:
        assert f.cancelled == ["w1"] and api.calls == 1 and res.answer == "api route"
        assert 1.0 <= took < 6, took  # cut at the quiet bar, not held to its timeout_s
        assert res.failover == ["climayte:claude-haiku-5-5"] and res.failover_errors == [{"model": "climayte:claude-haiku-5-5", "kind": "slow"}]
        assert res.selection["route"]["climayte_silent"] == "w1" and "no reply in 1 s" in res.selection["route"]["climayte_why"]


def test_agenthydras_switch_off_means_no_capacity_read(fake, tmp_path):
    f = fake(enabled=False)
    _, res, api = _run(tmp_path)
    assert f.reads == 0 and f.dispatched == [] and res.answer == "api route" and api.calls == 1


def test_a_task_whose_plan_is_below_its_floor_goes_to_climayte_and_says_why(fake, tmp_path, monkeypatch):
    # No live route meets its bar: Claude on the subscription takes it, and its route names the floor miss.
    monkeypatch.setattr(climayte_route, "floor_miss", lambda task: "no live route meets profile critical")
    f = fake()
    _, res, api = _run(tmp_path)
    assert len(f.dispatched) == 1 and api.calls == 0
    assert res.answer == "worker report"
    assert res.selection["route"]["decided"] == "subscription" and res.selection["route"]["why"] == "no live route meets profile critical"


def test_floor_miss_reads_the_plan(monkeypatch):
    from hswarm import dispatch

    task = Task(prompt="look at it", tools="read", profile="critical")
    monkeypatch.setattr(dispatch, "plan_for", lambda t: {"candidates": [{"model": "m"}], "below_floor": "code"})
    assert "stepped down to code" in climayte_route.floor_miss(task)
    monkeypatch.setattr(dispatch, "plan_for", lambda t: {"candidates": []})
    assert climayte_route.floor_miss(task) == "no live route can take profile critical"
    monkeypatch.setattr(dispatch, "plan_for", lambda t: {"candidates": [{"model": "m"}]})
    assert climayte_route.floor_miss(task) is None


def test_submit_never_refuses_a_task_climayte_can_take(fake, tmp_path, monkeypatch):
    from hswarm import dispatch, jobs

    monkeypatch.setattr(dispatch, "unreachable", lambda t: "every key disabled")
    fake()
    agentic = Task(prompt="look at it", id="a", tools="read", cwd=str(tmp_path), profile="critical")
    toolfree = Task(prompt="look at it", id="b", tools="none", profile="critical")
    assert jobs.unservable([agentic]) is None
    refusal = jobs.unservable([agentic, toolfree])
    assert refusal.startswith("NoCapableSwarmRoute") and "climayte_run" in refusal and "your own model" not in refusal
    monkeypatch.setattr(climayte_route, "_SWITCH", {"at": -1e9, "on": False})  # the owner's routing switch is off
    assert jobs.unservable([agentic]) is not None


def test_a_below_floor_task_climayte_cannot_take_is_refused_when_its_route_is_dead(fake, tmp_path, monkeypatch):
    # The switch is off, so no slot is waited for; its own route has nothing that serves, so it fails at once.
    from hswarm import jobs

    monkeypatch.setattr(climayte_route, "floor_miss", lambda task: "no live route can take profile critical")
    monkeypatch.setattr(jobs, "no_route_left", lambda tasks: "NoCapableSwarmRoute: every key disabled" if tasks else None)
    f = fake(enabled=False)
    _, res, api = _run(tmp_path)
    assert f.dispatched == [] and api.calls == 0
    assert res.status == "error" and res.error.startswith("NoCapableSwarmRoute")
    assert res.selection["route"]["floor_miss"] == "no live route can take profile critical"


def test_a_below_floor_task_whose_worker_failed_runs_its_live_route_and_says_so(fake, tmp_path, monkeypatch):
    from hswarm import jobs

    monkeypatch.setattr(climayte_route, "floor_miss", lambda task: "no live route meets profile critical")
    monkeypatch.setattr(jobs, "no_route_left", lambda tasks: None)
    fake(worker={"status": "failed", "result": None})
    _, res, api = _run(tmp_path)
    assert api.calls == 1 and res.answer == "api route"
    assert res.selection["route"]["floor_miss"] == "no live route meets profile critical" and res.selection["route"]["climayte_failed"] == "w1"


# Contract: a task whose wait for a CliMayte slot ran out is still offered to CliMayte when its walk reaches its first
# `after_climayte` leg, taking a slot free by then; it only does not wait for one again. Regression: 2026-10-13 (review),
# the timed-out wait was recorded as an ask, so the walk stepped onto the paid leg with CliMayte idle.
def test_a_task_whose_slot_wait_ran_out_is_still_offered_to_climayte_before_its_last_legs(fake, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "ROUTE_VIA_CLIMAYTE_START_S", 0.6)
    monkeypatch.setattr(climayte_route, "_ASKED", set())
    f = fake(idle=0)  # every account busy
    t = Task(id="t", prompt="fix it", cwd=str(tmp_path), tools="edit", profile="critical", max_turns=10, max_cost_usd=1.0)
    t0 = time.monotonic()
    no_room = {"via": "api", "short": "climayte", "short_why": "accounts"}
    assert asyncio.run(climayte_route.consult("j-wait", t, first="only anthropic routes are left")) == (None, no_room)
    assert time.monotonic() - t0 >= 0.6 and f.dispatched == []  # it waited its turn
    t0 = time.monotonic()
    assert asyncio.run(climayte_route.before_last_resort("j-wait", t, ["anthropic"])) == (None, no_room)
    assert time.monotonic() - t0 < 0.3 and f.dispatched == []  # still full: no second wait
    f.idle = 1  # an account came free
    res, _ = asyncio.run(climayte_route.before_last_resort("j-wait", t, ["anthropic"]))
    assert res is not None and res.answer == "worker report" and len(f.dispatched) == 1


class _Mgr:
    """The manager surface dispatch.run_selected reads, with no gates."""

    def client_for(self, leg):
        from types import SimpleNamespace

        return SimpleNamespace(pool=None)

    async def _park_broke_keys(self, c):
        pass

    def _gate_for(self, leg, c):
        return None

    async def _gated(self, job, gate, run):
        return await run


# Contract: a code task whose cheaper legs fail over is offered to CliMayte before its walk steps onto an OpenAI leg
# (`after_climayte`), with no price question, and runs that leg only when CliMayte cannot serve it. Regression:
# 2026-10-13, Baseten's one live key failed over and code tasks landed on paid GPT-6 while the owner's CLI accounts
# sat idle; the owner wants OpenAI's keys as the last resort, after his CliMayte accounts.
@pytest.mark.parametrize("worker,ran,answer", [
    (None, ["rank:glm-5-3-flash:baseten"], "worker report"),
    ({"status": "failed", "result": None}, ["rank:glm-5-3-flash:baseten", "rank:gpt-6-sol:openai"], "openai answer"),
])
def test_a_task_whose_cheaper_legs_fail_over_goes_to_climayte_before_an_openai_leg(fake, tmp_path, monkeypatch, worker, ran, answer):
    from hswarm import agent, dispatch
    from hswarm.job import Job
    from hswarm.spec import Result

    plan = {"profile": "code", "candidates": [
        {"model": "rank:glm-5-3-flash:baseten", "provider": "baseten", "benchmark_slug": "glm-5-3-flash"},
        {"model": "rank:gpt-6-sol:openai", "provider": "openai", "benchmark_slug": "gpt-6-sol", "after_climayte": True}]}
    monkeypatch.setattr(dispatch, "_plan", lambda *a, **k: plan)
    monkeypatch.setattr(climayte_route, "_ASKED", set())
    seen = []

    async def fake_run(client, task, **kw):
        seen.append(task.model)
        if task.model.endswith(":baseten"):
            return Result(id=task.id, backend="api", model=task.model, status="error", error="API Error: 503 no endpoints", cost_usd=0.01), []
        return Result(id=task.id, backend="api", model=task.model, status="ok", answer="openai answer", cost_usd=0.1), []

    monkeypatch.setattr(agent, "run_api_task", fake_run)
    f = fake(**({"worker": worker} if worker else {}))
    t = Task(id="t", prompt="fix it", cwd=str(tmp_path), tools="edit", profile="code", max_turns=10, max_cost_usd=1.0)
    job = Job(id="j", tasks=[t])
    job.results[t.id] = Result(id=t.id, backend="api", model=t.model)
    res, _ = asyncio.run(dispatch.run_selected(_Mgr(), job, t, None, True))
    assert seen == ran and res.answer == answer and len(f.dispatched) == 1
    assert "openai" in res.selection["route"]["why"] and res.cost_usd >= 0.01  # the dead leg's spend rides on the answer


# Contract: an auto task whose API leg gave up steps up to CliMayte once an account is free, and the worker is told only
# that a cheaper model tried, never the failed model's words; the failed run's spend rides on the answer. Regression:
# 2026-10-13, a give-up stepped up only for a task naming an `escalate` model, which no caller did.
def test_an_auto_task_whose_api_leg_gave_up_steps_up_to_climayte(fake, tmp_path, monkeypatch):
    from hswarm import dispatch
    from hswarm.spec import Result

    plan = {"profile": "code", "candidates": [
        {"model": "rank:glm-5-3-flash:baseten", "provider": "baseten", "benchmark_slug": "glm-5-3-flash", "score": 30}]}
    monkeypatch.setattr(dispatch, "_plan", lambda *a, **k: plan)
    monkeypatch.setattr(climayte_route, "_ASKED", set())
    f = fake(idle=0)  # every account busy when the task starts, so it runs on its API leg
    m = JobManager(client=_Api())

    async def gave_up(job, task, warm, is_pilot):  # the API walk itself reads this machine's keys, so it is stubbed here
        f.idle = 1  # an account comes free while the API leg works
        return Result(id=task.id, backend="api", model="rank:glm-5-3-flash:baseten", status="error",
                      error="FAILED: could not find the parser module", cost_usd=0.01), []

    monkeypatch.setattr(m, "_run_legs_api", gave_up)
    t = Task(id="t", prompt="fix it", cwd=str(tmp_path), tools="edit", profile="code", max_turns=10, max_cost_usd=1.0)
    res = asyncio.run(m.run_batch([t], concurrency=1)).results["t"]
    assert res.status == "ok" and res.answer == "worker report" and len(f.dispatched) == 1
    assert res.escalation["from"] == "rank:glm-5-3-flash:baseten" and res.escalation["to"] == "climayte"
    assert abs(res.cost_usd - 0.01) < 1e-9
    sent = f.dispatched[0]["tasks"][0]["prompt"]
    assert "gave up" in sent and "parser module" not in sent
