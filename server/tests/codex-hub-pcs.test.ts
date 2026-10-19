// server/tests/codex-hub-pcs.test.ts — which PC a Codex hub lets act as which, as the store decides it.
//
// The store (src/core/codex-hub-pcs.ts) as plain functions: each test has a hub folder of its own and says what time
// it is, so the 20-minute codes, the 7-day window and the 30-day floor are checked without waiting. The routes that
// use it are codex-hub-auth.test.ts's. Every token here is made at run time, as a client makes one.
import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import pckeys from '../../codex-hub-tray/testdata/pckey.json'
import { codexHubToken, hubTokenMatches } from '../src/core/codex-hub'
import { hubPcKey, isHubPcKey, isPcToken, pcTokenId } from '../src/core/codex-hub-ids'
import {
  bindPcInstall,
  exchangeLegacy,
  forgetPc,
  hubPcRows,
  legacyWindow,
  linkCredentialValid,
  logCodexHubStart,
  markPcUsed,
  mintConfirm,
  mintPairCode,
  type PairRedemption,
  pairTarget,
  pcByToken,
  pcStoreReadable,
  pendingKeyFor,
  pendingKeys,
  redeemPairCode,
  registerPcToken,
  retirePc,
  revokePc,
  takeConfirm,
} from '../src/core/codex-hub-pcs'
import { newPcToken } from './codex-hub-test-pc'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const T0 = Date.parse('2026-10-18T09:00:00.000Z')
const iso = (t: number) => new Date(t).toISOString()
const ADMIN = `admin-${crypto.randomUUID()}`
const LEGACY = `legacy-${crypto.randomUUID()}`
const A = 'install-aaaa-0001'
const B = 'install-bbbb-0002'
const C = 'install-cccc-0003'
const windows = process.platform === 'win32'

// --- the settings, each restored ------------------------------------------------------------------

const NAMES = ['CODEX_HUB_TOKEN', 'CODEX_HUB_LEGACY_TOKEN', 'CODEX_HUB_LEGACY_UNTIL'].flatMap(
  (s) => [`AGENTHYDRA_${s}`, `CCMANAGERUI_${s}`],
)
const saved = new Map(NAMES.map((n) => [n, process.env[n]]))

/** The hub's settings for the next calls; what is not given is unset. */
function settings(s: { admin?: string; legacy?: string; until?: string }): void {
  for (const n of NAMES) delete process.env[n]
  if (s.admin) process.env.AGENTHYDRA_CODEX_HUB_TOKEN = s.admin
  if (s.legacy) process.env.AGENTHYDRA_CODEX_HUB_LEGACY_TOKEN = s.legacy
  if (s.until) process.env.AGENTHYDRA_CODEX_HUB_LEGACY_UNTIL = s.until
}

const scratch = join(process.env.AGENTHYDRA_HOME!, `hub-pcs-${crypto.randomUUID().slice(0, 6)}`)
let roots = 0
/** A hub folder of the test's own, not made yet. */
const newRoot = () => join(scratch, `root-${++roots}`)

beforeEach(() => settings({ admin: ADMIN }))

afterAll(() => {
  for (const [n, v] of saved) {
    if (v === undefined) delete process.env[n]
    else process.env[n] = v
  }
  rmSync(scratch, { recursive: true, force: true })
})

// --- helpers --------------------------------------------------------------------------------------

const storeFile = (root: string) => join(root, '.pcs.json')
const stored = (root: string) => JSON.parse(readFileSync(storeFile(root), 'utf8'))
const mode = (path: string) => statSync(path).mode & 0o777

/** A PC's folder of copies, as a push leaves it: its manifest, with or without an install id. */
function folder(root: string, key: string, m: { pc?: string; install?: string; pushedAt: number }) {
  mkdirSync(join(root, key), { recursive: true })
  writeFileSync(
    join(root, key, 'manifest.json'),
    JSON.stringify({
      pc: m.pc ?? key,
      ...(m.install ? { install: m.install } : {}),
      pushedAt: iso(m.pushedAt),
      threads: [],
      files: {},
    }),
  )
}

/** A token for `pc` from the command line, bound to `install` (A unless given; null leaves it unbound). */
function pcIn(
  root: string,
  pc: string,
  opts: { install?: string | null; replace?: boolean; now?: number } = {},
) {
  const t = newPcToken()
  const r = registerPcToken(
    {
      pc,
      id: t.id,
      hash: t.hash,
      install: opts.install === undefined ? A : opts.install,
      replace: opts.replace,
    },
    root,
    opts.now ?? T0,
  )
  return { ...t, r }
}

/** Why each key that is not pending is not, from the list. */
const whys = (root: string, now = T0) =>
  Object.fromEntries((hubPcRows(root, now)?.pcs ?? []).map((r) => [r.key, r.why ?? r.state]))

// --- the token ------------------------------------------------------------------------------------

test('a PC token is chp_, its 16-hex id, _, and a 64-hex secret; near misses are not one', () => {
  const { token, id, hash } = newPcToken()
  expect(token).toHaveLength(85)
  expect(isPcToken(token)).toBe(true)
  expect(pcTokenId(token)).toBe(id)
  expect(hash).toBe(createHash('sha256').update(token, 'utf8').digest('hex'))
  const secret = token.slice(21)
  for (const miss of [
    token.toUpperCase(),
    `chp_${id.toUpperCase()}_${secret}`,
    `chp_${id}_${secret.toUpperCase()}`,
    `chp_${id}_${secret.slice(1)}`,
    `chp_${id}_${secret}0`,
    `chp_${id.slice(1)}_${secret}`,
    `chp_${id}0_${secret}`,
    `chp_${id}_${secret.slice(1)}g`,
    `${token} `,
    ` ${token}`,
    `${token}\n`,
    token.slice(4),
    `chq_${id}_${secret}`,
    `chp-${id}-${secret}`,
    '',
  ]) {
    expect({ miss, is: isPcToken(miss) }).toEqual({ miss, is: false })
    expect(pcTokenId(miss)).toBeNull()
  }
  expect(isPcToken(null)).toBe(false)
  expect(isPcToken(undefined)).toBe(false)
})

test('an admin token shaped like a PC token turns no hub on; the admin and legacy tokens are compared as digests', () => {
  settings({ admin: newPcToken().token, legacy: LEGACY })
  expect(codexHubToken()).toBeNull()
  expect(legacyWindow(newRoot(), T0)).toEqual({ open: false })
  settings({ admin: ` ${ADMIN} ` })
  expect(codexHubToken()).toBe(ADMIN)
  expect(hubTokenMatches(`Bearer ${ADMIN}`, ADMIN)).toBe(true)
  expect(hubTokenMatches(`bearer   ${ADMIN} `, ADMIN)).toBe(true)
  for (const header of [undefined, '', 'Bearer', `Bearer ${ADMIN}x`, `Basic ${ADMIN}`, ADMIN])
    expect(hubTokenMatches(header, ADMIN)).toBe(false)
})

test('every key case in codex-hub-tray/testdata/pckey.json is what hubPcKey answers', () => {
  expect(pckeys.length).toBeGreaterThan(10)
  for (const { pc, key } of pckeys as { pc: string; key: string | null }[])
    expect({ pc, key: hubPcKey(pc) }).toEqual({ pc, key })
})

