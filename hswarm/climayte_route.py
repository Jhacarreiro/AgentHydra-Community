"""One tool with CliMayte: an agentic task may run as a Claude Code CLI worker on the owner's Claude subscription
instead of on its API route. The subscription costs nothing extra, so it goes first whenever it can take the task now
(owner, 2026-10-13: the free accounts first when they are available, then the cheapest API key quite certain to finish
the job, paid keys last). Before a task runs, `consult` reads AgentHydra's idle CliMayte accounts
(GET /api/corch/capacity); with one free the task is dispatched to CliMayte (POST /api/corch/workers), polled
(GET /api/corch/workers/:id) and its report is the answer. With none free it runs on its API route at once, never
queued behind CliMayte. A task its own plan cannot run at its bar (floor_miss), or whose plan has only legs kept for after
CliMayte (climayte_first), waits up to ROUTE_VIA_CLIMAYTE_START_S for an idle account first.

This replaced a price test (AgentHydra's POST /api/routing/decide) that priced the subscription at its share of list
price: a paid key a little cheaper than that share won, so in 3 days to 2026-10-13, 46 tool tasks went to API keys by
price (35 of them "the API is more than 3x cheaper") while AgentHydra showed 16 of its 35 accounts idle.

Never a failure of its own: AgentHydra down, slow (over READ_TIMEOUT_S), or answering anything but 200 keeps the
task's own route, logged once per job. A worker that fails, is cancelled, or gives no reply within config.QUIET_TASK_S
hands the task back to the API route once, named in the result's `failover` (mark_dropped). While a worker runs, the
job's row names it (`climayte:<model>`) and each new line of its log stamps the row's progress, so a status read tells
a working worker from a silent one. The route taken is on the result (`selection["route"]`) and its ledger line
(provider `climayte`)."""
from __future__ import annotations

import asyncio
import dataclasses
import json
import logging
import os
import re
import urllib.error
import time
import urllib.request

from . import config, shared
from .spec import Result, Task, inline_files, now_iso

log = logging.getLogger("hswarm.climayte")

DEFAULT_URL = "http://127.0.0.1:7787"
READ_TIMEOUT_S = 2.0
POLL_S = 10.0
WORKER_ENV = "AGENTHYDRA_CLIMAYTE_WORKER"
FREE_FIRST = "an idle CliMayte account costs nothing extra, so it goes before any API key"
NO_ROOM = "no CliMayte account was idle"
STEPPED_UP = ("\n\nA cheaper model already tried this task and gave up. Any changes it made are still in the files: check "
              "their current state before you start.")
_ELIGIBLE_TOOLS = ("read", "edit", "all")
_LOGGED: set[str] = set()
_ACTIVE = 0  # tasks routed to CliMayte right now, across every job of this process (route_via_climayte_max)
# When this process sent each task still in CliMayte's hands, as free_route keeps it: the capacity read shows a sent task
# once its worker exists (queued, then running), so a task sent moments before a read asked is subtracted from the idle
# count until UNSEEN_S has passed. A task's stamp leaves the list when the task ends.
_SENT: list[float] = []
UNSEEN_S = 2.0
_ASKED: set[tuple[str, str]] = set()  # (job, task) CliMayte was asked to run: before_last_resort does not ask twice
_WAITED: set[tuple[str, str]] = set()  # (job, task) whose wait for a CliMayte slot ran out: a later ask takes a free slot, never waits again
_SWITCH = {"at": -1e9, "on": True}  # AgentHydra's own routing on/off, read at most once per SWITCH_TTL_S
SWITCH_TTL_S = 60.0


def base_url() -> str:
    return os.environ.get("AGENTHYDRA_URL", DEFAULT_URL).rstrip("/")


