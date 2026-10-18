// The Claude Agent SDK in a release. Its licence reserves all rights (its LICENSE.md: "All rights reserved", use under
// Anthropic's legal agreements), so a release does not hand out a copy of it: scripts/package-release.ts leaves it out
// of desk2/node_modules and writes desk2/sdk-pin.json instead, the exact
// version and sha512 desk2/bun.lock resolved. The first time something here needs the SDK, ensureSdk() downloads that
// version's tarball from the npm registry (npm_config_registry / NPM_CONFIG_REGISTRY name a mirror), checks it against
// the pin, and unpacks all of it into desk2/node_modules/@anthropic-ai/claude-agent-sdk, which is where the person's
// own install would have put it. A checkout has no pin: it runs on what `bun install` put in node_modules and never
// downloads anything. Kept in host/ because chat-host.ts imports nothing outside this folder.

import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createGunzip } from 'node:zlib'
import { untarPackage } from './tar'

export const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk'
/** In desk2/, beside package.json: only a release has one. */
export const SDK_PIN_FILE = 'sdk-pin.json'
/** Written into the unpacked package last: a folder without it is not a finished copy of the pinned version. */
export const SDK_MARKER = '.agenthydra-sdk.json'
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
/** A download gives up after this long without a byte. */
const IDLE_TIMEOUT_MS = 60_000
/** The SDK's tarball is under 2 MB; anything near these is not it. */
const MAX_TARBALL_BYTES = 64 * 1024 * 1024
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024
/** Temp folders a killed process left are removed once they are this old. */
const STALE_TEMP_MS = 60 * 60_000
const TEMP_PREFIX = '.claude-agent-sdk.'

/** What desk2/sdk-pin.json holds. */
export interface SdkPin {
  name: string
  version: string
  /** The tarball's sha512, as bun.lock and the registry write it: "sha512-<base64>". */
  integrity: string
  /** From the SDK's package.json, for Claude Code's binary before the SDK is here (engine/claude-code-binary.ts). */
  claudeCodeVersion?: string
  optionalDependencies: Record<string, string>
}

/** desk2/, the folder this server runs from. */
export const DESK_ROOT = join(import.meta.dir, '..', '..', '..')

/** The release's pin, or null in a checkout (no pin file). A pin file that does not pin the SDK is an error. */
export function readSdkPin(deskRoot = DESK_ROOT): SdkPin | null {
  const file = join(deskRoot, SDK_PIN_FILE)
  if (!existsSync(file)) return null
  const pin = JSON.parse(readFileSync(file, 'utf8')) as Partial<SdkPin>
  if (pin.name !== SDK_PACKAGE || typeof pin.version !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(pin.integrity ?? '') || typeof pin.optionalDependencies !== 'object')
    throw new Error(`${file} does not pin ${SDK_PACKAGE} to a version and a sha512`)
  return pin as SdkPin
}

