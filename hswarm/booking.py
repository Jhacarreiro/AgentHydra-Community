"""Booking: every finished ask attributed and costed (a ledger line and the savings running total), and `decide`,
hswarm_decide's body, which books its Jev spend the same way.

Nothing here imports the MCP SDK, so a caller outside the server gets the same booked cascade the tool runs without
loading the server: Dredd's Jev bridge imported hswarm.mcp_server for hswarm_decide, and each Python start paid
101 MB and 1.3 CPU-seconds for it, 998 modules, most of them mcp and pydantic (measured 2026-10-10, Python 3.14). The
MCP tools call these functions; nothing else is kept in two places.
"""
from __future__ import annotations

import asyncio

from . import decisions, typesafe, utilization
from .caller import detect as detect_caller
from .jobs import manager
from .ledger import append_row, ask_row
from .spec import Result, now_iso


async def book_asks(results: list, kind: str, extra: tuple = ()) -> dict:
    """Attribute and cost finished asks (ledger line + the savings running total). ⛔ Bookkeeping NEVER fails the
    answer it records (2026-09-21): the CLI `ask` does none of this and answered on the machine where the MCP tool
    kept failing, so a caller-stamp, ledger or savings-database fault must come back as a note beside the answer,
    not replace it.

    `extra` is (Result, ledger fields) pairs for spend that is not one of `results` (decide's Jev calls). Each
    gets a ledger line AND its own utilization row: the ledger line has no `id`, so handing it to utilization.record
    failed every decide with `KeyError: 'id'` (3,070 times, 2026-09-21 to 2026-09-24) and no Jev spend was saved."""
    try:
        caller = detect_caller(kind)
        for r, fields in extra:
            append_row(ask_row(r, caller) | fields)
            await asyncio.to_thread(utilization.record, utilization.ask_row(r, caller) | {"label": fields.get("job") or kind})
        saved = None
        for r in results:
            append_row(ask_row(r, caller) | ({"job": kind} if kind != "ask" else {}))
            saved = utilization.compact(await asyncio.to_thread(utilization.record_ask, r, caller))
        return {"savings": saved} if kind == "ask" else {}
    except Exception as e:  # noqa: BLE001 - see the docstring
        return {"bookkeeping_error": f"{type(e).__name__}: {e}"[:300]}


async def decide(items: list[dict], mgr=None, *, escalate_below: float = 0.7, fallback_model: str = "auto", batch: int = 1,
                 model: str = typesafe.MODEL, jev: typesafe.Jev | None = None) -> dict:
    """Typed decisions, booked: decisions.decide on `mgr` (this process's jobs.manager() when None), then its Jev calls
    and its fallback asks go through book_asks. The arguments and the answer are hswarm_decide's, whose docstring
    says what the cascade does; `jev` is an open client for the Jev leg in place of the configured pool, booked under
    its own provider. Unlike the tool, an unexpected failure raises instead of coming back as an `error`."""
    out = await decisions.decide(items, mgr or manager(), escalate_below=escalate_below, fallback_model=fallback_model, model=model, batch=batch,
                                 jev=jev)
    fallbacks = out.pop("_fallback_results")
    spent: tuple = ()
    # The Jev part, and each stand-in's when one stood in, is one ledger line each (all its calls), costed like an ask;
    # the caller stamp is added in book_asks.
    for stats, provider, name in ((out.pop("_jev_stats"), jev.provider if jev else "typesafe", model),
                                  *((s, s["provider"], s["model"]) for s in out.pop("_stand_in_stats") or ())):
        if stats.get("calls"):
            jr = Result(id="decide", status="ok" if not stats.get("errors") else "error", backend=provider, model=stats.get("model") or name,
                        usage={"in_hit": 0, "in_miss": stats.get("in", 0), "out": stats.get("out", 0), "reasoning": 0}, cost_usd=stats.get("cost_usd", 0.0),
                        seconds=round(stats.get("secs", 0.0), 3), turns=stats["calls"], finished=now_iso())
            fields = {"provider": provider, "job": "decide"}
            if stats.get("errors") and stats.get("key_dead", 0) >= stats["errors"] and not stats.get("in") and not stats.get("out"):
                # Every error was a dead key and no tokens came back: the line stays an error, but is not the model's.
                fields |= {"unjudged": "key", "error_kind": "key"}
            spent += ((jr, fields),)
    return out | await book_asks(fallbacks, "decide", spent)