def eligible(task: Task) -> bool:
    """An agentic task a CLI worker can do as asked: an absolute folder, tools that read or change files, no
    sandbox rule a worker could not keep (writable globs, receipts, a container), and not already a CliMayte worker."""
    if os.environ.get(WORKER_ENV) or (shared.REQUEST.get() or {}).get("climayte_worker"):
        return False  # the shared server's env is not the caller's: a worker's own request carries the header
    if not config.ROUTE_VIA_CLIMAYTE or not base_url():
        return False
    if not isinstance(task.tools, str) or task.tools not in _ELIGIBLE_TOOLS:
        return False
    if not task.cwd or not (os.path.isabs(task.cwd) or task.cwd.startswith("/")):
        return False
    if getattr(task, "runtime", "") or task.writable is not None or task.scripted or task.inventory or task.green:
        return False
    return True


def can_take(task: Task) -> bool:
    """eligible, and AgentHydra's routing switch was on when last read: jobs.unservable lets such a task through."""
    return eligible(task) and _SWITCH["on"]


def floor_miss(task: Task) -> str | None:
    """Why the task's own plan cannot run it at the bar it asked for, or None. A plan that stepped down
    (`below_floor`) or has no leg left would run below its profile or not at all; Claude on the subscription meets
    the bar, so such a task goes to CliMayte without a price comparison (sessions had been sending this work to
    Opus sub-agents on their own quota: 9 'critical has no live key' bypasses in 3 days, 2026-10-09)."""
    if not task.route:
        return None
    if not task.profile:  # a pinned route: missed only when it has keys and none can serve now
        from .jobs import route_health

        if task.backend == "api" and task.model and not route_health(task.model)["serves"]:
            return f"no leg of {task.model} can take a request now"
        return None
    from .dispatch import plan_for

    plan = plan_for(task)
    if plan.get("below_floor"):
        return f"no live route meets profile {task.profile} (the plan stepped down to {plan['below_floor']})"
    if not plan.get("candidates"):
        return f"no live route can take profile {task.profile}"
    return None


def climayte_first(task: Task) -> str | None:
    """Why CliMayte goes before the task's own route with no price question, or None: every leg its plan has left is
    one the owner keeps for after CliMayte (`after_climayte`, OpenAI; owner 2026-10-13: OpenAI's keys are the last resort,
    after his CliMayte accounts)."""
    if not task.route or not task.profile:
        return None
    from .dispatch import plan_for

    legs = plan_for(task).get("candidates") or []
    if legs and all(c.get("after_climayte") for c in legs):
        return f"only {', '.join(sorted({c['provider'] for c in legs}))} routes are left for profile {task.profile}, kept for after CliMayte"
    return None


async def before_last_resort(job_id: str, task: Task, providers: list[str], caller: dict | None = None) -> tuple[Result | None, dict | None]:
    """consult, once more, as a task's walk reaches its first `after_climayte` leg (its cheaper legs failed over): CliMayte
    is asked to run it before that leg is. A task CliMayte was already asked to run is not asked again."""
    if (job_id, task.id) in _ASKED:
        return None, None
    return await consult(job_id, task, first=f"its other routes failed over and only {', '.join(providers)} is left, kept for after CliMayte", caller=caller)


async def before_rescue(job_id: str, task: Task, caller: dict | None = None) -> tuple[Result | None, dict | None]:
    """consult, as a code or critical task's walk reaches its first lower-profile rescue leg (dispatch._climayte_at_floor):
    CliMayte is asked to run it before that leg is. A task CliMayte was already asked to run is not asked again."""
    if (job_id, task.id) in _ASKED:
        return None, None
    return await consult(job_id, task, first=f"its {task.profile} routes are gone and only lower-profile rescue routes are left", caller=caller)


async def step_up(job_id: str, task: Task, why: str, caller: dict | None = None) -> Result | None:
    """A cheaper API leg gave up on the task (jobs._step_up): CliMayte takes it as the next level up when an account
    is idle or comes free within ROUTE_VIA_CLIMAYTE_START_S, told that a cheaper model tried first. None when the task
    is not one CliMayte takes, was already asked (CliMayte failed it first), or no account came free. The worker is
    not shown the failed model's words, only that it gave up: they can quote files written by anyone."""
    if (job_id, task.id) in _ASKED:
        return None
    told = dataclasses.replace(task, prompt=task.prompt.rstrip() + STEPPED_UP)
    res, _ = await consult(job_id, told, first=f"stepped up: its API leg gave up ({why})", caller=caller)
    return res


