import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { sdkTarget } from '../../src/engine/claude-code-binary'
import { ensureSdk, readSdkPin, SDK_MARKER, SDK_PACKAGE, SDK_PIN_FILE, sdkDir, sdkReady, type SdkPin } from '../../src/host/sdk-package'

const VERSION = '9.9.9'

// A tar the test builds by hand, so the extractor is checked against bytes it did not write itself.
function tarEntry(name: string, data: Uint8Array = new Uint8Array(0), type = '0'): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 'utf8')
  header.write(type === '5' ? '0000755\0' : '0000644\0', 100)
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
  header.write('00000000000\0', 136)
  header.write('        ', 148)
  header.write(type, 156)
  if (type === '2') header.write('../../outside', 157)
  header.write('ustar\0', 257)
  header.write('00', 263)
  const sum = header.reduce((a, b) => a + b, 0)
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512)
  Buffer.from(data).copy(padded)
  return Buffer.concat([header, padded])
}

const SDK_JS = `export const query = () => 'stand-in query'\nexport { nested } from './lib/nested.mjs'\n`
/** A stand-in for the SDK's npm tarball: package.json, an entry point that imports a nested file, a README. */
function sdkTarball(o: { name?: string; extra?: Buffer[]; cut?: boolean } = {}): Buffer {
  const pkg = { name: o.name ?? SDK_PACKAGE, version: VERSION, type: 'module', main: 'sdk.mjs', exports: { '.': { types: './sdk.d.ts', default: './sdk.mjs' } } }
  const tar = Buffer.concat([
    tarEntry('package/', undefined, '5'),
    tarEntry('package/package.json', Buffer.from(JSON.stringify(pkg))),
    tarEntry('package/sdk.mjs', Buffer.from(SDK_JS)),
    tarEntry('package/lib/nested.mjs', Buffer.from(`export const nested = ${JSON.stringify('x'.repeat(700))}\n`)),
    ...(o.extra ?? []),
    tarEntry('package/README.md', Buffer.from('readme')),
    Buffer.alloc(1024),
  ])
  // A tarball cut inside an entry: what a killed download would leave, if its checksum were somehow right.
  return gzipSync(o.cut ? tar.subarray(0, 512 * 3 + 100) : tar)
}

const integrityOf = (bytes: Uint8Array) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`

let desk: string
let stops: (() => void)[]

beforeEach(() => {
  desk = mkdtempSync(join(tmpdir(), 'desk-sdk-'))
  stops = []
})

afterEach(() => {
  for (const s of stops) s()
  rmSync(desk, { recursive: true, force: true })
})

function pin(tgz: Buffer, over: Partial<SdkPin> = {}): void {
  const p: SdkPin = {
    name: SDK_PACKAGE,
    version: VERSION,
    integrity: integrityOf(tgz),
    claudeCodeVersion: '9.9.8',
    optionalDependencies: { [`${SDK_PACKAGE}-${process.platform}-${process.arch}`]: VERSION, [`${SDK_PACKAGE}-linux-${process.arch}-musl`]: VERSION },
    ...over,
  }
  writeFileSync(join(desk, SDK_PIN_FILE), JSON.stringify(p))
}

/** A local npm registry serving the SDK's tarball where npm keeps it. */
function registry(tgz: Buffer) {
  const hits = { tarball: 0 }
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      if (new URL(req.url).pathname === `/${SDK_PACKAGE}/-/claude-agent-sdk-${VERSION}.tgz`) {
        hits.tarball++
        return new Response(new Uint8Array(tgz))
      }
      return new Response('not found', { status: 404 })
    },
  })
  stops.push(() => server.stop(true))
  return { env: { NPM_CONFIG_REGISTRY: `http://127.0.0.1:${server.port}` }, hits }
}

const noFetch = (() => {
  throw new Error('fetched')
}) as unknown as typeof fetch

/** True when a read-only folder refuses a new file here: not for root, and not on Windows. */
function readOnlyRefuses(): boolean {
  if (process.platform === 'win32') return false
  const dir = mkdtempSync(join(tmpdir(), 'desk-sdk-ro-'))
  try {
    chmodSync(dir, 0o555)
    writeFileSync(join(dir, 'probe'), '')
    return false
  } catch {
    return true
  } finally {
    chmodSync(dir, 0o755)
    rmSync(dir, { recursive: true, force: true })
  }
}

/** What the unpack leaves beside the package: nothing but the package itself. */
const leftovers = () => readdirSync(join(desk, 'node_modules', '@anthropic-ai')).filter((n) => n !== 'claude-agent-sdk')

describe('the Agent SDK in a checkout', () => {
  test('there is no pin: the installed package is imported by name and nothing is fetched', async () => {
    expect(readSdkPin(desk)).toBeNull()
    expect(sdkReady({ deskRoot: desk })).toBe(true)
    expect(await ensureSdk({ deskRoot: desk, fetch: noFetch })).toBe(SDK_PACKAGE)
    expect(existsSync(join(desk, 'node_modules'))).toBe(false)
  })
})

