"""A batch is graded on the SOURCE ACCOUNT AS THE OWNER SEES IT, re-read at the end (2026-10-10).

THE INCIDENT. `move_chats {from:13, to:187, all_unarchived:true}` on 2026-10-09 answered ok with
four landed while one of them was still unarchived on #13 - its settle never ran (phase 'stamped-settle-visible') - and only a manual list_chats afterwards
found it. The owner's words: "you need better double-checking". Each phase checked its own step;
nothing re-read the account as a whole. Phase six (`_final_source_sweep`) does:

  1. a LANDED chat still unarchived on its source is re-settled once, and if it is STILL there
     the batch is not ok and names it;
  2. under --all-unarchived with no --limit, an unarchived chat the batch never took (one that
     appeared mid-batch, or one the enumeration missed) fails the batch by name;
  3. under --limit the leftovers were left on purpose: named, not a failure.
"""

import sys
import unittest
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import migrate_batch  # noqa: E402
import migrate_chat  # noqa: E402
from lib import hydralib  # noqa: E402

FLEET = {"instances": [{"num": 13, "name": "temp1", "dir": "c:\\i\\temp1", "isRunning": True}]}


class _Landing:
    def __init__(self, sid: str):
        self.session_id = sid
        self.src_instance = "temp1"
        self.match = {"instance": "temp1", "sessionId": sid}
        self.target = {"name": "anuthrone", "num": 187}


def _landed(sid: str, title: str):
    item = migrate_batch._Item(sid)
    item.landing = _Landing(sid)
    item.payload = {"landed": True, "ok": True, "sessionId": sid, "title": title}
    return item


def _args(all_unarchived=True, limit=0):
    parsed = migrate_batch._BatchArgs()
    parsed.all_unarchived = all_unarchived
    parsed.limit = limit
    parsed.source_labels = {"temp1"}
    return parsed


def _row(sid, title, archived=False):
    return {"instance": "temp1", "sessionId": sid, "title": title, "isArchived": archived}


class FinalSourceSweepTest(unittest.TestCase):
    def setUp(self):
        self.rows = []
        self.settle_works = False
        self.settled = []
        for obj, name, value in (
            (hydralib, "fleet", lambda: FLEET),
            (hydralib, "chats", lambda label=None, **k: list(self.rows)),
            (migrate_chat, "phase_settle", lambda land: self.settled.append(land.session_id)),
            (migrate_chat, "source_still_visible",
             lambda sid, src, fleet=None: not self.settle_works),
        ):
            p = mock.patch.object(obj, name, value)
            p.start()
            self.addCleanup(p.stop)

    def _run(self, items, parsed):
        sweep = migrate_batch._final_source_sweep(items, parsed)
        payload = {"ok": all(i.payload.get("ok") for i in items), "report": "body"}
        migrate_batch._apply_source_sweep(payload, sweep)
        return payload

    def test_a_landed_chat_still_on_the_source_fails_the_batch_by_name(self):
        # The 2026-10-09 shape: landed, settle never took, source still shows it.
        items = [_landed("stuck", "A chat whose settle never ran"), _landed("ok1", "Fine")]
        self.rows = [_row("stuck", "A chat whose settle never ran"), _row("ok1", "Fine", True)]
        payload = self._run(items, _args())
        self.assertFalse(payload["ok"])
        self.assertEqual(["stuck"], [r["sessionId"] for r in payload["sourceSweep"]["leftBehind"]])
        self.assertEqual(["stuck"], self.settled)  # one repair attempt, through the real phase
        self.assertIn("A chat whose settle never ran", payload["report"].splitlines()[0])
        self.assertFalse(items[0].payload["ok"])

    def test_a_left_behind_row_the_sweep_re_settles_is_not_a_failure(self):
        self.settle_works = True
        items = [_landed("stuck", "A chat whose settle never ran")]
        self.rows = [_row("stuck", "A chat whose settle never ran")]
        payload = self._run(items, _args())
        self.assertTrue(payload["ok"])
        self.assertEqual(["stuck"], payload["sourceSweep"]["repaired"])

    def test_an_unarchived_chat_the_batch_never_took_fails_an_all_unarchived_batch(self):
        items = [_landed("a", "Moved one")]
        self.rows = [_row("a", "Moved one", True), _row("late", "Started mid-batch")]
        payload = self._run(items, _args())
        self.assertFalse(payload["ok"])
        self.assertEqual(["late"], [r["sessionId"] for r in payload["sourceSweep"]["notTaken"]])
        self.assertIn("Started mid-batch", payload["report"])

    def test_leftovers_past_an_explicit_limit_are_named_but_not_a_failure(self):
        items = [_landed("a", "Moved one")]
        self.rows = [_row("a", "Moved one", True), _row("older", "Past the limit")]
        payload = self._run(items, _args(limit=1))
        self.assertTrue(payload["ok"])
        self.assertIn("Past the limit", payload["report"])

    def test_an_engine_the_source_app_restarted_after_the_kill_is_killed_then_settled(self):
        # The 2026-10-15 #187 -> #215 shape: --terminate-live killed the engine, the chat landed,
        # the still-open source app started a new engine for it, and the app refuses to archive
        # a running chat - so the settle only takes once that engine is gone.
        items = [_landed("dealflow", "Dealflow app Google Look styling")]
        row = {**_row("dealflow", "Dealflow app Google Look styling"), "live": True, "livePid": 90400}
        self.rows = [row]
        killed = []

        def taskkill(argv, timeout=None):
            killed.append(argv[2])
            row["live"] = False
            self.settle_works = True  # the app's refusal was the running engine

        parsed = _args()
        parsed.terminate_live = True
        with mock.patch.object(migrate_batch.clilib, "run_text", taskkill), \
                mock.patch.object(migrate_batch.ledgerlib, "note", lambda *a, **k: None):
            payload = self._run(items, parsed)
        self.assertEqual(["90400"], killed)
        self.assertTrue(payload["ok"])
        self.assertEqual(["dealflow"], payload["sourceSweep"]["repaired"])

    def test_a_restarted_source_engine_is_never_killed_without_a_kill_word(self):
        items = [_landed("dealflow", "Dealflow app Google Look styling")]
        self.rows = [{**_row("dealflow", "Dealflow app Google Look styling"),
                      "live": True, "livePid": 90400}]
        with mock.patch.object(migrate_batch.clilib, "run_text",
                               lambda *a, **k: self.fail("killed without --terminate-live")):
            payload = self._run(items, _args())
        self.assertFalse(payload["ok"])

    def test_an_unreadable_source_is_not_called_clean(self):
        def boom(*a, **k):
            raise hydralib.DaemonError("/api/chats", None, "daemon down")
        with mock.patch.object(hydralib, "chats", boom):
            payload = self._run([_landed("a", "Moved one")], _args())
        self.assertFalse(payload["ok"])
        self.assertIn("FINAL SWEEP NOT RUN", payload["report"])


if __name__ == "__main__":
    unittest.main()
