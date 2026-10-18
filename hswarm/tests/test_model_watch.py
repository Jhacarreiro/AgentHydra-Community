"""model_watch: id normalization, each model's standing, the strengths and weaknesses rule, and a scan in which one
provider fails while the others still record."""
from __future__ import annotations

import asyncio

import pytest

from hswarm import aa_index, client, model_watch


@pytest.mark.parametrize("raw, want", [
    ("GLM-5.3", "glm-5-3"),
    ("GLM-5.3-Flash", "glm-5-3-flash"),
    ("DeepSeek-V4.1-Flash", "deepseek-v4-1-flash"),
    ("DeepSeek-V4-Pro-0813", "deepseek-v4-pro"),
    ("Qwen3.8-27B-TEE", "qwen3-8-27b"),
    ("MiMo-V2.6-Pro-RL", "mimo-v2-6-pro"),
    ("Kimi-K3-TEE", "kimi-k3"),
    ("MiniMax-M3", "minimax-m3"),
    ("gpt-oss-120b", "gpt-oss-120b"),
    ("openai/gpt-6-astra", "gpt-6-astra"),
    ("gpt-6-astra-high", "gpt-6-astra-high"),
    ("  Example-Model-5.5  ", "example-model-5-5"),
])
def test_normalize_matches_the_provider_and_index_forms(raw, want):
    assert model_watch.normalize(raw) == want


def test_ids_of_takes_a_bare_list_or_a_data_object_and_drops_repeats():
    assert model_watch.ids_of(["example-a", {"id": "example-b"}, "example-a"]) == ["example-a", "example-b"]
    assert model_watch.ids_of({"data": [{"id": "example-c"}]}) == ["example-c"]
    assert model_watch.ids_of({"error": "nope"}) == []


ROUTES = {
    "example-route": {"provider": "example-a", "api_id": "Example-Alpha-1"},
    "rank:example-beta:example-b": {"provider": "example-b", "api_id": "example-beta-x", "benchmark_slug": "example-beta"},
    # Hugging Face's router pins a backend after a colon and lists the bare model id
    "rank:example-alpha:example-hf": {"provider": "example-hf", "api_id": "org/Example-Alpha:some-backend"},
}
POINTS = [{"slug": "example-alpha"}, {"slug": "example-beta"}]


def test_standing_follows_the_route_and_the_index():
    slugs = model_watch.index_slugs(POINTS)
    routed = model_watch.routed_for("example-a", ROUTES)
    assert model_watch.classify("example-alpha-1-TEE", routed, slugs) == "routed"
    assert model_watch.classify("example-alpha", routed, slugs) == "benchmarked_unrouted"
    assert model_watch.classify("example-gamma", routed, slugs) == "unbenchmarked"
    assert model_watch.classify("example-beta-x", model_watch.routed_for("example-b", ROUTES), slugs) == "routed"
    # a route on another provider serves nothing on this one
    assert model_watch.classify("example-alpha-1", model_watch.routed_for("example-c", ROUTES), slugs) == "unbenchmarked"
    assert model_watch.classify("org/Example-Alpha", model_watch.routed_for("example-hf", ROUTES), slugs) == "routed"


def test_merge_keeps_first_seen_and_marks_what_stopped_being_listed_gone():
    before = {"a": {"first_seen": "t1", "last_seen": "t1", "standing": "unbenchmarked"},
              "b": {"first_seen": "t1", "last_seen": "t1", "standing": "routed"}}
    out = model_watch.merge(before, {"a": "routed", "c": "unbenchmarked"}, "t2")
    assert out["a"] == {"first_seen": "t1", "last_seen": "t2", "standing": "routed"}
    assert out["c"] == {"first_seen": "t2", "last_seen": "t2", "standing": "unbenchmarked"}
    assert out["b"] == {"first_seen": "t1", "last_seen": "t1", "standing": "gone"}


def test_strengths_and_weaknesses_use_the_index_quartiles():
    # bench-x runs 1..5 over the index: its 25th percentile is 2 and its 75th is 4. critpt is under review and must not
    # count, though counted it would make p5 a weakness. bench-y has three scores, so it ranks nothing.
    points = [{"slug": f"p{i}", "scores": {"bench-x": float(i), "critpt": float(6 - i)}} for i in range(1, 6)]
    points[0]["scores"]["bench-y"] = 0.0
    points[1]["scores"]["bench-y"] = 50.0
    points[4]["scores"]["bench-y"] = 100.0
    points[4].update(input=8.0, output=4.0)
    out = model_watch.profile(points)
    assert out["p5"] == {"strengths": ["bench-x"], "weaknesses": [], "blended_usd_per_1m": 7.0}
    assert out["p1"] == {"strengths": [], "weaknesses": ["bench-x"], "blended_usd_per_1m": None}
    assert out["p3"] == {"strengths": [], "weaknesses": [], "blended_usd_per_1m": None}



