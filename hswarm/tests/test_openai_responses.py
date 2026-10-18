"""The api backend's OpenAI transport (openai_responses, ChatClient): OpenAI's Chat Completions refuses function tools
beside reasoning_effort, so on 2026-10-13 the code profile had no live route while 82 OpenAI keys served only
tool-free asks. The Responses API takes both."""
import asyncio
import json

import httpx

from hswarm.client import ChatClient

MODEL = "rank:gpt-6-sol-high:openai"
TOOLS = [{"type": "function", "function": {"name": "read_file", "description": "Read a file.",
                                           "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}}}]


def test_a_gpt6_task_calls_tools_at_its_effort_through_the_responses_api():
    """Contract: every turn of a tool-using GPT-6 task goes to /v1/responses carrying its tools AND its reasoning
    effort (the pair Chat Completions refuses); the transcript's tool call and its result go back as a function_call
    and a function_call_output under the same call_id, the system prompt as `instructions`; a function_call in the
    reply comes back as the OpenAI tool call the worker loop reads, and cached input is a hit."""
    sent: list[httpx.Request] = []

    def reply(req: httpx.Request) -> httpx.Response:
        sent.append(req)
        return httpx.Response(200, json={
            "status": "completed",
            "output": [{"type": "reasoning", "summary": []},
                       {"type": "function_call", "call_id": "call_2", "name": "read_file", "arguments": '{"path": "b.txt"}'}],
            "usage": {"input_tokens": 1000, "input_tokens_details": {"cached_tokens": 800}, "output_tokens": 40,
                      "output_tokens_details": {"reasoning_tokens": 30}}})

    client = ChatClient(api_keys=["sk-test-a"], provider="openai")
    client._http = httpx.AsyncClient(base_url="https://api.openai.com/v1", transport=httpx.MockTransport(reply))
    messages = [{"role": "system", "content": "You are a worker."}, {"role": "user", "content": "Read a.txt"}]

    async def two_turns():
        await client.chat(messages, model=MODEL, tools=TOOLS, affinity="job:t1")
        messages.append({"role": "assistant", "content": "", "tool_calls": [
            {"id": "call_1", "type": "function", "function": {"name": "read_file", "arguments": '{"path": "a.txt"}'}}]})
        messages.append({"role": "tool", "tool_call_id": "call_1", "content": "hello"})
        r = await client.chat(messages, model=MODEL, tools=TOOLS, affinity="job:t1")
        await client.aclose()
        return r

    r = asyncio.run(two_turns())
    assert [q.url.path for q in sent] == ["/v1/responses"] * 2
    body = json.loads(sent[1].content)
    assert body["reasoning"] == {"effort": "high"} and body["store"] is False
    assert body["tools"] == [{"type": "function", "name": "read_file", "strict": False, "description": "Read a file.",
                              "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}}]
    assert body["instructions"] == "You are a worker."
    assert body["input"] == [
        {"role": "user", "content": [{"type": "input_text", "text": "Read a.txt"}]},
        {"type": "function_call", "call_id": "call_1", "name": "read_file", "arguments": '{"path": "a.txt"}'},
        {"type": "function_call_output", "call_id": "call_1", "output": "hello"}]
    assert "temperature" not in body and "stop" not in body
    assert r.finish_reason == "tool_calls"
    assert r.message["tool_calls"] == [{"id": "call_2", "type": "function",
                                        "function": {"name": "read_file", "arguments": '{"path": "b.txt"}'}}]
    assert (r.usage.hit, r.usage.miss, r.usage.out) == (800, 200, 40)


# Contract: each OpenAI route asks for the effort its benchmark point was measured at, read from the point's own name
# ("GPT-6 Sol (max)", "GPT-6 Sol (high)"). Regression: 2026-10-13, the max-scored routes named no effort, so OpenAI
# ran them at its default, medium (probed), and the transport dropped "max" even when a task asked for it.
def test_every_openai_route_asks_for_the_effort_its_benchmark_point_names():
    import re

    from hswarm import config
    from hswarm.selection import evidence

    names = {p["slug"]: p["name"] for p in evidence()["points"]}
    routes = [m for m, spec in config.MODELS.items() if spec["provider"] == "openai" and spec.get("benchmark_slug")]
    assert len(routes) >= 7
    for model in routes:
        sent: list[dict] = []

        def reply(req: httpx.Request) -> httpx.Response:
            sent.append(json.loads(req.content))
            return httpx.Response(200, json={"status": "completed", "output": [
                {"type": "message", "content": [{"type": "output_text", "text": "ok"}]}], "usage": {"input_tokens": 1, "output_tokens": 1}})

        client = ChatClient(api_keys=["sk-test-a"], provider="openai")
        client._http = httpx.AsyncClient(base_url="https://api.openai.com/v1", transport=httpx.MockTransport(reply))
        asyncio.run(client.chat([{"role": "user", "content": "hi"}], model=model))
        measured = re.search(r"\((\w+)\)\s*$", names[config.MODELS[model]["benchmark_slug"]]).group(1).lower()
        assert (sent[0].get("reasoning") or {}).get("effort") == measured, model
