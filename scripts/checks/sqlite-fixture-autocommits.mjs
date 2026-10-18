// Guardrail against a bun:sqlite test fixture that commits one row at a time on Windows CI.
//
// This is not a style rule. On 2026-10-13 three tests timed out at bun's 5 s limit on GitHub's
// windows-latest runner and on no other runner:
//   · server/tests/opencode-sessions.test.ts   (5397 ms)
//   · server/tests/kit-ingest-foreign.test.ts  (5277 ms)
//   · server/tests/codex-thread-guard.test.ts  (5243 ms)
// Each fixture made about 9 separate autocommit writes (CREATE TABLE / INSERT via db.exec or
// db.query(...).run). Every autocommit is a journal fsync, and Windows pays that fsync dearly, so
// nine of them outran the limit. The fix was to wrap each fixture in db.exec('begin') ...
// db.exec('commit') (commits 8c09c086 and 6fea9abe). Nothing caught the next one before CI.
//
// The rule: in a test file that imports bun:sqlite, a Database handle opened for writing with
// `new Database(` may run at most THREE write statements before it is closed, unless those writes
// sit inside db.exec('begin') ... db.exec('commit') or inside db.transaction(...). A write is a
// `db.query(...).run`, `db.prepare(...).run`, `db.run`, or a `db.exec` whose SQL holds more than
// one statement or an INSERT / CREATE / UPDATE / DELETE / DROP / ALTER / REPLACE. SQL that cannot
// be read as a literal (a variable, say) counts as a write, because a `.run` on it is almost always
// a write. The threshold is 3: the broken fixture has 9 writes, and on the tree every unwrapped
// handle that is NOT a violation has at most 3 (measured with the threshold at 0: 12 such handles,
// the largest at 3). Four is the first count that is no longer a small fixture.
//
// DELIBERATELY NOT FLAGGED:
//   · A handle opened with `{ readonly: true }`. A read-only fixture cannot fsync per write.
//   · A handle on `:memory:` (or with no path). It has no journal file, so nothing is fsynced.
//   · Writes inside db.exec('begin') ... db.exec('commit'), or inside db.transaction(() => {...}).
//     Both are the fix, so both are read as the fix and never as a finding.
//   · Writes made through a helper that receives the handle as an argument. Following a handle
//     into another function is a larger job than this scan's precision can justify; the three
//     measured fixtures all wrote inline, which is where the rule applies.
//   · Anything inside a comment. Comments are blanked before the scan, so prose such as
//     "one commit for the whole fixture" never reads as a statement.
//   · Files that do not import bun:sqlite, such as desk2 fixtures on better-sqlite3.
//
// The SQL itself lives in string literals, so a blanked copy would lose it. The scan keeps two
// views of each file: `code` (comments and string contents blanked, same length) for locating
// calls and balancing parentheses, and `full` (comments only blanked) for reading the SQL.
//
// Self-contained by design (same reason as the other checks here): imports nothing but node stdlib,
// and returns plain finding objects for the runner.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ID = 'sqlite-fixture-autocommits'

// More than this many uncommitted writes on one handle is a violation. See the header for why 3.
const MAX_WRITES = 3

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'tmp', '.arkitect', 'coverage', 'build'])
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/

// A write keyword anywhere in the SQL text. Word-bounded and case-insensitive.
const WRITE_SQL = /\b(?:insert|update|delete|create|drop|alter|replace)\b/i

/** Recursively yield every test file under `dir`. */
function* testFiles(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* testFiles(p)
    } else if (TEST_FILE.test(e.name)) {
      yield p
    }
  }
}

/** Two same-length views of `text`: `code` has comments and string contents blanked, `full` has
 *  only comments blanked. Newlines always survive, so an index means the same place in both. */
function views(text) {
  const code = []
  const full = []
  const blank = (c) => (c === '\n' ? '\n' : ' ')
  let i = 0
  while (i < text.length) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') {
        code.push(' ')
        full.push(' ')
        i++
      }
      continue
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end === -1 ? text.length : end + 2
      for (; i < stop; i++) {
        code.push(blank(text[i]))
        full.push(blank(text[i]))
      }
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      // The quotes stay in both views so a literal's extent is visible; its contents differ.
      code.push(c)
      full.push(c)
      i++
      while (i < text.length && text[i] !== c) {
        if (text[i] === '\\' && i + 1 < text.length) {
          code.push(' ', ' ')
          full.push(text[i], text[i + 1])
          i += 2
          continue
        }
        code.push(blank(text[i]))
        full.push(text[i])
        i++
      }
      if (i < text.length) {
        code.push(c)
        full.push(c)
        i++
      }
      continue
    }
    code.push(c)
    full.push(c)
    i++
  }
  return { code: code.join(''), full: full.join('') }
}

