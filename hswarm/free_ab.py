"""Measure a Free-account model against the API route before any work is routed to it.

Why (owner, 2026-10-13): keep the Free accounts on current models. A new model gets measured on real, recent
HSwarm tasks first; only a model that holds level with the API answers gets routed work.

The four commands, in order (all state lives under ~/.hswarm/free-ab/<run>/, never in the repo):

  python -m hswarm.free_ab pick   --profile critical [--tools read] [--n 30] [--skip 0] [--run NAME]
      -> candidates.jsonl: recent tasks of that profile whose tools are all Free-allowed, that the API route
         answered ok, each with its API answer (duplicate prompts dropped, fixed-seed sample).
  python -m hswarm.free_ab arm    --run NAME --model luna-thinking [--provider chatgpt|claude] [--check-reads 8] [--conc 20]
                                  [--check] [--label NAME]
      -> arm_<label or model>.jsonl: each candidate through the Free tool route, every new thread asking for that model
         (any free_chat name: gpt-instant, gpt-thinking, gpt-auto, luna-thinking, or a slug). --check asks every ChatGPT
         thread that answers early to check its claims (the claim check route_via_free_check_profiles turns on per
         profile); without it the profile's own setting applies. --label names the arm, to run one model twice.
  python -m hswarm.free_ab judge  --run NAME --arm luna-thinking [--budget 20]
      -> judge_tasks_<model>.json, then `hswarm run` on it: a blind critical-profile worker with the task's own
         tools grades the two answers, shown in random order as A/B.
  python -m hswarm.free_ab report --run NAME [--arm luna-thinking]
      -> JSON tally per arm and a verdict line: 'holds level' (win+tie share >= 45% and judged errors not above
         the API's) or 'loses'.
  python -m hswarm.free_ab compare --run NAME --arms gpt-5-6-mini gpt-6-mini
      -> the arms side by side on only the tasks every arm served, and what each arm lost to the API route. Use it to
         ask "is the new model better than the one we use": two arms' own tallies cover different tasks, and the
         same API answers scored 7.44 in one judge run and 6.69 in another (2026-10-13), so compare paired.

How the 2026-10-13 numbers were made: this flow, as three scratch scripts. Luna Thinking scored 13 free wins,
15 API wins, 1 tie on 29 judged critical read tasks, and 7-5 on code read.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import os
import random
import shutil
import subprocess
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

from . import blobs, config
from .toolspecs import tool_names

CAP = 30_000
HOLDS_LEVEL_SHARE = 0.45
READ_TOOLS = {"read_file", "list_dir", "glob", "grep", "outline", "unfold", "fetch_output"}
WEB_TOOLS = READ_TOOLS | {"read_url", "web_search"}
FAIRJOB = Path.home() / ".claude" / "tools" / "fairjob.cmd"

SCHEMA = {"type": "object", "required": ["winner", "a_score", "b_score", "a_errors", "b_errors", "why"], "properties": {
    "winner": {"type": "string", "enum": ["A", "B", "tie"]},
    "a_score": {"type": "integer", "minimum": 0, "maximum": 10},
    "b_score": {"type": "integer", "minimum": 0, "maximum": 10},
    "a_errors": {"type": "integer", "minimum": 0, "description": "claims in answer A that the files or pages contradict, or quotes not found there"},
    "b_errors": {"type": "integer", "minimum": 0},
    "why": {"type": "string", "maxLength": 400}}}


def run_dir(run: str) -> Path:
    return config.HOME / "free-ab" / run


def _slug(model: str) -> str:
    return "".join(c if c.isalnum() or c in "-_." else "_" for c in model)


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines() if x.strip()]


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows), encoding="utf-8", newline="")


# ---- pick ----

def pick(profile: str, tools: str | None = None, n: int = 30, skip: int = 0, jobs_dir: Path | None = None,
         scan: int = 6000) -> list[dict]:
    """Recent real tasks of one profile with Free-allowed tools that the API answered ok, newest jobs first scanned."""
    jobs = jobs_dir or config.JOBS_DIR
    allowed = WEB_TOOLS if tools == "web" else READ_TOOLS
    picked: list[dict] = []
    for j in sorted(os.listdir(jobs) if jobs.is_dir() else [])[-scan:]:
        jd = jobs / j
        try:
            doc = json.loads((jd / "job.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        doc = blobs.expand(doc, blobs.blob_dir(jd))
        results = dict(doc.get("results") or {})
        for row in _read_jsonl(jd / "results.jsonl") if (jd / "results.jsonl").exists() else ():
            if isinstance(row, dict) and row.get("id"):
                results[row["id"]] = blobs.expand(row, blobs.blob_dir(jd))
        for t in doc.get("tasks") or []:
            if t.get("tools") in (None, "none") or t.get("profile") != profile:
                continue
            if tools and str(t.get("tools")) != tools:
                continue
            try:
                names = set(tool_names(t.get("tools")))
            except Exception:
                continue
            if not names or not names <= allowed or t.get("zdr") or t.get("purpose") == "evaluation" or t.get("backend") != "api":
                continue
            r = results.get(t.get("id")) or {}
            via = ((r.get("selection") or {}).get("route") or {}).get("via")
            if r.get("status") != "ok" or via in ("free", "climayte") or str(r.get("model", "")).startswith("free:"):
                continue
            if not t.get("cwd") or not Path(t["cwd"]).is_dir():
                continue
            picked.append({"job": j, "task": t, "api": {k: r.get(k) for k in (
                "model", "answer", "data", "cost_usd", "seconds", "turns", "tool_calls", "status")}})
    rnd = random.Random(7)
    rnd.shuffle(picked)
    out, seen = [], set()
    for c in picked:
        if c["task"]["prompt"] in seen:
            continue
        seen.add(c["task"]["prompt"])
        if len(seen) > skip:
            out.append(c)
        if len(seen) == skip + n:
            break
    return out


def cmd_pick(a) -> int:
    cands = pick(a.profile, a.tools, a.n, a.skip)
    path = run_dir(a.run) / "candidates.jsonl"
    _write_jsonl(path, cands)
    print(f"picked {len(cands)} -> {path}")
    return 0 if cands else 1


# ---- arm ----

async def _arm_one(run: str, model: str, i: int, r: dict, stamp: str, label: str | None = None) -> dict:
    from . import free_route
    from .spec import Task
    task = Task.from_dict(dict(r["task"]), {}, 0)
    task.profile = r["task"]["profile"]
    t0 = time.monotonic()
    waited = 0.0
    while True:
        tag = hashlib.sha256(model.encode()).hexdigest()[:6]  # gpt-6 and gpt-6-thinking share any short prefix
        res, note = await free_route.consult(f"ab{tag}{stamp}-{i}", task)
        infra = "free accounts unavailable" in str((note or {}).get("error") or "")  # a daemon relaunch, not the model
        if res is not None or (note and not note.get("short") and not infra) or note is None:
            break
        if time.monotonic() - t0 > 2400:
            break
        await asyncio.sleep(15)
        waited += 15
    out = {"i": i, "arm": label or model, "job": r["job"], "id": r["task"]["id"], "profile": task.profile, "tools": r["task"]["tools"],
           "wall_s": round(time.monotonic() - t0 - waited, 1), "waited_s": waited, "note": note, "api": r["api"]}
    if res is not None:
        out["free"] = {"status": res.status, "model": res.model, "answer": res.answer, "data": res.data, "turns": res.turns,
                       "seconds": res.seconds, "tool_calls": res.tool_calls, "route": (res.selection or {}).get("route")}
    print(json.dumps({"i": i, "ok": res is not None, "model": res.model if res else None,
                      "note": (note or {}).get("error") or (note or {}).get("fallback"), "wall_s": out["wall_s"]}),
          file=sys.stderr, flush=True)
    return out


async def _arm(a) -> list[dict]:
    from . import free_client, free_route
    free_client.CHECK_READS = int(a.check_reads)
    config.ROUTE_VIA_FREE_TOOLS = tuple(WEB_TOOLS)
    every = ("routine", "general", "decision", "research", "code", "critical")
    config.ROUTE_VIA_FREE_TOOL_PROFILES = every
    config.ROUTE_VIA_FREE_PROFILES = every
    config.ROUTE_VIA_FREE_TOOL_ASKS = {}
    if a.check:
        config.ROUTE_VIA_FREE_CHECK_PROFILES = every
    orig = free_route._call

    async def _call(name: str, arguments: dict, timeout: float) -> dict:
        if name == "free_chat":
            for it in arguments.get("tasks") or []:
                if "chat_id" not in it:
                    it.pop("model", None)
                    it["model"] = a.model
                    if a.provider:
                        it["provider"] = a.provider
        return await orig(name, arguments, timeout)

    free_route._call = _call
    try:
        rows = _read_jsonl(run_dir(a.run) / "candidates.jsonl")
        stamp = time.strftime("%H%M%S")
        gate = asyncio.Semaphore(int(a.conc))

        async def gated(i, r):
            async with gate:
                return await _arm_one(a.run, a.model, i, r, stamp, a.label)
        return list(await asyncio.gather(*(gated(i, r) for i, r in enumerate(rows))))
    finally:
        free_route._call = orig


def cmd_arm(a) -> int:
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr, format="%(asctime)s %(message)s")
    outs = asyncio.run(_arm(a))
    path = run_dir(a.run) / f"arm_{_slug(a.label or a.model)}.jsonl"
    _write_jsonl(path, outs)
    ok = [o for o in outs if "free" in o]
    print(f"DONE {a.label or a.model}: {len(ok)} of {len(outs)} served on Free; models "
          f"{dict(Counter(o['free']['model'] for o in ok))} -> {path}")
    return 0


# ---- judge ----

def _text_of(side: dict) -> str:
    v = side.get("data") if side.get("data") is not None else side.get("answer")
    t = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, indent=1)
    return t if len(t) <= CAP else t[:CAP] + "\n[... cut ...]"


def _free_is_a(job: str, task_id: str) -> bool:
    """Blind order, seeded per task so a rebuild gives the same A/B."""
    return random.Random(hashlib.sha256(f"{job}/{task_id}".encode()).hexdigest()).random() < 0.5


def build_judge(arm_rows: list[dict], cands: list[dict]) -> tuple[list[dict], dict]:
    tasks_by = {(c["job"], c["task"]["id"]): c["task"] for c in cands}
    tasks, key = [], {}
    for r in arm_rows:
        if "free" not in r or r["free"].get("status") != "ok":
            continue
        t = tasks_by[(r["job"], r["id"])]
        free_a = _free_is_a(r["job"], r["id"])
        a, b = (r["free"], r["api"]) if free_a else (r["api"], r["free"])
        prompt = t["prompt"] if len(t["prompt"]) <= CAP else t["prompt"][:CAP] + "\n[... cut ...]"
        jid = f"j{r['i']}"
        key[jid] = {"i": r["i"], "free_is": "A" if free_a else "B"}
        tasks.append({
            # purpose evaluation keeps the judge off the Free route: critical read work goes there now, and on 2026-10-13
            # 6 of 17 judges of a GPT-6 Thinking arm were Luna Thinking threads grading a Free answer.
            "id": jid, "cwd": t["cwd"], "tools": t["tools"], "web_hosts": t.get("web_hosts") or [], "profile": "critical",
            "purpose": "evaluation",
            "timeout_s": 900, "schema": SCHEMA,
            "prompt": ("Two workers were given the same task and answered it independently. Grade them.\n\n"
                       "Check each answer against the sources yourself with your tools: a claim the files (or pages) contradict, "
                       "or a quote that is not where it says, is an error. Rank by correctness first, then by how completely "
                       "it does what the task asked, then by usefulness. Length is not merit. Say tie only when neither is better.\n\n"
                       f"## The task they were given\n\n{prompt}\n\n## Answer A\n\n{_text_of(a)}\n\n## Answer B\n\n{_text_of(b)}"),
        })
    return tasks, key


def judge_command(tasks_file: Path, out_file: Path, budget: float, label: str) -> list[str]:
    inner = ["hswarm", "run", str(tasks_file), "--out", str(out_file), "--quiet", "--budget", str(budget), "--label", label]
    if FAIRJOB.exists():
        line = subprocess.list2cmdline([sys.executable, "-m", "hswarm", *inner[1:]])
        return [str(FAIRJOB), "-Weight", "1", "-NoLock", "-MinFreeGB", "1", "-Run", line]
    return [sys.executable, "-m", "hswarm", *inner[1:]]


def cmd_judge(a) -> int:
    d, slug = run_dir(a.run), _slug(a.arm)
    tasks, key = build_judge(_read_jsonl(d / f"arm_{slug}.jsonl"), _read_jsonl(d / "candidates.jsonl"))
    tf, kf, out = d / f"judge_tasks_{slug}.json", d / f"judge_key_{slug}.json", d / f"judge_{slug}.json"
    tf.write_text(json.dumps(tasks, ensure_ascii=False), encoding="utf-8", newline="")
    kf.write_text(json.dumps(key), encoding="utf-8", newline="")
    print(f"{len(tasks)} judge tasks -> {tf}")
    if not tasks:
        return 1
    cmd = judge_command(tf, out, a.budget, f"free-ab-judge-{a.run}-{slug}")
    return subprocess.call(cmd)


# ---- report ----

def _median(xs: list) -> float | None:
    xs = sorted(xs)
    return xs[len(xs) // 2] if xs else None


def report(arm_rows: list[dict], key: dict, judge_doc: dict) -> dict:
    rows = {r["i"]: r for r in arm_rows}
    results = judge_doc.get("results") or {}
    tally = {"free": 0, "api": 0, "tie": 0}
    by_stratum: dict = {}
    fs = aps = fe = ae = n = 0
    judge_models: dict = {}
    for jid, k in key.items():
        res = results.get(jid) or {}
        d = res.get("data")
        if res.get("status") != "ok" or not isinstance(d, dict):
            continue
        judge_models[res.get("model")] = judge_models.get(res.get("model"), 0) + 1
        fa = k["free_is"] == "A"
        w = d["winner"]
        who = "tie" if w == "tie" else ("free" if (w == "A") == fa else "api")
        tally[who] += 1
        r = rows[k["i"]]
        by_stratum.setdefault(f"{r['profile']}/{r['tools']}", {"free": 0, "api": 0, "tie": 0})[who] += 1
        fs += d["a_score"] if fa else d["b_score"]
        aps += d["b_score"] if fa else d["a_score"]
        fe += d["a_errors"] if fa else d["b_errors"]
        ae += d["b_errors"] if fa else d["a_errors"]
        n += 1
    served = [r for r in arm_rows if "free" in r]
    return {
        "sampled": len(arm_rows), "served_on_free": len(served),
        "free_misses": [((r.get("note") or {}).get("free_kind"), ((r.get("note") or {}).get("error") or "")[:90])
                        for r in arm_rows if "free" not in r],
        "judged": n, "tally": tally, "by_stratum": by_stratum, "judge_models": judge_models,
        "mean_score": {"free": round(fs / max(n, 1), 2), "api": round(aps / max(n, 1), 2)},
        "errors": {"free": fe, "api": ae},
        "seconds_median": {"free": _median([r["wall_s"] for r in served]),
                           "api": _median([r["api"].get("seconds") or 0 for r in served])},
        "api_cost_usd_of_served": round(sum(r["api"].get("cost_usd") or 0 for r in served), 3),
        "free_models": sorted({r["free"]["model"] for r in served}),
        "free_turns_median": _median([r["free"]["turns"] for r in served]),
    }


def verdict(rep: dict) -> str:
    n = rep["judged"]
    share = (rep["tally"]["free"] + rep["tally"]["tie"]) / n if n else 0.0
    ok = n > 0 and share >= HOLDS_LEVEL_SHARE and rep["errors"]["free"] <= rep["errors"]["api"]
    return f"{'holds level' if ok else 'loses'} (win+tie {share:.0%} of {n} judged, errors free {rep['errors']['free']} vs api {rep['errors']['api']})"


def _judged(d: Path, arm: str) -> tuple[list[dict], dict, dict]:
    slug = _slug(arm)
    return (_read_jsonl(d / f"arm_{slug}.jsonl"), json.loads((d / f"judge_key_{slug}.json").read_text(encoding="utf-8")),
            json.loads((d / f"judge_{slug}.json").read_text(encoding="utf-8")))


def compare(arms: dict[str, tuple[list[dict], dict, dict]]) -> dict:
    """Each arm's report on only the tasks every arm served, and how many tasks each served that another did not."""
    served = {n: {r["i"] for r in rows if "free" in r} for n, (rows, _, _) in arms.items()}
    both = set.intersection(*served.values()) if served else set()
    out = {"paired": len(both), "arms": {}}
    for n, (rows, key, doc) in arms.items():
        rep = report([r for r in rows if r["i"] in both], {k: v for k, v in key.items() if v["i"] in both}, doc)
        out["arms"][n] = {"served": len(served[n]), "only_this_arm_served": len(served[n] - both), "tally": rep["tally"],
                          "mean_score": rep["mean_score"], "errors": rep["errors"], "verdict": verdict(rep)}
    return out


