"""Small authenticated HTTP requests. No browser imports, workers or send retries."""

from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
import re
import time
from uuid import uuid4

import requests

from ..errors import ClaudeError
from ..http import account_email, account_label, valid_uuid
from ..results import code_blocks
from .stream import events
from .preparation import Preparations, account_key

BASE = "https://chatgpt.com"
TEXT_MODEL = "gpt-5-6-mini"
TEXT_MODEL_NAME = "GPT-5.6 Luna"
UNLIMITED_PLANS = {"free", "go", "plus", "pro"}  # paid personal plans include everything in Free
# What --prefer may ask a NEW chat for, when the account offers it (owner, 2026-10-08: "Run whatever trials you want").
# On 2026-10-13 the usage check's model list read the same on a Go and a Free account: GPT-6 (and its Thinking mini and
# mini), GPT-5.6 Luna (and its Thinking mini), GPT-5.5 and older minis. Only Luna's Instant is the verified unlimited
# text, so it stays the default.
#
# Two tables, so a new model needs no code change (owner, 2026-10-13: "in case they release a new 6.1"): PINNED names
# keep the slug routing was measured on; ROLES names resolve per account to the newest model it lists in that role
# (value: the reasoning_type), and any listed slug is sent as itself.
PINNED = {"luna-thinking": "gpt-5-6-t-mini", "gpt-6": "gpt-6", "gpt-6-thinking": "gpt-6-t-mini"}
ROLES = {"gpt-instant": "none", "gpt-thinking": "reasoning", "gpt-auto": "auto"}
SLUG = re.compile(r"gpt-[a-z0-9][a-z0-9.-]{0,38}")
_VERSION = re.compile(r"gpt-(\d+)(?:[.-](\d+))?(?=-|$)")
# ChatGPT sets conv_key_<uuid> (30 days) and history_off_<uuid> (7 days) on every Temporary Chat. Kept and sent
# back, ~370 chats made each account's jar ~62 KB and ChatGPT refused every request in 0.1 s (2026-10-07: all
# three accounts down 16 hours). read() sends its own history_off marker, so only the newest few are kept.
PER_CHAT_COOKIE = re.compile(r"(conv_key|history_off)_[0-9a-fA-F-]{36}")
PER_CHAT_COOKIES_KEPT = 20  # of each family


def prune_per_chat_cookies(cookies):
    """The cookies with only the PER_CHAT_COOKIES_KEPT newest (latest expiry) of each per-chat family."""
    kept, families = [], {}
    for cookie in cookies:
        match = PER_CHAT_COOKIE.fullmatch(cookie.get("name", ""))
        if match:
            families.setdefault(match.group(1), []).append(cookie)
        else:
            kept.append(cookie)
    for family in families.values():
        family.sort(key=lambda c: c.get("expires") or 0, reverse=True)
        kept.extend(family[:PER_CHAT_COOKIES_KEPT])
    return kept


def visible_messages(conversation):
    """Follow the selected branch and allow only visible user/assistant text."""
    result = []
    for message in reversed(_branch(conversation)):
        if isinstance(message, dict):
            visible = _visible_message(message)
            if visible:
                result.append(visible)
    return result


def thread_model(conversation):
    """The model a continued chat is sent on: the one its latest reply came from, when it is one AgentHydra sends, else
    Luna Instant. Before 2026-10-13 every continued message went to Luna Instant, so a thread started on GPT-6 answered
    only its first message there: a Free tool task, whose every tool result is a continued message, ran on Luna mini."""
    for message in reversed(visible_messages(conversation)):
        if message["role"] == "assistant" and message.get("model"):
            sent = message["model"]
            return sent if isinstance(sent, str) and SLUG.fullmatch(sent) else TEXT_MODEL
    return TEXT_MODEL


