"""Free web accounts first: a task may be answered by one of the owner's signed-in Free claude.ai or chatgpt.com
accounts, which AgentHydra manages, before any paid API leg is used: a tool-free task in one message, and a routine or
general task offered only reading tools (config.ROUTE_VIA_FREE_TOOLS, ROUTE_VIA_FREE_TOOL_PROFILES) as a thread that
runs them through a text protocol (free_client.py). `consult` reads `free_status`, sends one `free_chat`
task and polls `free_results` over AgentHydra's MCP endpoint (POST /api/mcp, stateless JSON-RPC).

Never a failure of its own: the daemon down or slow, not ready, no idle signed-in account, a refused send, a failed or
timed-out task, or an answer that is not the JSON the schema asks for keeps the task on its API route, logged once per job.
The route taken is on the result (`selection["route"]`) and its ledger line (provider `free`, cost 0). A free account only
answers text: no tool field, no system-prompt field, so the system text rides in the prompt."""
from __future__ import annotations

import asyncio
import dataclasses
import json
import logging
import re
import time
import urllib.error
import urllib.request
from collections import Counter

from . import config
from .climayte_route import base_url
from .free_client import FreeChatClient, TurnError, redo, tool_names_allowed, turn
from .spec import Result, Task, inline_files, now_iso

log = logging.getLogger("hswarm.free")

STATUS_TIMEOUT_S = 5.0  # 2 s sent every task to the API while the daemon stalled (39 jobs at 23:51-00:00Z, 2026-10-07)
MAX_PROMPT_CHARS = 100_000
WAIT_S = 40  # the daemon waits at most 45 s per call
WAIT_CAP_S = 240  # the longest a free account may hold a task before it goes back to its API route, whatever its timeout_s
TOOL_CAP_S = 600  # the longest a tool task may run on a Free thread before it goes back to its API route
HAIKU_PROFILES = ("routine", "general")
_LOGGED: set[str] = set()
_ACTIVE = 0  # tasks on a free account right now, across every job of this process (route_via_free_max)
# When this process sent each task still running: free_status shows a sent task's account busy once the daemon has
# started it (a status read and one POST, well under a second), so until then the task is subtracted from the idle
# count. Kept short: a sent task that free_status already shows is subtracted twice for this long, as _ACTIVE once was
# for good. A task's stamp leaves the list when the task ends.
_SENT: list[float] = []
UNSEEN_S = 2.0
SCHEMA_LINE = "Answer with only one JSON value that satisfies this JSON Schema, with no prose and no code fence:"


def eligible(task: Task) -> bool:
    """A text-only, auto-routed API task of an ordinary profile that no rule keeps off a third-party chat, offered no
    tool, or only tools a Free thread may run (config.ROUTE_VIA_FREE_TOOLS) on a profile that may use them there
    (config.ROUTE_VIA_FREE_TOOL_PROFILES); a tool-free task's profile must be one of config.ROUTE_VIA_FREE_PROFILES.
    A CliMayte worker's own asks qualify: the worker guard is climayte_route's (a worker must not start another worker),
    and copied here it kept every tool-free ask a worker made off the Free accounts (5,400 in 48 h, 5 of them on Free,
    2026-10-09; owner: "why you're running nothing on there")."""
    if not config.ROUTE_VIA_FREE or not base_url():
        return False
    if getattr(task, "images", None) or task.zdr:
        return False
    if task.purpose == "evaluation" or task.backend != "api":
        return False
    # An auto task carries its profile and, once built, the plan's first concrete model (spec._resolve_backend); a
    # pinned one has no profile. So the profile, never `model == auto`, says whether HSwarm may choose the route. Each
    # kind of task has its own list: critical read work goes to Free (Luna Thinking held level with the API on it),
    # critical tool-free work was never measured there and does not.
    if task.tools != "none":
        if task.profile not in config.ROUTE_VIA_FREE_TOOL_PROFILES or not tool_names_allowed(task):
            return False
    elif task.profile not in config.ROUTE_VIA_FREE_PROFILES:
        return False
    return len(shape(task)) <= MAX_PROMPT_CHARS


def shape(task: Task) -> str:
    """The task as a chat message: system text under a heading, the prompt, inlined files, then the schema line."""
    parts = []
    if task.system and task.system.strip():
        parts.append("# Instructions\n\n" + task.system.strip())
    parts.append(inline_files(task, task.prompt.strip()))
    if task.schema:
        # Compact: the same schema without the space after every comma and colon, which every free call paid for.
        parts.append(SCHEMA_LINE + "\n" + json.dumps(task.schema, ensure_ascii=False, separators=(",", ":")))
    return "\n\n".join(parts)


