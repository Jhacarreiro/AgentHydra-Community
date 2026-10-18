# Third-party notices

AgentHydra is MIT-licensed (see `LICENSE`). Some parts of it are adapted from, or ship, other
projects' work under their own licences: most under MIT, one adapted file under the Apache License
2.0 (vLLM, below), and the Inter typeface under the SIL Open Font License 1.1. Each of those
licences requires the original copyright notice and licence to travel with any substantial copy, so
they are reproduced here or in the file each section names. Each adapted source file names its
source in a header comment, except the shadcn-vue components, which carry none and are listed by
folder in their section.

This file is about code adapted into AgentHydra's own source. The third-party packages a release
bundle carries as they are (the npm packages bundled into its JavaScript or installed beside it, the
Rust crates of its Windows programs) are listed with their licences and licence texts in the
`THIRD-PARTY-LICENSES` file at the root of every bundle, which `scripts/third-party-licenses.ts`
writes when the bundle is built. A bundle does not carry the Claude Agent SDK, whose licence reserves
all rights: Desk downloads the version the bundle pins from the npm registry the first time a chat
needs it.

## NousResearch/hermes-agent

Source: <https://github.com/NousResearch/hermes-agent> (MIT). Read while building the 2026-09-04
release. Hermes is an agent runtime; AgentHydra is a dashboard over agent runtimes, so nothing of
its core was taken, and the two projects do not overlap in what they do.

Every claim below was checked by comparing our file against the real upstream file, rather than
trusting what our own header comments said - an earlier pass over-attributed, and one header cited
an upstream function (`_confirm_adapter_delivery`) that does not exist in that repository at all.
Over-attribution is not a safe default: it misstates the authorship of our own work, and it
implies a copy where none happened.

**Close derivatives.** Our code follows the original's structure closely enough that the MIT notice
below travels with it:

- `server/src/incidents.ts` and `orchestrator/scripts/lib/incidentlib.py`, from `cron/incidents.py`
  (~302 lines): the failure-type classification table, the normalise / redact / signature / classify
  functions and the CRUD surface are close translations. The reopen-on-recurrence semantics, the
  placeholder scrubbing and the whole notification layer are ours.
- `server/src/core/codex-account.ts`, the reset-credit section only, from `agent/account_usage.py`:
  the backend URL derivation, window parsing and the refuse-below-full-use guard.

**Prior art, credited but not copied.** No upstream code is present in these; reading Hermes is what
prompted writing them, which is worth saying plainly and is not a licence obligation:

- `server/src/boot-watchdog.ts` - arm / renew / disarm against a deadline, a generic watchdog
  discipline their `hermes_startup_watchdog.py` also implements, independently and far more heavily.
- `server/src/dispatch.ts`, `server/src/types.ts`, `orchestrator/scripts/lib/ledgerlib.py` -
  "unverified" as an outcome, and the never-retry-on-UNKNOWN rule their `cron/delivery_queue.py`
  documents for its own queue.
- `orchestrator/scripts/lib/approvallib.py` - the APPROVE / DENY / ESCALATE tri-state, and the rule
  that operator policy never shares a channel with untrusted prompt text. Their `tools/approval.py`
  is a 1000+ line live gateway; ours is a small synchronous classifier and shares none of it.

**Interoperability, not derivation.** `server/src/hermes-sessions.ts` reads a Hermes install's own
`state.db` so AgentHydra can list those sessions, exactly as it already reads Codex and OpenCode.
The table and column names are facts about a file format; no upstream code or logic is used.

`orchestrator/scripts/lib/mutationlib.py` carried a Hermes credit in an earlier draft and no longer
does: on comparison it shares nothing with `tools/checkpoint_manager.py`, which snapshots repo files
through a shadow git repository. It is our own before/after ledger.

No other Hermes content, its skills included, is part of this repository.

```
MIT License

Copyright (c) 2025 Nous Research

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## kenn-io/agentsview

The agent catalog (`server/src/agent-catalog.ts`) re-expresses the on-disk paths from the agent
registry in <https://github.com/kenn-io/agentsview> (MIT, Kenn Software LLC), as its header
states. Facts, not code, were taken; no source was copied.

## pingdotgg/t3code, getpaseo/paseo and omnigent-ai/omnigent

The open session's work rows and its compaction and usage-limit dividers in the old window
(removed in 2.0.0) took their ideas from <https://github.com/pingdotgg/t3code> (MIT, T3 Tools Inc.: one row per run of work
with a sentence summary, a live shimmer and a system divider), <https://github.com/getpaseo/paseo>
(Apache-2.0: folding a run of tool calls into one row, and finding a Claude subagent's run from the
call that started it, which `tailSubagent` in `server/src/transcript.ts` does) and
<https://github.com/omnigent-ai/omnigent>
(Apache-2.0: verb-based labels, a tool's input one argument a line), all read on 2026-10-04. The
loop detector (`server/src/loop-detector.ts`: a session repeating one failing tool call becomes an
incident) is Omnigent's idea, and privacy mode (`desk2/hydra/src/lib/privacy.ts`,
`desk2/hydra/src/composables/usePrivacy.ts`: account addresses masked on screen) is T3 Code's. Ideas, not
code, were taken; no source was copied.

## junegunn/fzf and microsoft/terminal

`desk2/hydra/src/lib/fuzzy.ts`, the session search box's scorer, is a TypeScript port of fzf's
`FuzzyMatchV2` (<https://github.com/junegunn/fzf>, `src/algo/algo.go`, MIT), written with
microsoft/terminal's C++ port of the same algorithm (<https://github.com/microsoft/terminal>,
`src/cascadia/fzf/fzf.cpp`, MIT) as the second reference for the highlight runs. The scoring
constants, character classes, bonus rules and the dynamic-programming table with its backtrace
follow fzf closely enough that both notices travel with it. The multi-field row matching, the
ranking tiebreak and the Vue wiring are ours.

```
The MIT License (MIT)