test('isHubPcKey is what hubPcKey makes: a dash last only where the cut at 63 left one', () => {
  for (const { key } of pckeys as { key: string | null }[])
    if (key) expect({ key, ok: isHubPcKey(key) }).toEqual({ key, ok: true })
  for (const key of ['a', '_', '_under_', 'a--b', `${'a'.repeat(62)}-`, `${'a'.repeat(61)}--`])
    expect({ key, ok: isHubPcKey(key) }).toEqual({ key, ok: true })
  for (const key of [
    '',
    '-',
    '-a',
    'a-',
    `${'a'.repeat(61)}-`,
    'a'.repeat(64),
    'A',
    'a b',
    '.pusher',
    '..',
  ])
    expect({ key, ok: isHubPcKey(key) }).toEqual({ key, ok: false })
})

// --- the store ------------------------------------------------------------------------------------

test('registering keeps the id and hash: .pcs.json holds no token, at mode 600, in a folder it made at 700', () => {
  const root = newRoot()
  const t = newPcToken()
  expect(registerPcToken({ pc: ' Office-PC ', id: t.id, hash: t.hash }, root, T0)).toEqual({
    ok: true,
    pc: 'Office-PC',
    key: 'office-pc',
    id: t.id,
  })
  const text = readFileSync(storeFile(root), 'utf8')
  expect(text).toContain(t.hash)
  expect(text).not.toContain(t.token)
  expect(text).not.toContain(t.token.slice(21))
  // A command-line token has no install id until its first use.
  expect(stored(root)).toEqual({
    version: 1,
    pcs: {
      'office-pc': {
        pc: 'Office-PC',
        tokenId: t.id,
        tokenHash: t.hash,
        pairedAt: iso(T0),
        pairedBy: 'cli',
      },
    },
  })
  if (!windows) {
    expect(mode(storeFile(root))).toBe(0o600)
    expect(mode(root)).toBe(0o700)
  }
  // Shapes are checked: a name with no control characters, a 16-hex id and a 64-hex hash.
  for (const bad of [
    { pc: '', id: t.id, hash: t.hash },
    { pc: '...', id: t.id, hash: t.hash },
    { pc: 'x'.repeat(65), id: t.id, hash: t.hash },
    { pc: 'Laptop\n[codex-hub] forged', id: t.id, hash: t.hash },
    { pc: 'Laptop', id: t.id.toUpperCase(), hash: t.hash },
    { pc: 'Laptop', id: t.id, hash: t.hash.slice(1) },
    { pc: 'Laptop', id: t.token, hash: t.hash },
  ])
    expect(registerPcToken(bad, root, T0)).toMatchObject({
      ok: false,
      status: 400,
      code: 'bad-request',
    })
})

test.skipIf(windows)('a temporary file an earlier run left at 0644 ends as a store at 600', () => {
  const root = newRoot()
  mkdirSync(root, { recursive: true })
  const tmp = `${storeFile(root)}.${process.pid}.tmp`
  writeFileSync(tmp, 'left by a run that stopped')
  chmodSync(tmp, 0o644)
  expect(pcIn(root, 'Laptop').r).toMatchObject({ ok: true })
  expect(mode(storeFile(root))).toBe(0o600)
  expect(existsSync(tmp)).toBe(false)
})

test('a token is found by its id, then its hash: a wrong secret, an unknown id and a revoked one are refused, and a placeholder matches none', () => {
  const root = newRoot()
  const a = pcIn(root, 'Office-PC')
  expect(pcByToken(a.token, root)).toMatchObject({
    ok: true,
    key: 'office-pc',
    record: { pc: 'Office-PC', tokenId: a.id, install: A },
  })
  const other = newPcToken()
  const unknown = { ok: false, status: 401, code: 'unknown-token' }
  expect(pcByToken(`chp_${a.id}_${other.token.slice(21)}`, root)).toMatchObject(unknown)
  expect(pcByToken(other.token, root)).toMatchObject(unknown)
  expect(pcByToken('not-a-token', root)).toMatchObject(unknown)

  expect(revokePc('office-pc', root, T0 + MIN)).toMatchObject({ ok: true })
  expect(pcByToken(a.token, root)).toMatchObject({ ok: false, status: 401, code: 'revoked' })

  // Revoking a key with copies and no token writes a placeholder: no token id, so no token is ever its.
  folder(root, 'old-pc', { pc: 'Old-PC', install: B, pushedAt: T0 })
  expect(revokePc('old-pc', root, T0)).toEqual({
    ok: true,
    pc: 'Old-PC',
    key: 'old-pc',
    state: 'revoked',
    relayClosed: false,
  })
  expect(stored(root).pcs['old-pc']).toEqual({
    pc: 'Old-PC',
    install: B,
    revokedAt: iso(T0),
    revokedWhy: 'revoked by the owner',
  })
  expect(pairTarget('old-pc', root, T0)).toMatchObject({ state: 'revoked', replaces: null })
  expect(pcByToken(newPcToken().token, root)).toMatchObject(unknown)
})

test('a token id belongs to one record, a revoked one included: id-taken', () => {
  const root = newRoot()
  const a = pcIn(root, 'Office-PC')
  const twin = { pc: 'Laptop', id: a.id, hash: newPcToken().hash, install: B }
  expect(registerPcToken(twin, root, T0)).toMatchObject({
    ok: false,
    status: 409,
    code: 'id-taken',
  })
  revokePc('office-pc', root, T0)
  expect(registerPcToken(twin, root, T0)).toMatchObject({ code: 'id-taken' })
  expect(stored(root).pcs.laptop).toBeUndefined()
})

test('the first use binds an unbound token to its install id, once, and notes when', () => {
  const root = newRoot()
  const a = pcIn(root, 'Office-PC', { install: null })
  expect(stored(root).pcs['office-pc'].install).toBeUndefined()
  expect(bindPcInstall('office-pc', a.id, A, root)).toBeNull()
  expect(bindPcInstall('office-pc', a.id, B, root)).toBeNull()
  expect(markPcUsed('office-pc', a.id, root, T0 + MIN)).toBeNull()
  expect(markPcUsed('office-pc', a.id, root, T0 + 2 * MIN)).toBeNull()
  expect(stored(root).pcs['office-pc']).toMatchObject({ install: A, firstUsedAt: iso(T0 + MIN) })
  // Another token's id binds nothing.
  const b = pcIn(root, 'Laptop', { install: null })
  expect(bindPcInstall('laptop', a.id, B, root)).toBeNull()
  expect(stored(root).pcs.laptop.install).toBeUndefined()
  expect(pcByToken(b.token, root)).toMatchObject({ ok: true })
})

test('pairing a key again replaces its token in place: a new id, the old token unknown, and a fresh record', () => {
  const root = newRoot()
  const a = pcIn(root, 'Office-PC')
  markPcUsed('office-pc', a.id, root, T0 + MIN)
  expect(pcIn(root, 'Office-PC').r).toMatchObject({ ok: false, status: 409, code: 'name-paired' })
  const b = pcIn(root, 'office pc', { install: B, replace: true, now: T0 + HOUR })
  expect(b.r).toEqual({ ok: true, pc: 'office pc', key: 'office-pc', id: b.id })
  expect(pcByToken(a.token, root)).toMatchObject({ code: 'unknown-token' })
  expect(pcByToken(b.token, root)).toMatchObject({ ok: true, key: 'office-pc' })
  expect(stored(root).pcs['office-pc']).toEqual({
    pc: 'office pc',
    tokenId: b.id,
    tokenHash: b.hash,
    install: B,
    pairedAt: iso(T0 + HOUR),
    pairedBy: 'cli',
  })
})

test('the store is cached and written through: a re-pair that leaves the file the same size is seen at once', () => {
  const root = newRoot()
  const a = pcIn(root, 'Office-PC')
  const size = statSync(storeFile(root)).size
  const b = pcIn(root, 'Office-PC', { replace: true })
  expect(statSync(storeFile(root)).size).toBe(size)
  expect(pcByToken(b.token, root)).toMatchObject({ ok: true, key: 'office-pc' })
  expect(pcByToken(a.token, root)).toMatchObject({ code: 'unknown-token' })
})