_SESSION_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)


def declared_by(job_id: str, caller: dict | None) -> dict:
    """The `by` a routed task sends CliMayte: the job's name, and the chat its caller ran under when that is a session
    id. The server refuses any other form of session id (400), so anything else is left out rather than sent."""
    by = {"label": f"HSwarm job {job_id}"[:80]}
    session = str((caller or {}).get("session_id") or (caller or {}).get("chat_id") or "")
    if _SESSION_ID.match(session):
        by["sessionId"] = session
    return by


def _say(job_id: str, msg: str) -> None:
    """One line per job, whatever happens to its other tasks."""
    if job_id not in _LOGGED:
        _LOGGED.add(job_id)
        log.warning("job %s: %s", job_id, msg)


def _request(method: str, path: str, body: dict | None, timeout: float) -> tuple[int, dict]:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base_url() + path, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        return e.code, {}


async def _call(method: str, path: str, body: dict | None = None, timeout: float = 15.0) -> tuple[int, dict]:
    return await asyncio.to_thread(_request, method, path, body, timeout)


async def switch_on() -> bool:
    """AgentHydra's routing on/off (settings.enabled of GET /api/routing/cost-model), the owner's switch; read at most
    once a minute. Unreadable means the last answer stands (on, before any answer)."""
    if time.monotonic() - _SWITCH["at"] < SWITCH_TTL_S:
        return _SWITCH["on"]
    _SWITCH["at"] = time.monotonic()
    try:
        status, doc = await asyncio.wait_for(_call("GET", "/api/routing/cost-model", None, READ_TIMEOUT_S), READ_TIMEOUT_S + 0.5)
    except (OSError, ValueError, asyncio.TimeoutError):
        return _SWITCH["on"]
    enabled = (doc.get("settings") or {}).get("enabled") if status == 200 else None
    if isinstance(enabled, bool):
        _SWITCH["on"] = enabled
    return _SWITCH["on"]


async def _room(job_id: str, asked: float) -> tuple[int | None, str]:
    """How many more tasks CliMayte can start now, or None (and a log line) when AgentHydra does not say in time.
    AgentHydra's idle accounts (room under their usage ceiling, no worker running), less the workers already queued or
    waiting for room there (each will take one) and the tasks this process sent since `asked` - UNSEEN_S; 0 at
    route_via_climayte_max. Beside it, what would hold a task when there is no room (the shortfall report counts only
    `accounts`, shortfall.py): `capped` at route_via_climayte_max, `machine` while AgentHydra holds every start for the
    PC's CPU or memory (its `held`), else `accounts`. Everything after the read is free of awaits, so consult claims the
    room it returns before any other task can read it."""
    try:
        # to_thread cannot stop a socket early, so the wait is bounded here as well as on the socket
        status, doc = await asyncio.wait_for(_call("GET", "/api/corch/capacity", None, READ_TIMEOUT_S), READ_TIMEOUT_S + 0.5)
    except (OSError, ValueError, asyncio.TimeoutError) as e:
        _say(job_id, f"CliMayte capacity unavailable ({type(e).__name__}); tasks keep their own route")
        return None, ""
    idle, waiting = doc.get("idle"), doc.get("waiting")
    if status != 200 or not isinstance(idle, int) or not isinstance(waiting, int):
        _say(job_id, f"CliMayte capacity answered HTTP {status}; tasks keep their own route")
        return None, ""
    if config.ROUTE_VIA_CLIMAYTE_MAX is not None and _ACTIVE >= config.ROUTE_VIA_CLIMAYTE_MAX:
        return 0, "capped"
    unseen = sum(1 for t in _SENT if t > asked - UNSEEN_S)
    return idle - waiting - unseen, "machine" if doc.get("held") else "accounts"


