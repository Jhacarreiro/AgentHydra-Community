# Contributing to AgentHydra Community

Thanks for helping. This page says how to build and test the project, how to run the public audit, and how
contributions are credited.

**TL;DR**

- Build from source with [Bun](https://bun.sh) 1.4.3, the version CI uses.
- Before a pull request, run `bun run check`, the typecheck and tests for what you changed, and `bun run audit:public`.
- Read [AGENTS.md](AGENTS.md): it holds the repository's rules, including how CHANGELOG entries are written.
- A pull request is merged with its author's own commits. If a maintainer adapts or rewrites it, its author is still
  credited, with a `Co-authored-by` trailer and in the CHANGELOG.
- Contributions are under the MIT licence, like the rest of the repository.

<details>
<summary><b>Read more: build and run</b></summary>

```sh
git clone https://github.com/Jhacarreiro/AgentHydra-Community.git
cd AgentHydra-Community
bun install                # also points git at .githooks, which turns on the hooks below
bun install --cwd desk2
bun run build              # builds the window (desk2/web and desk2/hydra)
bun run start              # starts the daemon on http://localhost:7787; it starts the window on 7798
```

Tests never touch your real agent homes: the root suite's preload refuses a write into `~/.claude`, `~/.codex`,
`~/.hswarm`, `~/.hydra-desk-2` and the like, and desk2's suites run on a temporary home. The details are in
[AGENTS.md](AGENTS.md) and [desk2/AGENTS.md](desk2/AGENTS.md).

</details>

<details>
<summary><b>Read more: checks and tests</b></summary>

| What | Command |
| --- | --- |
| Lint and format (Biome) | `bun run check` (`bun run format` fixes formatting) |
| Typecheck: daemon and orchestrator | `bun run typecheck` |
| Tests: daemon and orchestrator server | `bun run test` |
| Window: typecheck and tests | `cd desk2 && bun run typecheck && bun run test` |
| Orchestrator toolbox (Python 3.12, slow) | `bun run test:orchestrator` |
| HSwarm (Python) | `pip install -e "./hswarm[test]"`, then `python -m pytest hswarm/tests -q` |
| Free instances harness (Python) | `cd desk2 && bun run test:py` |
| Codex hub tray app (Go) | `cd codex-hub-tray && go test ./...` |
| Everything | `bun run check:deep` |

Run at least the lanes your change belongs to. Some tests need Windows or a real Chrome or Edge; CI runs those on
`windows-latest`, so a few failures on Linux or macOS for those reasons are expected. A behaviour change comes with
a test that fails without it.

</details>

<details>
<summary><b>Read more: the public audit and the git hooks</b></summary>

This repository is public, so everything committed is published. `bun run audit:public` reads the tree at `HEAD`
and every commit since `3a65ba8e`, the MIT base, and reports tokens and keys, credential files, private addresses,
email addresses other than noreply and documentation ones, home-folder paths, upstream hosts and private repository
names, binaries with no provenance, commit emails that are not noreply, and any commit that has upstream's
relicensing commit in its history. A finding prints its rule, `file:line` and a fingerprint, never the value.

- Use invented data in tests and docs: `example.com`, `example.test` or `example.invalid` addresses, the
  documentation IP ranges (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`), names such as "Example Owner", and
  paths such as `C:/Users/me/...`.
- Commit with your GitHub noreply address
  ([how](https://docs.github.com/en/account-and-profile/setting-up-and-managing-your-personal-account-on-github/managing-email-preferences/setting-your-commit-email-address)).
- A finding that is genuinely fine goes in `scripts/audit-public.allow.json` as `{rule, path, fp, reason}`, with a
  reason that says what the value is. Never paste the value. A new binary needs an entry in
  `scripts/binary-provenance.json` saying where it comes from and how it was built.
- **Never bring in code or text that upstream wrote after `3a65ba8e`.** That work is under PolyForm Noncommercial,
  not MIT. Write what you need from the MIT code and your own reasoning, and do not merge or rebase onto upstream's
  `main`. Nothing from private repositories either. The audit and the hook check commit ancestry only, so they
  cannot see code copied or cherry-picked from upstream's later work: keeping that out is up to you.

`bun install` enables the hooks in `.githooks/`:

- **pre-commit** refuses a commit on the branch `live` and runs Biome on the staged files.
- **pre-push** refuses any ref whose history contains upstream's relicensing commit `aee9dfc4`, runs the audit on
  what the push would publish, and gates release tags. It also stops a push to a public remote, your own fork
  included, until you repeat the command with `AGENTHYDRA_PUSH_PUBLIC=1`, so a public push is always deliberate.

</details>

<details>
<summary><b>Read more: writing the change</b></summary>

- **Commits** say what is now true, in plain words: `Area: what is now true`, then a body that says what changed
  and why. Several focused commits read better than one large one.
- **CHANGELOG entries** go under `[Unreleased]`: a bold headline sentence and one to three plain sentences for
  someone who uses the app, with no file names or endpoints. Those go in the commit message and the docs.
  [AGENTS.md](AGENTS.md) has the full rules.
- Match the surrounding code's style, naming and comment density, and keep behaviour your change is not about
  unchanged.

</details>

<details>
<summary><b>Read more: how contributions are credited</b></summary>

- A pull request is merged with its author's own commits, so the history names who wrote them.
- If a maintainer adapts or rewrites a contribution instead (to fit other work, to split it, or to fix it up), the
  resulting commits carry a `Co-authored-by: Name <address>` trailer for its author, and its CHANGELOG entry names
  them.
- An idea or report that shaped a change is thanked in that change's commit message.
- Contributions are licensed under the [MIT licence](LICENSE), the same as the rest of the repository: by opening
  a pull request you agree that your contribution may be distributed under it. You keep your copyright; the
  `LICENSE` line for "the AgentHydra Community contributors" covers you.

</details>

<details>
<summary><b>Read more: questions, bugs and security</b></summary>

- Bugs and ideas: open an issue on this repository.
- A vulnerability: report it privately, as [SECURITY.md](SECURITY.md) says, not in a public issue.
- Everyone here follows the [code of conduct](CODE_OF_CONDUCT.md).

</details>
