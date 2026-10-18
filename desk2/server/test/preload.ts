// Test preload for every desk2 suite (desk2/bunfig.toml): no test can remove the folder the suite runs in, or
// replace process.env, and a file that leaves a global swapped is named by the next file (see the end of this file).
//
// Why (2026-10-10): under Bun 1.4.3 on Windows, rmSync('', { recursive: true, force: true }) empties the WORKING
// folder and then throws EBUSY on the folder itself (Node throws ENOENT). A browser test whose beforeAll stopped
// before it made its Chrome profile cleaned up with rmSync(profile) while profile was still '', and every file under
// desk2/ went mid-run: node_modules, the builds and the uncommitted work. A remove whose target is the working folder,
// or a folder that holds it, now throws instead.
//
// The fs objects are patched in place (a default import and require() see that), and the four fs specifiers are
// replaced by modules made of the patched objects: Bun gives a named import of a builtin its own binding, which no
// patch of the object reaches (the root suite's tests/real-home-guard.ts measured it).

import { afterAll, beforeEach, mock } from 'bun:test'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type AnyFn = (...args: unknown[]) => unknown

const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)

/** The folder a remove would take with it when it holds the working folder ('' and '.' resolve to it); else null. */
function holdsCwd(target: unknown): string | null {
  const p = typeof target === 'string' ? target : target instanceof URL ? fileURLToPath(target) : Buffer.isBuffer(target) ? target.toString() : null
  if (p === null) return null
  const abs = path.resolve(p)
  const rel = path.relative(norm(abs), norm(process.cwd()))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) ? abs : null
}

function refusal(name: string, target: unknown): Error | null {
  const abs = holdsCwd(target)
  return abs ? new Error(`${name} would remove the folder the tests run in (${abs}): a path left empty by a setup that stopped early?`) : null
}

function guard(owner: Record<string, unknown>, name: string, style: 'sync' | 'callback' | 'promise'): void {
  const orig = owner[name] as AnyFn
  owner[name] = function (this: unknown, ...args: unknown[]) {
    const error = refusal(name, args[0])
    if (!error) return orig.apply(this, args)
    if (style === 'promise') return Promise.reject(error)
    const last = args[args.length - 1]
    if (style === 'callback' && typeof last === 'function') {
      process.nextTick(last as AnyFn, error)
      return undefined
    }
    throw error
  }
}

for (const name of ['rm', 'rmdir']) {
  guard(fs as unknown as Record<string, unknown>, `${name}Sync`, 'sync')
  guard(fs as unknown as Record<string, unknown>, name, 'callback')
  guard(fsp as unknown as Record<string, unknown>, name, 'promise')
}
const fsModule = () => ({ ...fs, default: fs })
const fspModule = () => ({ ...fsp, default: fsp })
for (const id of ['node:fs', 'fs']) mock.module(id, fsModule)
for (const id of ['node:fs/promises', 'fs/promises']) mock.module(id, fspModule)

// process.env cannot be replaced, only its keys set and deleted. A copy assigned back is a plain object: on Windows
// it holds Bun's upper-cased keys, so process.env.ProgramFiles read undefined for every later file. On 2026-10-10
// that is how findChrome found no Chrome mid-suite, and the browser test that then stopped early emptied desk2/.
Object.defineProperty(process, 'env', { value: process.env, writable: false, configurable: false, enumerable: true })

// A file that swaps a global (fetch, WebSocket, a DOM stand-in) puts it back before it ends: every file runs in this one
// process, so a swap left behind is every later file's. On 2026-10-12 web/test/stores.desk.test.ts left its fetch and
// WebSocket stubs in place, and 286 of 2426 tests in later files failed, each of them green alone: their fetch got
// that file's audio reply and no WebSocket (the headless Chrome tests' CDP among them) ever opened.
// A preload's beforeAll and afterAll run once per run, not per file, and a file's own beforeAll runs before the first
// beforeEach here, so the check sits where Bun resolves the next test file: after the last file's afterAll, before the
// next one loads. A guarded global that differs from the one this preload saw is put back there and named by the
// first test of the next file, which fails with the leaking file's name; the rest of the run goes on unharmed.
const GUARDED_GLOBALS = [
  'fetch', 'WebSocket', 'EventSource', 'Notification', 'window', 'document', 'navigator', 'location', 'localStorage',
  'sessionStorage', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'Date', 'Response',
  'Request', 'Headers', 'URL', 'AbortController', 'console',
]
const realGlobals = new Map(GUARDED_GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
const sameDescriptor = (a?: PropertyDescriptor, b?: PropertyDescriptor) =>
  a === b || (!!a && !!b && a.value === b.value && a.get === b.get && a.set === b.set)

/** Puts back every guarded global that differs from the preload's; returns their names. */
function putBackGlobals(): string[] {
  const changed: string[] = []
  for (const [name, real] of realGlobals) {
    if (sameDescriptor(Object.getOwnPropertyDescriptor(globalThis, name), real)) continue
    changed.push(name)
    if (real) Object.defineProperty(globalThis, name, real)
    else delete (globalThis as Record<string, unknown>)[name]
  }
  return changed
}

const leakMessage = (file: string, changed: string[]) =>
  `${path.relative(process.cwd(), file)} left globalThis.${changed.join(', globalThis.')} swapped when it ended (put ` +
  'back by the preload): restore it in that file, in an afterAll or afterEach, or every later file in the run gets it'

// Each test file gets its own temp folder under one run folder, removed when the next file starts and again at the
// run's end. Windows can hold a file a just-stopped child still has open, so each remove retries briefly. Without
// this, desk-* folders piled up in %TEMP% (2026-10-14: 587, about 200 a day).
const TEMP_VARS = ['TMPDIR', 'TEMP', 'TMP'] as const
const runTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk2-tests-'))
// Hydra Core mode reads ~/.agenthydra/core unless this is set, and core mode switched on there strips a paragraph from
// the Desk append, so 7 tests failed on a PC that runs it. A folder that does not exist reads as core mode off.
process.env.AGENTHYDRA_CORE_DIR = path.join(runTemp, 'core')
let fileTemp: string | null = null
let fileTempCount = 0

function removeTree(dir: string): void {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
}

function startFileTemp(): void {
  if (fileTemp) removeTree(fileTemp)
  fileTemp = path.join(runTemp, String(++fileTempCount))
  fs.mkdirSync(fileTemp, { recursive: true })
  for (const name of TEMP_VARS) process.env[name] = fileTemp
}

startFileTemp()

let currentFile = ''
let leak: string | null = null
Bun.plugin({
  name: 'desk2-test-file-boundary',
  setup(build) {
    build.onResolve({ filter: /\.(test|spec)\.[cm]?[jt]sx?$/ }, (args) => {
      const changed = putBackGlobals()
      if (changed.length && currentFile) leak = leakMessage(currentFile, changed)
      if (args.path !== currentFile) startFileTemp()
      currentFile = args.path
      return undefined
    })
  },
})
beforeEach(() => {
  if (leak === null) return
  const message = leak
  leak = null
  throw new Error(message)
})
afterAll(() => {
  if (fileTemp) removeTree(fileTemp)
  removeTree(runTemp)
  const changed = putBackGlobals()
  if (changed.length) throw new Error(leakMessage(currentFile, changed))
})
