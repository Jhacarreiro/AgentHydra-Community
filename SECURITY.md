# Security policy

**TL;DR**

- Report a vulnerability privately, through GitHub's private vulnerability reporting on this repository:
  [Report a vulnerability](https://github.com/Jhacarreiro/AgentHydra-Community/security/advisories/new).
- If that page says private reporting is not available, open an issue that only asks for a private security
  contact, with no details of the problem, and a maintainer will answer with one.
- Do not open a public issue, pull request or discussion about the problem itself until a fix is out.
- Fixes go into the next release and its CHANGELOG entry, with credit to the reporter if they want it.

<details>
<summary><b>Read more: what to report and what to expect</b></summary>

## What to include

- What is affected: the part of AgentHydra Community (the daemon, the window, the Codex hub or its tray app, the
  orchestrator, HSwarm, the installer or launchers) and the version or commit.
- How to reproduce it, and what an attacker gains: for example reaching the local API from a web page, reading a
  credential, or running code.
- Use invented data in the report. Never send a real token, credential file or chat content; describe it instead.

## What happens next

- The maintainers answer in the private advisory, agree on what the problem is, and work on a fix there.
- When the fix is released, the advisory is published with it, and the reporter is credited unless they ask not to
  be.
- This is a volunteer project, so there is no bounty and no fixed response time, but a report is never ignored.

## Scope

- In scope: this repository's code and the builds it publishes.
- Out of scope: the tools AgentHydra Community reads or drives (Claude Code, Claude Desktop, Codex, OpenCode and the
  rest), and services you set up yourself, such as a reverse proxy, a sign-in provider or a Login sync store.
  Report those to whoever maintains them.
- Upstream AgentHydra is a separate project; this repository cannot fix it.

</details>
