"""No-network checks for the verified text policy and fixed private-chat model."""

import json
import unittest
from unittest.mock import Mock

from claudfree.chatgpt.http import ChatGPTHttp, TEXT_MODEL, TEXT_MODEL_NAME, _stream_event, roles, thread_model
from claudfree.errors import ClaudeError
from claudfree.http import account_label


def account(plan, **extra):
    return {"account": {"plan_type": plan, "email": "example@example.test"}, **extra}


def model(**extra):
    return {"slug": TEXT_MODEL, "title": TEXT_MODEL_NAME, "reasoning_type": "none", **extra}


def entry(slug, title, reasoning_type):
    return {"slug": slug, "title": title, "reasoning_type": reasoning_type}


def usage(accounts, models):
    http = object.__new__(ChatGPTHttp)
    http._json = Mock(side_effect=[{"accounts": accounts}, {"models": models}])
    result = http.usage()
    assert all(call.args[0] == "GET" for call in http._json.call_args_list)
    return result


class ChatGPTUsageTests(unittest.TestCase):
    def test_verified_free_instant_is_unlimited_text_without_a_numeric_quota(self):
        result = usage({"personal": account("free")}, [model()])
        self.assertTrue(result["available"])
        self.assertTrue(result["unlimited_text"])
        self.assertEqual(result["model_slug"], TEXT_MODEL)
        self.assertIsNone(result["exact_remaining_messages"])
        self.assertEqual(result["windows"], [])
        self.assertIsNotNone(result["observed_at"])
        self.assertIn("separate limits", result["note"])
        self.assertNotIn("example@example.test", json.dumps(result))
        self.assertEqual(result["plan"], "free")
        self.assertEqual(result["source"], "verified_free_text_policy")

    def test_paid_personal_plan_includes_the_free_text_policy(self):
        result = usage({"personal": account("go")}, [model(), {"slug": "gpt-5-6-t-mini", "title": "Thinking mini", "reasoning_type": "reasoning"}, "junk"])
        self.assertTrue(result["unlimited_text"])
        self.assertEqual(result["plan"], "go")
        self.assertEqual(result["models"], [
            {"slug": TEXT_MODEL, "title": TEXT_MODEL_NAME, "reasoning": "none"},
            {"slug": "gpt-5-6-t-mini", "title": "Thinking mini", "reasoning": "reasoning"},
        ])
        self.assertEqual(result["source"], "plan_includes_free_text_policy")
        self.assertIn("on the Go plan, which includes everything in Free", result["note"])

    def test_account_label_rules(self):
        cases = [
            (("Example Owner", "owner@example.test"), "Example Owner"),
            (("owner@example.test", None), "owner"),
            (("", "owner@example.test"), "owner"),
            (("Exam\x00ple\x1b Owner", None), "Example Owner"),
            (("x" * 90, None), "x" * 60),
            ((None, None), None),
            (("  ", ""), None),
        ]
        for args, expected in cases:
            with self.subTest(args=args):
                self.assertEqual(account_label(*args), expected)

    def test_ambiguous_or_unverified_access_stays_unknown(self):
        cases = [
            ({}, [model()]),
            ({"paid": account("enterprise")}, [model()]),
            ({"personal": account("go"), "workspace": account("team")}, [model()]),
            ({"personal": account("free"), "workspace": account("team")}, [model()]),
            ({"personal": account("free"), "malformed": {}}, [model()]),
            ({"personal": account("free")}, []),
            ({"personal": account("free")}, [model(reasoning_type="reasoning")]),
        ]
        for accounts, models in cases:
            with self.subTest(accounts=accounts, models=models):
                result = usage(accounts, models)
                self.assertFalse(result["available"])
                self.assertFalse(result["unlimited_text"])
                self.assertIsNone(result["exact_remaining_messages"])

    def test_inaccessible_workspace_does_not_describe_the_current_login(self):
        result = usage({"personal": account("free"), "workspace": account("team", can_access_with_session=False)}, [model()])
        self.assertTrue(result["unlimited_text"])

    def test_http_failure_is_not_converted_to_unlimited(self):
        http = object.__new__(ChatGPTHttp)
        http._json = Mock(side_effect=ClaudeError("Fixture access failure", code="login_required"))
        with self.assertRaises(ClaudeError):
            http.usage()
        self.assertEqual(http._json.call_count, 1)

    def test_a_preferred_model_is_sent_only_where_the_account_offers_it(self):
        # 2026-10-08: Free accounts list GPT-6, Go accounts do not; a send naming a model the account lacks would fail.
        offers_six = {"models": [model(), {"slug": "gpt-6", "title": "GPT-6", "reasoning_type": "auto"}]}
        cases = [("gpt-6", offers_six, "gpt-6"), ("gpt-6", {"models": [model()]}, TEXT_MODEL), ("sonnet", offers_six, TEXT_MODEL)]
        for prefer, models, expected in cases:
            with self.subTest(prefer=prefer, offered=len(models["models"])):
                http = object.__new__(ChatGPTHttp)
                http._json = Mock(return_value=models)
                self.assertEqual(http.model_for(prefer), expected)
                self.assertEqual(http._json.call_count, 1)
        http = object.__new__(ChatGPTHttp)
        http.preparations = None
        http._request = Mock(side_effect=ClaudeError("Stop before fixture transmission", code="fixture"))
        with self.assertRaises(ClaudeError):
            http.send("Synthetic smoke message", model="gpt-6")
        self.assertEqual(http._request.call_args.kwargs["json"]["model"], "gpt-6")
        with self.assertRaises(ClaudeError) as refused:
            http.send("Synthetic smoke message", model="claude-sonnet")
        self.assertEqual(refused.exception.code, "invalid_model")
        self.assertEqual(http._request.call_count, 1)

    def test_roles_resolve_to_the_newest_listed_model_of_each_kind(self):
        # Contract: gpt-instant/thinking/auto follow the highest listed version, shorter slug on a tie, no code change.
        listed = [entry(*row) for row in (
            ("gpt-6", "GPT-6", "auto"), ("gpt-6-mini", "GPT-6", "none"), ("gpt-6-t-mini", "GPT-6", "reasoning"),
            ("gpt-5-6", "GPT-5.6 Luna", "auto"), (TEXT_MODEL, TEXT_MODEL_NAME, "none"),
            ("gpt-5-6-t-mini", "GPT-5.6 Luna", "reasoning"), ("gpt-5-5-mini", "GPT-5.5", "none"),
            ("gpt-6-t-mini-mini", "GPT-6", "reasoning"), ("auto", "Auto", "auto"))]
        self.assertEqual(roles(listed), {"gpt-instant": "gpt-6-mini", "gpt-thinking": "gpt-6-t-mini", "gpt-auto": "gpt-6"})
        listed.append(entry("gpt-6-1-mini", "GPT-6.1", "none"))
        self.assertEqual(roles(listed)["gpt-instant"], "gpt-6-1-mini")

    def test_usage_stays_available_when_the_default_model_is_retired(self):
        # Contract: a missing gpt-5-6-mini moves the default to gpt-instant instead of marking the account unavailable.
        result = usage({"personal": account("go")}, [entry("gpt-6-mini", "GPT-6", "none")])
        self.assertTrue(result["available"])
        self.assertTrue(result["default_moved"])
        self.assertEqual(result["model_slug"], "gpt-6-mini")
        self.assertEqual(result["text_model"], "GPT-6")
        self.assertEqual(result["roles"], {"gpt-instant": "gpt-6-mini"})
        self.assertNotIn("default_moved", usage({"personal": account("go")}, [model()]))

    def test_a_retitled_default_model_stays_available_under_its_new_title(self):
        # Contract: the default is found by slug and reasoning type, so a rename never marks an account unavailable.
        result = usage({"personal": account("free")}, [model(title="Another model")])
        self.assertTrue(result["available"])
        self.assertEqual(result["text_model"], "Another model")
        self.assertNotIn("default_moved", result)

    def test_a_listed_raw_slug_is_sent_and_an_unlisted_one_falls_back(self):
        # Contract: --prefer <slug> is sent only when listed; otherwise the account's default text model.
        listed = {"models": [model(), entry("gpt-5-5-mini", "GPT-5.5", "none")]}
        for prefer, expected in (("gpt-5-5-mini", "gpt-5-5-mini"), ("gpt-9-mini", TEXT_MODEL), ("gpt-instant", TEXT_MODEL), (None, TEXT_MODEL)):
            with self.subTest(prefer=prefer):
                http = object.__new__(ChatGPTHttp)
                http._json = Mock(return_value=listed)
                self.assertEqual(http.model_for(prefer), expected)
        http = object.__new__(ChatGPTHttp)
        http._json = Mock(return_value={"models": [entry("gpt-6-mini", "GPT-6", "none")]})
        self.assertEqual(http.model_for(None), "gpt-6-mini")

    def test_a_continued_chat_stays_on_the_model_its_thread_answered_on(self):
        def thread(*models):
            mapping, parent = {"root": {"parent": None, "message": None}}, "root"
            for k, slug in enumerate(models):
                for role, meta in (("user", {}), ("assistant", {"model_slug": slug} if slug else {})):
                    node = f"{role}{k}"
                    mapping[node] = {"parent": parent, "message": {"id": node, "author": {"role": role},
                                     "content": {"content_type": "text", "parts": ["Synthetic text"]}, "metadata": meta}}
                    parent = node
            return {"conversation_id": "11111111-2222-4333-8444-555555555555", "current_node": parent, "mapping": mapping}
        cases = [(("gpt-6",), "gpt-6"), ((TEXT_MODEL, "gpt-5-6-t-mini"), "gpt-5-6-t-mini"), (("gpt-6", TEXT_MODEL), TEXT_MODEL),
                 (("gpt-5-5",), "gpt-5-5"), (("claude-x",), TEXT_MODEL), ((None,), TEXT_MODEL), ((), TEXT_MODEL)]
        for models, expected in cases:
            with self.subTest(models=models):
                self.assertEqual(thread_model(thread(*models)), expected)

    def test_new_and_resumed_messages_default_to_luna_and_remain_temporary(self):
        chat = "11111111-2222-4333-8444-555555555555"
        parent = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        existing = {"conversation_id": chat, "current_node": parent, "is_temporary_chat": True,
                    "mapping": {parent: {"parent": None, "message": None}}}
        for body in (None, existing):
            with self.subTest(resuming=body is not None):
                http = object.__new__(ChatGPTHttp)
                http.preparations = None
                http._request = Mock(side_effect=ClaudeError("Stop before fixture transmission", code="fixture"))
                with self.assertRaises(ClaudeError):
                    http.send("Synthetic smoke message", existing=body)
                self.assertEqual(http._request.call_count, 1)
                request = http._request.call_args
                self.assertEqual(request.args, ("POST", "/backend-api/f/conversation"))
                self.assertEqual(request.kwargs["json"]["model"], TEXT_MODEL)
                self.assertTrue(request.kwargs["json"]["history_and_training_disabled"])
                if body:
                    self.assertEqual(request.kwargs["json"]["conversation_id"], chat)
                    self.assertNotIn("temporary_chat_requests_personalization", request.kwargs["json"])
                else:
                    self.assertFalse(request.kwargs["json"]["temporary_chat_requests_personalization"])