def roles(listed):
    """{role: slug} for each ROLES name this account resolves: among listed gpt-<major>[-<minor>] slugs of the role's
    reasoning type the highest version wins, and at one version the shorter slug (gpt-6-t-mini over gpt-6-t-mini-mini)."""
    found = {}
    for entry in listed if isinstance(listed, list) else []:
        slug = entry.get("slug") if isinstance(entry, dict) else None
        match = _VERSION.match(slug) if isinstance(slug, str) else None
        if not match:
            continue
        version = (int(match.group(1)), int(match.group(2) or 0))
        for role, kind in ROLES.items():
            if entry.get("reasoning_type") != kind:
                continue
            best = found.get(role)
            if best is None or (version, -len(slug)) > best[0]:
                found[role] = ((version, -len(slug)), slug)
    return {role: pair[1] for role, pair in found.items()}


def _slugs(listed):
    return {e["slug"] for e in listed if isinstance(e, dict) and isinstance(e.get("slug"), str)} if isinstance(listed, list) else set()


def resolve(prefer, listed):
    """The slug to send for `prefer` on an account listing `listed`, or None when it resolves to nothing listed."""
    if not isinstance(prefer, str):
        return None
    if prefer in PINNED:
        return PINNED[prefer] if PINNED[prefer] in _slugs(listed) else None
    if prefer in ROLES:
        return roles(listed).get(prefer)
    return prefer if SLUG.fullmatch(prefer) and prefer in _slugs(listed) else None


def default_text(listed):
    """(slug, moved): TEXT_MODEL while listed with reasoning none, else the account's gpt-instant (moved True), else
    (None, False). A retired or renamed Luna Instant then moves the default instead of marking every account down."""
    for entry in listed if isinstance(listed, list) else []:
        if isinstance(entry, dict) and entry.get("slug") == TEXT_MODEL and entry.get("reasoning_type") == "none":
            return TEXT_MODEL, False
    instant = roles(listed).get("gpt-instant")
    return (instant, True) if instant else (None, False)


def _branch(conversation):
    mapping = conversation.get("mapping")
    current = conversation.get("current_node")
    if not isinstance(mapping, dict) or not isinstance(current, str):
        raise ClaudeError("Unexpected ChatGPT conversation format.", code="invalid_response")
    branch, seen = [], set()
    while current is not None:
        if current in seen or current not in mapping or not isinstance(mapping[current], dict):
            raise ClaudeError("Invalid ChatGPT conversation branch.", code="invalid_response")
        seen.add(current)
        node = mapping[current]
        branch.append(node.get("message"))
        current = node.get("parent")
    return branch


def _visible_message(message):
    author, content = message.get("author", {}), message.get("content", {})
    metadata = message.get("metadata") or {}
    if (
        not isinstance(author, dict)
        or not isinstance(content, dict)
        or not isinstance(metadata, dict)
    ):
        raise ClaudeError("Invalid ChatGPT message format.", code="invalid_response")
    role = author.get("role")
    if (
        role not in {"user", "assistant"}
        or message.get("channel") not in {None, "final"}
        or message.get("recipient") not in {None, "all"}
        or metadata.get("is_visually_hidden_from_conversation")
        or content.get("content_type") not in {"text", "multimodal_text"}
    ):
        return None
    parts = content.get("parts", [])
    if not isinstance(parts, list):
        raise ClaudeError("Invalid ChatGPT text format.", code="invalid_response")
    text = "".join(part for part in parts if isinstance(part, str))
    if not text:
        return None
    # The web app's visible link token is rendered as an ordinary Markdown
    # link. Its private-use delimiters must not become part of a source URL.
    text = re.sub(
        r"\ue200url\ue202([^\ue202]+)\ue202(https?://[^\ue201]+)\ue201",
        r"[\1](\2)",
        text,
    )
    return {
        "id": message.get("id"),
        "role": role,
        "text": text,
        "model": metadata.get("model_slug") or metadata.get("resolved_model_slug"),
        "incomplete": message.get("status") != "finished_successfully",
        "content": [{"type": "text", "text": text}],
        "code_blocks": code_blocks(text),
        "citations": _citations(metadata, text),
        "tool_calls": [],
        "tool_results": [],
    }