test('revoke keeps the record and the copies; retire revokes only its own token; forget removes the record and the folder', () => {
  const root = newRoot()
  const a = pcIn(root, 'Office-PC')
  const b = pcIn(root, 'Laptop', { install: B })
  const c = pcIn(root, 'Spare', { install: C })
  folder(root, 'office-pc', { pc: 'Office-PC', install: A, pushedAt: T0 })

  expect(revokePc('office-pc', root, T0 + 1)).toEqual({
    ok: true,
    pc: 'Office-PC',
    key: 'office-pc',
    state: 'revoked',
    relayClosed: false,
  })
  expect(stored(root).pcs['office-pc']).toMatchObject({
    tokenId: a.id,
    revokedAt: iso(T0 + 1),
    revokedWhy: 'revoked by the owner',
  })
  // Again: as it was.
  expect(revokePc('office-pc', root, T0 + 2)).toMatchObject({ ok: true, state: 'revoked' })
  expect(stored(root).pcs['office-pc'].revokedAt).toBe(iso(T0 + 1))
  expect(existsSync(join(root, 'office-pc', 'manifest.json'))).toBe(true)
  expect(revokePc('nobody', root, T0)).toMatchObject({ ok: false, status: 404, code: 'not-found' })
  expect(pcByToken(b.token, root)).toMatchObject({ ok: true })

  // Retire: the caller's own record, while it still has the caller's token.
  expect(retirePc('laptop', a.id, null, root, T0)).toMatchObject({
    status: 401,
    code: 'unknown-token',
  })
  expect(retirePc('laptop', b.id, 'Laptop-2', root, T0 + 3)).toEqual({
    ok: true,
    pc: 'Laptop',
    key: 'laptop',
    state: 'revoked',
  })
  expect(stored(root).pcs.laptop).toMatchObject({
    revokedAt: iso(T0 + 3),
    revokedWhy: 'renamed to Laptop-2',
  })
  expect(pcByToken(b.token, root)).toMatchObject({ code: 'revoked' })
  expect(retirePc('laptop', b.id, null, root, T0)).toMatchObject({ status: 401, code: 'revoked' })
  expect(retirePc('spare', c.id, null, root, T0)).toMatchObject({ ok: true })
  expect(stored(root).pcs.spare.revokedWhy).toBe('retired by the PC')

  // Forget: the record and the copies go, and the token is unknown.
  expect(forgetPc('office-pc', root, T0)).toEqual({
    ok: true,
    pc: 'Office-PC',
    key: 'office-pc',
    removed: true,
  })
  expect(existsSync(join(root, 'office-pc'))).toBe(false)
  expect(stored(root).pcs['office-pc']).toBeUndefined()
  expect(pcByToken(a.token, root)).toMatchObject({ code: 'unknown-token' })
  expect(forgetPc('office-pc', root, T0)).toMatchObject({
    ok: false,
    status: 404,
    code: 'not-found',
  })
  // A folder with no record is forgotten too.
  folder(root, 'stray', { pushedAt: T0 })
  expect(forgetPc('stray', root, T0)).toMatchObject({ ok: true, pc: 'stray' })
  expect(existsSync(join(root, 'stray'))).toBe(false)
})

test("revoke and forget take a PC's key and nothing else: .., .pusher, '' and A are refused", () => {
  const root = newRoot()
  mkdirSync(join(root, '.pusher'), { recursive: true })
  writeFileSync(join(root, '.pusher', 'codex-hub-push.exe'), 'build')
  pcIn(root, 'A')
  for (const key of ['..', '.pusher', '', 'A', '.pcs.json', 'a/b', 'a b', '-a'])
    for (const r of [forgetPc(key, root, T0), revokePc(key, root, T0)])
      expect({ key, r }).toMatchObject({ key, r: { ok: false, status: 400, code: 'bad-key' } })
  expect(existsSync(join(root, '.pusher', 'codex-hub-push.exe'))).toBe(true)
  expect(stored(root).pcs.a.revokedAt).toBeUndefined()
})

test('a key the cut at 63 characters leaves ending in a dash is paired, redeemed, moved, revoked, forgotten and read after a restart', () => {
  const cut = (pckeys as { pc: string; key: string | null }[]).filter((c) => c.key?.endsWith('-'))
  expect(cut.length).toBe(2)
  const [one, two] = cut as { pc: string; key: string }[]
  const root = newRoot()
  settings({ admin: ADMIN, legacy: LEGACY })
  const office = pcIn(root, 'Office-PC', { install: C })
  // The command line's add, and the page's code.
  const a = pcIn(root, one.pc)
  expect(a.r).toMatchObject({ ok: true, key: one.key })
  const code = mintPairCode({ key: two.key, pc: two.pc, replaces: null }, root, T0)
  const b = newPcToken()
  expect(
    redeemPairCode({ code, id: b.id, hash: b.hash, install: B }, root, T0 + MIN),
  ).toMatchObject({
    ok: true,
    key: two.key,
  })
  // A restart reads them: a new root with a copy of the store is what a fresh process sees.
  const again = newRoot()
  mkdirSync(again, { recursive: true })
  copyFileSync(storeFile(root), storeFile(again))
  expect(pcStoreReadable(again)).toBe(true)
  for (const t of [office, a, b]) expect(pcByToken(t.token, again)).toMatchObject({ ok: true })

  expect(revokePc(one.key, root, T0 + 2 * MIN)).toMatchObject({
    ok: true,
    key: one.key,
    state: 'revoked',
  })
  expect(pcByToken(a.token, root)).toMatchObject({ code: 'revoked' })
  expect(forgetPc(two.key, root, T0 + 3 * MIN)).toMatchObject({
    ok: true,
    key: two.key,
    removed: true,
  })
  expect(pcByToken(b.token, root)).toMatchObject({ code: 'unknown-token' })
  expect(pcByToken(office.token, root)).toMatchObject({ ok: true })

  // An old pusher's folder under such a key moves by the exchange, and the store still reads.
  const moved = newRoot()
  folder(moved, two.key, { pc: two.pc, install: A, pushedAt: T0 })
  const t = newPcToken()
  expect(exchangeLegacy({ id: t.id, hash: t.hash, install: A }, moved, T0 + 1)).toMatchObject({
    ok: true,
    key: two.key,
  })
  const after = newRoot()
  mkdirSync(after, { recursive: true })
  copyFileSync(storeFile(moved), storeFile(after))
  expect(pcByToken(t.token, after)).toMatchObject({ ok: true, key: two.key })
})

test('a credential a relay link was let in with holds while its record has that token, or its key is pending', () => {
  const root = newRoot()
  settings({ admin: ADMIN, legacy: LEGACY })
  const a = pcIn(root, 'Office-PC')
  folder(root, 'laptop', { pc: 'Laptop', install: B, pushedAt: T0 })
  expect(linkCredentialValid('office-pc', a.id, root, T0)).toBe(true)
  expect(linkCredentialValid('office-pc', newPcToken().id, root, T0)).toBe(false)
  expect(linkCredentialValid('office-pc', undefined, root, T0)).toBe(false)
  expect(linkCredentialValid('office-pc', 'legacy', root, T0)).toBe(false)
  expect(linkCredentialValid('laptop', 'legacy', root, T0)).toBe(true)
  // The window's end, which closes nothing by itself.
  expect(linkCredentialValid('laptop', 'legacy', root, T0 + 7 * DAY)).toBe(false)
  revokePc('office-pc', root, T0)
  expect(linkCredentialValid('office-pc', a.id, root, T0)).toBe(false)
})