def brief(task: Task) -> str:
    """The task as a CLI worker is told it: HSwarm's brief for the kind of work, the prompt, its acceptance criteria
    and files, and the shape its final message must have."""
    from .acceptance import prompt_clause
    from .code_brief import system_for

    parts = [p.strip() for p in (system_for(task),) if p]
    parts.append(inline_files(task, task.prompt.strip() + prompt_clause(task.acceptance)))
    if task.schema:
        parts.append("Your final message must be ONLY one JSON object that matches this JSON Schema, no prose around it:\n"
                     + json.dumps(task.schema, ensure_ascii=False))
    return "\n\n".join(parts)


async def _cancel(wid: str) -> None:
    try:
        await _call("POST", "/api/corch/cancel", {"id": wid}, 5.0)
    except (OSError, ValueError):
        pass  # AgentHydra gone: nothing is left to cancel


JUDGING_ROLES = ("review", "judge", "refute", "doubt", "grader")


def worker_kind(task: Task) -> str:
    """The CliMayte kind for the task. Owner, 2026-10-05: CliMayte work is meant to run on moderate models, and
    CliMayte's pick for `review` is Opus high, so only a task that judges (profile critical or decision, or one of
    the JUDGING_ROLES) asks for it; the read-only reading, summarising and checking HSwarm exists to keep cheap is a
    `sweep` (Haiku or Sonnet). A task that writes files is `code`. A pinned model drops the task's profile
    (spec.py `_resolve_backend`), so such a task is judged by its role alone."""
    if task.tools in ("edit", "all"):
        return "code"
    if task.profile in ("critical", "decision") or (task.role or "").strip().lower() in JUDGING_ROLES:
        return "review"
    return "sweep"


async def run_worker(job_id: str, task: Task, note: dict, caller: dict | None = None) -> Result | None:
    """Run the task as a CliMayte worker; the Result, or None when the API route should take it instead."""
    title = (task.prompt.strip().splitlines() or ["hswarm task"])[0][:80]
    spec = {"prompt": brief(task), "cwd": task.cwd, "title": title, "kind": worker_kind(task)}
    if task.tools != "all":
        # A read or edit task runs nothing: CliMayte starts it light (no shell, no MCP server but its own), and a
        # light worker does not wait behind the CPU gate the way a builds-and-tests worker does (2026-10-13).
        spec["light"] = True
    try:
        # origin None: a routed task is never pinged to a chat (one ping per task would flood it). `by` is its
        # From instead: the job, and the chat its caller ran under (climayte-trace.ts).
        body = {"tasks": [spec], "group": f"hswarm-{job_id}-{task.id}", "origin": None, "by": declared_by(job_id, caller)}
        status, doc = await _call("POST", "/api/corch/workers", body)
    except (OSError, ValueError) as e:
        _say(job_id, f"CliMayte dispatch failed ({type(e).__name__}); the task runs on its API route")
        return None
    workers = doc.get("workers") if status == 200 else None
    wid = workers[0].get("id") if isinstance(workers, list) and workers and isinstance(workers[0], dict) else None
    if not wid:
        _say(job_id, f"CliMayte refused the task (HTTP {status}); it runs on its API route")
        return None
    note["worker"] = wid
    finished = False
    try:
        res = await _wait_worker(job_id, task, note, wid)
        finished = True
        return res
    finally:
        if not finished:  # the task or job was cancelled while the worker ran
            await asyncio.shield(_cancel(wid))


def _progress(w: dict) -> tuple | None:
    """What a worker has produced so far (its newest log line, output tokens and turns, across its attempts), or None
    while its model has not replied once: no output token and no turn."""
    attempts = [a for a in w.get("attempts") or () if isinstance(a, dict)]
    out = max([_count((w.get("tokens") or {}).get("output"))] + [_count((a.get("tokens") or {}).get("output")) for a in attempts])
    turns = max([_count(w.get("turns"))] + [_count(a.get("turns")) for a in attempts])
    return (w.get("lastActivity"), out, turns) if out or turns else None


def _count(v: object) -> int:
    return int(v) if isinstance(v, (int, float)) else 0


