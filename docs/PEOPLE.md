# People and the Hydra Core catalog

**TL;DR.** Hydra Core finds a person or an instrument in a catalog built from folders on your machine. Put one
folder per person under `~/.agenthydra/people/<family>/<slug>/` with a `persona.json` (and an optional `brief.md`),
then run `node hydra-core/catalog/build.mjs`. `--check` validates the result. A fresh install with no folders builds
an empty, valid catalog.

<details>
<summary>Format and sources</summary>

## A person folder

`~/.agenthydra/people/<family>/<slug>/persona.json`, the same for every family: `manager`, `board`, `expert`,
`dredd-seat`, `creator`.

| Field | Meaning |
| --- | --- |
| `name`, `title` | Shown to the chat |
| `oneLiner` | One plain line (under 160 characters): when to pick this person |
| `keywords` | Search tags |
| `brief` | File beside `persona.json` loaded on "become" (default `brief.md`) |
| `tier` | `intern`, `employee`, `manager` or `owner` (default by family: manager and board are `manager`, expert and dredd-seat `employee`, creator `owner`) |
| `modes` | Any of `become`, `consult`, `hire` |
| `cost` | `free`, `low`, `medium` or `high` |

Entry ids: `person:<slug>` for managers, `person:<family>-<slug>` for the other families. Persona text stays in the
files; the catalog holds only the one-liner and the path.

## Legacy managers

`~/.agenthydra/managers/<slug>/persona.json` is still read as a manager, so existing managers need no move.

## Other sources

The builder also reads skills (`~/.claude/skills`) and sub-agents (`~/.claude/agents`). Home paths always come from
`os.homedir()`. `AGENTHYDRA_CORE_DIR` overrides the core folder (default `~/.agenthydra/core`). Hand-written
`hand-*.json` files in `<core>/catalog/` are never touched and win over generated entries with the same id.

## Owner-specific sources: `<core>/catalog/sources.json`

Optional, outside the repo. Every key is optional; a missing key turns that source off.

`projectsDir`, `connectionsDir`, `extraSkillDirs`, `extraAgentDirs`, `dreddDir`, `sueDir`, `snapshotDir`, `laneDir`,
`boardroomDir` (paths, `~` allowed), `ownerName`, `companyId`, `seats` (`[{ slug, name, personaId }]`) and
`minimums` (`{ managers, employees, instruments, skills, knowledge }`, the floors `--check` enforces; none by default).

## Commands

- `node hydra-core/catalog/build.mjs` rewrites `<core>/catalog/generated-*.json` and `skips.json`.
- `node hydra-core/catalog/build.mjs --check` validates generated and hand files; exit 1 when invalid.

</details>
