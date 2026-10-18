// Model watch for the Free ChatGPT accounts (owner, 2026-10-13: keep the Free accounts on current models; a new 6.1
// must be quick to see and adopt). Desk remembers every model slug the accounts have listed and says so once when a
// slug nobody had listed appears, with what the role names resolve to, so it can be compared and adopted.
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { FreeInstance } from '@shared/free-instances'
import { writeFlushed } from '../write-flushed'

interface Listed { title?: string; reasoning?: string; accounts: number; roles: Set<string> }

/** The slugs the signed-in ChatGPT accounts list now, with how many list each and what the roles resolve to. */
function listed(instances: readonly FreeInstance[]): Map<string, Listed> {
  const out = new Map<string, Listed>()
  for (const i of instances) {
    if (i.provider !== 'chatgpt' || !i.loggedIn || !i.usage?.models?.length) continue
    for (const m of i.usage.models) {
      const entry = out.get(m.slug) ?? { title: m.title, reasoning: m.reasoning, accounts: 0, roles: new Set<string>() }
      entry.accounts++
      out.set(m.slug, entry)
    }
    for (const [role, slug] of Object.entries(i.usage.roles ?? {})) {
      const entry = out.get(slug)
      if (!entry) continue
      entry.roles.add(role)
    }
  }
  return out
}

export class ModelWatch {
  private readonly file: string
  constructor(home: string) {
    this.file = join(home, 'free', 'models-seen.json')
  }

  private read(): Set<string> | null {
    if (!existsSync(this.file)) return null
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'))
      return Array.isArray(data) ? new Set(data.filter((s): s is string => typeof s === 'string')) : null
    } catch { return null }
  }

  private write(seen: Set<string>): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFlushed(tmp, JSON.stringify([...seen].sort()))
    renameSync(tmp, this.file)
  }

  /** Compare what the accounts list now with what was seen. The first run seeds silently; later runs return a notice
   *  for slugs never seen before. A slug no account lists any more is forgotten (it notifies again if it returns). */
  check(instances: readonly FreeInstance[]): { title: string; body: string } | null {
    const now = listed(instances)
    if (!now.size) return null
    const before = this.read()
    const seen = new Set(now.keys())
    const fresh = before ? [...now.keys()].filter(s => !before.has(s)) : []
    const changed = !before || fresh.length > 0 || [...before].some(s => !seen.has(s))
    if (changed) this.write(seen)
    if (!fresh.length) return null
    const lines = fresh.map((slug) => {
      const m = now.get(slug)!
      const roles = [...m.roles]
      const meta = [m.title, m.reasoning].filter(Boolean).join(', ')
      return `${slug}${meta ? ` (${meta})` : ''}: listed by ${m.accounts} ChatGPT account${m.accounts === 1 ? '' : 's'}${roles.length ? `, a role of ${roles.join(', ')}` : ''}`
    })
    return { title: 'ChatGPT lists a new model', body: `${lines.join('; ')}. ${rolesLine(instances)} Compare it with HSwarm: hswarm models --free` }
  }
}

/** What each role name resolves to now, across the accounts, e.g. "Roles now: gpt-instant = gpt-6-mini." */
function rolesLine(instances: readonly FreeInstance[]): string {
  const roles = new Map<string, Set<string>>()
  for (const i of instances) {
    if (i.provider !== 'chatgpt' || !i.loggedIn) continue
    for (const [role, slug] of Object.entries(i.usage?.roles ?? {})) roles.set(role, (roles.get(role) ?? new Set()).add(slug))
  }
  if (!roles.size) return ''
  return `Roles now: ${[...roles].map(([role, slugs]) => `${role} = ${[...slugs].sort().join(' / ')}`).join(', ')}.`
}
