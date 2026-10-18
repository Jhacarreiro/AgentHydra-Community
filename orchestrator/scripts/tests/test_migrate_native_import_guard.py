"""The window-placement guard around a move's import follows the target's native mode.

A `native-only` profile lands the chat through the app's own call over its debugger: no window is
touched, so capture and restore (about 3.5s a chat, measured 2026-10-12) are skipped. A
`prefer-native` profile may still take the deep link, which reshows the window, so it keeps the guard.
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import migrate_chat  # noqa: E402
from lib import hydralib, windowlib  # noqa: E402

DIR = r"C:\Users\example\.claude-instances\moarz"


def _settings(mode):
    return {DIR.lower(): {"port": 19311, "mode": mode, "launchDebugger": True}}


class NativeImportGuardTests(unittest.TestCase):
    def test_guard_is_skipped_only_for_native_only(self):
        for mode, expected in [("native-only", True), ("prefer-native", False)]:
            with self.subTest(mode=mode):
                with mock.patch.object(hydralib, "api_get", lambda path, m=mode: _settings(m)):
                    self.assertIs(migrate_chat._native_only_target({"dir": DIR}), expected)

    def test_native_only_import_never_enters_the_window_guard(self):
        guarded = []

        def guard(instance):
            guarded.append(instance)
            raise AssertionError("the window guard must not run for a native-only target")

        posted = {}

        def post(path, body=None, timeout=None):
            posted["path"] = path
            return {"ok": True, "titled": True}

        with mock.patch.object(hydralib, "api_get", lambda path: _settings("native-only")), \
                mock.patch.object(windowlib, "keep_placement", guard), \
                mock.patch.object(hydralib, "api_post", post):
            result = migrate_chat._post_import_or_raise("sid-1", {"dir": DIR, "name": "moarz"}, {})
        self.assertEqual(result, {"ok": True, "titled": True})
        self.assertEqual(guarded, [])
        self.assertEqual(posted["path"], "/api/sessions/sid-1/import-desktop")


if __name__ == "__main__":
    unittest.main()
