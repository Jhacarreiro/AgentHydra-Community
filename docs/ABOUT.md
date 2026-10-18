# AgentHydra Community

> One local window that unifies Claude Code, Codex and OpenCode sessions across your PCs, manages every Claude and
> Codex account, and can reply into live chats.

This page is a short tour of the project for someone about to work on it: what it is, the things worth remembering,
how the repository is laid out, and where a new piece goes. It is written by hand; change it when the product moves.
For configuration and the MCP tools, read [REFERENCE.md](REFERENCE.md); for where the fork comes from,
[FORK.md](FORK.md).

## What it is

AgentHydra Community is a community fork of AgentHydra, continued from `3a65ba8e`, its last MIT-licensed commit. It is
a local dashboard for AI coding agents that unifies Claude Code, Codex, OpenCode, Hermes Agent and DeepSeek Harness
session history into one window. It lets you read and live-tail any session, reply straight into running Claude
sessions (singly or in bulk) and continue Codex chats, move a chat onto another signed-in account in one call, see
cost and usage analytics, and manage isolated Claude Desktop and Codex Desktop/CLI accounts side by side.

⛔ It does NOT start runs you cannot see: `headlessRunsAllowed()` returns false unconditionally, with no setting to
flip, so every attempt to add or dispatch a queued run answers HTTP 409 under the no-headless law. The run queue and
scheduler described below survive as an inspectable RECORD of past runs rather than a way to start new ones. New work
goes through `fan_out` or a visible desktop chat.

