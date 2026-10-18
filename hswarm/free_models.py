"""The keep-current loop for the Free ChatGPT accounts' models (owner, 2026-10-13: keep us up to date with current
models, e.g. a new 6.1 in the free models; quick to check and to update).

`hswarm models --free` reads the daemon's free_status (what each signed-in ChatGPT account lists as `offers`, and the slug
each role name gpt-instant / gpt-thinking / gpt-auto resolves to as `roles`), keeps the slugs it has seen in
~/.hswarm/free-model-watch.json, and reports a slug no earlier scan saw as `new` and one no account lists now as `gone`,
and what every route_via_free_tool_asks entry means today. Modelled on model_watch.py, which does the same for the API.
"""
from __future__ import annotations

import datetime as dt
import json
import time

from . import config, free_route

STATUS_TIMEOUT_S = 15.0
ROLES = ("gpt-instant", "gpt-thinking", "gpt-auto")
# Names kept because routing was measured on them (the harness's pinned names): name -> the slug each means.
PINNED = {"luna-thinking": "gpt-5-6-t-mini", "gpt-6": "gpt-6", "gpt-6-thinking": "gpt-6-t-mini"}
NOT_REPORTED = "roles not reported"
DEFAULT_TEXT = "gpt-5-6-mini"  # the harness's default text model (chatgpt/http.py TEXT_MODEL) while an account lists it
A_B = ("python -m hswarm.free_ab pick --profile critical --n 30", "python -m hswarm.free_ab arm --model <slug>",
       "python -m hswarm.free_ab judge", "python -m hswarm.free_ab report")


def path():
    return config.HOME / "free-model-watch.json"