/** Where the SDK goes: desk2/node_modules/@anthropic-ai/claude-agent-sdk. */
export function sdkDir(deskRoot = DESK_ROOT): string {
  return join(deskRoot, 'node_modules', ...SDK_PACKAGE.split('/'))
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** True when `dir` holds a finished copy of the pinned version (its marker says so, and its package.json agrees). */
function holdsPinned(dir: string, pin: SdkPin): boolean {
  const marker = readJson(join(dir, SDK_MARKER))
  const pkg = readJson(join(dir, 'package.json'))
  return marker?.version === pin.version && marker.integrity === pin.integrity && pkg?.name === pin.name && pkg.version === pin.version
}

/** The SDK's entry point as a file URL: imported by path, so no resolver cache from before the unpack is in the way. */
function entryOf(dir: string): string {
  const pkg = readJson(join(dir, 'package.json')) as { main?: string; exports?: Record<string, unknown> } | null
  const main = pkg?.exports?.['.']
  const rel = typeof main === 'string' ? main : ((main as { import?: string; default?: string } | undefined)?.import ?? (main as { default?: string } | undefined)?.default ?? pkg?.main ?? 'index.js')
  return pathToFileURL(join(dir, rel)).href
}

export interface SdkOptions {
  /** desk2/ (tests give a temp folder). */
  deskRoot?: string
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
}

/** True when the SDK can be imported now: a checkout, or a release whose copy was fetched before. */
export function sdkReady(o: SdkOptions = {}): boolean {
  const root = o.deskRoot ?? DESK_ROOT
  const pin = readSdkPin(root)
  return !pin || holdsPinned(sdkDir(root), pin)
}

const ensuring = new Map<string, Promise<string>>()

/**
 * What to import the SDK by: its name in a checkout; in a release, the file URL of the pinned copy, fetched first when
 * it is not here. Callers in this process share one download; a failed one is not remembered, so the next call tries
 * again. It fails with the reason when the computer is offline or the download is not the pinned tarball.
 */
export function ensureSdk(o: SdkOptions = {}): Promise<string> {
  const root = o.deskRoot ?? DESK_ROOT
  let pin: SdkPin | null
  try {
    pin = readSdkPin(root)
  } catch (err) {
    return Promise.reject(err)
  }
  if (!pin) return Promise.resolve(SDK_PACKAGE)
  const dir = sdkDir(root)
  if (holdsPinned(dir, pin)) return Promise.resolve(entryOf(dir))
  let one = ensuring.get(root)
  if (!one) {
    one = fetchSdk(pin, dir, o).finally(() => ensuring.delete(root))
    ensuring.set(root, one)
  }
  return one
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

async function fetchSdk(pin: SdkPin, dir: string, o: SdkOptions): Promise<string> {
  const env = o.env ?? process.env
  const registry = (env.npm_config_registry || env.NPM_CONFIG_REGISTRY || DEFAULT_REGISTRY).replace(/\/+$/, '')
  const url = `${registry}/${pin.name}/-/${pin.name.split('/').pop()}-${pin.version}.tgz`
  const what = `the Claude Agent SDK ${pin.version}`
  const parent = dirname(dir)
  mkdirSync(parent, { recursive: true })
  sweepTemps(parent)
  const tag = `${process.pid}.${randomBytes(4).toString('hex')}`
  const tgz = join(parent, `${TEMP_PREFIX}${tag}.tgz`)
  const unpacked = join(parent, `${TEMP_PREFIX}${tag}.tmp`)
  const aside = join(parent, `${TEMP_PREFIX}${tag}.old`)
  try {
    let digest: string
    try {
      digest = await download(url, tgz, o.fetch ?? fetch)
    } catch (err) {
      throw new Error(`could not download ${what} from ${registry}: ${reason(err)}. AgentHydra fetches it once, the first time a chat needs it; try again once this computer is online.`)
    }
    if (`sha512-${digest}` !== pin.integrity) throw new Error(`the download of ${what} from ${registry} is not the package this release pins (its sha512 differs), so it was not installed`)
    mkdirSync(unpacked)
    try {
      const source = createReadStream(tgz)
      const gunzip = createGunzip()
      source.on('error', (err) => gunzip.destroy(err))
      try {
        await untarPackage(source.pipe(gunzip), unpacked, MAX_UNPACKED_BYTES)
      } finally {
        source.destroy()
        gunzip.destroy()
      }
    } catch (err) {
      throw new Error(`could not unpack ${what}: ${reason(err)}`)
    }
    const pkg = readJson(join(unpacked, 'package.json'))
    if (pkg?.name !== pin.name || pkg.version !== pin.version) throw new Error(`the download of ${what} holds ${String(pkg?.name)}@${String(pkg?.version)}`)
    writeFileSync(join(unpacked, SDK_MARKER), `${JSON.stringify({ name: pin.name, version: pin.version, integrity: pin.integrity })}\n`)
    // Another process may have finished first; its copy is as good.
    if (holdsPinned(dir, pin)) return entryOf(dir)
    // What is there is not the pinned version, finished: an older release's copy, or one a killed process left.
    if (existsSync(dir)) renameSync(dir, aside)
    try {
      renameSync(unpacked, dir)
    } catch (err) {
      if (holdsPinned(dir, pin)) return entryOf(dir)
      throw err
    }
    return entryOf(dir)
  } finally {
    await Promise.all([rm(tgz, { force: true }), rm(unpacked, { recursive: true, force: true }), rm(aside, { recursive: true, force: true })]).catch(() => {})
  }
}

/** Streams the tarball to `file`, hashing as it goes; returns the base64 sha512. */
async function download(url: string, file: string, fetchImpl: typeof fetch): Promise<string> {
  const idle = new AbortController()
  let timer = setTimeout(() => idle.abort(new Error('the download stalled')), IDLE_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, { signal: idle.signal })
    if (!res.ok || !res.body) throw new Error(`the registry answered ${res.status}`)
    const hash = createHash('sha512')
    const fh = await open(file, 'w')
    let received = 0
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        clearTimeout(timer)
        timer = setTimeout(() => idle.abort(new Error('the download stalled')), IDLE_TIMEOUT_MS)
        received += chunk.length
        if (received > MAX_TARBALL_BYTES) throw new Error(`the download is over ${MAX_TARBALL_BYTES / 1024 / 1024} MB`)
        hash.update(chunk)
        await fh.write(chunk)
      }
    } finally {
      await fh.close()
    }
    return hash.digest('base64')
  } catch (err) {
    throw idle.signal.aborted && idle.signal.reason instanceof Error ? idle.signal.reason : err
  } finally {
    clearTimeout(timer)
  }
}

/** Temp files and folders a killed process left (older than an hour; a running download's are newer). */
function sweepTemps(parent: string): void {
  try {
    for (const name of readdirSync(parent)) {
      if (!name.startsWith(TEMP_PREFIX)) continue
      const path = join(parent, name)
      if (Date.now() - statSync(path).mtimeMs > STALE_TEMP_MS) rmSync(path, { recursive: true, force: true })
    }
  } catch {
    // best effort
  }
}