def _say(job_id: str, msg: str) -> None:
    if job_id not in _LOGGED:
        _LOGGED.add(job_id)
        log.warning("job %s: %s", job_id, msg)


def _rpc(name: str, arguments: dict, timeout: float) -> dict:
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}}).encode()
    req = urllib.request.Request(base_url() + "/api/mcp", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            doc = json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        raise OSError(f"HTTP {e.code}") from e
    result = doc.get("result") or {}
    if result.get("isError"):
        raise OSError("tool error")
    return json.loads(result["content"][0]["text"])


async def _call(name: str, arguments: dict, timeout: float) -> dict:
    # to_thread cannot stop a socket early, so the wait is bounded here as well as on the socket
    return await asyncio.wait_for(asyncio.to_thread(_rpc, name, arguments, timeout), timeout + 0.5)


_ERRORS = (OSError, ValueError, KeyError, IndexError, TypeError, asyncio.TimeoutError)


def _idle(status: dict, provider: str | None = None) -> int:
    """Signed-in accounts neither busy, resting after a failed send (mcp-free.ts restingFor) nor paced out of
    new chats for now (mcp-free.ts pacedOut); with a provider, only that provider's accounts with room (_room)."""
    if not status.get("ready"):
        return 0
    return sum(1 for a in status.get("accounts") or []
               if isinstance(a, dict) and a.get("signedIn") and not a.get("busy") and not a.get("resting")
               and not a.get("paced") and (provider is None or (a.get("provider") == provider and _room(a))))


CLAUDE_FAMILIES = ("haiku", "sonnet")  # the only model names that are Claude's; every other name is ChatGPT's
CLAUDE_FULL_PCT = 80  # a Claude account this far into its 5-hour window is not asked for a thread (mcp-free.ts roomBand 3)


def _room(account: dict) -> bool:
    """Whether a Claude account's 5-hour window has room for a thread of several messages ("5h 43%, week 19%" in
    free_status); ChatGPT's everyday text has no window, and a Claude account with no reading yet counts as room."""
    m = re.search(r"\b5h (\d+)%", str(account.get("usage") or ""))
    return account.get("provider") != "claude" or not m or int(m.group(1)) < CLAUDE_FULL_PCT


def _ask(ask: str) -> tuple[str, str | None]:
    """A route_via_free_tool_asks entry as free_chat's (model, provider): "sonnet@claude", or "gpt-6" (ChatGPT's).
    Any model name that is not "haiku" or "sonnet" is ChatGPT's (a role name like gpt-instant, a pinned name like
    luna-thinking, or a slug); an explicit "@provider" wins."""
    model, _, provider = ask.partition("@")
    return model, provider or ("chatgpt" if model and model not in CLAUDE_FAMILIES else None)


def _pick(task: Task, status: dict, unseen: int) -> tuple[str, str | None] | None:
    """The (model, provider) a task's Free thread asks for, or None when no account can take it now: a tool task of a
    profile with asks (config.ROUTE_VIA_FREE_TOOL_ASKS) takes the first whose provider has an idle account with room;
    any other task asks for its Claude family on whichever account is idle."""
    asks = config.ROUTE_VIA_FREE_TOOL_ASKS.get(task.profile or "") if task.tools != "none" else None
    if not asks:
        family = "haiku" if task.profile in HAIKU_PROFILES else "sonnet"
        return (family, None) if _idle(status) - unseen > 0 else None
    for model, provider in map(_ask, asks):
        if _idle(status, provider) - unseen > 0:
            return model, provider
    return None


def _short(status: dict, capped: bool) -> dict | None:
    """The note for an eligible task no Free account could take (the shortfall report counts these, shortfall.py):
    `short_why` is `capped` (route_via_free_max), `signed_out` (no account signed in), or what held most signed-in
    accounts (busy, paced or resting). None while the daemon is not ready, which says nothing about how many accounts
    it would take."""
    if not status.get("ready"):
        return None
    signed = [a for a in status.get("accounts") or [] if isinstance(a, dict) and a.get("signedIn")]
    if capped:
        why = "capped"
    elif not signed:
        why = "signed_out"
    else:
        why = Counter("paced" if a.get("paced") else "resting" if a.get("resting") else "busy" for a in signed).most_common(1)[0][0]
    return {"via": "api", "short": "free", "short_why": why}


def _tokens(text: str) -> int:
    return -(-len(text) // 4)


GPT_MODEL = "gpt-5-6-mini"
CLAUDE_MODELS = {"haiku": "claude-haiku-5-5", "sonnet": "claude-sonnet-5-5"}


def miss_model(task: Task, one: dict | None = None, accounts: list | None = None) -> str:
    """`free:<model>` for a Free try that was not accepted: the model the answering account named, else the one its
    provider gives for the family HSwarm asked for (Haiku for narrow profiles, Sonnet otherwise; a ChatGPT account
    ignores the family). The provider comes from the reply, the account's status entry, or the only provider among the
    signed-in accounts; `free:unknown` only when none of that is known."""
    one = one or {}
    if one.get("model"):
        return "free:" + str(one["model"])
    prov = str(one.get("provider") or "").lower()
    accts = [a for a in accounts or [] if isinstance(a, dict)]
    if not prov:
        name = one.get("account")
        for a in accts:
            if name is not None and name in (a.get("id"), a.get("name"), a.get("account"), a.get("num")):
                prov = str(a.get("provider") or "").lower()
    if not prov:
        seen = {str(a.get("provider") or "").lower() for a in accts if a.get("signedIn") and a.get("provider")}
        prov = seen.pop() if len(seen) == 1 else ""
    if "gpt" in prov or "openai" in prov:
        return "free:" + GPT_MODEL
    if "claude" in prov or "anthropic" in prov:
        return "free:" + CLAUDE_MODELS["haiku" if task.profile in HAIKU_PROFILES else "sonnet"]
    return "free:unknown"


def _miss(task: Task, fallback: str, status: str, kind: str, one: dict | None = None, accounts: list | None = None, error: str | None = None) -> dict:
    """The note for a Free try that did not serve the task. `free_miss` marks it for the ledger (jobs books an extra row)."""
    note = {"via": "api", "fallback": fallback, "free_miss": True, "free_model": miss_model(task, one, accounts), "free_status": status,
            "free_kind": kind, "ts": now_iso()}
    if one and one.get("account") is not None:
        note["account"] = one.get("account")
    if error:
        note["error"] = error
    return note


def _result(task: Task, one: dict, why: str, started: str, job_id: str) -> Result | None:
    from .worker import payload_in_text

    text = str(one.get("response") or "").strip()
    if not text:
        _say(job_id, "the free account's reply was empty; the task runs on its API route")
        return None
    # `seconds` is the account's own time on it (free_results), so the ledger shows how busy the Free accounts are.
    on_account = float(one.get("seconds") or 0.0)
    res = Result(id=task.id, backend=task.backend, model="free:" + str(one.get("model") or "unknown"), status="ok", turns=1,
                 answer=text, cost_usd=0.0, started=started, finished=now_iso(), seconds=on_account,
                 api_seconds=on_account)
    # A web chat reports no token counts, so the ledger gets an estimate (4 characters a token, as Desk's Free tab
    # counts them); without one every Free answer was ledgered as 0 tokens (2026-10-09).
    res.usage = {"in_hit": 0, "in_miss": _tokens(shape(task)), "out": _tokens(text), "reasoning": 0}  # ledger line: token_basis chars/4
    if task.schema:
        data = payload_in_text(text, task.schema)  # strips a code fence; the same schema check as the API route
        if data is None:
            _say(job_id, "the free account's reply did not match the task's schema; the task runs on its API route")
            return None
        res.data = data
    res.selection = {"route": {"via": "free", "account": one.get("account"), "chat_id": one.get("chat_id"), "why": why,
                               **({"recovered": 1} if one.get("recovered") else {})}}
    return res


# A tool-free turn that gave no reply, by where it stopped (free_client.TurnError.stage): its note's fallback, status and
# kind, which `hswarm` reads back from the ledger (commands.py).
_TURN_MISS = {"send": ("free send failed", "error", "unavailable"), "refused": ("free chat refused", "error", "unavailable"),
              "failed": ("free account failed", "error", "unavailable"), "timeout": ("free account timed out", "timeout", "timeout"),
              "results": ("free results unavailable", "error", "unavailable")}


async def _serve(job_id: str, task: Task, accounts: list | None = None) -> tuple[Result | None, dict | None]:
    started = now_iso("milliseconds")
    item = {"prompt": shape(task), "name": f"hswarm {job_id} {task.id}"}
    # Narrow work asks for the lightest Claude model (Haiku 5.5) (owner, 2026-10-07: low-impact Haiku 5.5 through
    # free instances where possible); research and decision ask for Sonnet by name, since "the account's usual
    # one" is its last turn's model, which those Haiku asks made Haiku 5.5 on every account (2026-10-10). A
    # ChatGPT account ignores both.
    item["model"] = "haiku" if task.profile in HAIKU_PROFILES else "sonnet"
    redone = 0
    while True:
        try:
            one = await turn(_call, item, min(task.timeout_s, WAIT_CAP_S))
            break
        except TurnError as e:
            if redo(e, None, redone):  # ChatGPT failed to answer the new thread: another one (free_client.REDO)
                redone += 1
                item = {**item, "name": f"hswarm {job_id} {task.id} g{redone + 1}"}
                continue
            fallback, status, kind = _TURN_MISS[e.stage]
            _say(job_id, f"{fallback} ({e.body}); the task runs on its API route")
            error = str(e.one.get("error") or "")[:200] if e.stage == "failed" else None
            return None, _miss(task, fallback, status, kind, e.one or None, accounts, error)
    why = "tool-free task on a signed-in Free account, no API cost"
    res = _result(task, one, why, started, job_id)
    return (res, None) if res else (None, _miss(task, "the free reply was unusable", "error", "model", one, accounts))


async def _serve_tools(job_id: str, task: Task, accounts: list | None = None,
                       ask: tuple[str, str | None] | None = None) -> tuple[Result | None, dict | None]:
    """A tool task on one Free thread: the API loop itself (agent.run_api_task) with a FreeChatClient for its wire, so the
    sandbox, receipts, schema check, loop guard and wall are the API route's own. Anything short of an ok result goes to
    its API route, which starts over; its tools only read, so the Free try left nothing behind."""
    from .agent import run_api_task

    model, provider = ask or ("haiku" if task.profile in HAIKU_PROFILES else "sonnet", None)
    client = FreeChatClient(job_id, task, model, call=_call, provider=provider)
    leg = dataclasses.replace(task, model="free:web", timeout_s=min(task.timeout_s, TOOL_CAP_S))
    res, _ = await run_api_task(client, leg, user_tag=job_id)
    one = {"account": client.account, "model": client.model, "chat_id": client.chat_id}
    if res.status != "ok":
        error = (res.error or res.status)[:200]
        _say(job_id, f"a tool task on a Free account ended {res.status} ({error}); it runs on its API route")
        kind = "timeout" if res.status == "timeout" else "unavailable" if error.startswith("free ") else "model"
        return None, _miss(task, f"free tool run {res.status}", "timeout" if kind == "timeout" else "error", kind, one, accounts, error)
    res.model = miss_model(task, one, accounts)  # the model that answered, as a Free miss would name it
    res.backend, res.cost_usd = task.backend, 0.0
    res.selection = {**(res.selection or {}), "route": {"via": "free", "account": client.account, "chat_id": client.chat_id,
                                                         "why": "tool task on a Free account through the text tool protocol, no API cost",
                                                         **({"recovered": client.recovered} if client.recovered else {})}}
    return res, None


async def consult(job_id: str, task: Task) -> tuple[Result | None, dict | None]:
    """(a finished Result, None) when a free account served the task; (None, note) when the API route runs and the
    note says why (a try that failed, or no account free to take it); (None, None) when nobody was asked or nothing is
    worth noting."""
    global _ACTIVE
    if not eligible(task):
        return None, None
    asked = time.monotonic()
    try:
        status = await _call("free_status", {}, STATUS_TIMEOUT_S)
    except _ERRORS as e:
        _say(job_id, f"free accounts unavailable ({type(e).__name__}); tasks keep their API route")
        return None, None
    # _idle already leaves out the accounts this process's running tasks hold (comparing _ACTIVE with it counted each
    # of them twice and stopped a process at 3 of 6 accounts). What it cannot show yet is a task sent moments ago:
    # tasks that read one snapshot at once would all take its one idle account, so those are subtracted here. Unseen is
    # measured from when the snapshot was asked for: measured from its answer, a status read slower than UNSEEN_S (the
    # daemon is allowed STATUS_TIMEOUT_S) aged out a task sent while it waited, and both took the one idle account.
    unseen = sum(1 for t in _SENT if t > asked - UNSEEN_S)
    capped = config.ROUTE_VIA_FREE_MAX is not None and _ACTIVE >= config.ROUTE_VIA_FREE_MAX
    if not isinstance(status, dict):
        return None, None
    ask = None if capped else _pick(task, status, unseen)
    if ask is None:
        return None, _short(status, capped)
    now = time.monotonic()
    _SENT.append(now)
    _ACTIVE += 1  # both taken before any await below
    try:
        if task.tools == "none":
            return await _serve(job_id, task, status.get("accounts"))
        return await _serve_tools(job_id, task, status.get("accounts"), ask)
    finally:
        _ACTIVE -= 1
        if now in _SENT:  # a finished task's account is free again, however recently it was sent
            _SENT.remove(now)