def _citations(metadata, text):
    citations, urls = [], set()
    # Only expose documented-looking public link fields, never raw metadata/tokens.
    for key in ("citations", "content_references"):
        for reference in metadata.get(key, []) or []:
            if isinstance(reference, dict):
                _add_citation(citations, urls, reference.get("url"), reference.get("title"))
                nested = reference.get("metadata")
                if isinstance(nested, dict):
                    _add_citation(citations, urls, nested.get("url"), nested.get("title"))
    for url in re.findall(r"https?://[^\s<>\]\)\"'\ue000-\uf8ff]+", text):
        _add_citation(citations, urls, url.rstrip(".,;:!"))
    return citations


def _add_citation(citations, urls, url, title=None):
    if isinstance(url, str) and url.startswith(("https://", "http://")) and url not in urls:
        urls.add(url)
        citations.append({"url": url, "title": title if isinstance(title, str) else url})


class ChatGPTHttp:
    def __init__(self, saved, *, timeout=120, session_factory=None, preparations=None):
        self.original = {
            "cookies": deepcopy(saved.get("cookies", [])),
            "origins": saved.get("origins", []),
        }
        self.session = (session_factory or requests.Session)()
        self.timeout = timeout
        self.preparations = preparations
        self.account_key = None
        self.account_label = None
        self.account_email = None
        self.session.headers.update(
            {"Accept": "application/json", "Origin": BASE, "Referer": BASE + "/"}
        )
        for cookie in prune_per_chat_cookies(saved.get("cookies", [])):
            # A cookie from auth.openai.com must never be sent to chatgpt.com.
            expiry = cookie.get("expires", -1)
            if cookie.get("domain", "").lstrip(".").lower() != "chatgpt.com" or (
                expiry > 0 and expiry <= time.time()
            ):
                continue
            self.session.cookies.set(
                cookie["name"],
                cookie["value"],
                domain=cookie["domain"],
                path=cookie.get("path", "/"),
                secure=cookie.get("secure", True),
                expires=int(expiry) if expiry > 0 else None,
                rest={
                    "HttpOnly": cookie.get("httpOnly", False),
                    "SameSite": cookie.get("sameSite", "Lax"),
                },
            )
            if cookie["name"] == "oai-did":
                self.session.headers["OAI-Device-ID"] = cookie["value"]

    def close(self):
        self.session.close()

    def saved_state(self):
        cookies = [
            c
            for c in self.original.get("cookies", [])
            if c.get("domain", "").lstrip(".").lower() != "chatgpt.com"
        ]
        for cookie in self.session.cookies:
            if cookie.domain.lstrip(".").lower() != "chatgpt.com" or cookie.is_expired():
                continue
            same_site = str(cookie.get_nonstandard_attr("SameSite", "Lax")).capitalize()
            cookies.append(
                {
                    "name": cookie.name,
                    "value": cookie.value,
                    "domain": cookie.domain,
                    "path": cookie.path,
                    "expires": cookie.expires if cookie.expires is not None else -1,
                    "secure": bool(cookie.secure),
                    "httpOnly": cookie.has_nonstandard_attr("HttpOnly")
                    and cookie.get_nonstandard_attr("HttpOnly") is not False,
                    "sameSite": same_site if same_site in {"Strict", "Lax", "None"} else "Lax",
                }
            )
        return {"cookies": prune_per_chat_cookies(cookies), "origins": self.original.get("origins", [])}

    def _request(self, method, path, **kwargs):
        if path == "/api/auth/session":
            # Only the split session cookie is needed for this endpoint. Avoid
            # sending analytics, device and unrelated chat cookies on every call.
            jar = requests.cookies.RequestsCookieJar()
            for cookie in self.session.cookies:
                if re.fullmatch(r"__Secure-next-auth\.session-token(?:\.\d+)?", cookie.name):
                    jar.set_cookie(cookie)
            prepared = requests.Request(method, BASE + path).prepare()
            kwargs["headers"] = {
                **kwargs.get("headers", {}),
                "Cookie": requests.cookies.get_cookie_header(jar, prepared) or "",
            }
        try:
            response = self.session.request(
                method, BASE + path, timeout=(10, self.timeout), allow_redirects=False, **kwargs
            )
        except requests.RequestException:
            raise ClaudeError(
                "ChatGPT HTTP request failed. No automatic retry or browser fallback was made.",
                code="network_error",
                retryable=method == "GET",
            ) from None
        if 200 <= response.status_code < 300:
            return response
        status = response.status_code
        detail = _refusal_detail(response)
        response.close()
        if status == 403:
            code, message = (
                "http_verification_required",
                "ChatGPT rejected the HTTP request with a device or access check. Verification may need refreshing. No retry or browser fallback was made; read the chat before deciding whether to send again.",
            )
        elif status == 401 or 300 <= status < 400:
            code, message = (
                "login_required",
                "ChatGPT requires sign-in. Run login --provider chatgpt.",
            )
        elif status == 404:
            code, message = (
                "not_found",
                "ChatGPT could not read this chat. Its UUID and current access cookies are required; the chat may also have expired.",
            )
        elif status == 429:
            code, message = (
                "rate_limited",
                "ChatGPT's account or request limit was reached. Wait for the limit to reset.",
            )
        else:
            code, message = (
                "http_rejected",
                "ChatGPT rejected the HTTP request. No retry or browser fallback was made.",
            )
        # Name the call that was refused and ChatGPT's own words for it (2026-10-15: a bare 404 "Model not found"
        # from /f/conversation read as a chat that could not be read).
        said = f" ChatGPT said: {detail}." if detail else ""
        raise ClaudeError(f"{message} Failed call: {method} {path.split('?')[0]}.{said}", code=code, status=status)

    def _json(self, method, path, **kwargs):
        response = self._request(method, path, **kwargs)
        try:
            body = response.json()
            if not isinstance(body, dict):
                raise ValueError()
            return body
        except ValueError:
            raise ClaudeError(
                "ChatGPT returned an unexpected response.", code="invalid_response"
            ) from None
        finally:
            response.close()

    def authenticate(self):
        body = self._json("GET", "/api/auth/session")
        if (
            not isinstance(body.get("user"), dict)
            or not body["user"]
            or not isinstance(body.get("accessToken"), str)
            or not body["accessToken"]
        ):
            raise ClaudeError(
                "ChatGPT login expired. Run login --provider chatgpt.", code="login_required"
            )
        self.session.headers["Authorization"] = "Bearer " + body["accessToken"]
        try:
            self.account_label = account_label(body["user"].get("name"), body["user"].get("email"))
            self.account_email = account_email(body["user"].get("email"))
        except Exception:
            self.account_label = self.account_email = None
        identifier = body["user"].get("id")
        self.account_key = (
            account_key(identifier) if isinstance(identifier, str) and identifier else None
        )

    def read(self, server_id):
        server_id = valid_uuid(server_id)
        # This boolean marker selects Temporary Chat lookup; it is not an auth
        # credential. The authenticated server still decides account access.
        body = self._json(
            "GET",
            "/backend-api/conversation/" + server_id,
            headers={"Cookie": "history_off_" + server_id + "=1"},
        )
        if body.get("conversation_id") != server_id:
            raise ClaudeError("ChatGPT returned a different conversation.", code="invalid_response")
        if body.get("is_temporary_chat") is not True:
            raise ClaudeError(
                "This chat is not confirmed as Temporary. No message was sent.",
                code="privacy_not_verified",
            )
        return body

    def usage(self):
        """Verify Free access and report text policy, without sending a message."""
        accounts = self._json("GET", "/backend-api/accounts/check/v4-2023-04-27")
        models = self._json("GET", "/backend-api/models?history_and_training_disabled=true")
        plans = _plans(accounts)
        listed = models.get("models", [])
        listed = listed if isinstance(listed, list) else []
        default, moved = default_text(listed)
        unlimited = bool(plans) and all(p in UNLIMITED_PLANS for p in plans) and default is not None
        plan = plans[0] if plans and all(p == plans[0] for p in plans) else None
        title = next((m.get("title") for m in listed if isinstance(m, dict) and m.get("slug") == default), None)
        title = title if isinstance(title, str) and title else TEXT_MODEL_NAME
        return {
            "plan": plan,
            "available": unlimited,
            "unlimited_text": unlimited,
            "text_model": title,
            "model_slug": default,
            "roles": roles(listed),
            **({"default_moved": True} if moved else {}),
            "source": (
                "not_exposed" if not unlimited
                else "verified_free_text_policy" if plan == "free"
                else "plan_includes_free_text_policy"
            ),
            "observed_at": datetime.now(timezone.utc).isoformat(),
            "is_snapshot": False,
            "windows": [],
            "exact_remaining_messages": None,
            "note": _usage_note(unlimited, plan, title),
            "models": _offered(models),
        }

    def model_for(self, prefer):
        """The model a new chat asked for `prefer` (a PINNED or ROLES name, or a listed slug) is sent: that model when
        this account lists it in Temporary Chats, else the account's default text model (which is Luna Instant until
        an account stops listing it, so a retirement never breaks a send). The reply's own model says which answered."""
        listed = self._json("GET", "/backend-api/models?history_and_training_disabled=true").get("models", [])
        return resolve(prefer, listed) or default_text(listed)[0] or TEXT_MODEL

    def send(self, prompt, *, existing=None, on_id=None, model=TEXT_MODEL):
        """One private POST. A prepared credential is consumed before transmission."""
        if not isinstance(prompt, str) or not prompt.strip():
            raise ClaudeError("Supply a nonempty prompt.", code="invalid_arguments")
        if existing is not None and existing.get("is_temporary_chat") is not True:
            raise ClaudeError("Temporary Chat is not verified.", code="privacy_not_verified")
        if model != TEXT_MODEL and not (isinstance(model, str) and SLUG.fullmatch(model)):
            raise ClaudeError("That ChatGPT model is not one AgentHydra sends.", code="invalid_model")
        previous = {m["id"] for m in visible_messages(existing)} if existing else set()
        payload = _send_payload(prompt, existing, model)
        server_id = payload.get("conversation_id")
        headers = {"Accept": "text/event-stream"}
        if self.preparations is not None:
            headers.update(self.preparations.take(self.account_key))
        response = self._request(
            "POST",
            "/backend-api/f/conversation",
            json=payload,
            stream=True,
            headers=headers,
        )
        server_id, complete = _read_stream(response, server_id, on_id)
        body = self.read(server_id)
        messages = visible_messages(body)
        fresh = [m for m in messages if m["role"] == "assistant" and m["id"] not in previous]
        if not fresh:
            raise ClaudeError(
                "A new assistant reply is not confirmed. Read this chat before sending again.",
                code="response_pending",
            )
        return body, messages, fresh[-1], complete