describe('the Agent SDK in a release', () => {
  test('the first need downloads the pinned tarball, checks it and unpacks all of it; the next one fetches nothing', async () => {
    const tgz = sdkTarball()
    pin(tgz)
    const reg = registry(tgz)
    expect(sdkReady({ deskRoot: desk })).toBe(false)
    const [a, b] = await Promise.all([ensureSdk({ deskRoot: desk, env: reg.env, fetch }), ensureSdk({ deskRoot: desk, env: reg.env, fetch })])
    expect(a).toBe(b)
    expect(reg.hits.tarball).toBe(1)
    const dir = sdkDir(desk)
    expect(dir).toBe(join(desk, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'))
    expect(readdirSync(dir).sort()).toEqual([SDK_MARKER, 'README.md', 'lib', 'package.json', 'sdk.mjs'])
    expect(leftovers()).toEqual([])
    const sdk = (await import(a)) as { query(): string; nested: string }
    expect(sdk.query()).toBe('stand-in query')
    expect(sdk.nested.length).toBe(700)
    expect(sdkReady({ deskRoot: desk })).toBe(true)
    expect(await ensureSdk({ deskRoot: desk, fetch: noFetch })).toBe(a)
  })

  test('a copy that is already here is used as it is', async () => {
    const tgz = sdkTarball()
    pin(tgz)
    await ensureSdk({ deskRoot: desk, env: registry(tgz).env, fetch })
    const before = readFileSync(join(sdkDir(desk), SDK_MARKER), 'utf8')
    expect(await ensureSdk({ deskRoot: desk, fetch: noFetch })).toContain('/claude-agent-sdk/sdk.mjs')
    expect(readFileSync(join(sdkDir(desk), SDK_MARKER), 'utf8')).toBe(before)
  })

  test('a download that is not the pinned tarball is refused, nothing is installed, and the next call tries again', async () => {
    const tgz = sdkTarball()
    pin(tgz, { integrity: integrityOf(Buffer.from('another tarball')) })
    const reg = registry(tgz)
    await expect(ensureSdk({ deskRoot: desk, env: reg.env, fetch })).rejects.toThrow(`the download of the Claude Agent SDK ${VERSION} from ${reg.env.NPM_CONFIG_REGISTRY} is not the package this release pins`)
    expect(existsSync(sdkDir(desk))).toBe(false)
    expect(leftovers()).toEqual([])
    await expect(ensureSdk({ deskRoot: desk, env: reg.env, fetch })).rejects.toThrow('is not the package this release pins')
    expect(reg.hits.tarball).toBe(2)
  })

  test('a folder a killed unpack or an older release left, without the marker, is replaced by a full copy', async () => {
    const tgz = sdkTarball()
    pin(tgz)
    const dir = sdkDir(desk)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: SDK_PACKAGE, version: VERSION }))
    writeFileSync(join(dir, 'half-written.mjs'), 'export const')
    expect(sdkReady({ deskRoot: desk })).toBe(false)
    const reg = registry(tgz)
    await ensureSdk({ deskRoot: desk, env: reg.env, fetch })
    expect(reg.hits.tarball).toBe(1)
    expect(existsSync(join(dir, 'half-written.mjs'))).toBe(false)
    expect(existsSync(join(dir, 'lib', 'nested.mjs'))).toBe(true)
    expect(leftovers()).toEqual([])
  })

  test('a tarball that ends inside an entry is not installed as a package', async () => {
    const tgz = sdkTarball({ cut: true })
    pin(tgz)
    await expect(ensureSdk({ deskRoot: desk, env: registry(tgz).env, fetch })).rejects.toThrow(`could not unpack the Claude Agent SDK ${VERSION}`)
    expect(existsSync(sdkDir(desk))).toBe(false)
    expect(leftovers()).toEqual([])
  })

  test('offline, it fails saying so, and leaves nothing behind', async () => {
    const tgz = sdkTarball()
    pin(tgz)
    const down = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
    const url = `http://127.0.0.1:${down.port}`
    down.stop(true)
    const err = await ensureSdk({ deskRoot: desk, env: { NPM_CONFIG_REGISTRY: url }, fetch }).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toStartWith(`could not download the Claude Agent SDK ${VERSION} from ${url}: `)
    expect((err as Error).message).toEndWith('try again once this computer is online.')
    expect(existsSync(sdkDir(desk))).toBe(false)
    expect(leftovers()).toEqual([])
  })

  /** A registry stand-in that counts its calls: a folder that cannot take the download is found before any. */
  const counting = (tgz: Buffer) => {
    const calls = { n: 0 }
    const impl = (async () => {
      calls.n++
      return new Response(new Uint8Array(tgz))
    }) as unknown as typeof fetch
    return { calls, impl }
  }
  const unsaved = (parent: string) => `could not save the Claude Agent SDK ${VERSION} in ${parent}: `

  test('a folder that cannot be made fails saying so, not as if offline, and nothing is fetched', async () => {
    const tgz = sdkTarball()
    pin(tgz)
    // desk2/node_modules/@anthropic-ai is a file: the download has nowhere to go.
    const parent = join(desk, 'node_modules', '@anthropic-ai')
    mkdirSync(join(desk, 'node_modules'))
    writeFileSync(parent, '')
    const reg = counting(tgz)
    const err = await ensureSdk({ deskRoot: desk, env: {}, fetch: reg.impl }).catch((e: Error) => e)
    expect((err as Error).message).toStartWith(unsaved(parent))
    expect((err as Error).message).not.toContain('online')
    expect(reg.calls.n).toBe(0)
  })

  // Root writes into a read-only folder, and Windows does not read these mode bits: there the next one is skipped.
  test.skipIf(!readOnlyRefuses())('a folder the download cannot be written in fails saying so, and nothing is fetched', async () => {
    const tgz = sdkTarball()
    pin(tgz)
    const parent = join(desk, 'node_modules', '@anthropic-ai')
    mkdirSync(parent, { recursive: true })
    chmodSync(parent, 0o555)
    stops.push(() => chmodSync(parent, 0o755))
    const reg = counting(tgz)
    const err = await ensureSdk({ deskRoot: desk, env: {}, fetch: reg.impl }).catch((e: Error) => e)
    expect((err as Error).message).toStartWith(unsaved(parent))
    expect((err as Error).message).not.toContain('online')
    expect(reg.calls.n).toBe(0)
    expect(existsSync(sdkDir(desk))).toBe(false)
  })

  test('a download far larger than the SDK is refused as not the package, not as offline', async () => {
    const tgz = sdkTarball()
    pin(tgz)
    // A body that never ends, in 1 MB chunks: past the cap the download stops reading it.
    const chunk = new Uint8Array(1024 * 1024)
    let sent = 0
    const huge = (async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            sent++
            c.enqueue(chunk)
          },
        }),
      )) as unknown as typeof fetch
    const err = await ensureSdk({ deskRoot: desk, env: { NPM_CONFIG_REGISTRY: 'https://registry.example.test' }, fetch: huge }).catch((e: Error) => e)
    expect((err as Error).message).toBe(`the download of the Claude Agent SDK ${VERSION} from https://registry.example.test is not the package this release pins (it is over 64 MB), so it was not installed`)
    expect(sent).toBeLessThan(70)
    expect(existsSync(sdkDir(desk))).toBe(false)
    expect(leftovers()).toEqual([])
  })

  test('a link or a path out of the package folder is refused', async () => {
    for (const extra of [tarEntry('package/../../outside.txt', Buffer.from('x')), tarEntry('package/link', undefined, '2')]) {
      const tgz = sdkTarball({ extra: [extra] })
      pin(tgz)
      await expect(ensureSdk({ deskRoot: desk, env: registry(tgz).env, fetch })).rejects.toThrow('could not unpack')
      expect(existsSync(sdkDir(desk))).toBe(false)
      expect(existsSync(join(desk, 'outside.txt'))).toBe(false)
    }
  })

  test('a tarball of some other package is refused', async () => {
    const tgz = sdkTarball({ name: '@example/not-the-sdk' })
    pin(tgz)
    await expect(ensureSdk({ deskRoot: desk, env: registry(tgz).env, fetch })).rejects.toThrow(`holds @example/not-the-sdk@${VERSION}`)
    expect(existsSync(sdkDir(desk))).toBe(false)
  })

  test("temp files a killed process left an hour ago are swept; a running download's are not", async () => {
    const tgz = sdkTarball()
    pin(tgz)
    const parent = join(desk, 'node_modules', '@anthropic-ai')
    mkdirSync(join(parent, '.claude-agent-sdk.1.dead.tmp'), { recursive: true })
    writeFileSync(join(parent, '.claude-agent-sdk.2.live.tgz'), '')
    const old = (Date.now() - 2 * 60 * 60_000) / 1000
    utimesSync(join(parent, '.claude-agent-sdk.1.dead.tmp'), old, old)
    await ensureSdk({ deskRoot: desk, env: registry(tgz).env, fetch })
    expect(leftovers()).toEqual(['.claude-agent-sdk.2.live.tgz'])
  })

  test('a pin that pins nothing is an error, not a checkout, and the reason names the SDK', async () => {
    writeFileSync(join(desk, SDK_PIN_FILE), JSON.stringify({ name: SDK_PACKAGE, version: VERSION }))
    expect(() => readSdkPin(desk)).toThrow('does not pin')
    await expect(ensureSdk({ deskRoot: desk, fetch: noFetch })).rejects.toThrow(`could not get the Claude Agent SDK: ${join(desk, SDK_PIN_FILE)} does not pin`)
    writeFileSync(join(desk, SDK_PIN_FILE), '{ cut off')
    await expect(ensureSdk({ deskRoot: desk, fetch: noFetch })).rejects.toThrow('could not get the Claude Agent SDK: ')
  })

  test("Claude Code's binary is known from the pin before the SDK is here", () => {
    const tgz = sdkTarball()
    pin(tgz)
    const target = sdkTarget(desk)
    expect(target.version).toBe(VERSION)
    expect(target.claudeCodeVersion).toBe('9.9.8')
    expect(target.installed()).toBeNull()
  })
})