/** Index of the `)` that closes the `(` at `open`, read from the `code` view, or -1. */
function closeParen(code, open) {
  let depth = 0
  for (let j = open; j < code.length; j++) {
    if (code[j] === '(') depth++
    else if (code[j] === ')') {
      depth--
      if (depth === 0) return j
    }
  }
  return -1
}

/** The argument span of a call whose `(` sits at `open`: [start, end) of the text between the parens. */
function argSpan(code, open) {
  const close = closeParen(code, open)
  if (close === -1) return null
  return { start: open + 1, end: close, close }
}

/** The SQL a call is given, read from the `full` view with its one wrapping pair of quotes removed,
 *  so `'begin'` reads as `begin`. An argument that is not a single string literal (a variable, or a
 *  concatenation) comes back as null, which is how the caller knows it cannot read the SQL. */
function sqlOf(full, span) {
  const text = full.slice(span.start, span.end).trim()
  const literal = /^(['"`])([\s\S]*)\1$/.exec(text)
  if (!literal || literal[2].includes(literal[1])) return null
  return literal[2].trim()
}

/** Is this statement text a write? Unreadable SQL is treated as one. */
function isWriteSql(sql) {
  if (sql === null) return true
  if (WRITE_SQL.test(sql)) return true
  // More than one statement in a single exec is a write batch even when no keyword is spelled out.
  const statements = sql.split(';').map((s) => s.trim()).filter(Boolean)
  return statements.length > 1
}

/** Find every handle opened for writing in one file, and the write statements against it. Returns
 *  one entry per handle, with its declaration line and the count of writes that are NOT wrapped in
 *  a transaction. */
function scanHandles(text) {
  const { code, full } = views(text)
  const results = []
  const declaration = /(?<![\w.$])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+Database\s*\(/g
  let decl
  while ((decl = declaration.exec(code)) !== null) {
    const name = decl[1]
    const openIdx = decl.index + decl[0].length - 1
    const args = argSpan(code, openIdx)
    if (!args) continue
    // A read-only handle cannot fsync per write, so it is out of scope by definition.
    if (/readonly\s*:\s*true/.test(full.slice(args.start, args.end))) continue
    // An in-memory database has no journal file, so no fsync: nothing here is slow on a disk.
    const target = full.slice(args.start, args.end).trim()
    if (target === '' || /^(['"`]):memory:\1$/.test(target)) continue

    // The region this handle is live in: from its declaration to its close, or to the next
    // declaration of the same name, or to the end of the file, whichever comes first.
    const from = args.close + 1
    const rest = code.slice(from)
    const closeM = new RegExp(`(?<![\\w.$])${name}\\s*\\.close\\s*\\(`).exec(rest)
    const redeclM = new RegExp(`(?<![\\w.$])(?:const|let|var)\\s+${name}\\s*=\\s*new\\s+Database\\s*\\(`).exec(rest)
    const candidates = [closeM, redeclM].filter(Boolean).map((m) => m.index)
    const to = candidates.length ? from + Math.min(...candidates) : code.length

    // Collect every call against this handle inside the region, in source order.
    const events = []
    const callRe = new RegExp(`(?<![\\w.$])${name}\\s*\\.(query|prepare|run|exec|transaction)\\s*\\(`, 'g')
    callRe.lastIndex = from
    let m
    while ((m = callRe.exec(code)) !== null && m.index < to) {
      const method = m[1]
      const open = m.index + m[0].length - 1
      const span = argSpan(code, open)
      if (!span) continue
      if (method === 'transaction') {
        events.push({ kind: 'tx', start: span.start, end: span.end })
        continue
      }
      // query / prepare count only when the statement is then `.run(`ed. `.all`, `.get` and `.values`
      // are reads, so they never reach the SQL check below.
      if ((method === 'query' || method === 'prepare') && !/^\s*\.run\s*\(/.test(code.slice(span.close + 1))) {
        continue
      }
      // begin / commit are markers, not writes, whichever method carries them: `db.exec('begin')` and
      // `db.run('BEGIN')` both open a transaction. Anything else is judged by its SQL.
      const sql = sqlOf(full, span)
      const text = sql ?? ''
      if (/^(?:begin|savepoint)\b/i.test(text)) {
        events.push({ kind: 'open', at: m.index })
      } else if (/^(?:commit|end|rollback|release)\b/i.test(text)) {
        events.push({ kind: 'close', at: m.index })
      } else if (/\bbegin\b/i.test(text) && /\bcommit\b/i.test(text)) {
        // One call carrying its own begin and commit is wrapped already.
        continue
      } else if (isWriteSql(sql)) {
        events.push({ kind: 'write', at: m.index, sql })
      }
    }

    // A write is uncounted if it sits inside a transaction( ... ) argument or between an open and a
    // close marker. Everything else is an autocommit, and those are what the threshold counts.
    const txSpans = events.filter((e) => e.kind === 'tx')
    let inTx = false
    let autocommits = 0
    for (const e of events) {
      if (e.kind === 'open') inTx = true
      else if (e.kind === 'close') inTx = false
      else if (e.kind === 'write') {
        const inside = txSpans.some((t) => e.at > t.start && e.at < t.end)
        if (inTx || inside) continue
        autocommits += 1
      }
    }

    results.push({
      name,
      line: lineAt(text, decl.index),
      autocommits,
    })
  }
  return results
}

/** 1-based line number of `index` in `text`. */
function lineAt(text, index) {
  let line = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/** The violations in one test file's text: one finding per handle whose uncommitted writes exceed
 *  MAX_WRITES. Returns plain `{ line, handle, autocommits }` objects. */
export function findViolations(text) {
  if (!/bun:sqlite/.test(text)) return []
  return scanHandles(text)
    .filter((h) => h.autocommits > MAX_WRITES)
    .map((h) => ({ line: h.line, handle: h.name, autocommits: h.autocommits }))
}

export const audit = {
  id: ID,
  title: 'a bun:sqlite test fixture must wrap its writes in one transaction, not autocommit each one',
  category: 'custom',
  domain: 'code',
  requires: {},
  // Gating: an autocommit fixture is fine on Linux and macOS and times out only on windows-latest,
  // so it passes locally and fails one leg of CI on someone else's schedule.
  gating: true,
  async run(ctx) {
    const root = ctx?.root ?? process.cwd()
    const findings = []
    let filesScanned = 0
    let handlesScanned = 0

    for (const file of testFiles(root)) {
      const rel = relative(root, file).replace(/\\/g, '/')
      let text
      try {
        if (statSync(file).size > 2_000_000) continue
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      if (!/bun:sqlite/.test(text)) continue
      filesScanned += 1
      const handles = scanHandles(text)
      handlesScanned += handles.length
      for (const h of handles) {
        if (h.autocommits <= MAX_WRITES) continue
        findings.push({
          id: ID,
          file: rel,
          line: h.line,
          severity: 'error',
          message:
            `The fixture handle \`${h.name}\` makes ${h.autocommits} separate autocommit writes ` +
            `(the limit is ${MAX_WRITES}). On windows-latest each one is a journal fsync, and ` +
            'three tests on this exact pattern timed out at bun\'s 5 s limit on 2026-10-13 ' +
            '(opencode-sessions 5397 ms, kit-ingest-foreign 5277 ms, codex-thread-guard 5243 ms).',
          fix:
            "Wrap the fixture's writes in one transaction: `db.exec('begin')` before the first " +
            "write and `db.exec('commit')` after the last, or `db.transaction(() => { ... })()`. " +
            'See codex-thread-guard.test.ts for the shape the fix took.',
        })
      }
    }

    const failed = findings.length > 0
    const report = failed
      ? `Found ${findings.length} sqlite fixture(s) that autocommit more than ${MAX_WRITES} writes:\n${findings
          .map((f) => `- ${f.file}:${f.line}`)
          .join('\n')}`
      : `Every bun:sqlite test fixture wraps its writes in one transaction ` +
        `(${handlesScanned} write handle(s) across ${filesScanned} file(s) checked, limit ${MAX_WRITES} autocommits). ✓`

    return { failed, findings, report }
  },
}

// Standalone CLI (used by CI): prints the report and exits 1 on any violation. During an arkitect
// run the module is only IMPORTED, so this block is inert there; it fires only on direct invocation.
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const res = await audit.run({ root: process.cwd() })
  console.log(res.report)
  if (res.failed) process.exit(1)
}
