// Where a chat gets Claude Code's native binary (the Agent SDK's platform package, 238 MB, which a release does not
// ship). In order: the platform package installed beside the SDK (a checkout), a copy cached under the Desk home,
// else a one-time download of exactly the version the SDK pins from npm, verified against the registry's sha512.
// A chat that needs the download waits for it (chat-runtime start); the one download is shared by every caller.

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { chmod, open, rename, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createGunzip } from 'node:zlib'
import { readSdkPin, SDK_PACKAGE } from '../host/sdk-package'
import { untarFile } from '../host/tar'

export { untarFile }

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
/** A metadata request or a stalled tarball gives up after this long without an answer or a byte. */
const IDLE_TIMEOUT_MS = 60_000
/** Temp files a crashed download left are removed once they are this old (a live download keeps writing to its own). */
const STALE_TEMP_MS = 60 * 60_000

/** What the SDK needs on this platform, as its own sdk.mjs works it out, and what the installed SDK pins. */
export interface ClaudeCodeTarget {
  /** The platform package, e.g. @anthropic-ai/claude-agent-sdk-win32-x64. */
  pkg: string
  /** The version the SDK pins for it in optionalDependencies: exactly what is downloaded. */
  version: string
  /** The Claude Code release inside it (the SDK's claudeCodeVersion), for people; null when the SDK does not say. */
  claudeCodeVersion: string | null
  /** claude.exe on Windows, claude elsewhere. */
  binary: string
  /** The binary of the platform package installed beside the SDK, or null (an install without optional packages, a release). */
  installed(): string | null
}

export type ClaudeCodeSource = 'package' | 'cache' | 'downloading' | 'download-needed'

export interface DownloadProgress {
  phase: 'download' | 'unpack'
  receivedBytes: number
  /** The tarball's size, null until the registry says it. */
  totalBytes: number | null
  /** 0-100 while downloading; null when the size is not known (or while unpacking). */
  percent: number | null
}

export interface ClaudeCodeStatus {
  source: ClaudeCodeSource
  /** The Claude Code release (what a person reads); the platform package version when the SDK does not say. */
  version: string
  path?: string
  progress?: DownloadProgress
}

/** Every platform package name sdk.mjs may use on this platform, the one it tries first first (it falls back to the other libc). */
export function platformPackages(platform: string, arch: string, preferMusl: boolean): string[] {
  if (platform === 'android') return [`${SDK_PACKAGE}-linux-${arch}-android`]
  if (platform !== 'linux') return [`${SDK_PACKAGE}-${platform}-${arch}`]
  const glibc = `${SDK_PACKAGE}-linux-${arch}`
  const musl = `${glibc}-musl`
  return preferMusl ? [musl, glibc] : [glibc, musl]
}

/** sdk.mjs's own libc test: Linux whose runtime report names no glibc version. */
function runsOnMusl(): boolean {
  if (process.platform !== 'linux') return false
  const report = typeof process.report?.getReport === 'function' ? (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }) : null
  return report != null && report.header?.glibcVersionRuntime === undefined
}

/** The installed SDK's own folder: found from where it resolves, so bun's isolated linker layout does not matter. */
function sdkRoot(): string {
  let dir = dirname(createRequire(import.meta.url).resolve(SDK_PACKAGE))
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string }
      if (pkg.name === SDK_PACKAGE) return dir
    } catch {
      // no package.json at this level
    }
    const up = dirname(dir)
    if (up === dir) throw new Error(`cannot find the ${SDK_PACKAGE} folder`)
    dir = up
  }
}

/**
 * The platform package and version of the SDK this server runs on. The installed copy is looked up the way sdk.mjs
 * does it: a require made from the SDK's own location, so it finds what the SDK's install put beside it. A release
 * ships neither the SDK nor its platform packages, only the pin of the SDK it fetches (host/sdk-package.ts), which
 * says the same, so a chat can show and fetch Claude Code before the SDK is there.
 */
export function sdkTarget(deskRoot?: string): ClaudeCodeTarget {
  const pin = readSdkPin(deskRoot)
  const root = pin ? null : sdkRoot()
  const sdk = pin ?? (JSON.parse(readFileSync(join(root!, 'package.json'), 'utf8')) as { claudeCodeVersion?: string; optionalDependencies?: Record<string, string> })
  const candidates = platformPackages(process.platform, process.arch, runsOnMusl())
  const pinned = sdk.optionalDependencies ?? {}
  const pkg = candidates.find((c) => pinned[c] !== undefined)
  if (!pkg) throw new Error(`Claude Code has no build for ${process.platform}-${process.arch}`)
  const binary = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const fromSdk = root ? createRequire(join(root, 'package.json')) : null
  return {
    pkg,
    version: pinned[pkg]!,
    claudeCodeVersion: sdk.claudeCodeVersion ?? null,
    binary,
    installed() {
      if (!fromSdk) return null
      for (const name of candidates) {
        try {
          const path = fromSdk.resolve(`${name}/${binary}`)
          if (existsSync(path)) return path
        } catch {
          // not installed
        }
      }
      return null
    },
  }
}