// --- pairing codes and confirmations ---------------------------------------------------------------

test('a pairing code is used once: a repeat with the same id, hash and install gets the same answer, and anything else is 401', () => {
  const root = newRoot()
  const code = mintPairCode({ key: 'office-pc', pc: 'Office-PC', replaces: null }, root, T0)
  expect(code).toMatch(/^[0-9a-f]{64}$/)
  const t = newPcToken()
  const redeem = (over: Partial<PairRedemption> = {}, now = T0 + MIN) =>
    redeemPairCode({ code, id: t.id, hash: t.hash, install: A, ...over }, root, now)
  expect(redeem({ install: null })).toMatchObject({ status: 400, code: 'install-required' })
  for (const bad of [{ code: 'abc' }, { id: 'x' }, { hash: t.token }])
    expect(redeem(bad)).toMatchObject({ status: 400, code: 'bad-request' })
  expect(redeem({ code: 'f'.repeat(64) })).toMatchObject({ status: 401, code: 'pair-code' })

  const answer = { ok: true as const, pc: 'Office-PC', key: 'office-pc', id: t.id }
  expect(redeem({ from: '203.0.113.7' })).toEqual(answer)
  expect(stored(root).pcs['office-pc']).toEqual({
    pc: 'Office-PC',
    tokenId: t.id,
    tokenHash: t.hash,
    install: A,
    pairedAt: iso(T0 + MIN),
    pairedBy: 'page',
    pairedFrom: '203.0.113.7',
  })
  expect(redeem({}, T0 + 2 * MIN)).toEqual(answer)
  const u = newPcToken()
  for (const other of [{ id: u.id, hash: u.hash }, { hash: u.hash }, { install: B }])
    expect(redeem(other)).toMatchObject({ ok: false, status: 401, code: 'pair-code' })
  // Another hub folder's code is not this one's.
  expect(
    redeemPairCode({ code, id: t.id, hash: t.hash, install: A }, newRoot(), T0 + MIN),
  ).toMatchObject({ code: 'pair-code' })
  // Once the key has another token, the repeat is refused too.
  pcIn(root, 'Office-PC', { replace: true })
  expect(redeem()).toMatchObject({ status: 401, code: 'pair-code' })
})

test('a code lasts 20 minutes, never past until, and at most 32 are kept: making one more drops the oldest', () => {
  const root = newRoot()
  const make = (key: string, until?: number) =>
    mintPairCode({ key, pc: key, replaces: null, until }, root, T0)
  const redeem = (code: string, now: number) => {
    const t = newPcToken()
    return redeemPairCode({ code, id: t.id, hash: t.hash, install: A }, root, now)
  }
  const refused = { ok: false, status: 401, code: 'pair-code' }
  expect(redeem(make('pc-one'), T0 + 20 * MIN)).toMatchObject(refused)
  expect(redeem(make('pc-two'), T0 + 20 * MIN - 1)).toMatchObject({ ok: true, key: 'pc-two' })
  expect(redeem(make('pc-three', T0 + MIN), T0 + MIN)).toMatchObject(refused)
  expect(redeem(make('pc-four', T0 + MIN), T0 + MIN - 1)).toMatchObject({ ok: true })

  const first = make('pc-first')
  const later = Array.from({ length: 32 }, (_, i) => make(`pc-${i}`))
  expect(redeem(first, T0)).toMatchObject(refused)
  expect(redeem(later[0]!, T0)).toMatchObject({ ok: true, key: 'pc-0' })
  expect(redeem(later[31]!, T0)).toMatchObject({ ok: true, key: 'pc-31' })
})

test("a code made before the key's credential changed is name-changed, once", () => {
  const root = newRoot()
  const t = newPcToken()
  const redeem = (code: string) =>
    redeemPairCode({ code, id: t.id, hash: t.hash, install: A }, root, T0 + 1)
  // Made while the key was free; then the command line gave it a token.
  const free = mintPairCode({ key: 'office-pc', pc: 'Office-PC', replaces: null }, root, T0)
  const a = pcIn(root, 'Office-PC')
  expect(redeem(free)).toMatchObject({ ok: false, status: 409, code: 'name-changed' })
  expect(redeem(free)).toMatchObject({ status: 401, code: 'pair-code' })
  // Made to replace that token; then it was paired again.
  const replacing = mintPairCode({ key: 'office-pc', pc: 'Office-PC', replaces: a.id }, root, T0)
  pcIn(root, 'Office-PC', { replace: true })
  expect(redeem(replacing)).toMatchObject({ status: 409, code: 'name-changed' })
  // A revoke drops the key's codes outright.
  const b = pcIn(root, 'Laptop', { install: B })
  const dropped = mintPairCode({ key: 'laptop', pc: 'Laptop', replaces: b.id }, root, T0)
  revokePc('laptop', root, T0)
  expect(redeem(dropped)).toMatchObject({ status: 401, code: 'pair-code' })
  expect(pcByToken(t.token, root)).toMatchObject({ code: 'unknown-token' })
})

test('a token id in use is id-taken, and the code stays for the next token', () => {
  const root = newRoot()
  const a = pcIn(root, 'Office-PC')
  const code = mintPairCode({ key: 'laptop', pc: 'Laptop', replaces: null }, root, T0)
  expect(
    redeemPairCode({ code, id: a.id, hash: newPcToken().hash, install: B }, root, T0),
  ).toMatchObject({ ok: false, status: 409, code: 'id-taken' })
  const t = newPcToken()
  expect(redeemPairCode({ code, id: t.id, hash: t.hash, install: B }, root, T0)).toMatchObject({
    ok: true,
    key: 'laptop',
  })
})

test('a confirmation is used once, bound to its key, the tray state and port, and capped like the codes', () => {
  const root = newRoot()
  const p = { key: 'office-pc', state: 'a'.repeat(32), port: 49152 }
  const c1 = mintConfirm({ ...p, replaces: 'legacy' }, root, T0)
  expect(c1).toMatch(/^[0-9a-f]{64}$/)
  expect(takeConfirm(c1, p, root, T0 + 1)).toEqual({ replaces: 'legacy' })
  expect(takeConfirm(c1, p, root, T0 + 2)).toBeNull()
  for (const other of [{ key: 'laptop' }, { state: 'b'.repeat(32) }, { port: 49153 }]) {
    const c = mintConfirm({ ...p, replaces: null }, root, T0)
    expect(takeConfirm(c, { ...p, ...other }, root, T0 + 1)).toBeNull()
  }
  expect(takeConfirm(mintConfirm({ ...p, replaces: null }, root, T0), p, newRoot(), T0)).toBeNull()
  const old = mintConfirm({ ...p, replaces: null }, root, T0)
  expect(takeConfirm(old, p, root, T0 + 20 * MIN)).toBeNull()
  const short = mintConfirm({ ...p, replaces: null, until: T0 + MIN }, root, T0)
  expect(takeConfirm(short, p, root, T0 + MIN)).toBeNull()

  const first = mintConfirm({ ...p, replaces: null }, root, T0)
  const later = Array.from({ length: 32 }, () => mintConfirm({ ...p, replaces: 'x' }, root, T0))
  expect(takeConfirm(first, p, root, T0)).toBeNull()
  expect(takeConfirm(later[0]!, p, root, T0)).toEqual({ replaces: 'x' })
  expect(takeConfirm(later[31]!, p, root, T0)).toEqual({ replaces: 'x' })
})

