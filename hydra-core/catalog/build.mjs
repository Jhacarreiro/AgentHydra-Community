#!/usr/bin/env node
// Hydra Core catalog builder (node 22, no dependencies).
//   node catalog/build.mjs           rebuild catalog/generated-<source>.json, drop any other generated-*.json (never touches hand-*.json)
//   node catalog/build.mjs --check   validate generated + hand files, print counts, exit 1 when invalid or too small
// Every parser tolerates missing fields: an entry that cannot be made valid is skipped and counted, never fatal.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// Home paths come from os.homedir() (HOME / USERPROFILE). Optional extra folders (a projects folder whose repos'
// AGENTS.md or CLAUDE.md become rules, more skill and agent folders) are read from <core>/catalog/sources.json
// when it exists; see docs/PEOPLE.md.
const HOME = homedir().replace(/\\/g, '/')
const CORE = (process.env.AGENTHYDRA_CORE_DIR || `${HOME}/.agenthydra/core`).replace(/\\/g, '/')
const CATALOG = `${CORE}/catalog`
const AGENTHYDRA = `${HOME}/.agenthydra`
const MANAGERS = `${AGENTHYDRA}/managers`
const PEOPLE = `${AGENTHYDRA}/people`
const ORG = `${CORE}/personas/org.json`
const cfgText = (() => { try { return readFileSync(`${CATALOG}/sources.json`, 'utf8').replace(/^\uFEFF/, '') } catch { return '' } })()
const CFG = (() => { try { const j = JSON.parse(cfgText); return j && typeof j === 'object' ? j : {} } catch { return {} } })()
const cfgPath = (k) => (typeof CFG[k] === 'string' && CFG[k] ? CFG[k].replace(/\\/g, '/').replace(/^~(?=\/|$)/, HOME) : '')
const cfgList = (k) => (Array.isArray(CFG[k]) ? CFG[k].map((v) => String(v).replace(/\\/g, '/').replace(/^~(?=\/|$)/, HOME)) : [])
const PROJECTS = cfgPath('projectsDir')
const SKILL_DIRS = [`${HOME}/.claude/skills`, ...cfgList('extraSkillDirs')]
const AGENT_DIRS = [`${HOME}/.claude/agents`, ...cfgList('extraAgentDirs')]

const KINDS = ['person', 'instrument', 'worker', 'knowledge', 'skill']
const TIERS = ['intern', 'employee', 'manager', 'owner']
const FAMILIES = ['intern', 'manager', 'board', 'expert', 'dredd-seat', 'sue', 'ape', 'art', 'you-sue', 'creator']
const PEOPLE_FAMILIES = ['manager', 'board', 'expert', 'dredd-seat', 'creator']
const FAMILY_TIER = { manager: 'manager', board: 'manager', expert: 'employee', 'dredd-seat': 'employee', creator: 'owner' }
const MODES = ['become', 'consult', 'hire']
const COSTS = ['free', 'low', 'medium', 'high']
const LOAD_TYPES = ['file', 'skill', 'tool', 'none']

// ---------- small helpers ----------
const fwd = (p) => String(p).replace(/\\/g, '/')
const safeRead = (p) => { try { return readFileSync(p, 'utf8').replace(/^\uFEFF/, '') } catch { return null } }
const safeJson = (p) => { const t = safeRead(p); if (t == null) return null; try { return JSON.parse(t) } catch { return null } }
const safeDir = (p) => { try { return readdirSync(p, { withFileTypes: true }) } catch { return [] } }
const isFile = (p) => existsSync(p)
const slugify = (s, max = 70) => String(s || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '')
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v))

/** One plain line, markdown stripped, at most `max` characters (default 159: the spec says under 160). */
function oneLine(s, max = 159) {
  const t = str(s).replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*]/g, '').replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max - 1)
  const dot = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '))
  if (dot > 60) return cut.slice(0, dot + 1)
  const sp = cut.lastIndexOf(' ')
  return (sp > 40 ? cut.slice(0, sp) : cut).replace(/[,;:\s-]+$/, '') + '…'
}
const tagsAll = (...lists) => [...new Set(lists.flat().map((t) => str(t).toLowerCase().trim()).filter((t) => t && t.length <= 40))]
const tagsOf = (...lists) => tagsAll(...lists).slice(0, 8)