def _refusal_detail(response):
    """ChatGPT's `detail` from a refused call's JSON body (a string, or an object's message), trimmed; None if absent."""
    try:
        body = response.json()
    except ValueError:
        return None
    detail = body.get("detail") if isinstance(body, dict) else None
    if isinstance(detail, dict):
        detail = detail.get("message") or detail.get("code")
    return detail[:200] if isinstance(detail, str) and detail else None


def _plans(accounts):
    records = accounts.get("accounts", {})
    records = list(records.values()) if isinstance(records, dict) else []
    plans = []
    for item in records:
        if isinstance(item, dict) and item.get("can_access_with_session") is False:
            continue
        account = item.get("account") if isinstance(item, dict) else None
        plans.append(account.get("plan_type") if isinstance(account, dict) else None)
    return plans


def _offered(models):
    """The models this account lists for Temporary Chats (slug, title, reasoning type): what a new private chat could
    ask for, read so which plan offers which model is a reading, not a guess (owner, 2026-10-13: "We literally have
    access to Go accounts. Do those not provide any higher level models?")."""
    advertised = models.get("models", [])
    if not isinstance(advertised, list):
        return []
    def text(value):
        return value if isinstance(value, str) else None
    return [{"slug": m["slug"], "title": text(m.get("title")), "reasoning": text(m.get("reasoning_type"))}
            for m in advertised if isinstance(m, dict) and isinstance(m.get("slug"), str)][:40]