// --- the state of a key, the window and pending keys ----------------------------------------------

test('pairTarget: free, token, pending, unpaired and revoked', () => {
  const root = newRoot()
  settings({ admin: ADMIN, legacy: LEGACY })
  expect(pairTarget('office-pc', root, T0)).toEqual({ state: 'free', replaces: null })
  const a = pcIn(root, 'Office-PC')
  expect(pairTarget('office-pc', root, T0)).toMatchObject({ state: 'token', replaces: a.id })
  folder(root, 'laptop', { pc: 'Laptop', install: B, pushedAt: T0 })
  expect(pairTarget('laptop', root, T0)).toMatchObject({
    state: 'pending',
    replaces: 'legacy',
    manifest: { pc: 'Laptop', install: B },
  })
  folder(root, 'bare', { pushedAt: T0 })
  expect(pairTarget('bare', root, T0)).toMatchObject({
    state: 'unpaired',
    replaces: null,
    why: 'no-install',
  })
  revokePc('office-pc', root, T0)
  expect(pairTarget('office-pc', root, T0)).toMatchObject({ state: 'revoked', replaces: null })
  // With the window closed, the folder that was pending is unpaired.
  settings({ admin: ADMIN })
  expect(pairTarget('laptop', root, T0)).toMatchObject({
    state: 'unpaired',
    why: 'window-closed',
  })
})

test('a key is pending only with an install id, a push since 30 days before the window, no record and an unclaimed install id', () => {
  const root = newRoot()
  settings({ admin: ADMIN, legacy: LEGACY })
  expect(legacyWindow(root, T0)).toMatchObject({ open: true, since: iso(T0) })
  folder(root, 'bare', { pushedAt: T0 })
  folder(root, 'stale', { install: 'install-stale-0001', pushedAt: T0 - 31 * DAY })
  folder(root, 'recent', { install: 'install-recent-001', pushedAt: T0 - 29 * DAY })
  folder(root, 'claimed', { install: A, pushedAt: T0 })
  pcIn(root, 'Elsewhere', { install: A })
  folder(root, 'paired', { install: B, pushedAt: T0 })
  expect(pcIn(root, 'paired', { install: B }).r).toMatchObject({ code: 'name-paired' })
  pcIn(root, 'paired', { install: B, replace: true })
  expect(pendingKeys(root, T0)).toEqual(['recent'])
  expect(whys(root)).toEqual({
    bare: 'no-install',
    claimed: 'claimed',
    elsewhere: 'token',
    paired: 'token',
    recent: 'pending',
    stale: 'old',
  })
  expect(pendingKeyFor('install-recent-001', root, T0)).toBe('recent')
  for (const install of [A, B, 'install-stale-0001', null])
    expect(pendingKeyFor(install, root, T0)).toBeNull()
})

test('of two folders with one install id only the newer is pending, and on a tie the lower key', () => {
  const root = newRoot()
  settings({ admin: ADMIN, legacy: LEGACY })
  folder(root, 'mac', { install: A, pushedAt: T0 })
  folder(root, 'mac-lan', { install: A, pushedAt: T0 - HOUR })
  folder(root, 'twin-b', { install: B, pushedAt: T0 })
  folder(root, 'twin-a', { install: B, pushedAt: T0 })
  expect(pendingKeys(root, T0)).toEqual(['mac', 'twin-a'])
  expect(whys(root)).toMatchObject({ 'mac-lan': 'duplicate:mac', 'twin-b': 'duplicate:twin-a' })
  expect(pendingKeyFor(A, root, T0)).toBe('mac')
  expect(pendingKeyFor(B, root, T0)).toBe('twin-a')
})

test('an exchange, a revoke of a pending key, a forget and a re-pair from another install each claim an install id', () => {
  const root = newRoot()
  settings({ admin: ADMIN, legacy: LEGACY })
  const D = 'install-dddd-0004'
  const E = 'install-eeee-0005'
  for (const [key, install] of [
    ['mac', A],
    ['pc-one', B],
    ['pc-two', C],
    ['pc-three', D],
    ['pc-four', E],
  ] as const) {
    folder(root, key, { install, pushedAt: T0 })
    folder(root, `${key}-old`, { install, pushedAt: T0 - HOUR })
  }
  expect(pendingKeys(root, T0)).toEqual(['mac', 'pc-four', 'pc-one', 'pc-three', 'pc-two'])
  const t = newPcToken()
  expect(exchangeLegacy({ id: t.id, hash: t.hash, install: A }, root, T0)).toMatchObject({
    ok: true,
    key: 'mac',
  })
  expect(revokePc('pc-one', root, T0)).toMatchObject({ ok: true })
  expect(stored(root).pcs['pc-one']).toMatchObject({
    install: B,
    revokedWhy: 'revoked by the owner before it moved',
  })
  expect(forgetPc('pc-two', root, T0)).toMatchObject({ ok: true })
  pcIn(root, 'pc-three', { install: 'install-new-00001', replace: true })
  const code = mintPairCode({ key: 'pc-four', pc: 'pc-four', replaces: 'legacy' }, root, T0)
  const u = newPcToken()
  expect(
    redeemPairCode({ code, id: u.id, hash: u.hash, install: 'install-new-00002' }, root, T0),
  ).toMatchObject({ ok: true })
  expect(pendingKeys(root, T0)).toEqual([])
  expect(whys(root)).toMatchObject({
    'mac-old': 'claimed',
    'pc-one-old': 'claimed',
    'pc-two-old': 'claimed',
    'pc-three-old': 'claimed',
    'pc-four-old': 'claimed',
  })
  // A record carries the first two; the others are kept in legacy.claimed.
  expect(stored(root).legacy.claimed).toEqual([C, D, E])
})

test('forgetting a stale copy claims nothing: the folder its PC pushes to now still moves', () => {
  const root = newRoot()
  settings({ admin: ADMIN, legacy: LEGACY })
  // One Mac under two keys, and a PC renamed long ago: the newest folder of each is pending, the others are stale.
  folder(root, 'example-mac', { pc: 'Example-Mac', install: A, pushedAt: T0 })
  folder(root, 'example-mac-lan', { pc: 'Example-Mac-Lan', install: A, pushedAt: T0 - HOUR })
  folder(root, 'newname', { install: B, pushedAt: T0 })
  folder(root, 'oldname', { install: B, pushedAt: T0 - 40 * DAY })
  expect(pendingKeys(root, T0)).toEqual(['example-mac', 'newname'])
  expect(whys(root)).toMatchObject({ 'example-mac-lan': 'duplicate:example-mac', oldname: 'old' })
  expect(forgetPc('example-mac-lan', root, T0)).toMatchObject({ ok: true })
  expect(forgetPc('oldname', root, T0)).toMatchObject({ ok: true })
  expect(pendingKeys(root, T0)).toEqual(['example-mac', 'newname'])
  expect(stored(root).legacy.claimed).toBeUndefined()
  const t = newPcToken()
  expect(exchangeLegacy({ id: t.id, hash: t.hash, install: A }, root, T0 + 1)).toMatchObject({
    ok: true,
    key: 'example-mac',
  })
})

