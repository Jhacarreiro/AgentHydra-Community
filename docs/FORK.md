# Where AgentHydra Community comes from

AgentHydra Community continues [AgentHydra](https://github.com/LunarWerxs/AgentHydra) from its last MIT-licensed
commit. This page records how its history was built and how anyone can check that, using only facts that are
public: the git history itself and GitHub's public record of the upstream repository. Why the fork exists is in the
[README](../README.md).

**TL;DR**

- The base is upstream's `3a65ba8e`, committed on 15 October 2026 at 16:10:12 UTC, under the MIT licence.
- Upstream's next commit, `aee9dfc4`, moved AgentHydra to PolyForm Noncommercial. It is not in this history, and the
  pre-push hook refuses any ref that contains it.
- On top of the base there are only this fork's own commits: none of the code or text upstream wrote after the base.
- Owner-run services and private-repository tooling were removed; everything else stays from upstream, under MIT,
  with its copyright notices.

<details>
<summary><b>Read more: the licence boundary</b></summary>

- **The base:** `3a65ba8e6497c16732f627fc8934723839c82fdd` on upstream's `main`, committed 2026-10-15 16:10:12 UTC.
  Its `LICENSE` is the MIT licence, "Copyright (c) 2026 LunarWerx Studios", and its `package.json` says `"MIT"`.
- **The relicensing commit:** `aee9dfc4f7dd0228d8e1740be90b646b30204f37`, committed 2026-10-15 16:11:42 UTC, whose
  only parent is `3a65ba8e`. It replaced the MIT licence with PolyForm Noncommercial 1.0.0.
- **They were published separately.** GitHub's public activity record for the upstream repository (its Activity
  view, filtered to `main`) shows `3a65ba8e` pushed to `main` on its own at 16:10:17 UTC on 15 October 2026, and
  `aee9dfc4` in a separate push at 16:11:52 UTC. So `3a65ba8e` was published as the head of `main` under the MIT
  licence before the licence changed. The MIT licence lets anyone use, copy, modify, merge, publish, distribute,
  sublicense and sell that code, as long as its copyright and permission notice stay with it.

</details>

<details>
<summary><b>Read more: how this history was built</b></summary>

- Everything up to and including `3a65ba8e` is upstream's history, unchanged.
- After it come only commits by this fork's maintainer, [@Jhacarreiro](https://github.com/Jhacarreiro), each with a
  GitHub noreply address:
  - first, the work of the maintainer's pull requests to AgentHydra, #8 to #24 (14 to 17 October 2026), which were
    written against the MIT code: Claude Code cloud sessions, the Codex hub and its tray app, and a set of fixes and
    test repairs. They keep their original author dates. Where a pull request had been written on a newer upstream
    `main`, only the maintainer's own lines were carried over, and anything upstream had added after the base was
    left out;
  - then the changes that make it a project of its own: its release channel and version line, the removals listed
    below, the public audit, and its documentation.
- There are no merges from upstream, and nothing upstream wrote after `3a65ba8e` (its code, its text or its
  changelog entries) was copied or adapted.

</details>

<details>
<summary><b>Read more: how to check it yourself</b></summary>

From a clone of this repository:

```sh
# Fetch upstream to compare against. This only reads it; never push anything from it.
git remote add upstream https://github.com/LunarWerxs/AgentHydra.git
git fetch upstream

git merge-base HEAD upstream/main                # prints 3a65ba8e6497c16732f627fc8934723839c82fdd
git merge-base --is-ancestor aee9dfc4 HEAD; echo $?   # 1: the relicensing commit is not in this history
git log --format='%h %an <%ae> %s' 3a65ba8e..HEAD     # only this fork's commits, all with noreply addresses
bun run audit:public                              # the tree, and every commit since the base
```

- The audit's `license.boundary` rule fails on any commit that has `aee9dfc4` in its history. It is built into
  `scripts/audit-public.mjs`, and its configuration can add another boundary commit but cannot remove that one.
  CI runs the audit on every push and pull request.
- The pre-push hook (`.githooks/check-public-push.mjs`, enabled by `bun install`) refuses, on every remote and with
  no override, any ref whose history contains `aee9dfc4`, and runs the audit on what the push would publish.
- Both look at commit ancestry only. Code copied or cherry-picked from upstream's later commits would make new
  commits without `aee9dfc4` in their history, and neither would flag them. That is kept out by the clean-room rule
  every contribution follows ([CONTRIBUTING.md](../CONTRIBUTING.md)), and anyone can compare the code itself with
  upstream's.

</details>

<details>
<summary><b>Read more: what was removed, and why</b></summary>

Each of these only worked with a service the upstream owner runs, or with a private repository nobody else has:

- **The update relay and its install-id ping:** update checks went through an upstream-run proxy with an install
  id; a release build now asks only this repository's releases, and not at all until it publishes one, and a source
  checkout asks only this repository, with git.
- **Connections settings sync, its `@cnct/connect` dependency, and Desk's Connections connector, chip and pane:**
  they needed an account on LunarWerx's own Connections service.
- **The price check, Sue and Dredd MCP tools:** they ran code from a private checkout beside the repository.
- **The 4MAN to-do board and its dashboard widget:** they read a private to-do tool from a Connections checkout.
- **HSwarm's usage pings:** they reported usage to the upstream owner's analytics.
- **The orchestrator's built-in sign-in client, relay and Cloudflare account and zone ids:** they were the upstream
  owner's infrastructure; remote access now uses only what you configure.
- **Built-in folder defaults in the orchestrator's jobs, and the core's working notes:** they named folders and
  tools on one particular machine.
- **The Hydra Core catalog's private sources:** they read private checkouts; the catalog is built from your own
  people, skills, agents and repositories.
- **The private UI-kit sync and the 1.x upgrade harness:** the first needed a private sibling repository (the kit
  files are now this repository's own), and the second tested upstream's own 1.x releases.

</details>

<details>
<summary><b>Read more: what stays from upstream</b></summary>

Everything else in AgentHydra at `3a65ba8e` stays, under the MIT licence and with its copyright and
[third-party notices](../THIRD-PARTY-NOTICES.md): the daemon and its MCP server, the window (Desk 2), the session
readers, instance and account management, CliMayte, HSwarm, analytics, the orchestrator, the launchers, the tray
host and the installer. The AgentHydra name is kept where it describes the software and where renaming would
break existing installs: data folders, `AGENTHYDRA_*` variables and executable names. `LICENSE` keeps the original
copyright line and adds one for this fork's changes.

</details>
