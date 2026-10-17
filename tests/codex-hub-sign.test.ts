// tests/codex-hub-sign.test.ts — scripts/codex-hub-sign.ts, which signs the builds a Codex hub hands out.
//
// The script makes the operator's key and writes `<build>.sig` beside each build; the hub serves it and each PC checks
// it (server/src/core/codex-hub-signature.ts, and the tray's own check in codex-hub-tray/hub.go). A fixed key and
// build pin the signed text: codex-hub-tray's TestBuildSignatureVector checks the same signature.
import { afterAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSignatureValid,
  hubBuildOf,
  updateKeyFrom,
} from '../server/src/core/codex-hub-signature'

const script = join(import.meta.dir, '..', 'scripts', 'codex-hub-sign.ts')
const dir = mkdtempSync(join(tmpdir(), 'ah-codex-hub-sign-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function sign(...args: string[]) {
  const r = Bun.spawnSync([process.execPath, script, ...args], { stdout: 'pipe', stderr: 'pipe' })
  return { status: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString() }
}
const sha256 = (b: string) => createHash('sha256').update(b).digest('hex')

// The private key whose seed is the bytes 0 to 31, the build is the text "example build".
const VECTOR = {
  key: `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f
-----END PRIVATE KEY-----
`,
  public: 'A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=',
  pusherLinuxX64:
    'bwOwxxI7hsyg9pKJlH3lbMjIC0EG5u9wQyR5soqZ5JPQz8V1M65jodrtlDz5pOlAZLxWw8h9E26hEg67SqpcCA==',
}

test('keygen writes a private key once, and pubkey prints the key keygen printed', () => {
  const keyFile = join(dir, 'hub-update.key')
  const made = sign('keygen', keyFile)
  expect(made.status).toBe(0)
  expect(updateKeyFrom(made.out)).not.toBeNull()
  expect(readFileSync(keyFile, 'utf8')).toStartWith('-----BEGIN PRIVATE KEY-----')
  if (process.platform !== 'win32') expect(statSync(keyFile).mode & 0o777).toBe(0o600)

  const before = readFileSync(keyFile, 'utf8')
  const again = sign('keygen', keyFile)
  expect(again.status).toBe(1)
  expect(again.err).toContain('exists already')
  expect(readFileSync(keyFile, 'utf8')).toBe(before)

  expect(sign('pubkey', keyFile)).toMatchObject({ status: 0, out: made.out })
}, 20_000)

test('sign writes a signature that holds for the build its file name says, and no other', () => {
  const keyFile = join(dir, 'sign.key')
  const pub = updateKeyFrom(sign('keygen', keyFile).out)!
  const builds = {
    'codex-hub-push.exe': ['pusher', 'windows-x64'],
    'codex-hub-tray.exe': ['tray', 'windows-x64'],
    'codex-hub-push-linux-arm64': ['pusher', 'linux-arm64'],
    'codex-hub-tray-darwin-x64': ['tray', 'darwin-x64'],
  } as const
  for (const file of Object.keys(builds)) writeFileSync(join(dir, file), `the ${file} build`)
  const r = sign('sign', keyFile, ...Object.keys(builds).map((file) => join(dir, file)))
  expect(r.status).toBe(0)
  for (const [file, [name, platform]] of Object.entries(builds)) {
    const sig = readFileSync(join(dir, `${file}.sig`), 'utf8')
    const sum = sha256(`the ${file} build`)
    expect(buildSignatureValid(pub, name, platform, sum, sig)).toBe(true)
    // Not for the other build, another platform, or other bytes.
    expect(
      buildSignatureValid(pub, name === 'pusher' ? 'tray' : 'pusher', platform, sum, sig),
    ).toBe(false)
    expect(buildSignatureValid(pub, name, 'linux-x64', sum, sig)).toBe(false)
    expect(buildSignatureValid(pub, name, platform, sha256('other bytes'), sig)).toBe(false)
  }
}, 20_000)

test('sign refuses a file the hub would not serve under that name, and then writes nothing', () => {
  const keyFile = join(dir, 'refuse.key')
  sign('keygen', keyFile)
  writeFileSync(join(dir, 'codex-hub-push-linux-x64'), 'a build')
  for (const odd of ['codex-hub-push-windows-x64', 'codex-hub-push-plan9-x64', 'pusher.exe']) {
    writeFileSync(join(dir, odd), 'a build')
    const r = sign('sign', keyFile, join(dir, 'codex-hub-push-linux-x64'), join(dir, odd))
    expect(r.status).toBe(1)
    expect(r.err).toContain('not a name the hub serves')
    expect(existsSync(join(dir, `${odd}.sig`))).toBe(false)
    expect(existsSync(join(dir, 'codex-hub-push-linux-x64.sig'))).toBe(false)
  }
  expect(sign('sign', join(dir, 'no-such.key'), join(dir, 'codex-hub-push-linux-x64')).status).toBe(
    1,
  )
  expect(sign('verify', keyFile).status).toBe(1)
}, 20_000)

test('a fixed key and build sign to the text the tray checks', () => {
  const keyFile = join(dir, 'vector.key')
  writeFileSync(keyFile, VECTOR.key)
  const build = join(dir, 'codex-hub-push-linux-x64')
  writeFileSync(build, 'example build')
  expect(sign('pubkey', keyFile).out).toBe(VECTOR.public)
  expect(sign('sign', keyFile, build).status).toBe(0)
  expect(readFileSync(`${build}.sig`, 'utf8')).toBe(`${VECTOR.pusherLinuxX64}\n`)
  expect(hubBuildOf('codex-hub-push-linux-x64')).toEqual({ name: 'pusher', platform: 'linux-x64' })
  // Base64 that is not the canonical form of 32 bytes is no key.
  expect(updateKeyFrom(VECTOR.public.replace(/g=$/, 'h='))).toBeNull()
  expect(updateKeyFrom(Buffer.alloc(31).toString('base64'))).toBeNull()
  expect(updateKeyFrom('not a key')).toBeNull()
}, 20_000)