Copyright (c) 2013-2024 Junegunn Choi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

```
MIT License

Copyright (c) Microsoft Corporation. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE
```

## vllm-project/vllm

`hswarm/anthropic_facade.py` adapts the request and stream converters of vLLM's
`vllm/entrypoints/anthropic/serving.py` (<https://github.com/vllm-project/vllm>, Apache-2.0,
Copyright contributors to the vLLM project), without its `OpenAIServingChat` base. Its header
says so, carries the `SPDX-License-Identifier: Apache-2.0` line, and says what was changed for
hswarm. That file is distributed under the Apache License 2.0; the rest of AgentHydra stays MIT.

The licence text is in `LICENSES/Apache-2.0.txt`, copied from the `LICENSE` file of vLLM's
published 0.31.0 source distribution on PyPI. That distribution has no `NOTICE` file, so there is
no NOTICE text to carry.

```
Copyright contributors to the vLLM project

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## DietrichGebert/ponytail

`CODE_BRIEF` in `hswarm/code_brief.py`, the brief an `edit` task gets when it brings no `system`
prompt of its own, is adapted from `skills/ponytail/SKILL.md` in
<https://github.com/DietrichGebert/ponytail> (MIT) at commit `e3ba2aa`, as the module's docstring
says, with what was dropped and changed for hswarm. The copyright line below is the one in
ponytail's own `LICENSE`, read at that commit and on its default branch on 2026-10-18 (the two are
byte for byte the same), and the licence text is that file's.

```
MIT License

Copyright (c) 2026 DietrichGebert

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## mui/material-ui

Two parts of HSwarm's review tasks take their design from the review skill in
<https://github.com/mui/material-ui> (MIT), as their comments say: the scope block a review batch
prepends to every prompt, with an echo mark the worker must repeat so a worker that reviewed the
wrong tree is flagged instead of trusted (`scope` in `hswarm/spec.py`), and the depth dial with hard
fan-out caps in `hswarm/roster.py`. `hswarm/roster.py` says its designs were written fresh, and
`hswarm/spec.py` calls its scope block adapted, so the notice travels with both. The copyright line
below is the one in the `LICENSE` file at the root of mui/material-ui, read on its default branch on
2026-10-18, and the licence text is that file's.

```
MIT License

Copyright (c) 2014 Call-Em-All

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## unovue/shadcn-vue

The UI components in `desk2/hydra/src/components/ui/` and `orchestrator/web/src/components/ui/`
come from shadcn-vue's component registry (<https://github.com/unovue/shadcn-vue>, MIT); the
`components.json` beside each app is that tool's configuration (style `reka-mira`). They have been
edited here since. `desk2/web/src/components/ui/` holds a further copy of some of the same
components, and the `cn()` class helper in each app's `src/lib/utils.ts` starts from the one
shadcn-vue's setup writes. The copyright holder below is the one in the `LICENSE` file of shadcn-vue's published
npm package (version 2.8.2, read from `npm pack shadcn-vue` on 2026-10-17); its `package.json`
also gives the licence as MIT.

```
MIT License

Copyright (c) 2023 unovue

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## rsms/inter

The Inter typeface (<https://github.com/rsms/inter>, SIL Open Font License 1.1) ships in two ways:

- `desk2/hydra/public/fonts/inter-latin.woff2` and `inter-latin-ext.woff2`, the Latin and
  Latin Extended subsets of Inter 4.001's variable font, kept in this repository. Vite copies them
  into `desk2/hydra/dist/fonts/`.
- The `@fontsource-variable/inter` package, which `src/styles/kit-base.css` imports in both
  `desk2/hydra` and `orchestrator/web`, so each of their builds carries that package's Inter
  woff2 files.

The copyright line below is the one embedded in the vendored files' `name` table, and the same
line opens the package's own `LICENSE`. The licence names no Reserved Font Name, so the subsets
keep the family name Inter. The full licence text, with this copyright line, is in
`desk2/hydra/public/fonts/OFL.txt`, beside the fonts, so every desk2/hydra build copies it into
`dist/fonts/` with them. It covers the package's files in both apps too.

```
Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
```