class StreamErrorTest(unittest.TestCase):
    # 2026-10-13: ChatGPT sends `error: true` beside its words, and the failure read "ChatGPT generation failed (True)".
    def test_a_bare_error_flag_gives_chatgpts_own_words_or_the_event_keys(self):
        with self.assertRaises(ClaudeError) as said:
            _stream_event({"error": True, "message": "You've hit your limit for this model."}, None, None)
        self.assertIn("You've hit your limit for this model.", str(said.exception))
        with self.assertRaises(ClaudeError) as bare:
            _stream_event({"type": "error", "error": True, "v": 3}, None, None)
        self.assertNotIn("(True)", str(bare.exception))
        self.assertIn("event keys: error, type, v", str(bare.exception))


class _Refused:
    status_code = 404

    def __init__(self, body):
        self._body = body

    def json(self):
        return json.loads(self._body)

    def close(self):
        pass


class RefusedCallTest(unittest.TestCase):
    # 2026-10-15: every send failed with a bare 404 {"detail":"Model not found"}, and the error named no call at all.
    def test_a_refused_call_names_its_method_path_and_chatgpts_detail(self):
        http = object.__new__(ChatGPTHttp)
        http.timeout = 5
        http.session = Mock()
        http.session.request.return_value = _Refused(b'{"detail":"Model not found"}')
        with self.assertRaises(ClaudeError) as refused:
            http._request("POST", "/backend-api/f/conversation?history=off", json={})
        self.assertEqual(refused.exception.status, 404)
        self.assertIn("Failed call: POST /backend-api/f/conversation.", str(refused.exception))
        self.assertIn("ChatGPT said: Model not found.", str(refused.exception))
        self.assertNotIn("history=off", str(refused.exception))


if __name__ == "__main__":
    unittest.main()
