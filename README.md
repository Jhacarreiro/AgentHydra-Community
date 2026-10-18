<div align="center">

# AgentHydra Community

### Every AI coding chat on your PCs, and every Claude and Codex account, in one window

[Download](https://github.com/Jhacarreiro/AgentHydra-Community/releases) &nbsp;·&nbsp; [Reference](docs/REFERENCE.md) &nbsp;·&nbsp; [Changelog](CHANGELOG.md) &nbsp;·&nbsp; [Why this fork](docs/FORK.md) &nbsp;·&nbsp; [Contributing](CONTRIBUTING.md)

[![CI](https://img.shields.io/github/actions/workflow/status/Jhacarreiro/AgentHydra-Community/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/Jhacarreiro/AgentHydra-Community/actions/workflows/ci.yml)
[![Public audit](https://img.shields.io/github/actions/workflow/status/Jhacarreiro/AgentHydra-Community/audit-public.yml?branch=main&style=flat-square&label=public%20audit)](https://github.com/Jhacarreiro/AgentHydra-Community/actions/workflows/audit-public.yml)
[![Release](https://img.shields.io/github/v/release/Jhacarreiro/AgentHydra-Community?include_prereleases&style=flat-square&color=c15f3c)](https://github.com/Jhacarreiro/AgentHydra-Community/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-c15f3c?style=flat-square)](LICENSE)

</div>

---

AgentHydra Community is a community fork of [AgentHydra](https://github.com/LunarWerxs/AgentHydra), continued from
`3a65ba8e`, its last MIT-licensed commit, and it stays MIT. Like AgentHydra, it is one window over every AI coding
chat and every Claude and Codex account you use, built on the files your tools already write: no sign-up and no
hosted service.

**What this fork adds first: one home server for several PCs.** Run AgentHydra on a home server, or any PC that
stays on, and let your other PCs report to it:

- **Codex hub:** each PC pushes its Codex chats to that one AgentHydra, which lists, searches and opens them beside
  its own, each marked with the PC it came from. While a PC is on, you can continue one of its chats from the hub:
  the turn runs on that PC, with its files and its Codex sign-in, and asks you for approvals as usual.
- **A tray app on each PC** (Windows, macOS or Linux; you build it with your hub's addresses): it pairs the PC
  through a page behind your own sign-in, starts at login, keeps the PC sending, and updates itself and the pusher
  from the hub, taking only builds signed with your key (or, built without a key, only over https).
- **Claude Code cloud sessions beside local ones:** cloud and Remote Control sessions appear in the same list as the
  chats on your disk, read-only, with which ones are working or waiting on you.
- **The inbox from a phone:** the window can sit behind a reverse proxy that signs you in first, so the same list
  opens on your phone.

All of this is off until you set it up, and it is new: it is covered by the repository's tests (the hub, relay,
pairing and signing suites, and the tray's own Go tests, run on Linux) but has not been in a published release yet.
See [One server, several PCs](#one-server-several-pcs).

**Why a fork.** On 15 October 2026 AgentHydra moved from the MIT licence to PolyForm Noncommercial. This fork's
maintainer also disagrees with how outside contributions were credited there: on 17 October 2026 all of the
maintainer's pull requests to AgentHydra, #8 to #24, were closed, and several were rebuilt in upstream commits that
credit no outside author. Here a contribution keeps its author's name. The full provenance is in
[docs/FORK.md](docs/FORK.md).

AgentHydra Community is maintained independently by [@Jhacarreiro](https://github.com/Jhacarreiro) and its
contributors. It is not affiliated with or endorsed by LunarWerx Studios, and it keeps the original copyright
notices ([LICENSE](LICENSE)).

![The window: the sidebar lists every chat grouped by project, and the open chat shows its to-dos and a permission prompt](.github/screenshots/window.png)

<sub>Screenshots use demo data. Some still show the original project's logo and Discord button.</sub>

## TL;DR

- **One server, several PCs:** your PCs' Codex chats in one inbox, continued on the PC they belong to, with a tray
  app that pairs each PC (opt-in)
- **Claude Code cloud sessions beside local ones:** which are working or waiting on you, in the same list (opt-in)
- **Every chat in one sidebar:** AgentHydra's own Claude Code chats, Claude Desktop's and the CLI's, Codex and
  OpenCode, grouped by project, live while they run
- **New starts from your projects:** a grid with each one's git state and open chats, the busiest first
- **Dev servers built in:** start, stop and watch your projects' local servers, and open them beside the chat
- **CliMayte:** hand a task's pieces to your other Claude CLI accounts, and a worker moves on when one runs out
- **Where the time and money went:** cost by day, model, project and account, and what is wasting it
- **Every Claude and Codex account in one table:** plan, 5-hour and weekly quota, open, quit, create
- **For agents too:** the whole thing over MCP, including "which account am I, and how much is left"
- **Nothing phones home:** updates are off until this project publishes releases, no install id is sent, and
  nothing talks to a LunarWerx service
- **A public audit** checks every file, and every commit since the MIT base, for secrets, personal data and
  anything from upstream's relicensing on

<details>
<summary><b>Read more: what each part does</b></summary>

### Every chat, in one window

- The sidebar holds AgentHydra's own Claude Code chats (composer, permission prompts, to-dos, diffs,
  Create PR) beside your Claude Desktop chats and CLI sessions, grouped by project. Filter by app, or
  keep only what is running or waiting on you. With Login sync, your other PC's chats are there too.
- Codex chats are listed and can be continued in the window, on the Codex account that holds them. OpenCode,
  Hermes and DeepSeek Harness conversations are listed and readable.
- **New** opens a grid of your projects, from the folders you add, wherever your chats ran and Project Hydra
  if you use it, each with its git state and how many chats are open in it. A chat started in a parent
  folder counts for the project it actually worked in, and is filed into that project's group.

![The New screen: a grid of projects, two of them with a count of open chats](.github/screenshots/new.png)

### Dev servers, built in

- The Dev servers page lists your projects' local servers: start, stop, restart, logs, errors, CPU
  and memory, alerts. A browser pane beside the chat opens any of them.
- A folder needs no setup: it reads Claude Code's `.claude/launch.json`, or `package.json`'s dev
  scripts. (This was DevWebUI; it is part of AgentHydra now.)
- **ChatGPT handoff** packs the task and repository into a Markdown file (common secret files left
  out), copies a prompt and opens ChatGPT. You review and send it yourself.
- Open a raw Claude or Codex `.jsonl` in your editor, download it under its title, or copy it.

### Reply, fan out, or move a session, never headless

AgentHydra never runs a chat you cannot see: every run is in a real app window.

- **Reply** into a session's own desktop chat; it checks the message landed. A busy chat says so.
- **Fan out** a task list across your other signed-in accounts (MCP `fan_out`), one visible chat
  each, and steer them with `fan_out_send`.
- **Import** a session into a desktop app to continue it by hand.
- **Move** a chat to another account with `move_chat`, or several with `move_chats`. It keeps its
  history ([Moving chats between accounts](docs/MOVING-CHATS-BETWEEN-ACCOUNTS.md)).

The old run queue stays as a read-only record. Starting a new headless run is refused on purpose.

### CliMayte: hand a task's pieces to your CLI accounts

- A chat keeps the plan and hands each piece to a Claude Code CLI session on one of your accounts.
  When an account nears its limit, the worker moves to another and carries on.
- No console windows, but nothing hidden: every worker is readable and steerable in the CliMayte
  view, and its transcript is a normal session.
- **Quick add:** type an email, sign in in the window it opens, and the account is ready.
- **Two PCs:** with Login sync, each PC sees the other's CliMayte tasks and never crowds the same
  account. Desktop and AgentHydra chats can be shared too, view only.
- Over MCP: `climayte_run`, `climayte_status`, `climayte_send`, `climayte_cancel`, `cli_limit_reset`.
  Details: [docs/CLIMAYTE.md](docs/CLIMAYTE.md).

### Where the time and the money went

![The analytics view: tiles for tokens used, cost at API rates, HSwarm savings and the busiest model above a cost-by-day bar chart, cost by model, project and account, and sessions and tokens by tool across Claude, Codex, OpenCode and Hermes](.github/screenshots/analytics.png)

- Cost by day, model, project and account (at list prices: what the same work would cost on the
  API). When in the week you work, how many sessions ran at once, which tools were used.
- Why it cost that much: skills and MCP servers loaded and never used, calls past 150k tokens of
  context, what subagents spent, cache use per account, each with a one-line fix.
- Sessions worth a second look: a tool that kept failing, a compacted context, code that was gone
  from its files two hours later.
- **Recurring mistakes** pairs each failed shell command with the one that fixed it, and **Copy as
  rules** turns them into a rules file for your agents.
- `AgentHydra.exe --spend --json` prints the same numbers.

### Every account, in one table

![The instances view: Claude Desktop accounts, a Codex account, a DeepSeek instance and a CLI account in one table, each with its five-hour and weekly usage, when they reset, its plan and when it was last active](.github/screenshots/instances.png)

- Each Claude Desktop instance with its account, plan, quota and process. Open, focus, quit,
  create and delete them, and give each a name, icon and colour.
- Codex Desktop and CLI the same way, each with its own login.
- **Claude native control:** turn on **Start debugger automatically** for an account
  (**Settings → Instances → Desktop**) and archiving and migration use Claude's own session
  manager ([guide](docs/CLAUDE-DESKTOP-NATIVE-CONTROL.md)).
- **Quick instance mode** (`AgentHydra.exe --instances`, or `bun run instances` from source) opens a
  small window that only starts and stops instances.

### For agents

- Everything is on MCP ([docs/REFERENCE.md](docs/REFERENCE.md)).
- `whoami` and the usage tools tell an agent which account it runs on and what is left, before it
  fans out ([docs/AI_USAGE_SELFCHECK.md](docs/AI_USAGE_SELFCHECK.md)).
- The **orchestrator** ([`orchestrator/`](orchestrator/README.md)) decides what should happen to a
  chat (sweeps, moves, archiving, naming), through the same MCP server and only while the tray icon
  is up. `orch.py policy` holds its switches.

### How it compares

Claude Squad and Conductor start new sessions in fresh git worktrees. AgentHydra starts nothing on its
own: it reads the history and account state your tools already write, and adds analytics and account
management on top. Cursor and Windsurf are editors; AgentHydra is a dashboard over the CLIs and apps
you already have.

</details>

## One server, several PCs

Pick one AgentHydra as the hub, usually on a home server that stays on, and point each PC at it. Nothing below
runs until you set its variables.

<details>
<summary><b>Read more: the hub, each PC, the tray app, cloud sessions and the phone</b></summary>

- **The hub:** set `AGENTHYDRA_CODEX_HUB_TOKEN` to a long random token. Like the rest of AgentHydra's API, the
  hub answers loopback only, so other PCs reach it through a reverse proxy you run: `/api/codex-hub/`, where the
  token is the authentication, and the pairing page `/codex-hub/pair`, which hands out that token and so is served
  only behind your own sign-in. On a machine with no screen, `AGENTHYDRA_DESK_AT_BOOT=1` starts the window's
  server with the daemon, so the proxy has something to reach after a restart.
- **Each PC:** set `AGENTHYDRA_CODEX_HUB_URL` and the same token. Its AgentHydra pushes its Codex chat list and the
  chats that changed every two minutes; a PC that does not run AgentHydra can run the standalone pusher. A chat
  archived or deleted on the PC leaves the hub at its next push. The hub's usage analytics leave these chats out,
  since they are the other PC's usage.
- **Continuing a chat from the hub:** the PC keeps a connection open to the hub, and when you continue one of its
  chats, its own Codex runs the turn. The PC lets the hub only read, resume, start and stop turns in chats it
  already has (never start a chat, change its configuration or sign in), and by default it refuses a turn without
  approvals or outside the sandbox. Close the chat in the Codex app on that PC first.
- **The tray app** (`codex-hub-tray/`, Go) is built by whoever runs the hub, with the hub's addresses and, if you
  sign builds, your public key. No release includes it. Opened once, it installs itself for the user, starts at
  login, opens the pairing page to get the token, runs the pusher, shows in its icon whether the PC is sending, and
  takes new pusher and tray builds from the hub. `bun scripts/codex-hub-sign.ts` makes the key and signs builds.
  The macOS app is built on a Mac with that folder's `build-macos.sh`, and `test-macos.sh` smoke-tests it there.
- **Claude Code cloud sessions:** set `AGENTHYDRA_CLOUD_SESSIONS=1`. AgentHydra then asks Anthropic's API, with
  each Claude Code CLI login it finds (or a `claude setup-token` token in `CLAUDE_CODE_OAUTH_TOKEN`), for that
  account's cloud and Remote Control sessions, and lists them with your local chats. The token needs the
  `user:sessions:claude_code` scope; it is never stored, logged or refreshed by AgentHydra.
- **From a phone:** put a reverse proxy that signs you in first (Cloudflare Access, oauth2-proxy, or a name only
  your VPN resolves) in front of the window, and list its address in `HYDRA_DESK_PUBLIC_ORIGINS`
  (for example `https://desk.example.com`). That name is then trusted like the machine itself, so never list one
  anyone can reach without the sign-in.

Details: [Codex chats from other PCs](docs/REFERENCE.md#codex-chats-from-other-pcs-codex-hub) and the window's
[ports and remote access](desk2/README.md#ports).

</details>

## Install

This project has not published a release yet, so for now you **build it from source** (Windows, macOS or Linux)
with [Bun](https://bun.sh) 1.4.3:

```sh
git clone https://github.com/Jhacarreiro/AgentHydra-Community.git
cd AgentHydra-Community && bun install && bun install --cwd desk2
bun run build && bun run start
```

**Windows, one line**, once releases exist (no Administrator; the download's SHA-256 is checked before anything
unpacks):

```powershell
irm https://raw.githubusercontent.com/Jhacarreiro/AgentHydra-Community/main/install.ps1 | iex
```

Until this project publishes its first release, the installer stops with a message instead of downloading
anything; `install.ps1 -FromZip <zip>` installs a zip you built yourself ([docs/RELEASING.md](docs/RELEASING.md)).

<details>
<summary><b>Read more: downloads, versions, updates, requirements, what reaches the network</b></summary>

- **Downloads,** once published: the Windows `.zip` holds the whole app: the window, the tray icon and the
  orchestrator tools. The single `.exe` is a small launcher that fetches the rest of the app from the same release
  the first time you run it. Linux and macOS get a `.tar.gz`. No download packs Bun or Claude Code: the launcher
  fetches the Bun the release was built with on first run (checked against Bun's published checksums), and the
  window fetches Claude Code when a chat first needs it.
- **Versions** are numbered by date, `YYYY.M.PATCH`, starting at `2026.10.0`, so they never collide with the
  `0.x`, `1.x` and `2.0.x` releases of the project this one was forked from.
- **Updates** come only from this repository, the one named in `release-channel.json`, and auto-update is off
  until you turn it on in Settings. A release build does only what its channel allows: `off` checks nothing and
  downloads nothing (the setting until the first release), `notify` tells you about a newer release, and `auto`
  installs it, taking only files from this repository's release downloads, checked against that release's
  `SHA256SUMS.txt`. A source checkout updates with `git pull --ff-only` of the branch it tracks, and only when that
  remote is this repository on GitHub; any other remote is reported in Settings and never contacted.
- **Requirements:** Bun only for a source checkout. The `claude` CLI and/or Claude Desktop for the
  Claude features. Optional: Codex Desktop/CLI, OpenCode, Hermes Agent, the DeepSeek Harness
  (`~/.dsh`), whose sessions show up when their stores exist. Windows for the tray; macOS and Linux
  builds exist but are not verified yet. Windows instance management needs the classic Squirrel
  installer of Claude Desktop, not the MSIX package (the Instances view links it).
- **Instance actions are real:** open, quit, create and delete act on your real Claude Desktop
  instances; delete asks you to type the name.
- **Network.** AgentHydra reads local files and talks to `localhost`. Nothing goes to a LunarWerx service, and no
  install id, ping or other data about your machine is sent anywhere. What does leave the machine:
  - **The update check:** one unauthenticated request to `api.github.com` for this repository's latest release,
    only when the release channel allows checking (not while it says `off`). A source checkout's check is a
    `git fetch` of this repository.
  - **A launcher repair:** a launcher that finds part of its install missing downloads its own version's archive
    from this repository's releases, whatever the update setting. While no releases exist, that download fails
    and the launcher says so.
  - **Bun** from Bun's GitHub releases on a release build's first run, and **Claude Code** from the npm registry
    when a chat first needs it.
  - **Model prices:** once a day, LiteLLM's public price list from `raw.githubusercontent.com`, so new models
    are priced; `AGENTHYDRA_PRICES_URL` points it at your own copy. Without it, the bundled table is used.
  - **Your own accounts:** usage and plan lookups for the Claude and Codex accounts you sign in, with their own
    logins, to Anthropic (`api.anthropic.com`, and `platform.claude.com` to renew a closed Desktop profile's
    login) and OpenAI (`chatgpt.com`).
  - **Only what you turn on:** cloud sessions (Anthropic's API), the Codex hub (your hub), Login sync (the store
    you deploy), usage sync between PCs (a private git repository you name), email alerts (your SMTP server),
    HSwarm (the model providers whose keys you add, and their sites' icons), Free instances (claude.ai and
    chatgpt.com, plus the Python and Node packages they install once), orchestrator remote access (your sign-in
    provider and tunnel), and Desk's RepoYeti and ReDesign connectors, which download that tool's release from
    GitHub when you install one.

</details>

## Optional features, off by default

Some parts reach outside your PC or depend on someone else's terms, so each one waits for you to set it up.

<details>
<summary><b>Read more: remote access, Free instances, Login sync</b></summary>

- **Orchestrator remote access** (the dashboard from a phone): a fresh clone has no sign-in provider, no relay
  and no tunnel. The gateway serves loopback only and refuses to open a tunnel, and the tray's Remote access
  starts off. To use it, put your own OpenID Connect provider in `orchestrator/state/remote/config.json`:

  ```json
  {
    "oauth": {
      "issuer": "https://accounts.example.com",
      "clientId": "<your client id>",
      "redirectUri": "https://<your relay>/oauth/callback"
    }
  }
  ```

  A named tunnel on your own Cloudflare zone needs `CF_ACCOUNT_ID`, `CF_ZONE_ID`, `CF_ZONE_NAME` and an API token
  in the environment; with one missing it says which and stops. See
  [orchestrator/README.md](orchestrator/README.md), "The remote front-end".
- **Free instances** (Windows only): the window can run work on free claude.ai and ChatGPT web logins. Nothing is
  installed and nothing reaches the network until you add an account under **Instances → Free** and sign in by
  hand in the browser window it opens. The first use needs Python 3.11+, Bun and Node.js, and sets up a Python
  environment under `~/.hydra-desk-2/free/runtime`. Each login is sealed with Windows DPAPI, so sign-in fails on
  Linux and macOS. HSwarm sends tool-free tasks to signed-in Free accounts when there are any; set
  `route_via_free = false` in its `settings.toml` to stop that. These logins go through the providers' own
  websites: **check that their terms allow this use before you turn it on.**
- **Login sync** keeps your CLI and Claude Desktop logins the same on your PCs through a store you deploy yourself
  ([cloud/login-sync-worker](cloud/login-sync-worker/README.md)). There is no built-in store.
- **Orchestrator jobs** use only folders you name: the to-do sweep is registered when `PROJECTHYDRA_HOME` points
  at your Project Hydra clone, and harvested to-dos are filed into repositories only under `ORCH_HARVEST_ROOTS`.

</details>

## The public audit

`bun run audit:public` checks what this repository would publish: the tree at `HEAD` and every commit since
`3a65ba8e`, the MIT base. CI runs it on every push and pull request, and the pre-push hook runs it on every push.

<details>
<summary><b>Read more: what it looks for and how to use it</b></summary>

- It looks for tokens and private keys, credential and state files, private, link-local and Tailscale addresses,
  email addresses other than noreply and documentation ones, home-folder paths and the name of whoever runs it,
  upstream service hosts and private repository names, internal host names, account ids, binaries with no recorded
  provenance, commit emails that are not noreply, and any commit at or past upstream's relicensing commit
  `aee9dfc4`.
- Modes: `--tree REV`, `--history A..B` and `--push REMOTE`, plus `--json` and `--suggest-allow`. It exits 0 when
  clean, 1 on a finding and 2 when it could not run. A finding is printed as its rule, `file:line` and a short
  fingerprint of the value, never the value itself.
- A finding that is genuinely fine goes in `scripts/audit-public.allow.json` as `{rule, path, fp, reason}`. Commit
  emails and the licence boundary cannot be allowed. Every binary needs an entry in
  `scripts/binary-provenance.json`.
- The pre-push hook refuses any ref whose history contains `aee9dfc4`, with no override, so nothing upstream wrote
  under its new licence can be pushed from a clone of this repository.

</details>

## Contributing, security and licence

- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md) says how to build, test and run the audit. A pull request is
  merged with its author's own commits; a contribution a maintainer adapts or rewrites still credits its author.
- **Security:** report a vulnerability privately, as [SECURITY.md](SECURITY.md) describes.
- **Code of conduct:** [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- **Licence:** [MIT](LICENSE). Third-party material and its licences are listed in
  [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## FAQ

<details>
<summary><b>Is it free?</b></summary>

Yes, MIT-licensed, with no account or subscription. You bring your own Claude Code, Codex or
OpenCode.

</details>

<details>
<summary><b>Can I try it without spending my Claude quota?</b></summary>

Yes. It never runs `claude` headless, and the scheduler is off by default. Instance actions still
act on real Claude Desktop instances.

</details>

<details>
<summary><b>Which AI tools does it support?</b></summary>

Claude Code, Codex, OpenCode, Hermes Agent and DeepSeek Harness sessions, in one list. Claude and Codex chats can
be continued; the others are read-only. Claude Desktop and Codex Desktop accounts are managed in the instances
view.

</details>

<details>
<summary><b>Can I switch to it from an AgentHydra install?</b></summary>

It keeps AgentHydra's data folders (`~/.agenthydra`, `~/.hydra-desk-2`), file names and `AGENTHYDRA_*` variables.
Copy those folders somewhere safe first: a newer release of the original project may have written data this
fork's code does not know.

</details>

<details>
<summary><b>I used CC Manager UI. What changes?</b></summary>

Nothing you have to do. `~/.ccmanagerui` moves to `~/.agenthydra` on first run, and every `CCMANAGERUI_*` variable
still works. Update shortcuts and MCP configs that name `CCManagerUI.exe` when convenient.

</details>

[Reference](docs/REFERENCE.md) covers configuration, the MCP tools, auto-update and the checks.

Based on [AgentHydra](https://github.com/LunarWerxs/AgentHydra) by LunarWerx Studios, used under the MIT licence.
