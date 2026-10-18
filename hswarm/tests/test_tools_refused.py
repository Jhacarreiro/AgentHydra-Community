"""A key whose plan refuses tool calls (Inworld's HTTP 400 "Tool calling is currently restricted on your plan") is remembered
on its row in the shared key state, so every process knows it, and a provider whose live keys are all refused is kept out
of a tooled plan. A code or critical task whose own legs are gone goes to CliMayte before any lower-profile rescue leg.

Each test fails on the code before the fix: before, the refusal lived in one process's memory (_NO_TOOL_KEYS), planning
offered the provider to tool work, and the walk went to the rescue legs without asking CliMayte."""
from __future__ import annotations

import json

from hswarm import client as _client
from hswarm import config, dispatch, keystate, selection
from hswarm.client import KeyPool
from hswarm.spec import Task

K = ["sk-test-alpha-0001", "sk-test-bravo-0002"]


def test_a_refused_key_is_remembered_across_a_restart(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "KEYS_STATE", tmp_path / "keys.json")
    before_restart = KeyPool(K, "inworld")
    before_restart.mark_tools_refused(K[0])
    after_restart = KeyPool(K, "inworld")  # a new process: it loads the shared state at start
    assert after_restart.tools_refused_keys() == {K[0]}
    assert after_restart.tools_refused_all() is False  # K[1] still takes tool calls
    assert K[0] not in json.dumps(keystate.read_all())  # the fingerprint is stored, never the key
    assert config.fingerprint(K[0]) in json.dumps(keystate.read_all())

    monkeypatch.setattr(_client, "TOOLS_REFUSED_S", 0.0)  # past the re-probe window: the key is tried again
    assert KeyPool(K, "inworld").tools_refused_keys() == set()


def test_a_provider_whose_live_keys_are_all_refused_is_kept_out_of_tool_plans(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "KEYS_STATE", tmp_path / "keys.json")
    inworld = KeyPool(K, "inworld")
    inworld.mark_tools_refused(K[0])
    inworld.mark_tools_refused(K[1])
    assert inworld.tools_refused_all() is True
    pools = {"inworld": inworld, "deepseek": KeyPool(["sk-test-charlie-0003"], "deepseek")}
    monkeypatch.setattr(dispatch.keys, "pool_for", lambda p: pools.get(p))
    seen = []

    def fake_plan(profile, *, usable=None, **kw):
        cands = [{"model": "inworld-model", "provider": "inworld"}, {"model": "deepseek-model", "provider": "deepseek"}]
        seen.append(usable)
        return {"profile": profile, "candidates": [c for c in cands if usable is None or usable(c["provider"])]}

    monkeypatch.setattr(selection, "plan", fake_plan)
    wake = lambda p: 0.0  # noqa: E731 - every pool can take a request now; only the tool refusal can keep one out
    tooled = dispatch._plan_here("code", min_context=0, wake=wake, tools="all")
    assert [c["provider"] for c in tooled["candidates"]] == ["deepseek"]
    free = dispatch._plan_here("code", min_context=0, wake=wake, tools="none")
    assert [c["provider"] for c in free["candidates"]] == ["inworld", "deepseek"]
    assert dispatch._why_not("inworld", wake, tooled=True) == "no live key's plan allows tool calls"


def _code_task(tmp_path, tools):
    t = Task(id="t", prompt="do", cwd=str(tmp_path), tools=tools, max_turns=10)
    t.profile = "code"
    t.route = True
    return t


def test_a_tooled_code_plan_puts_climayte_ahead_of_every_rescue_leg(tmp_path, monkeypatch):
    from hswarm import climayte_route

    monkeypatch.setattr(dispatch, "_pressure", lambda provider, gates=None: 0.0)
    monkeypatch.setattr(climayte_route, "can_take", lambda task: True)
    own = [{"model": "own-a", "provider": "nvidia"}]
    rescue = [{"model": "general-1", "provider": "groq", "rescue": "general"},
              {"model": "general-2", "provider": "baseten", "rescue": "general"}]
    plan = {"profile": "code", "candidates": own}

    _, legs, _ = dispatch._ordered(plan, _code_task(tmp_path, "all"), None, rescue)
    names = [c["model"] for c in legs]
    assert names == ["own-a", dispatch.CLIMAYTE_LEG, "general-1", "general-2"]

    # Tool-free and general work keep their plan exactly: no CliMayte leg is added.
    _, free_legs, _ = dispatch._ordered(plan, _code_task(tmp_path, "none"), None, rescue)
    assert [c["model"] for c in free_legs] == ["own-a", "general-1", "general-2"]
    general = _code_task(tmp_path, "all")
    general.profile = "general"
    _, gen_legs, _ = dispatch._ordered(plan, general, None, rescue)
    assert [c["model"] for c in gen_legs] == ["own-a", "general-1", "general-2"]
