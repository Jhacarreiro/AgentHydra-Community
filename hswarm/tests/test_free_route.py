"""Offline: a tool-free task goes to the owner's Free web accounts first (free_route.py), against a fake AgentHydra on a
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

from hswarm import config, free_client, free_route  # noqa: E402
from hswarm.client import ChatResult, Usage  # noqa: E402
from hswarm.jobs import JobManager  # noqa: E402
from hswarm.spec import Task  # noqa: E402

ACCOUNTS = [{"account": "a1", "num": 1, "provider": "claude", "signedIn": True, "busy": False, "usage": 0, "threads": 0}]


class _Api:
    def __init__(self):
        self.calls = 0

    async def chat(self, messages, **kw):
        self.calls += 1
        return ChatResult(message={"role": "assistant", "content": "api route"}, finish_reason="stop", usage=Usage(), model="deepseek-flash", seconds=0.01, cost_usd=0.01, peak=False)

    async def aclose(self):
        pass


class _Fake:
    """A fake AgentHydra: POST /api/mcp answering free_status, free_chat and free_results, and free_threads and
    free_read for a turn it dropped. `cut` holds the free_chat calls (1 = the first) it drops as a relaunched daemon
    does: the message is taken, then its batch is forgotten."""

    def __init__(self, accounts=None, reply="free answer", state="done", status_delays=(), cut=(), threads=(), read=(),
                 chat_error=False, model="gpt-5-6-mini", error=None):
        self.accounts = ACCOUNTS if accounts is None else accounts
        self.reply, self.state = reply, state  # a list of either answers each sent message in turn
        self.error = error  # a failed message's error, as AgentHydra words it ("<code>: <message>")
        self.cut, self.cutting = set(cut), False
        self.threads, self.read = list(threads), list(read)
        self.chat_error = chat_error  # free_chat answers with a tool error, as for a request it refuses
        self.names: list[str] = []  # every tool called, in order
        self.model = model  # the model every reply names
        self.chats: list[dict] = []
        self.status_delays = list(status_delays)  # seconds before each free_status answer, in arrival order
        self.hold = threading.Event()  # cleared, a sent chat is not answered until it is set again
        self.hold.set()
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                if self.path != "/api/mcp":
                    return self._send(404, {})
                name, args = body["params"]["name"], body["params"]["arguments"]
                fake.names.append(name)
                if name == "free_status":
                    if fake.status_delays:
                        time.sleep(fake.status_delays.pop(0))
                    out = {"ready": True, "accounts": fake.accounts, "running": 0}
                elif name == "free_chat" and fake.chat_error:
                    return self._send(200, {"jsonrpc": "2.0", "id": 1, "result": {"isError": True, "content": [{"type": "text", "text": "bad task"}]}})
                elif name == "free_chat":
                    fake.chats.append(args)
                    fake.hold.wait(10)
                    fake.cutting = len(fake.chats) in fake.cut
                    out = {**fake.batch(), "finished": False, "tasks": [{"task": 0, "state": "running"}]} if fake.cutting else fake.batch()
                elif name == "free_results":
                    if fake.cutting:
                        fake.cutting = False
                        return self._send(200, {"jsonrpc": "2.0", "id": 1, "result": {"isError": True, "content": [{"type": "text", "text": "no batch b1 here"}]}})
                    out = fake.batch()
                elif name == "free_threads":
                    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                    out = {"total": len(fake.threads), "threads": [{"updated": now, **t} for t in fake.threads]}
                elif name == "free_read":
                    out = {"chat_id": args.get("chat_id"), "messages": fake.read}
                else:
                    return self._send(404, {})
                self._send(200, {"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": json.dumps(out)}]}})

            def _send(self, status, doc):
                data = json.dumps(doc).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def batch(self):
        # A list of replies answers each sent message in turn: a tool task's thread is several messages long.
        nth = lambda v: v[min(len(self.chats), len(v)) - 1] if isinstance(v, list) else v  # noqa: E731
        reply, state = nth(self.reply), nth(self.state)
        one = {"task": 0, "state": state, "account": "a1", "chat_id": "c1", "response": reply, "model": self.model, "seconds": 1.0}
        if state == "failed" and self.error:
            one["error"] = self.error
        return {"batch": "b1", "finished": state == "done", "done": 1, "tasks": [one]}

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
    made: list[_Fake] = []

    def make(**kw):
        f = _Fake(**kw)
        made.append(f)
        monkeypatch.setenv("AGENTHYDRA_URL", f.url)
        return f

    yield make
    for f in made:
        f.close()


def _task(**kw) -> Task:
    """A tool-free auto task as the planner leaves it: the plan's first concrete model AND its profile (a pinned task
    has no profile). Planning on auto needs keys, so the profile is set after a pinned build."""
    spec = {"id": "t0", "prompt": "say hi", "tools": "none", "model": "deepseek-flash", "timeout_s": 30, **kw}
    task = Task.from_dict(spec, {}, 0)
    if "model" not in kw:
        task.profile = "general"
    return task


def _consult(task):
    return asyncio.run(free_route.consult("j1", task))


def test_a_tool_free_task_is_answered_by_a_free_account(fake):
    f = fake()
    res, note = _consult(_task())
    assert note is None and res.status == "ok" and res.answer == "free answer" and res.cost_usd == 0.0
    assert res.model == "free:gpt-5-6-mini"
    assert res.selection["route"]["via"] == "free" and res.selection["route"]["account"] == "a1" and res.selection["route"]["chat_id"] == "c1"
    assert f.chats[0]["tasks"][0]["name"] == "hswarm j1 t0" and "say hi" in f.chats[0]["tasks"][0]["prompt"]


def test_a_turn_the_daemon_dropped_is_read_back_from_its_thread(fake):
    # AgentHydra's daemon relaunches after each update it pulls (52 times on 2026-10-13) and forgets the batches in
    # flight, while Desk finishes the message: the reply is taken from its thread, not paid for again on the API route.
    f = fake(cut={1}, threads=[{"chat_id": "c9", "name": "hswarm j1 t0", "status": "done", "account": "a1"}],
             read=[{"role": "assistant", "text": "free answer"}])
    res, note = _consult(_task())
    assert note is None and res.answer == "free answer" and res.cost_usd == 0.0
    assert res.selection["route"]["chat_id"] == "c9" and res.selection["route"]["recovered"] == 1 and len(f.chats) == 1


def test_a_message_the_daemon_refuses_fails_over_at_once(fake):
    # The daemon answered: nothing is in flight, so no thread is waited for.
    f = fake(chat_error=True, threads=[{"chat_id": "c9", "name": "hswarm j1 t0", "status": "done", "account": "a1"}])
    res, note = _consult(_task())
    assert res is None and note["fallback"] == "free send failed" and "free_threads" not in f.names


def test_a_message_sent_while_no_daemon_listened_is_sent_again_once_one_does(fake, monkeypatch):
    # Between one daemon's exit and the next one's start a connection is refused: the message never left.
    f = fake()
    real, refused = free_route._call, []

    async def call(name, arguments, timeout):
        if name == "free_chat" and not refused:
            refused.append(name)
            raise ConnectionRefusedError("no daemon on the port")
        return await real(name, arguments, timeout)

    monkeypatch.setattr(free_route, "_call", call)
    res, note = _consult(_task())
    assert note is None and res.answer == "free answer" and res.selection["route"]["recovered"] == 1
    assert refused and len(f.chats) == 1 and "free_threads" not in f.names


def test_a_climayte_workers_ask_is_answered_by_a_free_account(fake, monkeypatch):
    # The worker guard is the CliMayte route's own; on this route it kept every ask a worker made on paid APIs (2026-10-09).
    f = fake()
    monkeypatch.setenv("AGENTHYDRA_CLIMAYTE_WORKER", "w-1")
    res, _ = _consult(_task())
    assert res is not None and res.model == "free:gpt-5-6-mini" and len(f.chats) == 1


def test_narrow_profiles_ask_for_haiku_and_the_rest_for_sonnet(fake):
    f = fake()
    for profile in ("routine", "general", "research", "decision"):
        task = _task()
        task.profile = profile
        _consult(task)
    assert [c["tasks"][0].get("model") for c in f.chats] == ["haiku", "haiku", "sonnet", "sonnet"]


def test_the_ledger_line_of_a_free_task_has_provider_free_and_no_cost(fake, monkeypatch):
    fake()
    api = _Api()
    monkeypatch.setattr(free_route, "eligible", lambda task: True)  # the job's task is pinned (an auto one needs keys)
    job = asyncio.run(JobManager(client=api).run_batch([_task()], concurrency=1))
    row = json.loads(config.LEDGER.read_text(encoding="utf-8").splitlines()[-1])
    assert api.calls == 0 and job.results["t0"].answer == "free answer"
    assert row["provider"] == "free" and row["cost_usd"] == 0
    assert float(row["seconds"]) == 1.0  # the account's own time on it, from free_results
    # Estimated at 4 characters a token: "free answer" is 11 characters (every Free answer was ledgered as 0, 2026-10-09).
    assert row["out"] == 3 and row["in_miss"] > 0


def test_hswarm_ask_on_auto_is_answered_by_a_free_account(fake, monkeypatch):
    from hswarm import mcp_server

    api = _Api()
    f = fake()
    monkeypatch.setattr(mcp_server, "manager", lambda: JobManager(client=api))
    out = asyncio.run(mcp_server.hswarm_ask("say hi"))
    assert out["status"] == "ok" and out["answer"] == "free answer" and out["model"] == "free:gpt-5-6-mini"
    assert api.calls == 0, "the API route ran although a free account was idle"
    row = json.loads(config.LEDGER.read_text(encoding="utf-8").splitlines()[-1])
    assert row["provider"] == "free" and row["cost_usd"] == 0
    # A thread name is unique on its account: one fixed name refused every ask after the first (2026-10-07).
    asyncio.run(mcp_server.hswarm_ask("say hi again"))
    names = [c["tasks"][0]["name"] for c in f.chats]
    assert len(names) == 2 and len(set(names)) == 2


def test_a_decide_escalation_on_auto_is_answered_by_a_free_account(fake):
    # hswarm_decide's escalations go through ask_routed, which never tried a Free account before 2026-10-08.
    api = _Api()
    f = fake()
    res = asyncio.run(JobManager(client=api).ask_routed("pick one", config.AUTO, profile="decision"))
    assert res.model == "free:gpt-5-6-mini" and api.calls == 0 and len(f.chats) == 1


def test_a_schema_tasks_json_reply_becomes_data(fake):
    f = fake(reply='```json\n{"n": 3}\n```')
    schema = {"type": "object", "properties": {"n": {"type": "integer"}}, "required": ["n"]}
    res, _ = _consult(_task(schema=schema))
    assert res.data == {"n": 3}
    assert free_route.SCHEMA_LINE in f.chats[0]["tasks"][0]["prompt"]


def test_a_schema_reply_that_is_not_json_falls_back(fake):
    fake(reply="sure, here you go")
    schema = {"type": "object", "properties": {"n": {"type": "integer"}}, "required": ["n"]}
    res, _ = _consult(_task(schema=schema))
    assert res is None


def test_an_unreachable_daemon_falls_back_without_an_error(monkeypatch):
    monkeypatch.setenv("AGENTHYDRA_URL", "http://127.0.0.1:9")
    assert _consult(_task()) == (None, None)


# Contract: with no account free the task keeps its API route and nothing is sent, and its note says what held the
# accounts: the shortfall report counts busy, paced and resting ones and reports signed-out ones apart (shortfall.py).
@pytest.mark.parametrize("accounts,why", [
    ([{**ACCOUNTS[0], "busy": True}, {**ACCOUNTS[0], "busy": True}, {**ACCOUNTS[0], "signedIn": False},
      {**ACCOUNTS[0], "resting": "until 2026-10-08T08:00:00Z after http_rejected (x1)"},
      {**ACCOUNTS[0], "paced": "until 2026-10-08T08:00:00Z (69 new chats per 30 min)"}], "busy"),
    ([{**ACCOUNTS[0], "paced": "until 2026-10-08T08:00:00Z (69 new chats per 30 min)"}] * 2, "paced"),
    ([{**ACCOUNTS[0], "signedIn": False}] * 2, "signed_out"),
])
def test_no_idle_account_falls_back_without_calling_free_chat(fake, accounts, why):
    f = fake(accounts=accounts)
    assert _consult(_task()) == (None, {"via": "api", "short": "free", "short_why": why})
    assert f.chats == []


# Contract: a task or an ask no Free account had room for says so on its ledger line, which the shortfall report
# reads (shortfall.py). Before 2026-10-13 it left no trace, so nothing could say how many more accounts would help.
def test_a_task_no_free_account_had_room_for_says_so_on_its_ledger_line(fake, monkeypatch):
    fake(accounts=[{**ACCOUNTS[0], "busy": True}])
    api = _Api()
    monkeypatch.setattr(free_route, "eligible", lambda task: True)  # pinned, so its API route needs no keys
    job = asyncio.run(JobManager(client=api).run_batch([_task(model="deepseek-flash")], concurrency=1))
    row = json.loads(config.LEDGER.read_text(encoding="utf-8").splitlines()[-1])
    assert api.calls == 1 and job.results["t0"].status == "ok"
    assert row["provider"] != "free" and row["short_pool"] == "free" and row["short_why"] == "busy"


def test_an_ask_no_free_account_had_room_for_says_so_on_its_ledger_line(fake, monkeypatch):
    from hswarm import mcp_server

    fake(accounts=[{**ACCOUNTS[0], "paced": "until 2026-10-08T08:00:00Z (69 new chats per 30 min)"}])
    monkeypatch.setattr(mcp_server, "manager", lambda: JobManager(client=_Api()))
    asyncio.run(mcp_server.hswarm_ask("say hi"))
    row = json.loads(config.LEDGER.read_text(encoding="utf-8").splitlines()[-1])
    assert row["job"] == "ask" and row["short_pool"] == "free" and row["short_why"] == "paced"


def test_one_process_can_fill_every_idle_account(fake, monkeypatch):
    # Its own tasks hold accounts, which free_status already shows busy: the idle ones are still free to take work
    # (comparing in-flight tasks with idle accounts stopped every process at half of them; a fixed cap of 6 held one
    # server to 6 of 11 accounts, 2026-10-08). Only a `route_via_free_max` someone set holds it back.
    f = fake(accounts=[{**ACCOUNTS[0], "busy": True}] * 10 + [ACCOUNTS[0]])
    monkeypatch.setattr(free_route, "_ACTIVE", 10)
    res, _ = _consult(_task())
    assert res is not None and len(f.chats) == 1
    monkeypatch.setattr(config, "ROUTE_VIA_FREE_MAX", 10)
    assert _consult(_task(id="t1")) == (None, {"via": "api", "short": "free", "short_why": "capped"}) and len(f.chats) == 1


def test_tasks_reading_one_snapshot_take_its_one_idle_account_once(fake, monkeypatch):
    # free_status cannot show a task sent a moment ago: two tasks that both read "one idle" must not both be sent, even
    # when the second's answer comes back after UNSEEN_S (the daemon may take STATUS_TIMEOUT_S). Measured from the
    # answer, the first task's send had aged out, and under a loaded full-suite run both took the account (2026-10-09).
    monkeypatch.setattr(free_route, "UNSEEN_S", 0.1)
    f = fake(accounts=[{**ACCOUNTS[0], "busy": True}] * 5 + [ACCOUNTS[0]], status_delays=[0, 0.4])
    f.hold.clear()

    async def both():
        tasks = [asyncio.create_task(free_route.consult("j1", _task())), asyncio.create_task(free_route.consult("j2", _task(id="t1")))]
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        f.hold.set()  # the sent task's chat runs until the other task has decided, so it cannot free the account first
        return [await t for t in tasks]

    results = asyncio.run(both())
    assert len(f.chats) == 1 and sum(r is not None for r, _ in results) == 1


def test_a_failed_free_task_hands_the_task_back(fake):
    fake(state="failed", reply="")
    res, note = _consult(_task())
    assert res is None and note["via"] == "api"


GENERATION = "generation_error: ChatGPT generation failed (no reason given; event keys: conversation_id, error, type); read the chat before sending again."


@pytest.mark.parametrize("error, sent, served", [
    (GENERATION, 2, True),
    # Another failure (a limit, a rejected request) is the account's, and goes to the API route as before.
    ("rate_limited: ChatGPT's account or request limit was reached. Wait for the limit to reset.", 1, False),
])
def test_a_new_thread_chatgpt_failed_to_answer_is_sent_again_on_a_new_one_once(fake, error, sent, served):
    # 76 of the 101 ChatGPT Free chats that failed on 2026-10-13/14 were "generation failed", each a paid API call after.
    f = fake(state=["failed", "done"], reply=["", "free answer"], error=error)
    res, note = _consult(_task())
    assert len(f.chats) == sent and (res is not None and res.answer == "free answer") == served
    if served:
        first, again = (c["tasks"][0] for c in f.chats)
        assert again["prompt"] == first["prompt"] and again["name"] == first["name"] + " g2" and note is None
    f2 = fake(state="failed", reply="", error=GENERATION)  # a second failed generation goes to the API route
    res, note = _consult(_task())
    assert res is None and note["via"] == "api" and len(f2.chats) == 1 + free_client.REDO


def test_a_tool_task_whose_new_thread_chatgpt_failed_to_answer_opens_another(fake, tmp_path):
    read = '<tool_call>{"name": "read_file", "arguments": {"path": "notes.txt"}}</tool_call>'
    f = fake(state=["failed", "done", "done"], reply=["", read, "It is 42."], error=GENERATION)
    res, note = _consult(_read_task(tmp_path))
    assert note is None and res.status == "ok" and res.answer == "It is 42."
    first, again, last = (c["tasks"][0] for c in f.chats)
    assert again["prompt"] == first["prompt"] and "chat_id" not in again and again["name"] == first["name"] + " g2"
    assert last["chat_id"] == "c1" and last["prompt"].startswith('<tool_result name="read_file">')


@pytest.mark.parametrize("kw,after", [
    ({"tools": "edit"}, {}),
    # Web tools only for research (2026-10-13 A/B): general and decision work offered them keeps its API route.
    ({"tools": "web"}, {}),
    ({"tools": "web"}, {"profile": "decision"}),
    ({}, {"zdr": True}),
    ({"model": "deepseek-flash"}, {}),
    ({}, {"profile": "critical"}),
    ({}, {"purpose": "evaluation"}),
])
def test_an_ineligible_task_is_never_sent(fake, kw, after):
    f = fake()
    task = _task(**kw)
    for k, v in after.items():
        setattr(task, k, v)
    assert _consult(task) == (None, None)
    assert f.chats == []


def _read_task(tmp_path, **kw):
    (tmp_path / "notes.txt").write_bytes(b"the answer is 42\n")
    return _task(prompt="What is the answer in notes.txt?", tools="read", cwd=str(tmp_path), timeout_s=60, **kw)


def test_a_read_task_runs_its_tools_on_a_free_thread(fake, tmp_path):
    # As GPT-5.6 mini did on real tasks (2026-10-13): the thread says it has no tools, and again after the nudge; a new
    # thread makes the call, shown in a fence as chat models do, and its last reply answers from the tool result.
    f = fake(reply=["FAILED: the project tools are unavailable in this chat.", "I can't issue those <tool_call> lines.",
                    '```json\n{"name": "read_file", "arguments": {"path": "notes.txt"}}\n```', "It is 42."])
    res, note = _consult(_read_task(tmp_path))
    assert note is None and res.status == "ok" and res.answer == "It is 42." and res.cost_usd == 0.0
    assert res.model == "free:gpt-5-6-mini" and res.selection["route"]["via"] == "free"
    first, nudge, fresh, last = (c["tasks"][0] for c in f.chats)
    assert first["prompt"].startswith("# Tools you have in this chat") and "## read_file" in first["prompt"] and "chat_id" not in first
    assert nudge == {"prompt": free_client.NUDGE, "chat_id": "c1"}
    assert fresh["prompt"] == first["prompt"] and "chat_id" not in fresh and fresh["name"] == first["name"] + " r2"
    # The thread already holds the brief and the task: the next message is only the tool's result.
    assert last["chat_id"] == "c1" and last["prompt"].startswith('<tool_result name="read_file">')
    assert "the answer is 42" in last["prompt"] and "# Your brief" not in last["prompt"]


@pytest.mark.parametrize("model, answer", [("gpt-5-6-mini", "It is 42."), ("claude-sonnet-5-5", "It is 41.")])
def test_a_chatgpt_thread_that_finishes_on_too_few_reads_is_asked_once_to_check(fake, tmp_path, monkeypatch, model, answer):
    # Free ChatGPT threads answered after a median of 3 reads where the API route read 20 (2026-10-13): one that would
    # finish on fewer than CHECK_READS tool results is asked, in the same thread, to check its claims first. A Claude
    # thread is not: Sonnet won without it, and the turn would spend its 5-hour window.
    monkeypatch.setattr(free_client, "CHECK_READS", 2)
    monkeypatch.setattr(config, "ROUTE_VIA_FREE_CHECK_PROFILES", ("general",))
    read = '<tool_call>{"name": "read_file", "arguments": {"path": "notes.txt"}}</tool_call>'
    f = fake(reply=[read, "It is 41.", read, "It is 42.", "never sent"], model=model)
    res, note = _consult(_read_task(tmp_path))
    assert note is None and res.status == "ok" and res.answer == answer
    sent = [c["tasks"][0]["prompt"] for c in f.chats]
    assert sent.count(free_client.CHECK) == (answer == "It is 42.") and len(sent) == (4 if answer == "It is 42." else 2)


def test_a_continued_message_the_daemon_dropped_before_its_thread_had_it_is_sent_again_once(fake, tmp_path):
    # The thread was last used before this turn began, so the message never reached it: it is sent again, in the same
    # thread, rather than read back (its last reply is the previous turn's) or failed over.
    read = '<tool_call>{"name": "read_file", "arguments": {"path": "notes.txt"}}</tool_call>'
    f = fake(reply=[read, "never answered", "It is 42."], cut={2},
             threads=[{"chat_id": "c1", "name": "hswarm j1 t0", "status": "done", "updated": "2026-01-01T00:00:00Z"}])
    res, note = _consult(_read_task(tmp_path))
    assert note is None and res.status == "ok" and res.answer == "It is 42."
    sent = [c["tasks"][0] for c in f.chats]
    assert len(sent) == 3 and sent[2]["chat_id"] == "c1" and sent[2]["prompt"] == sent[1]["prompt"]
    assert res.selection["route"]["recovered"] == 1


def test_a_task_whose_every_thread_refuses_its_tools_goes_to_its_api_route(fake, tmp_path):
    # Before 2026-10-13 the last refusal came back as the answer: an ok Free result saying the tools were unavailable.
    f = fake(reply="I can't use those tools here.")
    res, note = _consult(_read_task(tmp_path))
    assert res is None and note["via"] == "api" and note["free_kind"] == "model"
    assert len(f.chats) == 2 * (1 + free_client.NUDGES) and "refused their tools" in note["error"]


def test_a_schema_read_task_answers_through_submit_result_on_a_free_thread(fake, tmp_path):
    fake(reply=['<tool_call>{"name": "read_file", "arguments": {"path": "notes.txt"}}</tool_call>',
                '<tool_call>{"name": "submit_result", "arguments": {"n": 42}}</tool_call>'])
    schema = {"type": "object", "properties": {"n": {"type": "integer"}}, "required": ["n"]}
    res, note = _consult(_read_task(tmp_path, schema=schema))
    assert note is None and res.status == "ok" and res.data == {"n": 42}


@pytest.mark.parametrize("claude_usage, asks, sent", [
    ("5h 40%, week 3%", ("sonnet@claude", "gpt-6"), {"model": "sonnet", "provider": "claude"}),
    ("5h 95%, week 3%", ("sonnet@claude", "gpt-6"), {"model": "gpt-6", "provider": "chatgpt"}),
    ("5h 95%, week 3%", ("sonnet@claude",), None),
])
def test_a_tool_task_asks_for_its_profiles_first_model_with_room(fake, tmp_path, monkeypatch, claude_usage, asks, sent):
    # A Claude account near the end of its 5-hour window is passed over: a thread of several messages there hits its limit.
    monkeypatch.setattr(config, "ROUTE_VIA_FREE_TOOL_PROFILES", ("general", "decision"))
    monkeypatch.setattr(config, "ROUTE_VIA_FREE_TOOL_ASKS", {"decision": asks})
    monkeypatch.setattr(config, "ROUTE_VIA_FREE_CHECK_PROFILES", ())  # which model is asked, not the claim check
    chatgpt = {"account": "a2", "num": 2, "provider": "chatgpt", "signedIn": True, "busy": False, "usage": "unlimited everyday text"}
    f = fake(accounts=[{**ACCOUNTS[0], "usage": claude_usage}, chatgpt],
             reply=['<tool_call>{"name": "read_file", "arguments": {"path": "notes.txt"}}</tool_call>', "It is 42."])
    task = _read_task(tmp_path)
    task.profile = "decision"
    res, note = _consult(task)
    if sent is None:
        assert res is None and note["short"] == "free" and f.chats == []
        return
    assert note is None and res.status == "ok" and res.answer == "It is 42."
    first, after = (c["tasks"][0] for c in f.chats)
    assert {k: first.get(k) for k in ("model", "provider")} == sent
    assert after["chat_id"] == "c1" and "model" not in after and "provider" not in after


@pytest.mark.parametrize("ask, expected", [
    ("gpt-instant", ("gpt-instant", "chatgpt")), ("gpt-6-1-mini", ("gpt-6-1-mini", "chatgpt")),
    ("sonnet", ("sonnet", None)), ("sonnet@claude", ("sonnet", "claude")), ("@chatgpt", ("", "chatgpt")),
])
def test_ask_provider_is_chatgpt_for_any_name_but_the_claude_families(ask, expected):
    assert free_route._ask(ask) == expected


@pytest.mark.parametrize("claude_usage, profile, sent", [
    ("5h 40%, week 3%", "research", {"model": "sonnet", "provider": "claude"}),
    ("5h 95%, week 3%", "research", {"model": None, "provider": "chatgpt"}),
    ("5h 95%, week 3%", "decision", None),
    ("5h 40%, week 3%", "critical", {"model": "luna-thinking", "provider": "chatgpt"}),
    ("5h 40%, week 3%", "code", {"model": "luna-thinking", "provider": "chatgpt"}),
    # ChatGPT resting (a provider the daemon found failing): critical and code read work goes to Sonnet on Claude.
    ("5h 40%, week 3%", "critical-chatgpt-down", {"model": "sonnet", "provider": "claude"}),
    ("5h 40%, week 3%", "code-chatgpt-down", {"model": "sonnet", "provider": "claude"}),
    ("5h 95%, week 3%", "code-chatgpt-down", None),
])
def test_each_tool_profile_goes_to_the_free_model_that_held_level_with_the_api(fake, claude_usage, profile, sent):
    # By default: Sonnet on a Claude account with room for both; with none, research goes to a ChatGPT account (mini,
    # which checks its claims, 8 to 4 against the API), and decision is a shortfall (it lost there even when checked).
    # Critical and code read work go to Luna Thinking whatever Claude has left (13-15-1 and 7-5 against the API).
    profile, down = profile.removesuffix("-chatgpt-down"), profile.endswith("-chatgpt-down")
    chatgpt = {"account": "a2", "num": 2, "provider": "chatgpt", "signedIn": True, "busy": False, "usage": "unlimited everyday text",
               **({"resting": "until later after chatgpt down: not_found (x1)"} if down else {})}
    f = fake(accounts=[{**ACCOUNTS[0], "usage": claude_usage}, chatgpt], reply="I could not finish.")
    task = _task(tools="web" if profile == "research" else "read", cwd=".")
    task.profile = profile
    res, note = _consult(task)
    if sent is None:
        assert res is None and note["short"] == "free" and f.chats == []
        return
    first = f.chats[0]["tasks"][0]
    assert {k: first.get(k) for k in ("model", "provider")} == sent


def test_a_free_tool_run_that_fails_goes_to_its_api_route(fake, tmp_path):
    fake(state="failed")
    res, note = _consult(_read_task(tmp_path))
    assert res is None and note["free_miss"] and note["free_kind"] == "unavailable" and note["via"] == "api"
