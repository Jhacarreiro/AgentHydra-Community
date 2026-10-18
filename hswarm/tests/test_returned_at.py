"""job.json says when the starting call handed back a job that was still running; the AgentHydra daemon pings
the chat of such a job when it finishes, and never one whose result came back inside the call."""
import asyncio
import json

from hswarm import config, mcp_server
from hswarm.job import Job


class _Manager:
    _gates: dict = {}

    def __init__(self, state):
        self.state = state

    def submit(self, tasks, **kw):
        self.job = Job(id="20261012-000000-aaaa", tasks=[], state=self.state)
        return self.job

    async def wait(self, job_id, timeout_s):
        return self.job

    def status(self, job):
        return {"job_id": job.id, "state": job.state, "counts": {}}


def _run(monkeypatch, state, wait):
    mgr = _Manager(state)
    monkeypatch.setattr(mcp_server, "manager", lambda: mgr)
    asyncio.run(mcp_server.hswarm_run(tasks=["say OK"], tools="none", wait=wait))
    return mgr.job


def test_a_call_that_returns_a_running_job_stamps_returned_at(monkeypatch):
    job = _run(monkeypatch, "running", wait=False)
    doc = json.loads((config.JOBS_DIR / job.id / "job.json").read_text(encoding="utf-8"))
    assert doc["returned_at"] > 1_700_000_000_000


def test_a_call_that_returns_a_finished_job_stamps_nothing(monkeypatch):
    job = _run(monkeypatch, "done", wait=True)
    assert job.returned_at == 0 and not (config.JOBS_DIR / job.id / "job.json").exists()