def cmd_compare(a) -> int:
    d = run_dir(a.run)
    try:
        arms = {n: _judged(d, n) for n in a.arms}
    except (OSError, ValueError) as e:
        print(f"not judged yet ({e})", file=sys.stderr)
        return 1
    out = compare(arms)
    print(json.dumps(out, indent=1))
    for n, v in out["arms"].items():
        print(f"{n} on the {out['paired']} tasks every arm served: {v['verdict']}")
    return 0


def cmd_report(a) -> int:
    d = run_dir(a.run)
    arms = [a.arm] if a.arm else sorted(p.stem[len("arm_"):] for p in d.glob("arm_*.jsonl"))
    if not arms:
        print("no arms found", file=sys.stderr)
        return 1
    for arm in arms:
        slug = _slug(arm)
        try:
            key = json.loads((d / f"judge_key_{slug}.json").read_text(encoding="utf-8"))
            doc = json.loads((d / f"judge_{slug}.json").read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            print(f"{arm}: not judged yet ({e})", file=sys.stderr)
            continue
        rep = report(_read_jsonl(d / f"arm_{slug}.jsonl"), key, doc)
        print(json.dumps({"arm": arm, **rep}, indent=1))
        print(f"{arm}: {verdict(rep)}")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m hswarm.free_ab", description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("pick")
    s.add_argument("--profile", required=True)
    s.add_argument("--tools")
    s.add_argument("--n", type=int, default=30)
    s.add_argument("--skip", type=int, default=0)
    s.add_argument("--run", default=time.strftime("%Y%m%d"))
    s.set_defaults(fn=cmd_pick)
    s = sub.add_parser("arm")
    s.add_argument("--run", required=True)
    s.add_argument("--model", required=True)
    s.add_argument("--provider", choices=("chatgpt", "claude"))
    s.add_argument("--check-reads", type=int, default=8)
    s.add_argument("--conc", type=int, default=20)
    s.add_argument("--check", action="store_true")
    s.add_argument("--label")
    s.set_defaults(fn=cmd_arm)
    s = sub.add_parser("judge")
    s.add_argument("--run", required=True)
    s.add_argument("--arm", required=True)
    s.add_argument("--budget", type=float, default=20)
    s.set_defaults(fn=cmd_judge)
    s = sub.add_parser("report")
    s.add_argument("--run", required=True)
    s.add_argument("--arm")
    s.set_defaults(fn=cmd_report)
    s = sub.add_parser("compare")
    s.add_argument("--run", required=True)
    s.add_argument("--arms", nargs="+", required=True)
    s.set_defaults(fn=cmd_compare)
    a = p.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    raise SystemExit(main())