/** The status line a chat shows while it waits: "Getting Claude Code 2.1.288 (104 MB): 37%". */
export function describeProgress(version: string, p: DownloadProgress | null): string {
  if (p?.phase === 'unpack') return `Unpacking Claude Code ${version}`
  const size = p?.totalBytes ? ` (${Math.round(p.totalBytes / 1e6)} MB)` : ''
  return `Getting Claude Code ${version}${size}${p?.percent != null ? `: ${p.percent}%` : ''}`
}

/** A name that cannot collide with another process's temp file for the same download. */
function tempName(base: string, tag: string): string {
  return `${base}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.${tag}`
}

export interface ClaudeCodeBinaryOptions {
  /** The Desk home (the chat store's home): the cache lives in <home>/claude-code/<version>/. */
  home: string
  /** Defaults to what the installed SDK pins and installs; tests give their own. */
  target?: ClaudeCodeTarget
  /** Where the registry is: npm_config_registry / NPM_CONFIG_REGISTRY name a mirror. */
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
}

export class ClaudeCodeBinary {
  private readonly home: string
  private readonly target: ClaudeCodeTarget
  private readonly registry: string
  private readonly fetchImpl: typeof fetch
  private download: Promise<string> | null = null
  private progress: DownloadProgress | null = null
  private readonly listeners = new Set<(p: DownloadProgress) => void>()

  constructor(o: ClaudeCodeBinaryOptions) {
    this.home = o.home
    this.target = o.target ?? sdkTarget()
    const env = o.env ?? process.env
    this.registry = (env.npm_config_registry || env.NPM_CONFIG_REGISTRY || DEFAULT_REGISTRY).replace(/\/+$/, '')
    this.fetchImpl = o.fetch ?? fetch
  }

  /** What a person reads for the version: the Claude Code release when the SDK says it. */
  get version(): string {
    return this.target.claudeCodeVersion ?? this.target.version
  }

  /** <home>/claude-code/<platform package version>/: the version is the one the download is exact about. */
  get cacheDir(): string {
    return join(this.home, 'claude-code', this.target.version)
  }

  get cachePath(): string {
    return join(this.cacheDir, this.target.binary)
  }

  /** The binary a chat can start with now (installed package, else cache), or null when only a download gets it. */
  path(): string | null {
    const installed = this.target.installed()
    if (installed) return installed
    return existsSync(this.cachePath) ? this.cachePath : null
  }

  status(): ClaudeCodeStatus {
    const installed = this.target.installed()
    if (installed) return { source: 'package', version: this.version, path: installed }
    if (existsSync(this.cachePath)) return { source: 'cache', version: this.version, path: this.cachePath }
    if (this.download) return { source: 'downloading', version: this.version, ...(this.progress ? { progress: this.progress } : {}) }
    return { source: 'download-needed', version: this.version }
  }

