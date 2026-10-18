#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { CONFIG_DIR } from '../server/src/config'
import { moveCodexChat, planCodexChatMove } from '../server/src/core/codex-chat-move'
import { getCodexInstance, listCodexInstances } from '../server/src/core/codex-instances'
import { normalizeInstancePath } from '../server/src/core/paths'

// One explicit account drain, or one chat (--chat <thread id>), through the production mover.
// Rerunning resumes an interrupted move into the destination it already made. --recover-from names
// earlier copies of the destination transcript, read only to restore rows a past repair lost.
// Either account's Codex app may be open: an open source app archives each original itself.
// No model turns or archive sweep. Prints one JSON line per step.
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    from: { type: 'string' },
    to: { type: 'string', default: 'here' },
    chat: { type: 'string' },
    'recover-from': { type: 'string', multiple: true, default: [] },
    'all-active': { type: 'boolean', default: false },
  },
})
if (!values.from) throw new Error('Specify --from <account name, email, number or id>.')
const instances = (await listCodexInstances()).filter((row) => !row.isExternal)
function resolveAccount(selector: string) {
  if (selector === 'here') {
    const home = process.env.CODEX_HOME
    if (!home) throw new Error('CODEX_HOME is required to resolve here.')
    const found = instances.filter(
      (row) => normalizeInstancePath(row.codexHome) === normalizeInstancePath(home),
    )
    if (found.length !== 1) throw new Error('The calling Codex account could not be identified.')
    return found[0]!
  }
  const key = selector.toLowerCase()
  const exact = instances.filter((row) =>
    [row.id, row.name, row.account?.email, row.account?.name, String(row.num)].some(
      (value) => value?.toLowerCase() === key,
    ),
  )
  const matches = exact.length
    ? exact
    : instances.filter((row) =>
        [row.name, row.account?.email, row.account?.name].some((value) =>
          value?.toLowerCase().includes(key),
        ),
      )
  if (matches.length !== 1)
    throw new Error(`Account '${selector}' must match exactly one instance.`)
  return matches[0]!
}
const source = resolveAccount(values.from)
const target = resolveAccount(values.to!)
const plan = await planCodexChatMove(source.id, target.id)
console.log(JSON.stringify({ from: source.name, to: target.name, chats: plan.chats.length }))
if (values.chat && !plan.chats.some((chat) => chat.id === values.chat))
  throw new Error(`Chat ${values.chat} is not an active chat of ${source.name}.`)
if (!values['all-active'] && !values.chat) {
  console.log(JSON.stringify({ dryRun: true, plan }))
  process.exit(0)
}
const runDir = join(CONFIG_DIR, 'backups', `codex-move-${Date.now()}`)
mkdirSync(runDir, { recursive: true })
const reportPath = join(runDir, 'report.json')
const report = { sourceId: source.id, targetId: target.id, plan, results: [] as unknown[] }
const save = () => writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
save()
const chats = values.chat ? plan.chats.filter((chat) => chat.id === values.chat) : plan.chats
if (!chats.length) throw new Error(`Chat ${values.chat} is no longer active.`)
for (const [index, chat] of chats.entries()) {
  // The mover rechecks account identity, transcript state and source process on every chat.
  if (!getCodexInstance(source.id) || !getCodexInstance(target.id))
    throw new Error('An account was removed during the batch.')
  const result = await moveCodexChat(
    source.id,
    {
      targetId: target.id,
      threadId: chat.id,
      updatedAt: chat.updatedAt,
      sourceAccountId: plan.sourceAccountId,
      targetAccountId: plan.targetAccountId,
    },
    {
      recoverFrom: values['recover-from'],
      onProgress: (progress) => console.log(JSON.stringify({ chat: index + 1, ...progress })),
    },
  )
  report.results.push({ sourceThreadId: chat.id, title: chat.title, ...result })
  save()
  console.log(JSON.stringify({ chat: index + 1, total: chats.length, ...result }))
  if (!result.ok) {
    console.error(`The source was retained. Report: ${reportPath}`)
    process.exit(1)
  }
}
console.log(JSON.stringify({ complete: true, moved: report.results.length, reportPath }))