test('with the window closed, a forget and a re-pair still claim: opening it again moves no other folder', () => {
  const late = T0 + 8 * DAY
  for (const how of [
    'revoke, then forget',
    'revoke, then re-pair',
    'forget',
    'pair from another install',
    'add',
  ] as const) {
    const root = newRoot()
    settings({ admin: ADMIN, legacy: LEGACY })
    folder(root, 'mac-local', { install: A, pushedAt: T0 })
    folder(root, 'mac-lan', { install: A, pushedAt: T0 - HOUR })
    expect(pendingKeys(root, T0)).toEqual(['mac-local'])
    if (how.startsWith('revoke'))
      expect(revokePc('mac-local', root, T0)).toMatchObject({ ok: true })
    expect(legacyWindow(root, late).open).toBe(false)
    if (how === 'add') {
      expect(pcIn(root, 'mac-local', { install: null, now: late }).r).toMatchObject({ ok: true })
    } else if (how === 'revoke, then re-pair' || how === 'pair from another install') {
      const code = mintPairCode({ key: 'mac-local', pc: 'mac-local', replaces: null }, root, late)
      const u = newPcToken()
      expect(
        redeemPairCode({ code, id: u.id, hash: u.hash, install: 'install-new-00001' }, root, late),
      ).toMatchObject({ ok: true })
    } else {
      expect(forgetPc('mac-local', root, late)).toMatchObject({ ok: true })
    }
    // The owner opens the window again, for another PC that was off.
    settings({ admin: ADMIN, legacy: LEGACY, until: iso(late + DAY) })
    expect({ how, open: legacyWindow(root, late).open }).toEqual({ how, open: true })
    expect({ how, pending: pendingKeys(root, late) }).toEqual({ how, pending: [] })
    const t = newPcToken()
    expect({
      how,
      r: exchangeLegacy({ id: t.id, hash: t.hash, install: A }, root, late),
    }).toMatchObject({ how, r: { status: 401 } })
  }
})

test("a name with a control character is never a record's or a log line's: a space stands in for each run, or the key", () => {
  const root = newRoot()
  settings({ admin: ADMIN, legacy: LEGACY })
  // Its name with spaces is another key's: the key stands in for it.
  const forged = 'Office\n[codex-hub] \u001b\u009b PC'
  folder(root, 'office-pc', { pc: forged, install: A, pushedAt: T0 })
  folder(root, 'lap-top', { pc: 'Lap\u0007\u0007top\u0085', install: B, pushedAt: T0 })
  const said = spyOn(console, 'log').mockImplementation(() => {})
  try {
    logCodexHubStart(root, T0)
    const t = newPcToken()
    expect(exchangeLegacy({ id: t.id, hash: t.hash, install: A }, root, T0 + 1)).toMatchObject({
      ok: true,
      pc: 'office-pc',
    })
    expect(stored(root).pcs['office-pc'].pc).toBe('office-pc')
    expect(revokePc('lap-top', root, T0 + 2)).toMatchObject({ ok: true, pc: 'Lap top' })
    expect(stored(root).pcs['lap-top'].pc).toBe('Lap top')
    expect(forgetPc('lap-top', root, T0 + 3)).toMatchObject({ ok: true, pc: 'Lap top' })
    for (const [line] of said.mock.calls) expect(String(line)).not.toMatch(/\p{Cc}/u)
  } finally {
    said.mockRestore()
  }
})

test("a record's name is one whose key is its key, and one the page takes, for a cut key that ends in a dash too", () => {
  const root = newRoot()
  settings({ admin: ADMIN, legacy: LEGACY })
  const cut = `${'a'.repeat(62)}-`
  // Pushed before control characters were refused. With a space for it, the name makes the cut key, but is longer
  // than the page and add take.
  folder(root, cut, { pc: `${'a'.repeat(62)}-\u0007b`, install: A, pushedAt: T0 })
  // One whose name, with spaces, is another key's.
  const other = `${'b'.repeat(62)}-`
  folder(root, other, { pc: 'Other\u0007PC', install: B, pushedAt: T0 })
  // One that makes its key and is short enough: kept, with a space for the control character.
  const long = `${'c'.repeat(30)}-${'d'.repeat(32)}`
  folder(root, long, { pc: `${'C'.repeat(30)}\u0007${'D'.repeat(32)}`, install: C, pushedAt: T0 })
  for (const [key, install] of [
    [cut, A],
    [other, B],
    [long, C],
  ] as const) {
    const t = newPcToken()
    expect(exchangeLegacy({ id: t.id, hash: t.hash, install }, root, T0 + 1)).toMatchObject({
      ok: true,
      key,
    })
    const pc: string = stored(root).pcs[key].pc
    expect({ key, made: hubPcKey(pc), fits: pc.length <= 64 }).toEqual({
      key,
      made: key,
      fits: true,
    })
    expect(pc).not.toMatch(/\p{Cc}/u)
  }
  expect(stored(root).pcs[cut].pc).toBe(`${cut}0`)
  expect(stored(root).pcs[other].pc).toBe(`${other}0`)
  expect(stored(root).pcs[long].pc).toBe(`${'C'.repeat(30)} ${'D'.repeat(32)}`)
})

test("a folder whose name is not a PC's key is left out: never pending, listed or paired, and the start log names it", () => {
  const root = newRoot()
  settings({ admin: ADMIN, legacy: LEGACY })
  folder(root, 'office-pc.bak', { pc: 'Office-PC', install: A, pushedAt: T0 })
  folder(root, 'Laptop', { pc: 'Laptop', install: B, pushedAt: T0 })
  folder(root, 'mac', { pc: 'Mac', install: C, pushedAt: T0 })
  expect(pendingKeys(root, T0)).toEqual(['mac'])
  expect(hubPcRows(root, T0)?.pcs.map((r) => r.key)).toEqual(['mac'])
  expect(pendingKeyFor(A, root, T0)).toBeNull()
  const t = newPcToken()
  expect(exchangeLegacy({ id: t.id, hash: t.hash, install: A }, root, T0 + 1)).toMatchObject({
    status: 401,
  })
  const said = spyOn(console, 'log').mockImplementation(() => {})
  try {
    logCodexHubStart(root, T0)
    expect(said.mock.calls.map(([line]) => String(line))).toContain(
      `[codex-hub] 2 folder(s) left out, as their names are not a PC's key: "Laptop", "office-pc.bak": ` +
        `move each out of ${root}, or give it its PC's key`,
    )
  } finally {
    said.mockRestore()
  }
  // Nothing was written that the next start cannot read.
  const again = newRoot()
  mkdirSync(again, { recursive: true })
  if (existsSync(storeFile(root))) copyFileSync(storeFile(root), storeFile(again))
  expect(pcStoreReadable(again)).toBe(true)
})

test('a PC named __proto__ or constructor is a record like any other, and none before it is paired', () => {
  const root = newRoot()
  expect(pairTarget('constructor', root, T0)).toEqual({ state: 'free', replaces: null })
  expect(pairTarget('__proto__', root, T0)).toEqual({ state: 'free', replaces: null })
  const proto = pcIn(root, '__proto__')
  // A store read back from disk, with no record for constructor: none there either.
  const early = newRoot()
  mkdirSync(early, { recursive: true })
  copyFileSync(storeFile(root), storeFile(early))
  expect(pairTarget('constructor', early, T0)).toEqual({ state: 'free', replaces: null })
  const ctor = pcIn(root, 'constructor', { install: B })
  expect(proto.r).toMatchObject({ ok: true, key: '__proto__' })
  expect(ctor.r).toMatchObject({ ok: true, key: 'constructor' })
  const text = readFileSync(storeFile(root), 'utf8')
  expect(Object.keys(JSON.parse(text).pcs).sort()).toEqual(['__proto__', 'constructor'])
  expect(pcByToken(proto.token, root)).toMatchObject({ ok: true, key: '__proto__' })
  expect(revokePc('__proto__', root, T0 + 1)).toMatchObject({ ok: true, key: '__proto__' })
  expect(pcByToken(proto.token, root)).toMatchObject({ code: 'revoked' })
  // After a restart too.
  const again = newRoot()
  mkdirSync(again, { recursive: true })
  copyFileSync(storeFile(root), storeFile(again))
  expect(pcByToken(proto.token, again)).toMatchObject({ code: 'revoked' })
  expect(pcByToken(ctor.token, again)).toMatchObject({ ok: true, key: 'constructor' })
  expect(forgetPc('__proto__', again, T0 + 2)).toMatchObject({ ok: true })
  expect(Object.keys(stored(again).pcs)).toEqual(['constructor'])
})