  /** Called with each progress step of the running download (and while unpacking); returns how to stop listening. */
  onProgress(fn: (p: DownloadProgress) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /**
   * The binary's path, downloading it first when there is none. Callers in this process share one download; one that
   * failed is not remembered, so the next call (a Retry) starts it again.
   */
  resolve(): Promise<string> {
    const have = this.path()
    if (have) return Promise.resolve(have)
    if (!this.download) {
      this.download = this.fetchBinary().finally(() => {
        this.download = null
        this.progress = null
      })
    }
    return this.download
  }

  private report(p: DownloadProgress): void {
    this.progress = p
    for (const fn of this.listeners) fn(p)
  }

  private async fetchBinary(): Promise<string> {
    const { pkg, version, binary } = this.target
    const dir = this.cacheDir
    mkdirSync(dir, { recursive: true })
    this.sweepTemps(dir)
    const tgz = join(dir, tempName('package', 'part'))
    const out = join(dir, tempName(binary, 'tmp'))
    try {
      const meta = await this.fetchJson(`${this.registry}/${pkg}/${version}`)
      const dist = (meta as { dist?: { tarball?: unknown; integrity?: unknown } }).dist
      if (typeof dist?.tarball !== 'string' || typeof dist.integrity !== 'string') throw new Error(`the registry has no download for ${pkg}@${version}`)
      if (!dist.integrity.startsWith('sha512-')) throw new Error(`the registry's checksum for ${pkg}@${version} is not sha512`)
      const digest = await this.downloadTo(new URL(dist.tarball, `${this.registry}/`).href, tgz)
      if (`sha512-${digest}` !== dist.integrity) throw new Error(`the download of ${pkg}@${version} does not match the registry's checksum`)
      this.report({ phase: 'unpack', receivedBytes: this.progress?.receivedBytes ?? 0, totalBytes: this.progress?.totalBytes ?? null, percent: null })
      await this.extract(tgz, `package/${binary}`, out)
      // Another Desk process may have finished first; its copy is as good, and is left in place.
      if (existsSync(this.cachePath)) return this.cachePath
      if (process.platform !== 'win32') await chmod(out, 0o755)
      await rename(out, this.cachePath)
      return this.cachePath
    } catch (err) {
      if (existsSync(this.cachePath)) return this.cachePath
      throw err
    } finally {
      await Promise.all([rm(tgz, { force: true }), rm(out, { force: true })]).catch(() => {})
    }
  }

  /** Temp files a killed process left (older than an hour; a running download's are newer) are not kept forever. */
  private sweepTemps(dir: string): void {
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.part') && !name.endsWith('.tmp')) continue
        const file = join(dir, name)
        if (Date.now() - statSync(file).mtimeMs > STALE_TEMP_MS) unlinkSync(file)
      }
    } catch {
      // best effort
    }
  }

  private async fetchJson(url: string): Promise<unknown> {
    const res = await this.fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(IDLE_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`the registry answered ${res.status} for ${url}`)
    return res.json()
  }

  /** Streams the tarball to `file`, hashing as it goes; returns the base64 sha512. Gives up when no byte comes for a minute. */
  private async downloadTo(url: string, file: string): Promise<string> {
    const idle = new AbortController()
    let timer = setTimeout(() => idle.abort(new Error('the download stalled')), IDLE_TIMEOUT_MS)
    const res = await this.fetchImpl(url, { signal: idle.signal })
    if (!res.ok || !res.body) {
      clearTimeout(timer)
      throw new Error(`the registry answered ${res.status} for the download`)
    }
    const length = Number(res.headers.get('content-length'))
    const totalBytes = Number.isFinite(length) && length > 0 ? length : null
    const hash = createHash('sha512')
    const fh = await open(file, 'w')
    let received = 0
    let lastPercent = -1
    this.report({ phase: 'download', receivedBytes: 0, totalBytes, percent: totalBytes ? 0 : null })
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        clearTimeout(timer)
        timer = setTimeout(() => idle.abort(new Error('the download stalled')), IDLE_TIMEOUT_MS)
        hash.update(chunk)
        await fh.write(chunk)
        received += chunk.length
        const percent = totalBytes ? Math.min(100, Math.floor((received / totalBytes) * 100)) : null
        if (percent !== lastPercent) {
          lastPercent = percent ?? -1
          this.report({ phase: 'download', receivedBytes: received, totalBytes, percent })
        }
      }
    } catch (err) {
      throw idle.signal.aborted && idle.signal.reason instanceof Error ? idle.signal.reason : err
    } finally {
      clearTimeout(timer)
      await fh.close()
    }
    if (totalBytes !== null && received !== totalBytes) throw new Error('the download ended early')
    return hash.digest('base64')
  }

  private async extract(tgz: string, wanted: string, out: string): Promise<void> {
    const fh = await open(out, 'w')
    let written = 0
    const source = createReadStream(tgz)
    const gunzip = createGunzip()
    source.on('error', (err) => gunzip.destroy(err))
    try {
      const found = await untarFile(source.pipe(gunzip), wanted, async (chunk) => {
        await fh.write(chunk)
        written += chunk.length
      })
      if (!found) throw new Error(`the package has no ${wanted}`)
      if (written === 0) throw new Error(`${wanted} in the package is empty`)
    } finally {
      source.destroy()
      gunzip.destroy()
      await fh.close()
    }
  }
}

const instances = new Map<string, ClaudeCodeBinary>()

/** The one resolver for a Desk home: every chat and the status route share its download. */
export function claudeCodeBinaryFor(home: string): ClaudeCodeBinary {
  let one = instances.get(home)
  if (!one) {
    one = new ClaudeCodeBinary({ home })
    instances.set(home, one)
  }
  return one
}