def load() -> dict:
    try:
        d = json.loads(path().read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _slug(o) -> str | None:
    s = o.get("slug") if isinstance(o, dict) else o
    return s if isinstance(s, str) and s else None


def _accounts(status: dict) -> list[dict]:
    return [a for a in (status.get("accounts") or []) if isinstance(a, dict) and a.get("signedIn") and a.get("provider") == "chatgpt"]


def _default(a: dict) -> str | None:
    """An account's default text model by the harness's rule: gpt-5-6-mini while listed, else its gpt-instant."""
    if a.get("default_moved"):
        return (a.get("roles") or {}).get("gpt-instant")
    return DEFAULT_TEXT if DEFAULT_TEXT in {x for x in map(_slug, a.get("offers") or []) if x} else None


def analyse(status: dict, previous: dict, now: str) -> dict:
    """The report for one free_status read against the stored state (no I/O)."""
    accounts = _accounts(status)
    offers: dict[str, int] = {}
    roles: dict[str, set[str]] = {r: set() for r in ROLES}
    reported = False
    for a in accounts:
        for s in {x for x in map(_slug, a.get("offers") or []) if x}:
            offers[s] = offers.get(s, 0) + 1
        if isinstance(a.get("roles"), dict):
            reported = True
            for r in ROLES:
                if a["roles"].get(r):
                    roles[r].add(a["roles"][r])
    seen = previous.get("slugs") or {}
    first = not seen  # the first scan records what is listed; only a later one calls a model new, as Desk does
    # A slug listed again after a scan saw it gone is new again, as Desk's notice treats it.
    new = [] if first else sorted(s for s in offers if s not in seen or (seen[s] or {}).get("gone"))
    gone = sorted(s for s, v in seen.items() if s not in offers and not (v or {}).get("gone"))
    resolves = {r: sorted(roles[r]) if reported else NOT_REPORTED for r in ROLES}
    asks = {}
    for profile, entries in config.ROUTE_VIA_FREE_TOOL_ASKS.items():
        rows = []
        for ask in entries:
            model, _, provider = ask.partition("@")
            if provider and provider != "chatgpt":
                means = f"{provider} account"
            elif not model:
                defaults = sorted({d for d in map(_default, accounts) if d})
                means = ", ".join(defaults) + " (each account's default)" if defaults else "each account's default text model"
            elif model in resolves:
                v = resolves[model]
                means = v if isinstance(v, str) else (", ".join(v) or "no account lists one")
            elif model in PINNED:
                n = offers.get(PINNED[model], 0)
                means = f"{PINNED[model]} (pinned; {n} of {len(accounts)} accounts list it)"
            else:
                n = offers.get(model, 0)
                means = f"{model} ({n} of {len(accounts)} accounts list it)"
            rows.append({"ask": ask, "means": means})
        asks[profile] = rows
    slugs = {}
    for s, n in offers.items():
        old = seen.get(s) or {}
        slugs[s] = {"first_seen": old.get("first_seen", now), "last_seen": now, "accounts": n}
    for s, old in seen.items():
        if s not in offers:
            slugs[s] = {**old, "gone": True}
    return {"scanned_at": now, "first": first, "accounts": len(accounts), "offers": offers, "roles": resolves,
            "default_moved": [a.get("account") for a in accounts if a.get("default_moved")],
            "new": new, "gone": gone, "asks": asks, "slugs": slugs}


async def scan() -> dict:
    """Read free_status, compare with the stored state, store the new state, return the report."""
    try:
        status = await free_route._call("free_status", {}, STATUS_TIMEOUT_S)
    except free_route._ERRORS as e:
        return {"error": f"free_status not read ({type(e).__name__})", "new": [], "gone": []}
    if not isinstance(status, dict) or not status.get("ready"):
        return {"error": "the daemon is not ready", "new": [], "gone": []}
    out = analyse(status, load(), _now())
    if not out["offers"]:
        # No signed-in ChatGPT account has read its model list yet (Desk reads it with usage): nothing is gone.
        return {"error": f"no ChatGPT account reported its models ({out['accounts']} signed in)", "new": [], "gone": []}
    try:
        config.HOME.mkdir(parents=True, exist_ok=True)
        path().write_text(json.dumps({"scanned_at": out["scanned_at"], "slugs": out["slugs"]}, indent=2), encoding="utf-8")
    except OSError as e:
        out["state_error"] = str(e)
    return out


def render(out: dict) -> str:
    if out.get("error"):
        return f"Free model watch: {out['error']}"
    lines = [f"Free ChatGPT models ({out['accounts']} signed-in accounts)"
             + (": first scan, every model recorded; the next scan reports what is new" if out.get("first") else ":")]
    for s, n in sorted(out["offers"].items()):
        lines.append(f"  {s:<22} {n} of {out['accounts']} accounts" + ("  NEW" if s in out["new"] else ""))
    lines.append("Role names resolve to:")
    for r, v in out["roles"].items():
        lines.append(f"  {r:<14} {v if isinstance(v, str) else ', '.join(v) or 'no account lists one'}")
    if out["default_moved"]:
        lines.append(f"Default text model moved (gpt-5-6-mini not listed) on: {', '.join(map(str, out['default_moved']))}")
    lines.append("route_via_free_tool_asks mean today:")
    for profile, rows in out["asks"].items():
        for r in rows:
            lines.append(f"  {profile:<10} {r['ask']:<16} -> {r['means']}")
    if out["new"]:
        lines.append("NEW: " + ", ".join(out["new"]))
    if out["gone"]:
        lines.append("GONE: " + ", ".join(out["gone"]))
    if out["new"]:
        lines += ["Next steps for a new model:", "  (a) measure it against the API:"]
        lines += [f"      {c}" for c in A_B]
        lines.append("  (b) to adopt it, change route_via_free_tool_asks (settings) or the default in config.py, citing the A/B numbers.")
    return "\n".join(lines)


def summary() -> str:
    """The one line `hswarm doctor` carries, offline."""
    state = load()
    if not state.get("scanned_at"):
        return "never scanned; `hswarm models --free` reads what the Free ChatGPT accounts list"
    try:
        secs = time.time() - dt.datetime.strptime(state["scanned_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc).timestamp()
    except ValueError:
        secs = 0.0
    age = f"{secs / 3600:.1f} h" if secs < 48 * 3600 else f"{secs / 86400:.1f} days"
    slugs = state.get("slugs") or {}
    live = sum(1 for v in slugs.values() if not (v or {}).get("gone"))
    return f"last scan {age} ago: {live} models listed, {len(slugs) - live} gone"
