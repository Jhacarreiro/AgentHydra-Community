"""A chat that has seen how its job ended (read its status or results once it was final, or cancelled it) is never
pinged about it: hswarm records the chat beside the job (job.mark_seen, <job>/seen/<session id>) and the AgentHydra
daemon's job ping looks for that file (server/src/swarm-job-ping.ts seenByChat). 2026-10-13: a chat that had read one job's results and
cancelled another was pinged about both an hour later."""
import asyncio

import pytest

from hswarm import config, mcp_server, shared
from hswarm.job import Job

SID = "4138a08f-1111-2222-3333-444455556666"


class _NoLiveJobs:
    """A server that runs none of the jobs: every read and cancel goes to the record on disk, as after a restart."""

    _gates: dict = {}

    def get(self, job_id):
        raise KeyError(job_id)

    def status(self, job):  # looked up before get() runs, never called
        raise AssertionError("no live job to report")

    def cancel(self, job_id):
        raise KeyError(job_id)


@pytest.fixture
def chat(monkeypatch):
    monkeypatch.setattr(mcp_server, "manager", lambda: _NoLiveJobs())
    monkeypatch.setattr(shared, "ACTIVE", True)
    token = shared.REQUEST.set({"session": SID, "chat": f"local_{SID}", "instance": "moarz"})
    yield
    shared.REQUEST.reset(token)


def _on_disk(job_id: str, state: str) -> None:
    Job(id=job_id, tasks=[], state=state, finished="" if state == "running" else "2026-10-13T08:57:17+00:00").save()


def _seen(job_id: str) -> set[str]:
    folder = config.JOBS_DIR / job_id / "seen"
    return {p.name for p in folder.iterdir()} if folder.is_dir() else set()


@pytest.mark.parametrize("read", ["status", "results"])
def test_reading_a_finished_job_records_the_chat(chat, read):
    _on_disk("20261013-085650-d353", "done")
    call = mcp_server.hswarm_status if read == "status" else mcp_server.hswarm_results
    asyncio.run(call("20261013-085650-d353"))
    assert set(_seen("20261013-085650-d353")) == {SID}


def test_reading_a_running_job_records_nothing(chat):
    _on_disk("20261013-085650-d354", "running")
    asyncio.run(mcp_server.hswarm_status("20261013-085650-d354"))
    asyncio.run(mcp_server.hswarm_results("20261013-085650-d354"))
    assert _seen("20261013-085650-d354") == set()


def test_cancelling_a_job_records_the_chat(chat):
    _on_disk("20261013-083355-6238", "running")
    asyncio.run(mcp_server.hswarm_cancel("20261013-083355-6238"))
    assert set(_seen("20261013-083355-6238")) == {SID}
