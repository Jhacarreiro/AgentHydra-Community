# AgentHydra MCP tools

**TL;DR**

- Every tool lives in one place: an entry in its family's `HydraTool[]` array (`server/src/mcp-*.ts`).
- Its flags on that entry decide how it is offered: `listed`, `callerChat`, `refuses`. Nothing else to edit.
- Only `listed: true` tools are shown to agents; every other one is reached with `hydra_find` and `hydra_run`.
- `bun test server/tests/mcp-tools-shape.test.ts` checks every tool; the listed set has a size budget.

<details><summary>Adding a tool</summary>

1. Pick the module of its family (`mcp-session-tools.ts`, `mcp-fan-out.ts`, `mcp-find.ts`, ...), or make a new
   `mcp-<family>.ts` exporting a `HydraTool[]` and spread it into `TOOLS` in `mcp.ts`.
2. Write the entry: `name` (snake_case), `description`, `inputSchema` (`S({...}, required)` from `mcp-client.ts`),
   `run(args)`.
3. The description's first sentence says what the tool does; `hydra_find` shows it as the summary and searches it.
   Start with `MUTATES:` when it changes anything (the eval refuses those on read-only questions, and agents read it).
4. Flags, only when they apply:
   - `listed: true`: agents call it often enough to be worth its schema in every chat. Default: not listed, still
     reachable through `hydra_find` / `hydra_run`, still answered by name.
   - `callerChat: 'chat'`: it acts on a Hydra Desk chat and its `chat` argument defaults to the calling chat.
     `callerChat: 'deskChat'`: it receives the calling chat as `deskChat`. Both also apply through `hydra_run`.
   - `refuses: true`: it refuses every call and is kept only so an old caller gets the refusal.
5. Run `bun test server/tests/mcp-tools-shape.test.ts server/tests/mcp-find.test.ts` and the server typecheck.

</details>

<details><summary>Changing or retiring a tool</summary>

- Renaming: old names keep answering through `RENAMED_TOOLS` in `mcp.ts`; add the old name there.
- Listing or unlisting: flip `listed` on the entry. The shape test holds the listed set to its count and token budget,
  so listing one more may mean trimming a description.
- A tool named in `SERVER_INSTRUCTIONS`, the Desk prompt or the Desk handoff should stay listed, or the text should
  say to reach it through `hydra_run`.

</details>

<details><summary>Why the list is short</summary>

On 2026-10-11 the server listed 105 tools, about 35k tokens of schemas, and a client that loads every schema pays
that in every chat. The transcripts on the PC that day showed about 30 tools carrying over 95% of the calls, so those
are listed and the rest are found and run through two tools, the way the Connections MCP reaches its catalog.

</details>