def test_a_newer_routed_model_of_the_same_maker_supersedes_an_older_one(monkeypatch):
    # Owner, 2026-10-10: route the newer models a provider serves, skip the ones a newer routed version beats. Only the
    # same maker, released later and scoring higher, supersedes; Artificial Analysis's "Kimi" is Moonshot AI.
    points = [
        {"slug": "example-alpha-2", "creator": "Example Labs", "release_date": "2026-08-01", "score": 40.0},
        {"slug": "example-alpha-1", "creator": "Example Labs", "release_date": "2026-05-01", "score": 30.0},
        {"slug": "example-alpha-3", "creator": "Example Labs", "release_date": "2026-09-01", "score": 35.0},
        {"slug": "example-beta-1", "creator": "Other Labs", "release_date": "2026-01-01", "score": 10.0},
        {"slug": "kimi-k3", "creator": "Moonshot AI", "release_date": "2026-07-16", "score": 43.6},
        {"slug": "kimi-k2-6", "creator": "Kimi", "release_date": "2026-04-20", "score": 27.0},
    ]
    monkeypatch.setattr(model_watch, "evidence", lambda: {"points": points})
    standings = {"Example-Alpha-2": "routed", "Example-Alpha-1": "benchmarked_unrouted", "Example-Alpha-3": "benchmarked_unrouted",
                 "Example-Beta-1": "benchmarked_unrouted", "moonshotai/Kimi-K3": "routed", "moonshotai/Kimi-K2.6": "benchmarked_unrouted"}
    state = {"scanned_at": "t", "providers": {"example-a": {"models": {m: {"first_seen": "t0", "standing": s} for m, s in standings.items()}},
                                               "example-b": {"models": {"Example-Alpha-1": {"first_seen": "t0", "standing": "benchmarked_unrouted"}}}}}
    row = model_watch.digest(state)["providers"]["example-a"]
    assert row["superseded"] == [{"id": "Example-Alpha-1", "slug": "example-alpha-1", "by": "example-alpha-2"},
                                 {"id": "moonshotai/Kimi-K2.6", "slug": "kimi-k2-6", "by": "kimi-k3"}]
    assert [r["id"] for r in row["benchmarked_unrouted"]] == ["Example-Alpha-3", "Example-Beta-1"]
    # nothing newer is routed on another provider, so the same model still asks for a route there
    assert [r["id"] for r in model_watch.digest(state)["providers"]["example-b"]["benchmarked_unrouted"]] == ["Example-Alpha-1"]

class FakeClient:
    answers: dict = {}

    def __init__(self, provider: str):
        self.provider = provider
        self.spec = {"models_path": "/models"}

    async def get_json(self, path: str):
        answer = FakeClient.answers[self.provider]
        if isinstance(answer, Exception):
            raise answer
        return answer

    async def aclose(self) -> None:
        return None


def test_a_failing_provider_is_recorded_and_hides_none_of_the_others(monkeypatch):
    monkeypatch.setattr(client, "DeepSeekClient", FakeClient)
    monkeypatch.setattr(aa_index, "scored_unindexed", lambda providers: [])
    FakeClient.answers = {"example-a": RuntimeError("HTTP 503"), "example-b": [{"id": "example-gamma"}, "Example-Delta-TEE"]}
    first = asyncio.run(model_watch.scan(["example-a", "example-b"]))
    assert first["providers"]["example-a"]["error"] == "RuntimeError: HTTP 503"
    assert first["providers"]["example-b"]["error"] is None
    assert first["providers"]["example-b"]["new"] == ["Example-Delta-TEE", "example-gamma"]
    assert "example-gamma" in first["providers"]["example-b"]["unbenchmarked"]

    # A failed scan keeps the table it had (a provider down is not a provider that stopped serving), and a model
    # that is no longer listed is gone.
    FakeClient.answers = {"example-a": RuntimeError("HTTP 503 again"), "example-b": []}
    asyncio.run(model_watch.scan(["example-a", "example-b"]))
    stored = model_watch.load()
    assert stored["providers"]["example-b"]["models"]["example-gamma"]["standing"] == "gone"
    assert stored["providers"]["example-a"]["error"] == "RuntimeError: HTTP 503 again"
    assert "Example-Delta-TEE" in stored["providers"]["example-b"]["models"]
    assert "failing: example-a" in model_watch.summary()
