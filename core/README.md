# AgentHydra core

The rebuild of AgentHydra's guts as one small task runner, beside the running daemon and Desk until it passes
their smoke test (owner, 2026-10-14: "it's literally A plus B equals C").

**TL;DR**
- **One idea.** A (every account and model, with its room left or its price) + B (a task: a prompt, a folder, the
  tools it needs) = C (B runs on the cheapest A with room that can do it, its reply streams back, and a limit or a
  failure moves it to the next A).
- **One of everything.** One process, one picker, one queue, one store, one event socket. No polling loops, no
  second copy of a chat to keep in step.
- **Chats, CliMayte workers, HSwarm jobs and fan-outs are all tasks.** A chat is tasks with history; a worker is a
  task on a Claude login; an HSwarm job is tasks on API models; a fan-out is many tasks at once.
- **Its test is the live probe**, `core/smoke/smoke.ts`, on the owner's real accounts. A unit test only for a rule
  the probe cannot see.
- **Switch-over** when every stage of the probe passes here: the window points at the core and the old services
  stop. Until then the old ones keep running and nothing here touches their files.

<details><summary>The model</summary>

- **Account** `{ id, backend, home | key, room() }`: a Claude CLI login (its config dir), a Codex login (its
  `CODEX_HOME`), a Free ChatGPT web login, or an API model. `room()` is the 5-hour and weekly percentage left for
  a login, the price for an API model. An account a person is using now has no room.
- **Task** `{ id, prompt, cwd, tools, images?, chatId?, thread? }`. `tools` is what it must be able to do: none,
  read, edit, all.
- **run(task)**: the accounts whose backend can do `tools` and that have room, cheapest first; the task's turn
  streams items (user, assistant_text, tool_use, system, result) to the store and the socket; a limit marks the
  account full until its reset and picks again; a thread a backend holds stays with its account.
- **Chat** `{ id, title, cwd, service, threads, items, queue }`. One turn at a time: a message sent while one
  runs is queued and can be taken back. A pin to another service applies to the next turn, which starts with a
  handoff of what was said since that service last ran.
- **Backends** each turn one task into items: `claude` (the Agent SDK on a login's config dir), `codex` (that
  login's app-server), `chatgpt` (a Free web login), `api` (one HTTP call to a routed model).
- **Store**: a chat is one JSONL file of items plus one line in `chats.json`, under the core's home
  (`CORE_HOME`, default `~/.agenthydra-core`). Outside chats (Claude sessions on disk, Codex threads) are read where
  they are, never copied.
- **Events**: one WebSocket that sends every chat and item change; the window redraws from it.

</details>

<details><summary>Tasks: what CliMayte, HSwarm and fan-outs become</summary>

Over 14 days (2026-10-14) sessions called 138 AgentHydra and HSwarm tools 42,622 times; twelve carried 74% of it, and
a third of all calls only asked whether a run had finished. A task is the whole of it:

- `POST /api/tasks {prompt, cwd, tools: none | read | edit | all, title?, kind?}` answers the task: `{id, status}`.
- `GET /api/tasks/:id` and `GET /api/tasks/:id/wait?seconds=N` (answers when it settles, or after N seconds; no
  polling) give `{id, status: queued | running | done | failed | cancelled, backend, account, result, error,
  verdict}`; `GET /api/tasks?limit=N` lists them, newest first.
- `POST /api/tasks/:id/cancel`; `POST /api/tasks/:id/send {text}`, a follow-up in the same thread on the same
  account once it has settled (202 and the row; 409 while it runs, or for an HSwarm task, which keeps no thread);
  `POST /api/tasks/:id/verdict {pass, note?}` once it is done or failed, which teaches the picker what each kind
  of task needs.
- `GET /api/usage`: every account with its room. `GET /api/health` names the server (`agenthydra-core`).
- The same six as MCP tools (`bun core/src/mcp.ts`, stdio): run, wait, send, cancel, verdict, usage.

A task with tools runs on an agent login (Claude, Codex); a tool-free one on the cheapest route with room (a Free web
login, then an API model). The smoke stages `task-*` are its bar.

</details>

<details><summary>Running it</summary>

- `bun core/src/main.ts` serves `http://127.0.0.1:7789/api` (`CORE_PORT`).
- `bun core/smoke/smoke.ts --json` runs the probe against it; `CORE_URL=http://127.0.0.1:7798/api
  AH_URL=http://127.0.0.1:7787/api` runs the same probe against the old Desk, as the baseline.
- `core/LOOP.md` is the rebuild's frontier loop (`~/.claude/tools/frontier.py`): its Status names the earliest
  stage that is not green yet.

</details>
