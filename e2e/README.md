# e2e: the black-box lane

End-to-end scenarios that run the real daemon (`bun server/src/main.ts`), Desk 2's server and the
MCP stdio server as child processes in throwaway homes, and drive them only over HTTP, stdio and raw
sockets. Nothing here imports from `server/src` or `desk2`, so the lane sees what a person or a
client sees. It adds to the root suite and changes none of it.

## TL;DR

- **Run it:** `bun install --frozen-lockfile` at the root and in `desk2/`, then `cd e2e && bun run test`. About 25 s on Linux.
- **Five scenarios:** E1 boot and store, E2 CliMayte dispatch, E3 Origin/Host guards, E4 MCP over both transports, E6 idle egress.
- **Hermetic:** every scenario runs in its own temp home with outbound traffic refused and counted, and ends by checking that the real `~/.claude.json`, `~/.claude`, `~/.codex` and their siblings did not change.
- **Known bugs stay visible:** a bug the lane knows of is asserted as it should behave and marked `[known bug, fix proposed in <pull request>]` (none open today). The lane stays green while it fails and goes red once the bug is fixed, as a cue to drop the marker.
- **Root suite untouched:** the files are `*.e2e.ts`, which a `bun test` at the root never picks up.
- **CI:** `.github/workflows/e2e.yml` on ubuntu-latest (push to main, pull requests, daily, manual).

<details>
<summary><b>Running it locally</b></summary>

Linux, Bun 1.4, and `strace` for E6 (below). From the repository root:

```sh
bun install --frozen-lockfile
(cd desk2 && bun install --frozen-lockfile)   # E3 starts Desk 2's server
cd e2e
bun run test        # every scenario: bun test --todo --timeout 120000 ./*.e2e.ts
bun run typecheck   # tsc with the server workspace's TypeScript and Bun types
bun test --todo ./e2-climayte-dispatch.e2e.ts   # one scenario
```

Run from inside `e2e/`: the root's `bunfig.toml` preload is for the root suite. Keep `--todo`, or
the known-bug assertions are listed but not run.