There is no hosted service or account sign-up: it reads the local stores the CLIs and desktop apps already write and
talks to localhost, with a Windows system-tray launcher and an MCP server so agents can drive all of it themselves.
What does leave the machine is listed in the README's network section: the update check (a release build's is off
until this repository publishes releases; a source checkout's `git ls-remote` runs on its timer either way), Bun and
Claude Code downloads (and, in a release, the Claude Agent SDK at the version it pins), the Claude upkeep pass on
Windows (Claude Desktop's own update feed, about hourly, with the device id, version and OS version the app sends;
the install's own updater and an npm update of the CLI when they are behind), a daily price list, usage lookups for
your own accounts (DeepSeek's balance too, when a DeepSeek key is found), HSwarm's calls in a source checkout, where
it starts unless `AGENTHYDRA_HSWARM_ENABLED=0` (the providers you add keys for, Artificial Analysis's public model
pages at most once a day while its MCP tools are in use, and the providers' icons when its console opens), and
whatever you turn on. Nothing goes to a service the original publisher runs.

What this fork adds first is one home server for several PCs: a Codex hub that collects every PC's Codex chats and
continues them on the PC they belong to, a tray app that pairs each PC with the hub, Claude Code cloud sessions
beside local ones, and the window behind a sign-in proxy so it opens on a phone. All of it is opt-in. AgentHydra
itself was formerly named CC Manager UI.

## Things not to forget

The intricacies worth remembering: the gotchas, the half-built parts, the decisions whose reason lives nowhere else.

- `add_queue_item` and `launch_terminal_session` are refused on every call (HTTP 409) under the no-headless law (a
  literal false in `server/src/headless-policy.ts`), so new work on another account has to go through `fan_out` or
  `spawn_chat` as a visible desktop chat instead.
- Rate-limit auto-resume and cross-account failover are both off by default and trust only the CLI's own error
  report as evidence of a quota stop: model prose or tool output never counts, and a transient 529 that clears on its
  own is not a stop (`server/src/rate-limit-signal.ts`).
- Auto-update is off by default, and even when it is on it installs only what the install allows. A release build
  follows its `release-channel.json` (off: no check and no download; notify: tell, never install; auto: install the
  channel repository's verified release). A source checkout pulls the branch it tracks only when that remote is the
  channel's repository on GitHub and the working tree is clean, then reinstalls, rebuilds and relaunches on the same
  port, so for checkouts that track the channel's `main` a push to `main` is effectively the release
  (`server/src/updater.ts`, `server/src/release-channel.ts`).
- `redeem_codex_reset_credit` refuses to spend a banked Codex /usage reset credit unless the busiest rate-limit
  window is already 100% used (`force` bypasses the guard), so a credit is not wasted redeeming early
  (`server/src/mcp.ts`).
- Deleting a chat inside Claude Desktop only removes the app's own record, not the transcript; only `delete_chat`'s
  `--released` sweep finds and clears the leftover `<sid>.desktop-released.json` markers left on disk
  (`orchestrator/scripts/delete_chat.py`).
- UI-automation actuators that hunt for a chat row (archive, rename, delete) must collapse any sidebar project group
  they expanded, in a `finally` block that runs whatever the outcome, because earlier versions left the user's
  sidebar permanently rearranged (`misc/Manage-DesktopChat.ps1`).
- The native tray host wraps its daemon launch command in one extra quote pair and forces null stdio, because
  cmd.exe otherwise silently swallows the launch (reports success with no daemon running) and inherited terminal
  pipes can block the daemon before it ever binds its port (`misc/tray-host-native/src/daemon.rs`).
- Anything under `misc\` that the RUNNING daemon opens by path must be named in `RUNTIME_MISC_FILES` and resolved
  with `resolveMiscAsset`, never with `join(import.meta.dir, '..', ...)`: inside a compiled exe `import.meta.dir` is
  the virtual embedded root, so two `..` hops ask for a path on a drive that does not exist. Both actuators were
  broken this way and found a day apart (`server/src/misc-assets.ts`, `server/src/ui-archive.ts`).
- A PowerShell spawn's exit code is not proof the script ran: `powershell -File <missing>` prints its complaint and
  EXITS 0, so a `code === 0` check reported ok:true over a script that never existed, and `chat_rename` answered
  success three times while the sidebar never changed. The resolver returns non-zero itself when it has no path;
  prove the EFFECT (the rendered row, the read-back), never the exit code (`server/src/ui-archive.ts`).
- Archived chats never move in a batch by default, and the guard is a COUNT rather than a boolean: `move_chats` takes
  `archived_count`, which must equal the archived chats the batch holds (and they must be the whole batch), because a
  boolean an agent set for itself read identically to one a human asked for and queued 22 archived chats behind 3
  unarchived ones. `move_chat`, the singular, still takes `archived: true`
  (`orchestrator/scripts/migrate_batch.py`, `server/src/mcp.ts`).
- The Codex hub is off unless `AGENTHYDRA_CODEX_HUB_TOKEN` is set, and like the rest of the API it answers loopback
  Hosts only. Its pairing page hands out the hub token, so it is served only behind the operator's own sign-in,
  never through the forward the pushers use (`server/src/routes/codex-hub.ts`).
- Nothing upstream wrote after `3a65ba8e` may come into this repository. The audit's `license.boundary` rule and the
  pre-push hook refuse any history that contains the relicensing commit `aee9dfc4` (`scripts/audit-public.mjs`,
  `.githooks/check-public-push.mjs`), but they check ancestry only: a copy or a cherry-pick of upstream's later work
  makes commits without it, so the clean-room rule in `CONTRIBUTING.md` is what keeps that out.

## At a glance

- **Ships as:** a desktop app (Windows, macOS, Linux). Releases, once this repository publishes them, are a small
  launcher plus an `app/server.js` bundle, with Bun downloaded on first run, and a PowerShell one-line installer for
  Windows; until then, run it from source with Bun. AgentHydra's window is Desk 2 (`desk2/`, port 7798), and the
  daemon on `http://localhost:7787` is its engine and API.
- **Repository:** https://github.com/Jhacarreiro/AgentHydra-Community, releases from the channel in
  `release-channel.json`, versions `YYYY.M.PATCH` from `2026.10.0`.
- **Written in:** TypeScript (about 1,900 files), Vue (about 550), Python (about 520), with some JavaScript, Go (the
  Codex hub tray app), Rust (the window host, the tray host and CliMayte's worker runner), C# (the Windows launcher)
  and PowerShell.
- **Built with:** Bun, Hono, Vue, Vite, Tailwind.
- **Tests:** about 1,000 test files across the Bun, Python and Go suites.
- **CI:** `ci.yml`, `natives.yml` (the three Windows programs, built from source), `codex-hub-tray.yml` (the hub's
  tray, tested and built twice to compare), `release.yml` and `audit-public.yml` (the public audit, on every push and
  pull request).

## Architecture

- `server/` - Bun + Hono daemon: sqlite (queue, dispatch, scheduler, accounts), the Claude, Codex, OpenCode and
  foreign session readers, transcript tail, the scheduler, the instance runtime pointer, `core/` (Claude and Codex
  Desktop/CLI instance lifecycle, and the Codex hub), cloud sessions, and the MCP server (`mcp.ts`) that exposes the
  whole API to agents.
- `desk2/` - AgentHydra 2.0's window (Desk 2, called Hydra Desk 2 until 2026-10-06): its own Bun server on port 7798
  with a Vue web UI and a WebView2 window host; every chat in one sidebar, chats run through the Claude Agent SDK, and
  AgentHydra's accounts, quota, CliMayte, HSwarm, analytics, dev servers, a browser pane and connectors inside the
  window.
- `codex-hub-tray/` - the Codex hub's tray app (Go, for Windows, macOS and Linux), built by whoever runs a hub with
  its addresses; it pairs a PC, runs its pusher and keeps both up to date from the hub.
- `launcher/` - the release launcher: a small C# `AgentHydra.exe` on Windows and an sh `agenthydra` launcher on POSIX;
  it ships no Bun, downloads Bun into `runtime/` on first run, and restores any missing part of its version from the
  release archive, verified against `SHA256SUMS.txt`.
- `hswarm/` - HydraSwarm, AgentHydra's cheap worker swarm (Python): an MCP server and CLI that hand tasks to many
  cheap API models at once.
- `orchestrator/` - the Python toolbox (stdlib only, `orch.py` + `scripts/`) that decides what SHOULD happen to a
  chat (dry loop, sweep, moving chats between accounts, archiving, naming, tray-icon arm/disarm), talking to the
  daemon over HTTP only; it has its own remote server and web front-end, off until you configure a sign-in provider.
- `misc/` - Windows launcher toolkit: a native Rust tray host (`tray-host-native/`) whose Open starts AgentHydra's
  window and which starts, probes and stops the daemon, plus PowerShell daemon-supervisor and shortcut/icon scripts.
- `cloud/` - the Login sync Worker each person deploys for themselves.
- `tests/` - the Windows-gated tray launcher guard, the git hook suites, and server and instance unit tests.
- `scripts/` - repo tooling: the release and packaging scripts, the public audit, the README screenshot generator
  (fixture-driven, never a live daemon) and `scripts/checks/` guardrails, each written from a bug that shipped.
- `docs/` - REFERENCE.md (config, MCP, stack, checks), FORK.md, RELEASING.md, AI_USAGE_SELFCHECK.md,
  MOVING-CHATS-BETWEEN-ACCOUNTS.md and the rest.
- `.github/` - the CI, release and public-audit workflows.

## Features

Each path is where the feature is defined.

**Shipped**

- **Foreign-tool session reading (Cursor, Windsurf, Zed, Copilot CLI)** - A shared adapter reads and lists session
  history from other AI coding tools alongside Claude, Codex and OpenCode, read-only. - `server/src/foreign-sessions.ts`
- **Claude Code cloud and Remote Control sessions** - Opt-in (`AGENTHYDRA_CLOUD_SESSIONS=1`): lists each account's
  cloud and Remote Control sessions from Anthropic's API with the CLI's own login, never storing or refreshing its
  token, and shows them beside local chats, read-only, with working, waiting-on-you and done states. -
  `server/src/cloud-sessions.ts`, `server/src/cloud-sessions-cache.ts`
- **Codex chats from other PCs (Codex hub)** - Opt-in (`AGENTHYDRA_CODEX_HUB_TOKEN` on the hub,
  `AGENTHYDRA_CODEX_HUB_URL` on each PC): each PC pushes its Codex chat list and changed rollouts to one hub, which
  lists, searches and reads them beside its own, marked with their PC and left out of its usage analytics. While the
  PC is on, Desk continues one of its chats there through a relay; the PC accepts only reads, resumes and turns in
  existing chats, and by default only with approvals and the sandbox on. - `server/src/core/codex-hub.ts`,
  `server/src/core/codex-hub-push.ts`, `server/src/core/codex-hub-relay.ts`, `server/src/routes/codex-hub.ts`
- **Codex hub tray app and signed builds** - A tray app per PC pairs it through a page behind the operator's
  sign-in, starts at login, runs the pusher, and updates the pusher and itself from the hub, taking only builds signed
  with the operator's ed25519 key (or, built without a key on request, only over https). A build can trust two keys,
  so the key can change without setting each PC up again, and two builds of one commit are the same bytes. -
  `codex-hub-tray/`, `codex-hub-tray/build.sh`,
  `server/src/core/codex-hub-update.ts`, `server/src/core/codex-hub-signature.ts`, `scripts/codex-hub-sign.ts`
- **Reply into live Claude sessions, single or bulk** - The session composer types a message into the chat's own
  running Claude Desktop window and confirms it landed by watching the transcript grow; select several sessions to
  send the same message to each. A busy chat or a closed instance refuses rather than queueing. -
  `server/src/routes/session-message.ts`
- **ChatGPT handoff (context pack)** - Turns a task and working directory into a bounded, secret-scrubbed Markdown
  attachment, downloads it, copies a matching prompt and opens ChatGPT for the user to attach and submit themselves.
  - `server/src/context-pack.ts`
- **Cost & usage analytics** - Cost by day, model, project and account, session and agent-hour tiles, an
  hour-of-week activity grid, concurrency and sessions worth a second look, computed while the session list is built
  with no message text kept, including Hermes, DeepSeek Harness and HSwarm spend; also printable via
  `AgentHydra.exe --spend --json`. - `server/src/analytics.ts`, `server/src/routes/analytics.ts`
- **Claude Desktop instance management** - Create, open, focus, quit and delete isolated Claude Desktop profiles,
  each with its own account, name, icon and colour; see plan, remaining weekly quota (click a Weekly cell to copy its
  reset date), process, memory and uptime, and the paired isolated CLI login alongside it. -
  `server/src/core/lifecycle.ts`, `server/src/routes/instances.ts`, `desk2/hydra/src/components/CopyResetDate.vue`
- **Codex Desktop/CLI instance management** - Manages isolated Codex Desktop profiles and `CODEX_HOME` CLI homes the
  same way, so separate OpenAI logins run in separate Codex windows; open, focus and quit the desktop and launch or
  log in the CLI from the same row. On a Mac or Linux service with a minimal PATH, Codex is still found and started.
  - `server/src/core/codex-instances.ts`
- **Quick instance mode** - A compact portable window with just Claude Desktop/CLI and Codex start, focus and stop
  controls, skipping the session scanner, database, queue, scheduler, monitor and updater; it runs its own
  lightweight daemon on a separate port and can coexist with the full manager. - `server/src/fleet-instances.ts`
- **Windows system tray & native launcher** - A native Rust tray host whose Open starts AgentHydra's window through
  Desk 2's own launcher, and which starts, probes and stops the daemon by matching `/api/health`'s own service
  identity, so a neighbouring dev server on another port is never adopted or killed. The tray host, the window host
  and CliMayte's runner are built from their Rust source, never committed: each Windows release builds its own and
  publishes their checksums, and a checkout that has not built them runs the PowerShell tray, opens the window in the
  browser and runs CliMayte's workers under Bun. - `misc/tray-host-native/src/daemon.rs`,
  `misc/tray-host-native/src/main.rs`, `misc/AgentHydra-Tray.json`, `scripts/build-natives.ts`
- **Small release: a launcher plus a bundle, Bun fetched on first run** - A release is a small launcher
  (`AgentHydra.exe` on Windows, an sh launcher elsewhere) plus `app/server.js`, a `bun build` bundle that carries
  every runtime helper in `RUNTIME_MISC_FILES`. No Bun, no Claude Code and no Claude Agent SDK are shipped: the
  launcher downloads Bun into `runtime/` on first run and restores any missing part from the release archive,
  verified against `SHA256SUMS.txt`, Desk fetches the SDK version `desk2/sdk-pin.json` pins when a chat first needs
  it, and the packager fails a Windows archive over 30 MB. Every bundle carries `LICENSE`, `THIRD-PARTY-NOTICES.md`,
  `LICENSES/` and `THIRD-PARTY-LICENSES`, the licence and text of every third-party package inside it, and is not
  built when one falls outside the permissive allowlist. - `launcher/windows/AgentHydra.cs`,
  `server/src/misc-assets.ts`, `scripts/package-release.ts`, `scripts/third-party-licenses.ts`,
  `desk2/server/src/host/sdk-package.ts`
- **Auto-update (off by default, held to the release channel)** - Off until turned on in Settings (a saved choice
  overrides it); a background check updates a source checkout by git pull + reinstall + rebuild, only from the release
  channel's repository, and a release install by downloading that repository's latest release bundle and swapping it
  in, only when its `release-channel.json` says auto, then relaunches on the same port. - `server/src/updater.ts`,
  `server/src/auto-update.ts`, `server/src/release-channel.ts`
- **MCP server exposing the full API to agents** - One MCP server over the daemon's API, served over stdio and over
  HTTP at `/api/mcp`, so an agent drives sessions, instances, usage, chat moves, fan-out and the orchestrator through
  the same source of truth as the window. - `server/src/mcp.ts`, `server/src/index.ts`, `server/src/mcp-stdio.mjs`
- **Agent self-identification & quota self-check** - `whoami` works out which Claude or Codex account the calling
  process bills to, with a confidence level; `check_usage`, `check_my_usage` and `usage_budget` read that account's
  5-hour and weekly quota so an agent can pace itself before a fan-out without asking a human. -
  `server/src/core/instance-ref.ts`, `server/src/mcp.ts`, `server/src/usage-service.ts`
- **Orchestrator: standing decision loop for chats** - A sibling Python toolbox decides what should happen to a chat
  (dry loop, sweep, moves between accounts, archiving, naming, tray-icon arm/disarm), steered by a policy file and
  driven through the daemon's `orchestrator_*` MCP tools; nothing acts unless the tray icon is armed, and
  `orchestrator_cancel` kills a running operation's process tree and frees its route lock. - `orchestrator/orch.py`,
  `server/src/mcp.ts`
- **Email notifications on rate-limit reset / usage events** - Sends an SMTP email (own mailer, no third-party
  service) when a rate-limited session's window resets or another watched usage event fires, configured from
  Settings. - `server/src/reset-watch.ts`, `server/src/notify-smtp.ts`
- **Failure incident tracking** - Groups repeated failures (and version-drift flags) by scope, key and normalized
  error signature into a durable incident tracked open -> acked -> resolved, reopening if a resolved signature recurs;
  list, ack and resolve over HTTP and MCP, with email or OS notification. - `server/src/incidents.ts`,
  `server/src/routes/incidents.ts`
- **Codex rate-limit reset credit redemption** - Spends one banked Codex /usage reset credit to restore the full
  5-hour and weekly windows in one shot; refuses unless the busiest window is already 100% used (`force` bypasses).
  - `server/src/mcp.ts`, `server/src/core/codex-account.ts`
- **Move a chat between accounts in one call (`move_chat`)** - Fuzzy-matches a chat's title and resolves from and to
  by instance number, name, label, email, "here" or "best", then drives the orchestrator's `migrate_chat` through every
  rail (hold, breaker, live-writer refusal, verified landing, source row settled) in one call. Still the only way to
  move a single ARCHIVED chat a human named, via `archived: true`. - `server/src/mcp.ts`,
  `orchestrator/scripts/migrate_chat.py`, `docs/MOVING-CHATS-BETWEEN-ACCOUNTS.md`
- **Fan-out: one task list over other accounts as visible chats (`fan_out`)** - One chat's task list is spread over
  OTHER signed-in accounts as visible desktop chats, one account each, ranked by real quota room; `fan_out_status`
  reads every member's verdict and last words, `fan_out_send` steers the group, `fan_out_recover` meets each failed
  member with a fixed recovery recipe, and `fan_out_delete` cleans a probe group up. - `server/src/mcp-fan-out.ts`,
  `orchestrator/scripts/fan_out.py`, `orchestrator/scripts/lib/recoverylib.py`
- **Delete a chat everywhere, with undo (`delete_chat`)** - Removes ONE chat from every place it exists (the desktop
  meta record in every profile, the CLI transcript and every sidecar) with an undo copy taken first; `--released`
  sweeps the transcripts Claude Desktop's own Delete abandons. Run as an orchestrator act. -
  `orchestrator/scripts/delete_chat.py`
- **Move MANY chats in one call, bounded and detached (`move_chats`)** - Every chat is moved and verified, then every
  source row settled and stamped once per batch; it detaches past a declared limit with an operation id, bounds and
  names each phase's timeout per chat, refuses archived chats unless `archived_count` equals them exactly, and
  `migrate_reconcile` heals half-moves a killed batch leaves. - `server/src/mcp.ts`,
  `orchestrator/scripts/migrate_reconcile.py`, `orchestrator/scripts/migrate_batch.py`
- **Unified session browser (Claude, Codex, OpenCode, Hermes, DeepSeek Harness)** - Browse, filter (provider,
  project, instance, recency), search and live-tail transcripts together, newest first; mark sessions done, and open a
  raw Claude or Codex `.jsonl` in the editor, download it under its real title, or copy it out. -
  `server/src/sessions.ts`, `server/src/routes/sessions.ts`
- **DeepSeek Harness as a first-class session source** - DeepSeek Harness chats list, search, tail, export and PRICE
  alongside the other sources, read straight off `~/.dsh` with nothing to configure and nothing written back. It
  needs its own reader because the store is multi-frame Zstandard, and `Bun.file().text()` on those bytes does not
  throw, it returns mojibake. - `server/src/dsh-sessions.ts`, `server/src/pricing.ts`
- **DeepSeek Harness homes as managed instances** - Every `DSH_HOME` on the machine in one table: launch a hidden
  `dsh web` and its chromeless window, see which are serving and on what port, stop one, or give a second account its
  own home. The harness's one-time `?token=` never leaves the daemon. - `server/src/core/dsh-instances.ts`,
  `desk2/hydra/src/components/DshInstanceRows.vue`
- **Claude version drift across the fleet** - Flags a running Desktop behind the newest installed Claude build, or a
  live chat on an older engine, as an incident (never killed), runs the classic install's own `Update.exe --update`
  when Claude Desktop's update feed offers a newer build, hard-links a closed profile's staged build up to the newest
  verified copy and updates the npm CLI when nothing runs from it; `AGENTHYDRA_VERSION_AUTOFIX=0` makes it flag only,
  though it still asks the feed. - `server/src/version-drift.ts`, `server/src/routes/versions.ts`,
  `server/src/mcp.ts`
- **Stale-daemon detection with one-click restart** - A source install running older code than its checkout says so
  in `/api/health`, every MCP result and the app header, with a one-click Restart; a startup watchdog exits with a
  distinct code if boot hangs before the port binds, so the tray supervisor restarts it. -
  `server/src/core/running-code.ts`, `server/src/boot-watchdog.ts`
- **HSwarm jobs as a first-class session source** - Reads HSwarm's job records off `HSWARM_HOME` (`~/.hswarm`) as one
  session per job, so a fan-out job lists, searches and tails like any other transcript, priced from HSwarm's own
  ledger and live DeepSeek balance, read-only, with the API key never logged or returned. The source keeps its frozen
  id `zswarm`. - `server/src/hswarm-sessions.ts`, `server/src/hswarm-cost.ts`, `server/src/agent-catalog.ts`
- **Import a session into a desktop app** - Turns a CLI or finished session into a real chat inside a chosen Claude
  Desktop instance, so it can be seen and continued by hand there; available from the UI and as the
  `import_session_to_desktop` MCP tool. - `server/src/session-launch.ts`, `server/src/mcp.ts`
- **Claude native control for desktop instances** - Opens AgentHydra's Claude Desktop profiles with a local debugger
  connection (on by default for its own profiles on Windows, with a per-profile opt-out in Settings), so archive,
  migration-source cleanup and a message into a stopped chat run through the app's own session manager instead of
  sidebar UI automation. - `server/src/routes/desktop-sessions.ts`, `server/src/core/claude-native/native-program.ts`,
  `server/src/core/instances.ts`
- **One-line Windows installer with SHA-256 verification** - `irm .../install.ps1 | iex` installs the release archive
  under `%LOCALAPPDATA%` without admin, downloads only from the release channel's repository, refuses to install
  unless the download matches the release's published `SHA256SUMS.txt`, and creates a Start Menu shortcut. While
  the channel has no releases it refuses before downloading anything; `-FromZip` installs a local build. -
  `install.ps1`
- **The public audit** - One command reads the tree and every commit since the MIT base for secrets, personal data,
  private addresses, upstream hosts and private repository names, unrecorded binaries, non-noreply commit emails and
  any commit with the relicensing commit in its history; CI and the pre-push hook run it. - `scripts/audit-public.mjs`,
  `.githooks/check-public-push.mjs`, `.github/workflows/audit-public.yml`

**Partial - exists but incomplete, gated off, or known broken**

- **Run queue with scheduler** - The queue view keeps past claude CLI runs (prompt, model, exit code, output)
  inspectable, but creating or dispatching any new run is refused by the permanent no-headless policy, so the
  scheduler has nothing it can start. - `server/src/routes/queue.ts`, `server/src/dispatch.ts`,
  `server/src/headless-policy.ts`
- **Rate-limit auto-resume & cross-account failover** - Off by default: finds Claude sessions a 5-hour limit stopped
  (trusting only the CLI's own error report) and lists them as a session filter; once the window resets, a thread
  with no desktop home is imported into the desktop instance with most quota headroom, while a thread already in a
  desktop app is only marked and waits for its owner. Cross-account failover was retired. -
  `server/src/rate-limit-signal.ts`, `server/src/rate-limit-discovery.ts`, `server/src/monitor.ts`

## Where to add a new one

- **A new MCP tool exposed to agents** - add a tool definition and handler to the TOOLS array in `server/src/mcp.ts`
  beside the existing ones; label a mutating tool `MUTATES:` in its description.
- **A new session source or provider reader** - implement the Adapter interface (list, listAsync, read) in
  `server/src/foreign-sessions.ts` and register it in ADAPTERS, or add a dedicated first-class reader like
  `dsh-sessions.ts` or `hswarm-sessions.ts`.
- **A new rate-limit resume behaviour** - extend `server/src/monitor.ts`'s per-stop pipeline and
  `dispatchDueResumes`; a resume may only land in a desktop app, since `dispatchItem` refuses every headless run.
- **A new orchestrator act (script)** - add one script under `orchestrator/scripts/` following the
  one-script-per-act pattern, with its own rails and tests; `orch.py`'s catalog lists the scripts on disk and `main()`
  dispatches to them.
- **A new isolated-instance kind (beyond Claude, Codex and DSH)** - follow `server/src/core/lifecycle.ts`'s
  `createInstance` for a Desktop profile lifecycle, or `server/src/core/codex-instances.ts`'s `createCodexInstance`
  for a CLI-home style.
