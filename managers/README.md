# Manager Hydra router

Manager Hydra gives a Claude Code chat a manager: a persona with a brief, a playbook index and a roster of other managers. `router.mjs` is a `UserPromptSubmit` hook. On each message it decides which manager should handle the chat, swaps the manager when the subject changes, and injects that manager's brief into the conversation.

## TL;DR

- One hook, no dependencies, Node 22 or newer.
- Each message is scored by the HSwarm Jev door on local, with keyword matching as the fallback when Jev does not answer within 4 seconds.
- A manager holds a chat until another domain is clearly the better fit, so the chat does not flap between managers.
- A full brief is injected on assignment, on a swap, and every 12th message; other messages get one reminder line.

## Files

- `router.mjs`: the hook. Exports `loadPersonas`, `isContinuation`, `pick`, `buildInjection`, `run` and `main`. Runs as a hook only when executed directly.
- `install.mjs`: registers the hook in Claude Code's `settings.json`. Idempotent. `--uninstall` removes only the router entries. Writes a `.bak-<ms>` backup before it changes a file.
- `test/*.test.mjs`: `node:test` suites. Run `node --test managers/test/*.test.mjs`.
- `test/fixtures/`: generic example managers used by the tests.

## A manager folder

Each folder under the managers directory holds:

- `persona.json`: `slug`, `name`, `title`, `role` (`domain`, `coordinator` or `floor`), `brief`, and for domain managers a `jev` question. Optional: `oneLiner`, `keywords`, `playbook` (a list of `{ file, facet, read_when }`).
- The brief file named by `brief`.
- The playbook files named in `playbook`.

A folder with an invalid `persona.json` is skipped and named in `router.log`.

## How a message is routed

1. A message starting with `/`, or a session marked as a CliMayte worker, is skipped.
2. A session pinned by `AGENTHYDRA_MANAGER` keeps that manager. A pin that names no manager is an error.
3. A short filler reply (such as "continue" or "ok") keeps the current manager without scoring.
4. Otherwise the message is scored: a coordinator question, a floor question, and one yes-or-no question per domain manager. Each domain manager's score is its yes-probability.
5. A coordinator at 0.7 or more takes the message.
6. The best domain manager takes it at 0.6 or more. A current domain manager at 0.45 or more holds unless the best is 0.25 or more ahead.
7. If no domain reaches 0.6, the current manager is kept. A new session gets the floor manager.
8. On a swap, or every 12th message, the full brief and playbook index are injected; otherwise one reminder line is injected.

If Jev does not answer within 4 seconds, or is unreachable, the router scores with keywords (0.6 per whole-word keyword hit, capped at 0.9) and says so in the injected note and the system message.

## Environment

- `AGENTHYDRA_MANAGERS_DIR`: managers folder. Default `~/.agenthydra/managers`.
- `AGENTHYDRA_JEV_PORT`: HSwarm port. Default `7793`.
- `AGENTHYDRA_CONSOLE_TOKEN_FILE`: token file for the Jev door. Default `~/.hswarm/console-token`.
- `AGENTHYDRA_MANAGER`: pin a manager slug for the session.
- `AGENTHYDRA_CLIMAYTE_WORKER`: set to skip routing in worker sessions.

## State and log

- `<managers>/sessions/<session-id>.json`: the current manager, pin state, message count, last full injection and the swap history.
- `<managers>/router.log`: one line per routed message and per error.

## Install

```
node managers/install.mjs                 # register the hook in ~/.claude/settings.json
node managers/install.mjs --settings <p>  # another settings file
node managers/install.mjs --uninstall     # remove only the router entries
```

Run install once; running it again changes nothing.