- `E2E_TMP=<dir>`: where the temp homes go (default: the OS temp dir).
- `E2E_KEEP=1`: keep every temp home, with its `logs/` (each daemon boot, the second daemon, Desk 2, the MCP stdio server, E6's strace). CI sets it and prints the logs when a run fails.
- `E2E_REQUIRE_STRACE=1`: E6 fails instead of falling back to sampling when `strace` is missing or cannot trace here (its boot test fails, its idle test is skipped). CI sets it.
- `E2E_STRICT_HOME=1`: compare the real home strictly even inside a Claude Code session (below).

About 10 s of a run is E6's idle window.

</details>

<details>
<summary><b>What every scenario shares (harness.ts)</b></summary>

- **A temp home per scenario**, with every root the daemon and its children read pointed inside it: `HOME`, `USERPROFILE`, `LOCALAPPDATA`, `APPDATA`, `XDG_*`, `TMPDIR`, `AGENTHYDRA_HOME`, `AGENTHYDRA_DATA_DIR`, `AGENTHYDRA_DB`, `AGENTHYDRA_INSTANCES_ROOT`, `AGENTHYDRA_CLAUDE_PROJECTS_ROOT`, `AGENTHYDRA_CORE_DIR`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `AGENTHYDRA_MCP_CONFIG`, `HYDRA_DESK_HOME`, `HYDRA_FAMILY_DIR`, `HSWARM_HOME`, `ORCHESTRATOR_STATE_DIR` (after `scripts/smoke-release.ts` and `tests/setup.ts`). The child env is built from scratch, so nothing from the developer's shell but `PATH` (behind the fake CLI's folder) reaches the daemon.
- **A free port per daemon**, Desk 2 and HSwarm included. The daemon must answer `/api/health` from the temp home's store, or the scenario stops.
- **Auto-update off at boot.** A fresh store has it off (`server/src/db.ts`, `auto_update_enabled`), but once on it updates the checkout it runs from with `git pull` and a reinstall, which here is the checkout under test. So the harness switches it off over `POST /api/update/settings` as soon as the daemon answers, whatever the default; its first tick is 6 h out.
- **No network.** `HTTPS_PROXY`, `HTTP_PROXY` and `ALL_PROXY` point at a loopback listener that records each connection and refuses it.
- **A fake Claude CLI.** `AGENTHYDRA_CLAUDE_PATH`, and `claude` first on `PATH`, run `server/tests/mocks/fake-claude.ts`, so nothing can reach a real login.
- **HSwarm off** (`AGENTHYDRA_HSWARM_ENABLED=0`). The sidecar needs Python packages the lane does not install; it would run on one machine and crash at import on another. Its daemon routes are still swept by E3.
- **Cleanup.** Every process whose environment carries the home's `E2E_HOME` is SIGKILLed at the end (read from `/proc`), wherever a SIGKILLed daemon's children were reparented, and also when the run itself is stopped with SIGINT or SIGTERM. Then the home is removed, on a stopped run too, unless `E2E_KEEP=1`.
- **The real home is checked last.** Each scenario snapshots `~/.claude.json`, `~/.claude`, `~/.codex`, `~/.claude-instances`, `~/.agenthydra`, `~/.hydra-desk-2`, `~/.hswarm` (and the shell's `CLAUDE_CONFIG_DIR` / `CODEX_HOME`) before anything starts: path, size, mtime and a hash for files up to 1 MiB. Its last test stops everything and compares. A root that is itself a symlink (into a dotfiles checkout, say) is walked at its target, and where it points is recorded too. A symlink inside a root is recorded, not followed: retargeting it is caught, a write through it to a folder outside these roots is not. In CI the comparison is strict. Run inside a Claude Code session (`CLAUDECODE` set), it skips what that session writes on its own (its transcripts and session state under `~/.claude`, and `~/.claude.json` apart from its `mcpServers` key, which is what AgentHydra writes there). `settings.json`, `.credentials.json` and hooks are always compared.

</details>

<details>
<summary><b>What each scenario guards</b></summary>

**E1, two boots on one store** (`e1-boot-state.e2e.ts`). A fresh home boots with auto-update off. Settings written over `POST /api/settings` read back at once. A second daemon on the same store says "already running", exits 0 and leaves the first serving. SIGHUP ends the daemon with exit 1 and a `CRASH reason=signal:SIGHUP` record (`server/src/index.ts` treats it as fatal on purpose). The next boot keeps every setting, auto-update off included. The store's schema is read read-only from `sqlite_master` after each start, and the `session_stats_gone` index must stay dropped after every one, the second daemon's included. Covers from outside what `tests/settings.test.ts` covers in process.

**E2, CliMayte dispatch** (`e2-climayte-dispatch.e2e.ts`). A CLI instance created over `POST /api/cli-instances` lives inside the temp home. Seeded with a fake `.credentials.json` and a usage reading in `DATA_DIR/usage-cache.json`, it reads as signed in. One task over `POST /api/corch/workers` runs to done on the fake CLI, launched exactly once. The same `requestId` sent again answers the same worker with `repeat: true`, in that worker's group. Once the store on disk has the worker done, a SIGKILL and a reboot keep it done, and the request still repeats without a second launch. A second task is then killed at the worst moment: the daemon is SIGKILLed as the runner's exit file goes (watched with `fs.watch`), before the worker's end reaches the disk. After the reboot the worker may read done or running (see the findings), but it is never launched again, never gets a second attempt, and its request still answers the same worker. This is what `server/tests/climayte-request-id.test.ts` and `climayte-steering.test.ts` check in process, with the instance store, the usage cache and HTTP in the path.

**E3, Origin and Host guards** (`e3-origin-host.e2e.ts`). Every route the daemon mounts on its shared app (`app.<verb>('/api/...')` in `server/src/index.ts`, in every module that imports that app, `server/src/routes/*.ts` among them, and in every module `index.ts` hands it to; read as text each run, 261 today), under `/api` and under Desk 2's `/ah/api` mirror, is sent a foreign Origin, another local port's Origin, the `null` Origin, a rebound Host, and `Sec-Fetch-Site: cross-site`. Each must get 403 from the loopback guard before any handler runs. Because the list is read each run, a route added tomorrow that escapes the guard fails here. The sweep starts only once `/api/health` (GET and POST, both prefixes) refuses every case: with the guard down it would run every handler, `POST /api/update/apply` (a `git pull` and reinstall of the checkout under test) and `POST /api/shutdown` among them, so a guard that is down fails the scenario before that. The daemon still answers its own origin in both spellings and a client with no browser headers. A foreign preflight is not granted. Desk 2's server is started too: its API and its `/ws` upgrade, which bypasses Hono, refuse the same hostile requests and accept Desk 2's own origin.

**E4, MCP over stdio and HTTP** (`e4-mcp.e2e.ts`). `bun server/src/mcp.ts` (stdio, relaying to the daemon) and `POST /api/mcp` initialize as the same server and list the same tools. `list_sessions` finds a seeded Claude transcript over both transports. `add_queue_item` is refused with HTTP 409 (no-headless) over both, and the queue stays empty. The stdio server exits 0 when its client closes stdin.

**E6, idle egress** (`e6-idle-egress.e2e.ts`). A fresh boot may reach only its one documented download: the model price list (`server/src/price-catalog.ts`, raw.githubusercontent.com). On Linux the daemon runs under `strace -f`, which records every `connect`, `sendto`, `sendmsg` and `sendmmsg` call the daemon, its threads and its children make from the moment it starts. None of them, during the boot or the idle window below, may name an IPv4 or IPv6 address other than loopback, or port 53 on any address (a DNS query, loopback included: on Ubuntu the resolver is systemd-resolved's stub on 127.0.0.53, which sends it on), and a failed call counts. That sees a client that ignores the proxy however briefly its connection is open, a UDP datagram to anything but loopback, and a DNS query through `resolv.conf`. A lookup made over a Unix socket (nscd, or systemd-resolved's own socket through glibc's `resolve` module) is not seen by itself; a connection to the address it returns is. Once the boot goes quiet, the daemon is left alone for 10 s and must make no outbound attempt at all, through the proxy or directly. This catches a background fetch a change starts at boot or on a short timer. Without a working `strace` (missing, or unable to trace here), E6 prints a warning and samples the open TCP sockets of the daemon and its children from `/proc` every 250 ms during the idle window instead, which misses a connection opened and closed between two samples and every datagram; `E2E_REQUIRE_STRACE=1` (CI) turns that into a failure. A timer that first fires after the window is not seen: the update loop's first tick is hours out, so what keeps it from running here is the harness switching auto-update off, not E6.

The numbering leaves a gap on purpose: E5 is kept for the Codex hub.

</details>

<details>
<summary><b>Known findings</b></summary>

Each known bug is one `knownBug(...)` test (harness.ts). While the bug is there it reports as `todo` and prints `known bug still present`, plus a `::warning` annotation on GitHub. Once fixed, bun fails it with "marked as todo but passes"; then turn it into a plain `test`, so the fix stays guarded.

None is open today. Three bugs this lane found are fixed, and it asserts each fix as a plain test:

- **The `session_stats_gone` index came back on every start after the first** (E1). The base schema created it on every open and the schema's v1 step dropped it only while `user_version < 1`, so every later start brought it back, a second daemon that exits at once at the single-instance guard included (the schema runs when db.ts is imported, before the guard). Fixed in dedc881: the base schema drops it on every open.
- **`tests/mcp.test.ts` asserted the opposite of the daemon** (E4). It stubbed `fetch` and expected `add_queue_item` to succeed, while a live daemon refuses every call with 409 (`server/src/routes/queue.ts`, `headlessRunsAllowed()` is `false`), as the tool's own description says (`server/src/mcp-session-tools.ts`). Fixed in 9a9581b: the MCP test hands the call to the daemon's routes and expects the refusal.
- **A repeated request to an unnamed CliMayte group answered with a new group name** (E2). The workers were the right ones (`repeat: true`, same id), but the reply's `group` was a fresh `g-xxxxxx` that held none of them. Fixed in fa5f5e3: a repeat answers in its workers' own group.

Behaviour the lane asserts as it is:

- **A worker that ends as the daemon dies reads `running` after the reboot, for up to five minutes from its launch** (E2). `finish()` in `server/src/climayte.ts` removes the runner's pid and exit files on the daemon's thread (`cleanUpRunner` in `server/src/climayte-stops.ts`), while the worker's end is only queued to the disk (`changed` and `save` in `server/src/climayte-core.ts`, written off the thread by `server/src/climayte-store-writer.ts`). Killed in between, the store still has the attempt running, and `workers.json`'s copy wins over `done/` (`mergeDone` in `climayte-core.ts`). When the runner's pid had not reached the store yet, the reboot finds no exit file and no pid, so `attemptExited` (`climayte-stops.ts`) reads the attempt as a spec no runner has claimed yet, timed from its launch (`unclaimedFor` in `server/src/climayte-runner.ts`): not ended for `RUNNER_CLAIM_MS` (60 s), then not until `RUNNER_CLAIM_GIVE_UP_MS` (5 min). Then it is settled from its log, which is still there. (When the pid had reached the store, the gone runner reads as ended at once.) Nothing is launched twice. E2 asserts that, on either side of the race, and is not a known-bug marker because a kill can still land after the write. Removing the runner files only once the store round that records the end has landed would close the window.
- **Desk 2 accepts any loopback Origin** (`desk2/server/src/index.ts`, `isLocalHost`). The daemon accepts only its own (AH-11). E3 does not assert the other-local-port case on Desk 2.

</details>

<details>
<summary><b>What the lane leans on</b></summary>

- `server/tests/mocks/fake-claude.ts` and `AGENTHYDRA_CLAUDE_PATH` (E2).
- The shapes of a CLI instance's `.credentials.json` and of `DATA_DIR/usage-cache.json` (harness.ts `signIn`, E2).
- CliMayte's store layout under `AGENTHYDRA_HOME/corch`: `workers.json`, `done/<id>.json`, and `logs/<id>-<n>.jsonl.exit.json` beside each attempt's log (E2).
- `POST /api/cli-instances`, `POST /api/corch/workers`, `GET /api/corch/workers/:id`, `/api/update/settings`, `/api/settings`, `/api/health` (`dbPath`, `pid`).
- Routes registered as `app.<verb>('/api/...')` on the shared app from `server/src/http-app.ts` (E3 fails loudly if the scan finds 200 or fewer).
- The `[agenthydra] CRASH reason=signal:SIGHUP` and "already running" log lines (E1).

A red run is one of two things: one of these seams moved (fix the lane in the same change), or the app regressed (fix the app, and keep the scenario as the test that caught it).

</details>