async def _wait_worker(job_id: str, task: Task, note: dict, wid: str) -> Result | None:
    from .agent import LIVE_ROW

    started = now_iso("milliseconds")
    loop = asyncio.get_running_loop()
    begun = loop.time()
    deadline = begun + task.timeout_s
    # The job's row for this task (jobs._run_one). Until 2026-10-13 it kept the API leg's name, 0 turns and no progress
    # stamp the whole time a worker ran, so status listed a working worker under quiet_running as a silent leg, and a
    # chat cancelled two (jobs 20261013-222800-34e6 and -223522-44f8; the first had finished its review 3 s earlier).
    row, seen, running_at, named = LIVE_ROW.get(), None, None, "claude"

    def drop(key: str) -> None:
        """The worker did not serve the task: its note says so and names its model (mark_dropped); the API route takes it."""
        note[key], note["climayte_model"] = wid, named

    while True:
        try:
            status, w = await _call("GET", f"/api/corch/workers/{wid}")
        except (OSError, ValueError):
            status, w = 0, {}
        state = w.get("status") if status == 200 else None
        named = str(w.get("reportedModel") or w.get("model") or named)
        if row is not None:
            row.model = f"climayte:{named}"
        if state == "done":
            res = _result(task, w, note, started, job_id)
            if res is None:
                note["climayte_model"] = named  # its report was empty or broke the schema (_result notes which)
            return res
        if state in ("failed", "cancelled"):
            _say(job_id, f"CliMayte worker {wid} {state}; its task runs on the API route")
            return drop("climayte_" + state)
        if state != "running" and loop.time() - begun >= config.ROUTE_VIA_CLIMAYTE_START_S:
            await _cancel(wid)
            _say(job_id, f"CliMayte worker {wid} was still {state or 'unreachable'} after {config.ROUTE_VIA_CLIMAYTE_START_S:g} s; cancelled, its task runs on the API route")
            return drop("climayte_not_started")
        if state == "running" and running_at is None:
            running_at = loop.time()  # the queue wait is ROUTE_VIA_CLIMAYTE_START_S's; the reply wait starts here
        if (mark := _progress(w) if state == "running" else None) is not None and mark != seen:
            seen = mark
            if row is not None:
                row.progress_at = now_iso("milliseconds")  # what job.quiet_seconds reads, as an api reply stamps it
        elif seen is None and running_at is not None and loop.time() - running_at >= config.QUIET_TASK_S:
            # Running, by AgentHydra's word, with not one reply from its model: a silent leg, failed over like one
            # (an API leg's first call is cut at config.SLOW_LEG_CALL_S), not held to the task's whole timeout_s.
            await _cancel(wid)
            note["climayte_why"] = f"CliMayte worker {wid} gave no reply in {config.QUIET_TASK_S:g} s"
            _say(job_id, f"{note['climayte_why']}; cancelled, its task runs on the API route")
            return drop("climayte_silent")
        if loop.time() + POLL_S > deadline:
            await _cancel(wid)
            res = Result(id=task.id, backend=task.backend, model=w.get("reportedModel") or "claude", status="timeout",
                         error=f"CliMayte worker {wid} still {state or 'unreachable'} after {task.timeout_s} s", started=started, finished=now_iso())
            res.selection = {"route": {**note, "via": "climayte"}}
            return res
        await asyncio.sleep(POLL_S)


def _result(task: Task, w: dict, note: dict, started: str, job_id: str) -> Result | None:
    from .worker import payload_in_text

    text = str(w.get("result") or "").strip()
    res = Result(id=task.id, backend=task.backend, model=w.get("reportedModel") or w.get("model") or "claude", status="ok",
                 answer=text, cost_usd=0.0, started=started, finished=now_iso())
    if not text:
        note["climayte_failed"] = note.get("worker")
        return None
    if task.schema:
        data = payload_in_text(text, task.schema)
        if data is None:
            note["climayte_failed"] = note.get("worker")
            _say(job_id, "CliMayte's report did not match the task's schema; it runs on the API route")
            return None
        res.data = data
    res.selection = {"route": {**note, "via": "climayte"}}
    return res


