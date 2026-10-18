"""Offline: the Free A/B tool (free_ab.py) on synthetic jobs, answers and judge files. No network, throwaway HOME."""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import config, free_ab, free_route  # noqa: E402
from hswarm.spec import Task  # noqa: E402


def _job(jobs: Path, name: str, tasks: list[dict], results: dict) -> None:
    d = jobs / name
    d.mkdir(parents=True)
    (d / "job.json").write_text(json.dumps({"tasks": tasks, "results": results}), encoding="utf-8")


def _task(tid: str, cwd: Path, prompt: str, profile="critical", tools="read", **kw) -> dict:
    return {"id": tid, "cwd": str(cwd), "prompt": prompt, "profile": profile, "tools": tools, "backend": "api", **kw}


def _ok(answer="API answer") -> dict:
    return {"status": "ok", "model": "api-model", "answer": answer, "seconds": 3, "cost_usd": 0.01}


def test_pick_keeps_ok_api_answers_of_the_profile_with_free_tools_and_drops_duplicates(tmp_path):
    jobs = config.JOBS_DIR
    cwd = tmp_path / "proj"
    cwd.mkdir()
    _job(jobs, "j1", [
        _task("a", cwd, "keep me"),
        _task("b", cwd, "keep me"),                          # duplicate prompt
        _task("c", cwd, "wrong profile", profile="code"),
        _task("d", cwd, "shell tools", tools="all"),
        _task("e", cwd, "failed on api"),
        _task("f", cwd, "answered by free"),
        _task("g", cwd, "no tools", tools="none"),
    ], {"a": _ok(), "b": _ok(), "c": _ok(), "d": _ok(), "e": {"status": "error"}, "g": _ok(),
        "f": {**_ok(), "selection": {"route": {"via": "free"}}}})
    got = free_ab.pick("critical", "read", n=10)
    assert [c["task"]["prompt"] for c in got] == ["keep me"]
    assert got[0]["api"]["answer"] == "API answer"


def _rep_inputs(wins: dict, errors=(0, 0)):
    """Arm rows + key + judge doc where each task's Free answer is side A and the judge names the winner."""
    rows, key, results, i = [], {}, {}, 0
    for who, count in wins.items():
        for _ in range(count):
            rows.append({"i": i, "profile": "critical", "tools": "read", "wall_s": 5.0,
                         "api": {"seconds": 2, "cost_usd": 0.01},
                         "free": {"model": "m", "turns": 3, "status": "ok"}})
            key[f"j{i}"] = {"i": i, "free_is": "A"}
            w = {"free": "A", "api": "B", "tie": "tie"}[who]
            results[f"j{i}"] = {"status": "ok", "model": "judge", "data": {
                "winner": w, "a_score": 7, "b_score": 6, "a_errors": 0, "b_errors": 0, "why": "x"}}
            i += 1
    if rows:
        results["j0"]["data"]["a_errors"], results["j0"]["data"]["b_errors"] = errors
    return rows, key, {"results": results}


def test_report_tallies_the_judge_file():
    rows, key, doc = _rep_inputs({"free": 3, "api": 2, "tie": 1})
    rep = free_ab.report(rows, key, doc)
    assert rep["tally"] == {"free": 3, "api": 2, "tie": 1}
    assert rep["judged"] == 6 and rep["served_on_free"] == 6
    assert rep["by_stratum"]["critical/read"]["free"] == 3
    assert rep["mean_score"] == {"free": 7.0, "api": 6.0}


def test_verdict_at_the_45_percent_edge():
    # 9 of 20 = 45% holds; 8 of 20 = 40% loses
    holds = free_ab.report(*_rep_inputs({"free": 8, "tie": 1, "api": 11}))
    loses = free_ab.report(*_rep_inputs({"free": 7, "tie": 1, "api": 12}))
    assert free_ab.verdict(holds).startswith("holds level")
    assert free_ab.verdict(loses).startswith("loses")


def test_verdict_loses_when_free_errors_exceed_the_apis():
    rep = free_ab.report(*_rep_inputs({"free": 10, "api": 10}, errors=(4, 1)))
    assert free_ab.verdict(rep).startswith("loses")


def test_judge_builder_shuffles_deterministically_and_never_names_the_free_answer(tmp_path):
    cands, arm = [], []
    for i in range(12):
        t = _task(f"t{i}", tmp_path, f"prompt {i}")
        cands.append({"job": "j", "task": t, "api": {}})
        arm.append({"i": i, "job": "j", "id": f"t{i}", "api": {"answer": f"OMEGA-TEXT-{i}"},
                    "free": {"status": "ok", "answer": f"ALPHA-TEXT-{i}"}})
    tasks, key = free_ab.build_judge(arm, cands)
    again, key2 = free_ab.build_judge(arm, cands)
    assert key == key2 and tasks == again
    assert {k["free_is"] for k in key.values()} == {"A", "B"}
    for t in tasks:
        i = t["id"][1:]
        p = t["prompt"]
        free_side = key[t["id"]]["free_is"]
        first, second = ("ALPHA", "OMEGA") if free_side == "A" else ("OMEGA", "ALPHA")
        assert p.index(f"{first}-TEXT-{i}") < p.index(f"{second}-TEXT-{i}")
        assert "Free" not in p and "free" not in p.lower().replace("freely", "")
        assert t["profile"] == "critical" and t["tools"] == "read"
        assert not free_route.eligible(Task.from_dict(t, {}, 0))  # a judge never runs on the Free route it grades


def test_compare_counts_only_the_tasks_every_arm_served():
    a = _rep_inputs({"free": 2, "api": 2})            # tasks 0-3, all served
    b = _rep_inputs({"free": 3, "api": 1})
    del b[0][3]["free"]                                # arm b did not serve task 3 (judged as an api win in arm a)
    out = free_ab.compare({"a": a, "b": b})
    assert out["paired"] == 3
    assert out["arms"]["a"]["tally"] == {"free": 2, "api": 1, "tie": 0}
    assert out["arms"]["b"]["tally"] == {"free": 3, "api": 0, "tie": 0}
    assert out["arms"]["a"]["only_this_arm_served"] == 1 and out["arms"]["b"]["only_this_arm_served"] == 0