def _usage_note(unlimited, plan, title=TEXT_MODEL_NAME):
    if unlimited and plan == "free":
        return (
            f"{title}: unlimited everyday text on the Free plan, subject to abuse safeguards. "
            "Uploads, images, voice and other tools have separate limits. This is a verified plan policy, not a remaining-message counter."
        )
    if unlimited:
        return (
            f"{title}: unlimited everyday text on the {plan.capitalize() if plan else 'paid'} plan, which includes everything in Free, subject to abuse safeguards. "
            "Uploads, images, voice and other tools have separate limits. This is a plan policy, not a remaining-message counter."
        )
    return "An unlimited Free text allowance could not be verified for this login. No remaining-message counter was returned."


def _send_payload(prompt, existing, model=TEXT_MODEL):
    payload = {
        "action": "next",
        "messages": [
            {
                "id": str(uuid4()),
                "author": {"role": "user"},
                "content": {"content_type": "text", "parts": [prompt]},
            }
        ],
        "parent_message_id": valid_uuid(existing["current_node"]) if existing else str(uuid4()),
        "model": model,
        "history_and_training_disabled": True,
    }
    if existing:
        payload["conversation_id"] = valid_uuid(existing["conversation_id"])
    else:
        # The service rejects this field on continuations (HTTP 422).
        payload["temporary_chat_requests_personalization"] = False
    return payload