test('legacy.claimed keeps the newest 256 install ids', () => {
  const root = newRoot()
  mkdirSync(root, { recursive: true })
  const claimed = Array.from({ length: 256 }, (_, i) => `install-old-${String(i).padStart(4, '0')}`)
  writeFileSync(
    storeFile(root),
    JSON.stringify({ version: 1, pcs: {}, legacy: { since: iso(T0), claimed } }),
  )
  settings({ admin: ADMIN, legacy: LEGACY })
  folder(root, 'mac', { install: A, pushedAt: T0 })
  expect(forgetPc('mac', root, T0)).toMatchObject({ ok: true })
  expect(stored(root).legacy.claimed).toEqual([...claimed.slice(1), A])
})

test('the window: closed with no legacy token, with one equal to the admin token, past …_LEGACY_UNTIL, and 7 days after since', () => {
  const root = newRoot()
  expect(legacyWindow(root, T0)).toEqual({ open: false })
  settings({ admin: ADMIN, legacy: ADMIN })
  expect(legacyWindow(root, T0)).toEqual({ open: false })
  settings({ legacy: LEGACY })
  expect(legacyWindow(root, T0)).toEqual({ open: false })
  // Nothing so far saw the window, so nothing was written.
  expect(existsSync(storeFile(root))).toBe(false)

  settings({ admin: ADMIN, legacy: LEGACY })
  const week = { since: iso(T0), until: iso(T0 + 7 * DAY) }
  expect(legacyWindow(root, T0)).toEqual({ open: true, ...week })
  expect(legacyWindow(root, T0 + 7 * DAY - 1)).toEqual({ open: true, ...week })
  expect(legacyWindow(root, T0 + 7 * DAY)).toEqual({ open: false, ...week })

  settings({ admin: ADMIN, legacy: LEGACY, until: '2026-10-19T00:00:00Z' })
  expect(legacyWindow(root, T0)).toEqual({
    open: true,
    since: iso(T0),
    until: '2026-10-19T00:00:00.000Z',
  })
  expect(legacyWindow(root, Date.parse('2026-10-19T00:00:00Z')).open).toBe(false)
  settings({ admin: ADMIN, legacy: LEGACY, until: '2026-10-18' })
  expect(legacyWindow(root, T0).open).toBe(false)
  // Later than the default too.
  settings({ admin: ADMIN, legacy: LEGACY, until: '2026-11-30T12:00:00+01:00' })
  expect(legacyWindow(root, T0 + 30 * DAY)).toEqual({
    open: true,
    since: iso(T0),
    until: '2026-11-30T11:00:00.000Z',
  })
})

test('an …_LEGACY_UNTIL that does not parse is said once, and the default applies', () => {
  const root = newRoot()
  const said = spyOn(console, 'error').mockImplementation(() => {})
  try {
    for (const until of ['next tuesday', '2026-13-45', '1792310400']) {
      settings({ admin: ADMIN, legacy: LEGACY, until })
      expect(legacyWindow(root, T0)).toEqual({
        open: true,
        since: iso(T0),
        until: iso(T0 + 7 * DAY),
      })
      legacyWindow(root, T0)
    }
    const lines = said.mock.calls.map((c) => String(c[0]))
    expect(lines.filter((l) => l.includes('is not an ISO 8601 date'))).toHaveLength(3)
  } finally {
    said.mockRestore()
  }
})

test('since is written once, and kept when the setting is removed and set again', () => {
  const root = newRoot()
  settings({ admin: ADMIN, legacy: LEGACY })
  expect(legacyWindow(root, T0).since).toBe(iso(T0))
  expect(legacyWindow(root, T0 + DAY).since).toBe(iso(T0))
  settings({ admin: ADMIN })
  expect(legacyWindow(root, T0 + 2 * DAY)).toEqual({ open: false })
  expect(stored(root).legacy.since).toBe(iso(T0))
  // Set again after the end: nothing reopens unless the end moves too.
  settings({ admin: ADMIN, legacy: LEGACY })
  expect(legacyWindow(root, T0 + 8 * DAY)).toMatchObject({ open: false, since: iso(T0) })
  settings({ admin: ADMIN, legacy: LEGACY, until: iso(T0 + 9 * DAY) })
  expect(legacyWindow(root, T0 + 8 * DAY)).toMatchObject({ open: true, since: iso(T0) })
})

// --- the exchange ---------------------------------------------------------------------------------

test('the exchange: once per pending folder, found by its install id, safe to repeat, and noted when it comes after the move', () => {
  const root = newRoot()
  settings({ admin: ADMIN, legacy: LEGACY })
  folder(root, 'office-pc', { pc: 'Office-PC', install: A, pushedAt: T0 })
  const t = newPcToken()
  const exchange = (over: Partial<Parameters<typeof exchangeLegacy>[0]> = {}, now = T0 + 1) =>
    exchangeLegacy({ id: t.id, hash: t.hash, install: A, ...over }, root, now)
  expect(exchange({ install: null })).toMatchObject({ status: 400, code: 'install-required' })
  expect(exchange({ id: 'x' })).toMatchObject({ status: 400, code: 'bad-request' })

  const answer = { ok: true as const, pc: 'Office-PC', key: 'office-pc', id: t.id }
  expect(exchange({ from: '198.51.100.4' })).toEqual(answer)
  expect(stored(root).pcs['office-pc']).toEqual({
    pc: 'Office-PC',
    tokenId: t.id,
    tokenHash: t.hash,
    install: A,
    pairedAt: iso(T0 + 1),
    pairedBy: 'exchange',
    pairedFrom: '198.51.100.4',
  })
  expect(exchange({}, T0 + 2)).toEqual(answer)

  const unauthorized = { ok: false, status: 401, code: 'unauthorized' }
  const u = newPcToken()
  expect(exchange({ hash: u.hash })).toMatchObject(unauthorized)
  expect(exchange({ id: u.id, hash: u.hash, install: B })).toMatchObject(unauthorized)
  // A folder whose manifest has no install id never moves by itself.
  folder(root, 'bare', { pushedAt: T0 })
  expect(exchange({ id: u.id, hash: u.hash, install: 'install-bare-0001' })).toMatchObject(
    unauthorized,
  )
  // The install id has moved already: refused, and the record notes it once.
  const warned = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    expect(exchange({ id: u.id, hash: u.hash }, T0 + HOUR)).toMatchObject(unauthorized)
    expect(exchange({ id: u.id, hash: u.hash }, T0 + 2 * HOUR)).toMatchObject(unauthorized)
    expect(String(warned.mock.calls[0]?.[0])).toContain(
      `an exchange for Office-PC's install arrived after Office-PC moved to chp_${t.id}`,
    )
  } finally {
    warned.mockRestore()
  }
  expect(stored(root).pcs['office-pc'].contestedAt).toBe(iso(T0 + HOUR))
  expect(pcByToken(t.token, root)).toMatchObject({ ok: true })

  // An id another record has: id-taken, and the folder stays pending.
  folder(root, 'laptop', { pc: 'Laptop', install: B, pushedAt: T0 })
  expect(exchangeLegacy({ id: t.id, hash: u.hash, install: B }, root, T0)).toMatchObject({
    ok: false,
    status: 409,
    code: 'id-taken',
  })
  expect(pendingKeys(root, T0)).toEqual(['laptop'])
})