/** Minimal YAML front matter: key: value, folded/literal blocks, and `- item` lists. Comment lines are ignored. */
function frontMatter(text) {
  const out = { fm: {}, lists: {}, body: str(text) }
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(out.body)
  if (!m) return out
  out.body = out.body.slice(m[0].length)
  let cur = null
  for (const line of m[1].split(/\r?\n/)) {
    if (/^\s*#/.test(line) || !line.trim()) continue
    const k = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line)
    if (k) {
      cur = k[1]
      let v = k[2].trim()
      if (/^[>|][+-]?$/.test(v)) v = ''
      out.fm[cur] = v
      continue
    }
    const li = /^\s+-\s+(.*)$/.exec(line)
    if (li && cur) { (out.lists[cur] ||= []).push(li[1].trim().replace(/^["']|["']$/g, '')); continue }
    if (cur && /^\s+/.test(line)) out.fm[cur] = (out.fm[cur] + ' ' + line.trim()).trim()
  }
  for (const k of Object.keys(out.fm)) out.fm[k] = out.fm[k].replace(/^(["'])([\s\S]*)\1$/, '$2')
  return out
}

// ---------- validation (shared by build and --check) ----------
export function validate(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'not an object'
  for (const k of ['id', 'kind', 'name', 'when', 'how', 'source']) if (typeof e[k] !== 'string' || !e[k].trim()) return `missing ${k}`
  if (!KINDS.includes(e.kind)) return 'bad kind'
  if (!e.id.startsWith(e.kind + ':') || e.id.length <= e.kind.length + 1 || /\s/.test(e.id)) return 'bad id'
  if (e.when.length >= 160) return 'when too long'
  if (/[\r\n]/.test(e.when)) return 'when not one line'
  if (e.how.length > 600) return 'how too long'
  if (e.name.length > 120) return 'name too long'
  if (e.title != null && (typeof e.title !== 'string' || e.title.length > 200)) return 'bad title'
  if (!Array.isArray(e.tags) || e.tags.some((t) => typeof t !== 'string')) return 'bad tags'
  if (!COSTS.includes(e.cost)) return 'bad cost'
  if (e.kind === 'person') {
    if (!TIERS.includes(e.tier)) return 'person without valid tier'
    if (!FAMILIES.includes(e.family)) return 'person without valid family'
    if (e.tier === 'owner' && Array.isArray(e.modes) && e.modes.includes('become')) return 'owner tier is consult only'
    if (e.reportsTo != null && !(typeof e.reportsTo === 'string' && e.reportsTo.startsWith('person:'))) return 'reportsTo must be a person id'
    if (e.division != null && (typeof e.division !== 'string' || !e.division)) return 'bad division'
    if (!Array.isArray(e.modes) || !e.modes.length || e.modes.some((m) => !MODES.includes(m))) return 'person without valid modes'
  } else if (e.tier != null || e.modes != null || e.family != null || e.reportsTo != null || e.division != null) return 'person fields on a non-person'
  if (e.folders != null && (!Array.isArray(e.folders) || e.folders.some((f) => typeof f !== 'string'))) return 'bad folders'
  const l = e.load
  if (!l || typeof l !== 'object' || !LOAD_TYPES.includes(l.type)) return 'bad load'
  if (l.type === 'file' && (typeof l.path !== 'string' || !l.path)) return 'load file without path'
  if (l.type === 'skill' && (typeof l.name !== 'string' || !l.name)) return 'load skill without name'
  if (l.type === 'tool' && (typeof l.call !== 'string' || !l.call)) return 'load tool without call'
  if (JSON.stringify(e).length > 3000) return 'entry too long (persona text inside the JSON?)'
  return null
}

// ---------- source runner ----------
const allSkips = {}
const written = new Set()
function runSource(name, fn) {
  const skips = { count: 0, reasons: {}, examples: [] }
  const seen = new Set()
  const out = []
  const skip = (why, id) => {
    skips.count++
    skips.reasons[why] = (skips.reasons[why] || 0) + 1
    if (id && skips.examples.length < 5) skips.examples.push(`${id}: ${why}`)
  }
  const add = (e) => {
    const err = validate(e)
    if (err) return skip(err, e && e.id)
    if (seen.has(e.id)) return skip('duplicate id', e.id)
    seen.add(e.id)
    out.push(e)
  }
  try { fn(add, skip) } catch (err) { skip('source failed: ' + str(err && err.message).split('\n')[0].slice(0, 120)) }
  mkdirSync(CATALOG, { recursive: true })
  writeFileSync(`${CATALOG}/generated-${name}.json`, JSON.stringify(out, null, 2) + '\n')
  written.add(`generated-${name}.json`)
  allSkips[name] = skips
  console.log(`${name}: ${out.length} entries, ${skips.count} skipped`)
}

// ---------- 1. managers ----------
function managers(add, skip) {
  const org = safeJson(ORG) || {}
  for (const d of safeDir(MANAGERS)) {
    if (!d.isDirectory()) continue
    const dir = `${MANAGERS}/${d.name}`
    const p = safeJson(`${dir}/persona.json`)
    if (!p) { if (existsSync(`${dir}/brief.md`) || d.name === 'research' || d.name === 'sessions' || d.name === 'analytics') continue; skip('no persona.json', d.name); continue }
    const slug = slugify(p.slug || d.name)
    const briefPath = `${dir}/${str(p.brief) || 'brief.md'}`
    const hasBrief = isFile(briefPath)
    const id = `person:${slug}`
    add({
      id, kind: 'person', name: str(p.name) || slug, title: str(p.title) || undefined, tier: 'manager', family: 'manager',
      division: (org[slug] && org[slug].division) || undefined, reportsTo: org[slug] && org[slug].reportsTo ? `person:${org[slug].reportsTo}` : undefined,
      when: oneLine(p.oneLiner || p.jev || p.title || p.name),
      tags: tagsAll(Array.isArray(p.keywords) ? p.keywords : [], p.role),
      modes: ['become', 'consult', 'hire'], cost: 'medium',
      how: `core_use { chat, id: "${id}", mode: "become" | "consult" (with question) | "hire" (with job) }. Becoming loads its brief into this chat.`,
      load: hasBrief ? { type: 'file', path: briefPath } : { type: 'none' },
      source: `${dir}/persona.json (oneLiner, keywords, brief)`
    })
  }
}

// ---------- 1b. people folders: ~/.agenthydra/people/<family>/<slug>/persona.json (one format for every family) ----------
function people(add, skip) {
  const org = safeJson(ORG) || {}
  for (const family of PEOPLE_FAMILIES) {
    for (const d of safeDir(`${PEOPLE}/${family}`)) {
      if (!d.isDirectory()) continue
      const dir = `${PEOPLE}/${family}/${d.name}`
      const p = safeJson(`${dir}/persona.json`)
      if (!p) { skip('no persona.json', `${family}/${d.name}`); continue }
      const slug = slugify(p.slug || d.name)
      const id = family === 'manager' ? `person:${slug}` : `person:${slug.startsWith(family + '-') ? slug : family + '-' + slug}`
      const tier = TIERS.includes(p.tier) ? p.tier : FAMILY_TIER[family]
      const modes = Array.isArray(p.modes) ? p.modes.filter((m) => MODES.includes(m)) : []
      const briefPath = `${dir}/${str(p.brief) || 'brief.md'}`
      const hasBrief = isFile(briefPath)
      const useModes = modes.length ? modes : family === 'manager' ? ['become', 'consult', 'hire'] : hasBrief ? ['become', 'consult'] : ['consult']
      add({
        id, kind: 'person', name: str(p.name) || slug, title: str(p.title) || undefined, tier, family,
        division: (org[slug] && org[slug].division) || undefined, reportsTo: org[slug] && org[slug].reportsTo ? `person:${org[slug].reportsTo}` : undefined,
        when: oneLine(p.oneLiner || p.jev || p.title || p.name),
        tags: tagsAll(Array.isArray(p.keywords) ? p.keywords : [], p.role, family),
        modes: useModes, cost: COSTS.includes(p.cost) ? p.cost : 'medium',
        how: `core_use { chat, id: "${id}", mode: ${useModes.map((m) => `"${m}"`).join(' | ')} }. Becoming loads its brief into this chat.`,
        load: hasBrief ? { type: 'file', path: briefPath } : { type: 'none' },
        source: `${dir}/persona.json (oneLiner, keywords, brief)`
      })
    }
  }
}

// ---------- 2. skills ----------
function skills(add, skip) {
  for (const root of SKILL_DIRS) {
    for (const d of safeDir(root)) {
      if (!d.isDirectory()) continue
      const file = `${root}/${d.name}/SKILL.md`
      const t = safeRead(file)
      if (t == null) { skip('no SKILL.md', d.name); continue }
      const { fm } = frontMatter(t)
      const name = slugify(fm.name || d.name)
      const desc = fm.description || ''
      if (!desc) { skip('no description', name); continue }
      const lead = /^([A-Z][A-Za-z.'’\- ]{1,40}?) on /.exec(desc)
      const expert = lead && /what would .{1,40} say/i.test(desc)
      const source = `${file}:1 (front matter name, description)`
      if (expert) {  // listed only as a person; no duplicate skill: entry
        const id = `person:${name}`
        add({
          id, kind: 'person', name: lead[1].trim(), title: oneLine(desc.replace(/\s+Use (whenever|when|for)[\s\S]*$/, ''), 200),
          tier: 'employee', family: 'expert', when: oneLine(desc), tags: tagsOf(fm.field, name, lead[1]), modes: ['consult', 'become'], cost: 'medium',
          how: `core_use { chat, id: "${id}", mode: "consult", question } for a hidden answer, or mode "become" to load the skill into this chat (Skill tool, skill "${name}").`,
          load: { type: 'skill', name }, source
        })
      } else {
        add({
          id: `skill:${name}`, kind: 'skill', name, title: undefined, when: oneLine(desc), tags: tagsOf(fm.field, name.split('-')),
          cost: 'free', how: `Invoke the Skill tool with skill "${name}"; it loads its instructions into this chat.`,
          load: { type: 'skill', name }, source
        })
      }
    }
  }
}

// ---------- 3. agents ----------
function agents(add, skip) {
  for (const root of AGENT_DIRS) {
    for (const f of safeDir(root)) {
      if (!f.isFile() || !f.name.endsWith('.md')) continue
      const file = `${root}/${f.name}`
      const t = safeRead(file)
      if (t == null) { skip('agent unreadable', f.name); continue }
      const { fm } = frontMatter(t)
      const name = slugify(fm.name || f.name.replace(/\.md$/, ''))
      const model = str(fm.model).toLowerCase()
      add({
        id: `worker:${name}`, kind: 'worker', name, when: oneLine(fm.description || `Sub-agent type ${name}`),
        tags: tagsOf('agent', model, name.split('-')), cost: /opus/.test(model) ? 'high' : /haiku/.test(model) ? 'low' : 'medium',
        how: `Agent tool with subagent_type "${name}"${model ? ` (model ${model}${fm.effort ? ', effort ' + fm.effort : ''})` : ''}.`,
        load: { type: 'file', path: file }, source: `${file}:1 (front matter name, description, model)`
      })
    }
  }
}

// ---------- 4. repo rules ----------
function repos(add, skip) {
  if (!PROJECTS) return
  for (const d of safeDir(PROJECTS)) {
    if (!d.isDirectory()) continue
    const dir = `${PROJECTS}/${d.name}`
    const file = ['AGENTS.md', 'CLAUDE.md'].map((n) => `${dir}/${n}`).find(isFile)
    if (!file) continue
    add({
      id: `knowledge:repo-${slugify(d.name)}`, kind: 'knowledge', name: `${d.name} repo rules`,
      when: oneLine(`read before you edit, commit, test or deploy in ${d.name}`), tags: tagsOf('repo', 'rules', d.name), cost: 'free',
      folders: [dir], how: `Read ${file} before you edit, commit, test or deploy here (core_use mode "load" returns it).`,
      load: { type: 'file', path: file }, source: file
    })
  }
}

// ---------- retired sources ----------
// Older builders also wrote generated-dredd, -crainium, -pinned, -boardroom and -owners.json, and the catalog loader and
// the Stop hook read every generated-*.json, so a file no source writes now would keep its entries live. The pinned
// source also split rulings into <core>/knowledge/pinned/<slug>.md; only the files it wrote (its Source line) go.
function retire() {
  for (const d of safeDir(CATALOG)) {
    if (!d.isFile() || !/^generated-.*\.json$/.test(d.name) || written.has(d.name)) continue
    rmSync(`${CATALOG}/${d.name}`, { force: true })
    console.log(`${d.name}: removed, no source writes it now`)
  }
  const pinnedDir = `${CORE}/knowledge/pinned`
  for (const f of safeDir(pinnedDir)) {
    const path = `${pinnedDir}/${f.name}`
    if (f.isFile() && f.name.endsWith('.md') && /^Source: .* split by build\.mjs\)$/m.test((safeRead(path) || '').split('\n', 4).join('\n'))) rmSync(path, { force: true })
  }
  try { rmdirSync(pinnedDir) } catch {}  // only when nothing else is in it
}

// ---------- build ----------
function build() {
  runSource('managers', managers)
  runSource('people', people)
  runSource('skills', skills)
  runSource('agents', agents)
  runSource('repos', repos)
  retire()
  writeFileSync(`${CATALOG}/skips.json`, JSON.stringify(allSkips, null, 2) + '\n')
}

// ---------- check ----------
function loadFile(path) {
  const t = safeRead(path)
  if (t == null) return { error: 'unreadable' }
  try {
    const a = JSON.parse(t)
    return Array.isArray(a) ? { entries: a } : { error: 'not a JSON array' }
  } catch (e) { return { error: 'invalid JSON: ' + str(e.message).slice(0, 80) } }
}
function check() {
  let bad = 0
  const fail = (m) => { bad++; console.log('INVALID: ' + m) }
  const files = safeDir(CATALOG).filter((d) => d.isFile() && /^(generated|hand)-.*\.json$/.test(d.name)).map((d) => d.name).sort()
  if (!files.length) fail('no catalog files; run the builder first (node hydra-core/catalog/build.mjs)')
  const byLayer = { generated: new Map(), hand: new Map() }
  for (const f of files) {
    const layer = f.startsWith('hand-') ? 'hand' : 'generated'
    const r = loadFile(`${CATALOG}/${f}`)
    if (r.error) { fail(`${f}: ${r.error}`); continue }
    r.entries.forEach((e, i) => {
      const err = validate(e)
      if (err) return fail(`${f}[${i}] ${e && e.id}: ${err}`)
      if (byLayer[layer].has(e.id)) return fail(`${f}[${i}]: duplicate id ${e.id} (also in ${byLayer[layer].get(e.id).file})`)
      byLayer[layer].set(e.id, { e, file: f })
    })
  }
  const merged = new Map([...byLayer.generated].map(([k, v]) => [k, v.e]))
  let overridden = 0
  for (const [k, v] of byLayer.hand) { if (merged.has(k)) overridden++; merged.set(k, v.e) }
  const all = [...merged.values()]
  const by = (fn) => all.reduce((m, e) => { const k = fn(e); if (k) m[k] = (m[k] || 0) + 1; return m }, {})
  const kinds = by((e) => e.kind)
  const tiers = by((e) => e.tier)
  console.log(`catalog: ${all.length} entries (${byLayer.generated.size} generated, ${byLayer.hand.size} hand, ${overridden} generated replaced by hand)`)
  console.log('by kind: ' + JSON.stringify(kinds))
  console.log('by tier: ' + JSON.stringify(tiers))
  const sk = safeJson(`${CATALOG}/skips.json`)
  console.log('skips per source: ' + (sk ? Object.entries(sk).map(([k, v]) => `${k}=${v.count}`).join(' ') : 'unknown (skips.json missing)'))
  if (sk) for (const [k, v] of Object.entries(sk)) if (v.count) console.log(`  ${k}: ${JSON.stringify(v.reasons)} e.g. ${v.examples.join(' | ')}`)
  // Floors come from sources.json "minimums"; a fresh install has none, so an empty catalog is valid.
  const floor = CFG.minimums && typeof CFG.minimums === 'object' ? CFG.minimums : {}
  const need = [
    ['managers', tiers.manager || 0, floor.managers || 0],
    ['employees', tiers.employee || 0, floor.employees || 0],
    ['instruments', kinds.instrument || 0, floor.instruments || 0],
    ['skills', kinds.skill || 0, floor.skills || 0],
    ['knowledge entries', kinds.knowledge || 0, floor.knowledge || 0]
  ]
  for (const [label, have, min] of need) if (have < min) fail(`only ${have} ${label}, need at least ${min}`)
  console.log(bad ? `CHECK FAILED: ${bad} problem(s)` : 'CHECK OK')
  process.exit(bad ? 1 : 0)
}

if (process.argv.includes('--check')) check()
else build()
