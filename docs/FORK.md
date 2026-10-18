# Where AgentHydra Community comes from

AgentHydra Community continues [AgentHydra](https://github.com/LunarWerxs/AgentHydra) from its last MIT-licensed
commit. This page records how its history was built and how anyone can check that, using only facts that are
public: the git history of both repositories and GitHub's public record of the upstream repository. Why the fork
exists is in the [README](../README.md).

**TL;DR**

- The base is upstream's `3a65ba8e`, committed on 15 October 2026 at 16:10:12 UTC, under the MIT licence.
- This history starts with one commit that imports that version unchanged: its tree has the same hash as
  `3a65ba8e`'s, which anyone can check in a clone of upstream. Upstream's own history stays in upstream's repository.
- Upstream's next commit, `aee9dfc4`, moved AgentHydra to PolyForm Noncommercial. It is not in this history, and the
  pre-push hook refuses any ref that contains it.
- On top of the import there are only this fork's own commits: none of the code or text upstream wrote after the
  base.
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

- The first commit, `c81335b7` ("Import AgentHydra at 3a65ba8e, its last MIT commit"), has no parent. Its tree is
  `3a65ba8e`'s, `d6eda7b9e375d15e916c7a001099fa96051d6cc2`, so every file in it is upstream's at the base, unchanged,
  and keeps its authors' copyright ([LICENSE](../LICENSE)). It is not one of upstream's commits: the fork's
  maintainer committed it, and only its tree is upstream's.
- After it come only commits by this fork's maintainer, [@Jhacarreiro](https://github.com/Jhacarreiro), each with a
  GitHub noreply address:
  - first, the work of the maintainer's pull requests to AgentHydra, #8 to #24 (14 to 17 October 2026): Claude
    Code cloud sessions, the Codex hub and its tray app, and a set of fixes and test repairs. The earliest of them
    were started on the MIT code; the later ones were started on upstream's `main` of those days, which by then
    held the relicensing commit, and most of the early ones merged that `main` in later. From every one of them,
    only the maintainer's own lines were carried onto the base, keeping their original author dates, and anything
    upstream had added after the base was left out;
  - then the changes that make it a project of its own: its release channel and version line, the removals listed
    below, the public audit, and its documentation.
- There are no merges from upstream, and nothing upstream wrote after `3a65ba8e` (its code, its text or its
  changelog entries) was copied or adapted.
- Upstream's history up to `3a65ba8e` is not carried. This repository used to carry it unchanged, all 3037 commits up
  to and including the base. It is upstream's record of its own work, and it is in upstream's repository already,
  where anyone can read it.
  Republishing it here listed upstream's authors as this repository's contributors and published again values that
  upstream had since taken out of its files. The import keeps every file of the base, and its tree hash ties it to
  upstream's commit, so the fork's provenance does not depend on that history.
- Docs and code comments that came with the import cite upstream's commits by hash (the CliMayte notes, for
  example). Those commits are in upstream's repository, not in this one.
- A clone of this repository made while it still carried upstream's history cannot fast-forward to this one, which
  shares no commit with it. Delete it and clone again: it holds upstream's history, and the hook and audit it
  carries are older ones that would let a push of that history back through.

</details>

<details>
<summary><b>Read more: how to check it yourself</b></summary>

From a clone of this repository:

```sh
git rev-list --max-parents=0 HEAD         # one root only: c81335b7e90a85880cffbb54e51743a459cc7172
git rev-parse c81335b7^{tree}             # d6eda7b9e375d15e916c7a001099fa96051d6cc2, 3a65ba8e's tree
git log --format='%h %an <%ae> %s' HEAD   # only this fork's commits, all with noreply addresses
bun run audit:public                      # the root, the tree, and every commit after the root
```

Then, in a separate clone of upstream (this only reads it; never push anything from it):

```sh
git clone https://github.com/LunarWerxs/AgentHydra.git agenthydra-upstream
cd agenthydra-upstream
git rev-parse 3a65ba8e^{tree}             # the same d6eda7b9e375d15e916c7a001099fa96051d6cc2
TZ=UTC git log -1 --date=iso-strict-local --format=%cd 3a65ba8e   # 2026-10-15T16:10:12+00:00
git rev-list --count 3a65ba8e             # 3037: the history this repository does not carry
git log -1 --format=%P aee9dfc4           # the relicensing commit's only parent: 3a65ba8e
```

- One root means every commit in this history descends from the import commit, so none of upstream's commits,
  `aee9dfc4` included, can be in it. A merge that brought upstream's history in would add upstream's first commit as
  a second root.
- Before the default run, a `--history` range from the import commit or a `--push` run reads anything, the audit
  checks the import commit: it must be in the clone, have no parent, have `3a65ba8e`'s tree, and be the only root of
  the history it reads, so that every commit it reads descends from it. Anything else stops it with an error, so a
  shallow clone that does not reach the root cannot run those. A `--tree` run, or a range that starts later, does
  not make that check.
- The audit's `license.boundary` rule fails on any commit that has `aee9dfc4` in its history, and its
  `upstream.history` rule on any commit that shares a commit with upstream's history up to `3a65ba8e`. Both are
  built into `scripts/audit-public.mjs`; its configuration can add a commit to either but cannot remove these. Both
  need that commit in the clone to find it, and a clone of this repository holds no upstream commit. Upstream's older
  history can still come into such a clone without them, with one of upstream's earlier tags; it has a root of its
  own, so the root check above stops it there.
- The pre-push hook (`.githooks/check-public-push.mjs`, enabled by `bun install`) refuses, on every remote and with
  no override, any ref whose history contains `aee9dfc4` or any commit up to `3a65ba8e`, or has a root other than
  the import commit, and any tag on upstream's work: on `3a65ba8e` or a commit before it (upstream's own release
  tags), on a commit with `3a65ba8e`'s tree (the import commit), or on a commit whose release workflow is still the
  one in that tree (this fork's first commits, which a tag would publish with upstream's workflow). It also runs the
  audit on what the push would publish. `--no-verify`, or a clone without the hooks, skips it.
- CI runs the audit on every push and pull request, but GitHub runs the copy the pushed commit carries, after the
  push has landed: it reports, and refuses nothing. A branch from a clone made before this history began carries an
  older audit, which passes upstream's history, and upstream's own commits and tags carry none. What can stop those
  on GitHub's side is a pair of repository rulesets, described in
  [RELEASING.md](RELEASING.md#what-github-itself-must-refuse).
- The audit reads the tree at `HEAD`, the import commit's author, committer and message, and every line each later
  commit adds. It does not read the import commit's tree line by line: that is upstream's tree at `3a65ba8e`, fixed
  by its hash, and it still holds values this fork's later commits took out, such as upstream's service hosts and
  account ids, the names of its private repositories, and its maintainers' email addresses and home-folder paths.
  All of it was public in upstream's repository at that commit already.
- A `pii.local-name` finding comes from your own name: the audit also looks for your git `user.name` and your
  account name, and a one-word name that is also a folder name in this repository matches it. Check those findings,
  or run `bun scripts/audit-public.mjs --no-local-names` to get the result anyone else gets.
- The audit and the hook look at commit ancestry and object hashes only. Code copied or cherry-picked from upstream's
  later commits would make new commits with no upstream commit in their history, and neither would flag them. That
  is kept out by the clean-room rule every contribution follows ([CONTRIBUTING.md](../CONTRIBUTING.md)), and anyone
  can compare the code itself with upstream's.

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
copyright line and adds one for this fork's changes, and [NOTICE](../NOTICE) says in three sentences where this
project comes from; every release and every install carries both.

</details>