// --- failing closed -------------------------------------------------------------------------------

test('a store that will not read refuses everything, closes the window, and is never written over', () => {
  const quiet = spyOn(console, 'error').mockImplementation(() => {})
  try {
    for (const text of [
      '{"version":2,"pcs":{}}\n',
      '{"version":1,"pcs":',
      '{"version":1,"pcs":{"Office-PC":{"pc":"Office-PC"}}}',
    ]) {
      const root = newRoot()
      mkdirSync(root, { recursive: true })
      writeFileSync(storeFile(root), text)
      folder(root, 'office-pc', { pc: 'Office-PC', install: A, pushedAt: T0 })
      settings({ admin: ADMIN, legacy: LEGACY })
      const t = newPcToken()
      const unreadable = { ok: false, status: 503, code: 'store-unreadable' }
      expect(pcStoreReadable(root)).toBe(false)
      expect(pcByToken(t.token, root)).toMatchObject(unreadable)
      expect(legacyWindow(root, T0)).toEqual({ open: false })
      expect(pendingKeys(root, T0)).toEqual([])
      expect(pendingKeyFor(A, root, T0)).toBeNull()
      expect(pairTarget('office-pc', root, T0)).toBeNull()
      expect(hubPcRows(root, T0)).toBeNull()
      expect(registerPcToken({ pc: 'Laptop', id: t.id, hash: t.hash }, root, T0)).toMatchObject(
        unreadable,
      )
      expect(revokePc('office-pc', root, T0)).toMatchObject(unreadable)
      expect(forgetPc('office-pc', root, T0)).toMatchObject(unreadable)
      expect(retirePc('office-pc', t.id, null, root, T0)).toMatchObject(unreadable)
      expect(exchangeLegacy({ id: t.id, hash: t.hash, install: A }, root, T0)).toMatchObject(
        unreadable,
      )
      const code = mintPairCode({ key: 'laptop', pc: 'Laptop', replaces: null }, root, T0)
      expect(redeemPairCode({ code, id: t.id, hash: t.hash, install: B }, root, T0)).toMatchObject(
        unreadable,
      )
      expect(bindPcInstall('office-pc', t.id, A, root)).toMatchObject(unreadable)
      expect(linkCredentialValid('office-pc', t.id, root, T0)).toBe(false)
      expect(readFileSync(storeFile(root), 'utf8')).toBe(text)
      expect(existsSync(join(root, 'office-pc', 'manifest.json'))).toBe(true)
    }
  } finally {
    quiet.mockRestore()
  }
})

test('a write that fails is store-unwritable, and nothing is registered', () => {
  const root = newRoot()
  const tmp = `${storeFile(root)}.${process.pid}.tmp`
  mkdirSync(tmp, { recursive: true })
  const quiet = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const t = newPcToken()
    const unwritable = { ok: false, status: 500, code: 'store-unwritable' }
    expect(registerPcToken({ pc: 'Office-PC', id: t.id, hash: t.hash }, root, T0)).toMatchObject(
      unwritable,
    )
    const code = mintPairCode({ key: 'laptop', pc: 'Laptop', replaces: null }, root, T0)
    expect(redeemPairCode({ code, id: t.id, hash: t.hash, install: B }, root, T0)).toMatchObject(
      unwritable,
    )
    expect(existsSync(storeFile(root))).toBe(false)
    expect(pcByToken(t.token, root)).toMatchObject({ code: 'unknown-token' })
    expect(pairTarget('office-pc', root, T0)).toEqual({ state: 'free', replaces: null })
    // Writable again: the same code is still good.
    rmSync(tmp, { recursive: true })
    expect(redeemPairCode({ code, id: t.id, hash: t.hash, install: B }, root, T0)).toMatchObject({
      ok: true,
      key: 'laptop',
    })
  } finally {
    quiet.mockRestore()
  }
})

// --- the list and the start log ---------------------------------------------------------------------

test('the list: every key with a record or a folder, sorted, with its state, and the window', () => {
  const root = newRoot()
  settings({ admin: ADMIN, legacy: LEGACY })
  const a = pcIn(root, 'Office-PC')
  markPcUsed('office-pc', a.id, root, T0 + MIN)
  folder(root, 'office-pc', { pc: 'Office-PC', install: A, pushedAt: T0 })
  folder(root, 'laptop', { pc: 'Laptop', install: B, pushedAt: T0 - DAY })
  expect(hubPcRows(root, T0)).toEqual({
    legacy: { open: true, since: iso(T0), until: iso(T0 + 7 * DAY), pending: 1 },
    pcs: [
      {
        key: 'laptop',
        pc: 'Laptop',
        state: 'pending',
        install: B,
        pushedAt: iso(T0 - DAY),
        chats: 0,
        relay: false,
      },
      {
        key: 'office-pc',
        pc: 'Office-PC',
        state: 'token',
        tokenId: a.id,
        pairedAt: iso(T0),
        pairedBy: 'cli',
        firstUsedAt: iso(T0 + MIN),
        install: A,
        pushedAt: iso(T0),
        chats: 0,
        relay: false,
      },
    ],
  })
})

test('at start the hub says what is pending, what cannot move, and what to do with the legacy token', () => {
  const root = newRoot()
  const lines: string[] = []
  const log = spyOn(console, 'log').mockImplementation((s: unknown) => void lines.push(String(s)))
  const error = spyOn(console, 'error').mockImplementation(
    (s: unknown) => void lines.push(`error: ${s}`),
  )
  const start = (now = T0) => {
    lines.length = 0
    logCodexHubStart(root, now)
    return [...lines]
  }
  try {
    folder(root, 'laptop', { pc: 'Laptop', install: B, pushedAt: T0 })
    folder(root, 'laptop-lan', { install: B, pushedAt: T0 - HOUR })
    folder(root, 'bare', { pushedAt: T0 })
    folder(root, 'stale', { install: C, pushedAt: T0 - 40 * DAY })
    expect(start()).toEqual([
      '[codex-hub] 4 PC folder(s) have no token of their own (bare, laptop, laptop-lan, stale): pair them, ' +
        'or see docs/CODEX-HUB.md "Moving PCs to tokens of their own"',
    ])
    settings({ admin: ADMIN, legacy: LEGACY })
    expect(start()).toEqual([
      '[codex-hub] legacy window open until 2026-10-25 09:00 UTC: 1 PC(s) still on the old shared token: ' +
        'Laptop (last push 2026-10-18 09:00 UTC)',
      '[codex-hub] 3 folder(s) cannot move by themselves: bare (no install id), laptop-lan (same install as ' +
        'laptop), stale (no push since 2026-09-08 09:00 UTC): pair them through the page, or forget them',
    ])
    expect(start(T0 + 8 * DAY)).toEqual([
      '[codex-hub] the legacy window closed on 2026-10-25 09:00 UTC; remove AGENTHYDRA_CODEX_HUB_LEGACY_TOKEN ' +
        'from hub.env',
    ])
    settings({ admin: ADMIN, legacy: ADMIN })
    expect(start()).toEqual([
      'error: [codex-hub] AGENTHYDRA_CODEX_HUB_LEGACY_TOKEN is the admin token; it is ignored. Give ' +
        'AGENTHYDRA_CODEX_HUB_TOKEN a new value',
    ])
    settings({})
    expect(start()).toEqual([])
  } finally {
    log.mockRestore()
    error.mockRestore()
  }
})