async def consult(job_id: str, task: Task, first: str | None = None, caller: dict | None = None) -> tuple[Result | None, dict | None]:
    """(a finished Result, None) when CliMayte served the task; (None, note) when the API route runs, the note saying
    why; (None, None) when nobody was asked. An eligible task goes to CliMayte whenever an account can start it now
    (_room), and to its API route at once when none can. `first` (before_last_resort), a floor miss, or a plan left with
    only routes kept for after CliMayte (climayte_first) makes the task wait up to ROUTE_VIA_CLIMAYTE_START_S for an
    account instead. A task whose own route misses its bar (floor_miss) and that CliMayte did not serve carries
    `floor_miss` on its note, so jobs can refuse it at once when that route cannot serve at all, instead of running it
    there."""
    global _ACTIVE
    if not eligible(task):
        return None, None
    missed = None if first else floor_miss(task)
    first = first or missed or climayte_first(task)
    unserved = {"via": "api", "floor_miss": missed} if missed else None
    if not await switch_on():  # read before any wait: an idle account is no use with the owner's switch off
        return None, unserved
    loop = asyncio.get_running_loop()
    asked = time.monotonic()
    room, held = await _room(job_id, asked)
    if first and room is not None and room <= 0 and (job_id, task.id) not in _WAITED:
        # Its own route is below its bar or kept for after CliMayte: worth a wait for an account to come free.
        until = loop.time() + config.ROUTE_VIA_CLIMAYTE_START_S
        while room is not None and room <= 0 and loop.time() < until:
            await asyncio.sleep(POLL_S)
            asked = time.monotonic()
            room, held = await _room(job_id, asked)
    if room is None:
        return None, unserved
    if room <= 0:
        short = {"short": "climayte", "short_why": held}  # a task CliMayte had no room for (shortfall.py)
        if first:
            # It waited its turn once. Not an ask: CliMayte never saw it, so the walk still offers it before its last legs
            # (an account may be free by then), only without waiting again (2026-10-13: recorded as an ask, it skipped CliMayte).
            _remember(_WAITED, job_id, task)
            return None, {**(unserved or {"via": "api"}), **short}
        return None, {"via": "api", "decided": "api", "why": NO_ROOM, **short}
    now = time.monotonic()
    _SENT.append(now)
    _ACTIVE += 1  # both taken with no await since the room read, held to the worker's end
    try:
        return await _consult(job_id, task, first or FREE_FIRST, missed, caller)
    finally:
        _ACTIVE -= 1
        if now in _SENT:  # its account is free again, however recently it was sent
            _SENT.remove(now)


# The note keys a worker that took the task and did not serve it leaves (_wait_worker, _result).
_DROPPED = ("climayte_silent", "climayte_failed", "climayte_cancelled", "climayte_not_started")


def mark_dropped(res: Result, note: dict | None) -> None:
    """Name a worker that took the task and did not serve it (`note`, consult's) in `res.failover`, as a route leg that
    could not serve is, with its kind in `failover_errors` (jobs.leg_kind's words: a silent worker stalled, any other
    could not serve); the note on `selection["route"]` keeps the worker id and why."""
    if not note or not any(note.get(k) for k in _DROPPED):
        return
    leg = f"climayte:{note.get('climayte_model') or 'claude'}"
    res.failover = [leg, *(f for f in res.failover if f != leg)]
    res.failover_errors = [{"model": leg, "kind": "slow" if note.get("climayte_silent") else "unavailable"},
                           *(getattr(res, "failover_errors", None) or [])]


def _remember(seen: set, job_id: str, task: Task) -> None:
    if len(seen) > 20_000:  # a long-running server: the ids are only needed for the walk of a task still running
        seen.clear()
    seen.add((job_id, task.id))


async def _consult(job_id: str, task: Task, why: str, missed: str | None = None, caller: dict | None = None) -> tuple[Result | None, dict | None]:
    note = {"provider": "climayte", "decided": "subscription", "why": why}
    _remember(_ASKED, job_id, task)
    res = await run_worker(job_id, task, note, caller)
    if res is not None:
        return res, None
    return None, {"via": "api", "decided": "subscription", "why": note["why"], "fallback": "CliMayte could not serve it",
                  **({"floor_miss": missed} if missed else {}),
                  **{k: v for k, v in note.items() if k.startswith("climayte_") or k == "worker"}}