def _read_stream(response, server_id, on_id):
    """Return the confirmed server UUID and whether the stream completed."""
    complete = False
    try:
        if "text/event-stream" not in response.headers.get("content-type", ""):
            raise ClaudeError(
                "ChatGPT did not return a message stream.", code="invalid_response"
            )
        for event in events(response.iter_lines(chunk_size=1024)):
            server_id = _stream_event(event, server_id, on_id)
            if event.get("type") == "message_stream_complete":
                complete = True
    except (requests.RequestException, UnicodeError):
        raise ClaudeError(
            "The reply stream was interrupted. Read the chat; do not resend automatically.",
            code="stream_interrupted",
        ) from None
    finally:
        response.close()
    if not server_id:
        raise ClaudeError(
            "No server UUID was confirmed. Do not automatically resend.",
            code="response_pending",
        )
    return server_id, complete


def _stream_event(event, server_id, on_id):
    if event.get("type") == "error" or event.get("error"):
        # ChatGPT's own words for it, so a failure says whether it was a model's usage cap or something else: 3 of
        # the first 6 Luna Thinking threads of an A/B failed here in 6 to 9 s with nothing more (2026-10-13).
        # ChatGPT often sends `error: true` with its words elsewhere in the event; a bare flag is not a reason.
        raw = event.get("error")
        why = (raw.get("message") or raw.get("code")) if isinstance(raw, dict) else raw if isinstance(raw, str) else None
        why = why or event.get("message") or event.get("code") or event.get("error_code") or event.get("detail")
        if not isinstance(why, str) or not why.strip():
            why = "no reason given; event keys: " + ", ".join(sorted(map(str, event))[:12])
        why = " ".join(why.split())[:200]
        raise ClaudeError(
            f"ChatGPT generation failed{f' ({why})' if why else ''}; read the chat before sending again.",
            code="generation_error",
        )
    candidate = event.get("conversation_id")
    if not candidate:
        return server_id
    candidate = valid_uuid(candidate)
    if server_id and candidate != server_id:
        raise ClaudeError(
            "The reply belongs to a different conversation.",
            code="invalid_response",
        )
    if not server_id and on_id:
        on_id(candidate)
    return candidate


@contextmanager
def connection(store, timeout):
    saved = store.load()
    if saved is None:
        raise ClaudeError("Run login --provider chatgpt first.", code="login_required")
    client = ChatGPTHttp(saved, timeout=timeout, preparations=Preparations(store.directory))
    failed = False
    try:
        client.authenticate()
        yield client
    except BaseException:
        failed = True
        raise
    finally:
        try:
            updated = client.saved_state()
            if updated != saved:
                store.save(updated)
        except (OSError, ClaudeError):
            if not failed:
                raise ClaudeError(
                    "The HTTP operation finished, but rotated login cookies could not be saved. Do not automatically resend a message.",
                    code="session_save_failed",
                ) from None
        finally:
            client.close()
