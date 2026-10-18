"""OpenAI's Responses API for the `api` backend: what a provider with `transport = "openai-responses"` speaks.

WHY: HSwarm's `code` profile (tool-using edit tasks) had no live route although 82 OpenAI keys worked (2,017
ok tool-free calls in two days, measured 2026-10-13). `hswarm/providers/openai.toml` marked every GPT-6 route
`tools = false` because OpenAI's Chat Completions endpoint accepts function tools only at reasoning_effort "none"
(a 400 otherwise). OpenAI's Responses API (POST /v1/responses) accepts function tools together with
`reasoning: {effort}`, so a GPT-6 route can now carry tools at any effort.

The worker loop keeps speaking OpenAI chat. This module turns one OpenAI-shaped request into a Responses
request body and the reply back into an OpenAI-shaped assistant message, so agent.py, the ledger and failover
see no difference.
"""
from __future__ import annotations


from .usage import Usage

PATH = "/responses"
# The effort levels the Responses API's `reasoning.effort` accepts. Anything else a caller sends is left out,
# so the model's default runs.
# "max" too: GPT-6 takes it (probed 2026-10-13: echoed back, as the GPT-6 benchmark points were measured), and an effort
# left out of this list is dropped, which runs the model at its default, medium.
EFFORTS = ("none", "minimal", "low", "medium", "high", "xhigh", "max")


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    return "".join(p.get("text") or "" for p in content or [] if isinstance(p, dict) and p.get("type", "text") == "text")


def _input_items(messages: list[dict]) -> tuple[str, list[dict]]:
    """(instructions text, input items). System/developer messages hoist to top-level `instructions`, joined
    with blank lines; the rest become role-tagged input items in order."""
    instructions: list[str] = []
    items: list[dict] = []
    for m in messages:
        role = m.get("role")
        if role in ("system", "developer"):
            if text := _text_of(m.get("content")):
                instructions.append(text)
            continue
        if role == "assistant":
            if text := _text_of(m.get("content")):
                items.append({"role": "assistant", "content": [{"type": "output_text", "text": text}]})
            for call in m.get("tool_calls") or ():
                fn = call.get("function") or {}
                items.append({"type": "function_call", "call_id": str(call.get("id") or ""),
                              "name": str(fn.get("name") or ""), "arguments": str(fn.get("arguments") or "")})
            continue
        if role == "tool":
            items.append({"type": "function_call_output", "call_id": str(m.get("tool_call_id") or ""),
                          "output": _text_of(m.get("content"))})
            continue
        # user (and any unmapped role): text -> input_text, image_url -> input_image
        content = m.get("content")
        if isinstance(content, str):
            if content:
                items.append({"role": "user", "content": [{"type": "input_text", "text": content}]})
            continue
        parts: list[dict] = []
        for p in content or []:
            if not isinstance(p, dict):
                continue
            if p.get("type", "text") == "text" and p.get("text"):
                parts.append({"type": "input_text", "text": p["text"]})
            elif p.get("type") == "image_url":
                url = str(((p.get("image_url") or {}).get("url")) or "")
                if url:
                    parts.append({"type": "input_image", "image_url": url})
        if parts:
            items.append({"role": "user", "content": parts})
    return "\n\n".join(instructions), items


def _tools(tools: list[dict] | None) -> list[dict]:
    out = []
    for t in tools or ():
        fn = t.get("function") or t
        spec = {"type": "function", "name": fn.get("name"), "strict": False,
                "parameters": fn.get("parameters") or {"type": "object", "properties": {}}}
        if fn.get("description"):
            spec["description"] = fn["description"]
        out.append(spec)
    return out


def _tool_choice(tool_choice) -> dict | str | None:
    if tool_choice in ("none", "auto", "required", None):
        return tool_choice
    if isinstance(tool_choice, dict):
        fn = tool_choice.get("function") or {}
        name = fn.get("name") or (tool_choice.get("name"))
        if name:
            return {"type": "function", "name": name}
    return None


def responses_request(api_id: str, messages: list[dict], *, tools: list[dict] | None = None, tool_choice=None,
                      max_tokens: int | None = None, reasoning_effort: str | None = None,
                      response_format: dict | None = None) -> dict:
    """One OpenAI-shaped chat call as a Responses request body.

    Not sent: `temperature` and `stop` (reasoning models refuse them). `store` is always False: hswarm keeps its
    own transcripts and never relies on the provider's stored ones.
    """
    instructions, items = _input_items(messages)
    body: dict = {"model": api_id, "input": items, "store": False}
    if instructions:
        body["instructions"] = instructions
    if spec := _tools(tools):
        body["tools"] = spec
    if (choice := _tool_choice(tool_choice)) is not None:
        body["tool_choice"] = choice
    if max_tokens:
        body["max_output_tokens"] = int(max_tokens)
    if reasoning_effort in EFFORTS:
        body["reasoning"] = {"effort": reasoning_effort}
    if response_format:
        if response_format.get("type") == "json_schema":
            schema = response_format.get("json_schema") or {}
            body["text"] = {"format": {"type": "json_schema", "name": schema.get("name"),
                                       "schema": schema.get("schema"), "strict": schema.get("strict", False)}}
        elif response_format.get("type") == "json_object":
            body["text"] = {"format": {"type": "json_object"}}
    return body


def chat_message(data: dict) -> tuple[dict, str]:
    """A Responses reply as (the OpenAI-shaped assistant message, its finish_reason). Reasoning items are dropped."""
    texts: list[str] = []
    calls: list[dict] = []
    for item in data.get("output") or ():
        if not isinstance(item, dict):
            continue
        itype = item.get("type")
        if itype == "message":
            for part in item.get("content") or ():
                if isinstance(part, dict) and part.get("type") == "output_text" and part.get("text"):
                    texts.append(part["text"])
        elif itype == "function_call":
            calls.append({"id": item.get("call_id"), "type": "function",
                          "function": {"name": item.get("name"), "arguments": item.get("arguments") or ""}})
        # reasoning items (and any other) are dropped
    message: dict = {"role": "assistant", "content": "\n".join(texts)}
    if calls:
        message["tool_calls"] = calls
    finish = "stop"
    if calls:
        finish = "tool_calls"
    elif data.get("status") == "incomplete" and (data.get("incomplete_details") or {}).get("reason") == "max_output_tokens":
        finish = "length"
    return message, finish


def usage(u: dict | None) -> Usage:
    """Responses usage as hswarm's counters. `input_tokens_details.cached_tokens` is the cache hit; the rest of
    `input_tokens` is the miss. `output_tokens_details.reasoning_tokens` is the reasoning output."""
    u = u or {}
    details_in = u.get("input_tokens_details") or {}
    details_out = u.get("output_tokens_details") or {}
    hit = int(details_in.get("cached_tokens") or 0)
    miss = max(0, int(u.get("input_tokens") or 0) - hit)
    return Usage(hit=hit, miss=miss, out=int(u.get("output_tokens") or 0),
                 reasoning=int(details_out.get("reasoning_tokens") or 0))