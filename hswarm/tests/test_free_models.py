"""Offline: `hswarm models --free` against a fake free_status (free_models.py). conftest points config.HOME at a temp folder."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from hswarm import free_models, free_route  # noqa: E402

BASE = ["gpt-6", "gpt-6-mini", "gpt-6-t-mini", "gpt-5-6", "gpt-5-6-mini", "gpt-5-6-t-mini"]
ROLES = {"gpt-instant": "gpt-6-mini", "gpt-thinking": "gpt-6-t-mini", "gpt-auto": "gpt-6"}


def _status(offers, roles=ROLES, n=2):
    accounts = [{"account": f"a{i}", "provider": "chatgpt", "signedIn": True, "offers": list(offers),
                 **({"roles": dict(roles)} if roles is not None else {})} for i in range(n)]
    return {"ready": True, "accounts": accounts + [{"account": "c1", "provider": "claude", "signedIn": True}]}


def _scan(monkeypatch, status):
    async def fake(name, args, timeout):
        assert name == "free_status"
        return status
    monkeypatch.setattr(free_route, "_call", fake)
    return asyncio.run(free_models.scan())


def test_first_scan_lists_slugs_and_resolves_roles(monkeypatch):
    out = _scan(monkeypatch, _status(BASE))
    assert out["offers"]["gpt-6-mini"] == 2 and out["accounts"] == 2
    assert out["roles"]["gpt-instant"] == ["gpt-6-mini"]
    assert out["first"] and out["new"] == [] and free_models.path().exists()
    assert "gpt-6-mini" in free_models.render(out)


def test_a_scan_with_no_model_lists_changes_nothing(monkeypatch):
    _scan(monkeypatch, _status(BASE))
    out = _scan(monkeypatch, _status([]))
    assert out.get("error") and out["gone"] == []
    assert _scan(monkeypatch, _status(BASE))["gone"] == []


def test_second_scan_reports_new_model_and_moved_role(monkeypatch):
    _scan(monkeypatch, _status(BASE))
    out = _scan(monkeypatch, _status(BASE + ["gpt-6-1-mini"], {**ROLES, "gpt-instant": "gpt-6-1-mini"}))
    assert out["new"] == ["gpt-6-1-mini"] and out["roles"]["gpt-instant"] == ["gpt-6-1-mini"]
    assert "free_ab pick --profile critical" in free_models.render(out)
    assert _scan(monkeypatch, _status(BASE + ["gpt-6-1-mini"]))["new"] == []


def test_vanished_slug_is_gone(monkeypatch):
    _scan(monkeypatch, _status(BASE))
    out = _scan(monkeypatch, _status(BASE[:-1]))
    assert out["gone"] == ["gpt-5-6-t-mini"] and "GONE: gpt-5-6-t-mini" in free_models.render(out)
    assert _scan(monkeypatch, _status(BASE))["new"] == ["gpt-5-6-t-mini"]  # listed again: new again, as in Desk


def test_asks_table_names_the_pinned_slug_and_roles_not_reported(monkeypatch):
    out = _scan(monkeypatch, _status(BASE, roles=None))
    critical = out["asks"]["critical"][0]
    assert critical["ask"] == "luna-thinking" and critical["means"].startswith("gpt-5-6-t-mini")
    assert {"ask": "@chatgpt", "means": "gpt-5-6-mini (each account's default)"} in out["asks"]["research"]
    assert out["roles"]["gpt-instant"] == free_models.NOT_REPORTED
