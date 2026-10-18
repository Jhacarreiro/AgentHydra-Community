#!/usr/bin/env bun
/**
 * The THIRD-PARTY-LICENSES file of a release bundle: the name, version, licence and licence text of every third-party
 * package whose code ends up in it. scripts/package-release.ts calls it for what it assembles (the npm packages bun
 * inlines into app/server.js and desk2/agenthydra-server/, Desk's production node_modules, the packages vite builds into
 * Desk's two dists, and the crates of the Rust programs a bundle carries); the command line is for builds made elsewhere.
 *
 *   bun scripts/third-party-licenses.ts [--out <file>] [--json <file>] [--title <text>] <source>...
 *
 * Each source is `<path>[=<where it ships>[,<where else>]]`:
 *   --npm-tree <node_modules>        every package installed in that folder
 *   --npm-metafile <metafile.json>   every package a `bun build --metafile` inlined (its paths resolve against --root,
 *                                    the folder the build ran in; default: this one)
 *   --npm-built <third-party.json>   every package a vite build put into a dist (desk2/scripts/third-party-modules.ts)
 *   --go <module dir>                every module `go list -deps` links into the program for --goos and --goarch
 *                                    (default: this machine's), and Go's own licence
 *   --cargo <crate dir>              every crate `cargo metadata` resolves for --target (default: this machine's), and
 *                                    the Rust standard library's licences
 *   --merge <list.json>              a list an earlier run wrote with --json
 *
 * It fails, and writes nothing, when a package declares no licence, declares one outside ALLOWED_LICENCES, or carries
 * no licence text (a NOTICE, PATENTS or COPYRIGHT file that states no licence is not one).
 * scripts/third-party-licenses.json settles a package whose own files fall short, one version at a time: the licence
 * its project states, and the text fetched from a fixed address and checked against its SHA-256.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export type Ecosystem = 'npm' | 'go' | 'cargo' | 'toolchain'

export interface LicenceText {
  /** The file's name inside the package, or where the text was fetched from. */
  file: string
  text: string
}

export interface ThirdPartyPackage {
  ecosystem: Ecosystem
  name: string
  version: string
  /** An SPDX expression, or null when neither the package's metadata nor its licence files say. */
  license: string | null
  /** Where `license` was read: the package's metadata, a licence file, or scripts/third-party-licenses.json. */
  licenseFrom: string
  /** The project's own address, when its metadata gives one. */
  source?: string
  texts: LicenceText[]
  /** Where in the bundle its code is. */
  shippedIn: string[]
  /** The folder it was read from, for the texts; never written out. */
  dir?: string
}

/**
 * The licences a bundle may carry: permissive ones, whose terms a copy meets by keeping the notice and the text, and
 * MPL-2.0, whose files ship unmodified. Anything else, or a name that is not SPDX, fails the build until someone has
 * looked at it.
 */
export const ALLOWED_LICENCES = [
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSL-1.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'OFL-1.1',
  'Unicode-3.0',
  'Unicode-DFS-2016',
  'Unlicense',
  'Zlib',
] as const
/** The SPDX exceptions allowed after WITH: LLVM's only adds permissions to Apache-2.0. */
export const ALLOWED_EXCEPTIONS = ['LLVM-exception'] as const

const slashes = (path: string) => path.replace(/\\/g, '/')
const key = (p: Pick<ThirdPartyPackage, 'ecosystem' | 'name' | 'version'>) =>
  `${p.ecosystem}:${p.name}@${p.version}`
const label = (p: Pick<ThirdPartyPackage, 'name' | 'version'>) => `${p.name} ${p.version}`

// ---------------------------------------------------------------------------------------------------------------------
// Licence expressions

export type LicenceExpression =
  | { id: string; exception?: string }
  | { op: 'AND' | 'OR'; left: LicenceExpression; right: LicenceExpression }

/**
 * Parses an SPDX licence expression ("MIT", "(MIT OR Apache-2.0) AND Unicode-3.0", "Apache-2.0 WITH LLVM-exception").
 * A `/` between two names, as older Cargo.toml files write it, reads as OR. Throws on anything else.
 */
export function parseLicence(expression: string): LicenceExpression {
  const tokens = expression
    .replace(/\//g, ' OR ')
    .replace(/([()])/g, ' $1 ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  let at = 0
  const peek = () => tokens[at]?.toUpperCase()
  const word = (): string => {
    const t = tokens[at++]
    if (!t || /^(?:AND|OR|WITH|\(|\))$/i.test(t))
      throw new Error(`"${expression}" is not a licence expression`)
    return t
  }
  const atom = (): LicenceExpression => {
    if (peek() === '(') {
      at++
      const inner = or()
      if (tokens[at++] !== ')') throw new Error(`"${expression}" has an unclosed bracket`)
      return inner
    }
    const id = word()
    if (peek() === 'WITH') {
      at++
      return { id, exception: word() }
    }
    return { id }
  }
  const and = (): LicenceExpression => {
    let left = atom()
    while (peek() === 'AND') {
      at++
      left = { op: 'AND', left, right: atom() }
    }
    return left
  }
  const or = (): LicenceExpression => {
    let left = and()
    while (peek() === 'OR') {
      at++
      left = { op: 'OR', left, right: and() }
    }
    return left
  }
  const parsed = or()
  if (at !== tokens.length) throw new Error(`"${expression}" is not a licence expression`)
  return parsed
}

const allowedIds = new Set(ALLOWED_LICENCES.map((id) => id.toLowerCase()))
const allowedExceptions = new Set(ALLOWED_EXCEPTIONS.map((id) => id.toLowerCase()))

/** True when a copy may carry code under `expression`: one side of an OR, and every side of an AND, is allowed. */
export function licenceAllowed(expression: string): boolean {
  const ok = (e: LicenceExpression): boolean => {
    if ('op' in e) return e.op === 'OR' ? ok(e.left) || ok(e.right) : ok(e.left) && ok(e.right)
    // "Apache-2.0+" is "this version or a later one": the version named is enough.
    if (!allowedIds.has(e.id.replace(/\+$/, '').toLowerCase())) return false
    return !e.exception || allowedExceptions.has(e.exception.toLowerCase())
  }
  return ok(parseLicence(expression))
}

// ---------------------------------------------------------------------------------------------------------------------
// Licence texts

/** A licence file by name: LICENSE, LICENCE, COPYING, NOTICE, UNLICENSE, COPYRIGHT, PATENTS, with any suffix. */
const LICENCE_FILE = /^(?:licen[cs]e|copying|notice|unlicen[cs]e|copyright|patents)(?:[-._ ].*)?$/i
/** Files whose name looks like a licence's but that hold code or markup (a `license.js`, a `LICENSE.html` page). */
const NOT_A_TEXT = /\.(?:[cm]?[jt]sx?|json|map|rs|go|py|html?|css|ya?ml|toml)$/i
const TEXT_LIMIT = 1024 * 1024

function readText(file: string): string | null {
  const st = statSync(file, { throwIfNoEntry: false })
  if (!st?.isFile() || st.size === 0 || st.size > TEXT_LIMIT) return null
  const text = readFileSync(file, 'utf8')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim()
  return text ? text : null
}

/** The licence texts in a package's folder: its licence files, and the files of a LICENSES/ folder if it keeps one. */
export function licenceTexts(dir: string, extra: string[] = []): LicenceText[] {
  const out: LicenceText[] = []
  const add = (rel: string) => {
    if (out.some((t) => t.file === rel)) return
    const text = readText(join(dir, rel))
    if (text) out.push({ file: rel, text })
  }
  let entries: import('node:fs').Dirent[] = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isFile() && LICENCE_FILE.test(e.name) && !NOT_A_TEXT.test(e.name)) add(e.name)
    else if (e.isDirectory() && /^licen[cs]es$/i.test(e.name))
      for (const f of readdirSync(join(dir, e.name)).sort())
        if (!NOT_A_TEXT.test(f)) add(`${e.name}/${f}`)
  }
  for (const rel of extra) add(slashes(rel))
  return out
}

const words = (text: string) =>
  ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `

/** What each licence's text says that no other one on the list does; the first that matches names it. */
const FINGERPRINTS: Array<[id: string, all: string[], none?: string[]]> = [
  ['Apache-2.0', ['apache license version 2 0']],
  ['MPL-2.0', ['mozilla public license version 2 0']],
  ['BSL-1.0', ['boost software license version 1 0']],
  ['CC0-1.0', ['cc0 1 0 universal']],
  ['OFL-1.1', ['sil open font license']],
  ['BlueOak-1.0.0', ['blue oak model license']],
  ['Unicode-3.0', ['unicode license v3']],
  ['Unlicense', ['this is free and unencumbered software released into the public domain']],
  [
    'MIT',
    [
      'permission is hereby granted free of charge to any person obtaining a copy',
      'the above copyright notice and this permission notice shall be included in all copies or substantial portions',
    ],
  ],
  ['MIT-0', ['permission is hereby granted free of charge to any person obtaining a copy']],
  [
    'ISC',
    [
      'permission to use copy modify and or distribute this software for any purpose with or without fee is hereby granted',
      'provided that the above copyright notice and this permission notice appear in all copies',
    ],
  ],
  [
    '0BSD',
    [
      'permission to use copy modify and or distribute this software for any purpose with or without fee is hereby granted',
    ],
  ],
  [
    'BSD-3-Clause',
    [
      'redistribution and use in source and binary forms with or without modification are permitted',
      'used to endorse or promote products derived from this software',
    ],
  ],
  [
    'BSD-2-Clause',
    [
      'redistribution and use in source and binary forms with or without modification are permitted',
    ],
  ],
  ['Zlib', ['altered source versions must be plainly marked as such']],
]

/** The SPDX name of the licence `text` is, or null when it is none this script knows (a NOTICE, a PATENTS grant). */
export function identifyLicence(text: string): string | null {
  const w = words(text)
  for (const [id, all, none = []] of FINGERPRINTS)
    if (all.every((p) => w.includes(` ${p} `)) && !none.some((p) => w.includes(` ${p} `))) return id
  return null
}

/** The licence a package's texts state, when its metadata states none: each text it names, all of them together. */
function licenceFromTexts(texts: LicenceText[]): { license: string; from: string } | null {
  const found = texts.flatMap((t) => {
    const id = identifyLicence(t.text)
    return id ? [{ id, file: t.file }] : []
  })
  const ids = [...new Set(found.map((f) => f.id))]
  if (!ids.length) return null
  return {
    license: ids.join(' AND '),
    from: `identified from ${[...new Set(found.map((f) => f.file))].join(', ')}`,
  }
}

function withLicence(
  pkg: Omit<ThirdPartyPackage, 'license' | 'licenseFrom'>,
  declared: string | null,
  declaredFrom: string,
): ThirdPartyPackage {
  if (declared) return { ...pkg, license: declared, licenseFrom: declaredFrom }
  const found = licenceFromTexts(pkg.texts)
  return { ...pkg, license: found?.license ?? null, licenseFrom: found?.from ?? 'nowhere' }
}

// ---------------------------------------------------------------------------------------------------------------------
// npm

type PackageJson = {
  name?: string
  version?: string
  license?: unknown
  licenses?: unknown
  repository?: unknown
}

/** package.json's licence: `license` as SPDX, or the old `{ type }` object and `licenses` list (any one of them). */
export function declaredNpmLicence(pkg: PackageJson): string | null {
  const read = (l: unknown): string | null =>
    typeof l === 'string'
      ? l.trim() || null
      : l && typeof l === 'object' && typeof (l as { type?: unknown }).type === 'string'
        ? (l as { type: string }).type.trim() || null
        : null
  const one = read(pkg.license)
  if (one) return one
  if (!Array.isArray(pkg.licenses)) return read(pkg.licenses)
  const ids = pkg.licenses.map(read).filter((id): id is string => !!id)
  if (ids.length <= 1) return ids[0] ?? null
  return `(${ids.join(' OR ')})`
}

/** A repository field as an https address, or undefined when it is not one. */
export function repositoryUrl(repo: unknown): string | undefined {
  const raw =
    typeof repo === 'string'
      ? repo
      : repo && typeof repo === 'object'
        ? (repo as { url?: unknown }).url
        : undefined
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  let url = raw
    .trim()
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git@([^:/]+):/, 'https://$1/')
    .replace(/\.git$/, '')
  if (url.startsWith('github:')) url = `https://github.com/${url.slice('github:'.length)}`
  else if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`
  return /^https?:\/\/[^\s]+$/.test(url) ? url : undefined
}

/** The package in folder `dir`, as it ships in `shippedIn`. */
export function npmPackage(dir: string, shippedIn: string[]): ThirdPartyPackage {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson
  if (!pkg.name || !pkg.version) throw new Error(`${dir}/package.json names no package and version`)
  return withLicence(
    {
      ecosystem: 'npm',
      name: pkg.name,
      version: pkg.version,
      source: repositoryUrl(pkg.repository),
      texts: licenceTexts(dir),
      shippedIn,
      dir,
    },
    declaredNpmLicence(pkg),
    'package.json',
  )
}

/** Every package installed in a node_modules folder, nested ones included; links (a workspace's own) are not. */
export function npmTree(nodeModules: string, shippedIn: string[]): ThirdPartyPackage[] {
  const out: ThirdPartyPackage[] = []
  const visit = (dir: string) => {
    if (!existsSync(join(dir, 'package.json'))) return
    out.push(npmPackage(dir, shippedIn))
    if (existsSync(join(dir, 'node_modules'))) walk(join(dir, 'node_modules'))
  }
  // By name, so the list and its problems come out in the same order on every filesystem (ext4 lists a folder in
  // hash order, NTFS by name).
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
  const walk = (folder: string) => {
    for (const e of readdirSync(folder, { withFileTypes: true }).sort(byName)) {
      if (e.name.startsWith('.') || !e.isDirectory()) continue
      const path = join(folder, e.name)
      if (!e.name.startsWith('@')) visit(path)
      else
        for (const s of readdirSync(path, { withFileTypes: true }).sort(byName))
          if (s.isDirectory()) visit(join(path, s.name))
    }
  }
  walk(nodeModules)
  return out
}

/**
 * The package folder a file belongs to (the path up to node_modules/<name> or node_modules/@scope/<name>), or null.
 * The same rule as desk2/scripts/third-party-modules.ts, which a vite config loads and so cannot import this file.
 */
export function packageDirOf(file: string): string | null {
  let path = slashes(file)
    .replace(/^\0/, '')
    .replace(/[?#].*$/, '')
  // A metafile's paths are relative to where the build ran: "node_modules/hono/dist/index.js".
  if (path.startsWith('node_modules/')) path = `./${path}`
  const at = path.lastIndexOf('/node_modules/')
  if (at < 0) return null
  const rest = path.slice(at + '/node_modules/'.length).split('/')
  const depth = rest[0]?.startsWith('@') ? 2 : 1
  if (rest.length <= depth || !rest[0] || rest[0].startsWith('.')) return null
  return `${path.slice(0, at)}/node_modules/${rest.slice(0, depth).join('/')}`
}

/** What `bun build --metafile` writes, as far as this needs: every input, by path relative to where the build ran. */
export interface Metafile {
  inputs: Record<string, unknown>
}

/** Every npm package a bun build inlined, from its metafile; `root` is the folder the build ran in. */
export function npmFromMetafile(
  meta: Metafile,
  root: string,
  shippedIn: string[],
): ThirdPartyPackage[] {
  const dirs = new Set<string>()
  for (const input of Object.keys(meta.inputs)) {
    const dir = packageDirOf(input)
    if (dir) dirs.add(resolve(root, dir))
  }
  return [...dirs].sort().map((dir) => npmPackage(dir, shippedIn))
}

/** The list desk2/scripts/third-party-modules.ts writes into a vite build's output. */
export const BUILT_LIST = '.vite/third-party.json'

/** Every npm package a vite build put into its dist, from that list; `appRoot` is the app's folder (desk2/web). */
export function npmFromBuilt(
  listFile: string,
  appRoot: string,
  shippedIn: string[],
): ThirdPartyPackage[] {
  const list = JSON.parse(readFileSync(listFile, 'utf8')) as {
    packages?: Array<{ name: string; version: string; dir: string }>
  }
  if (!Array.isArray(list.packages)) throw new Error(`${listFile} holds no package list`)
  return list.packages.map((p) => {
    const pkg = npmPackage(resolve(appRoot, p.dir), shippedIn)
    if (pkg.name !== p.name || pkg.version !== p.version)
      throw new Error(
        `${listFile} lists ${p.name}@${p.version} in ${p.dir}, which now holds ${pkg.name}@${pkg.version}: rebuild`,
      )
    return pkg
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// Go and Rust

function tool(cmd: string, args: string[], cwd: string, env?: Record<string, string>): string {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 512 * 1024 * 1024,
  })
  if (r.error) throw new Error(`${cmd} did not run (${r.error.message}): is it installed?`)
  if (r.status !== 0)
    throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd}:\n${(r.stderr ?? '').trim()}`)
  return r.stdout
}

const GO_LIST =
  '{{with .Module}}{{if not .Main}}{{.Path}}\t{{.Version}}\t{{with .Replace}}{{.Dir}}{{else}}{{.Dir}}{{end}}{{end}}{{end}}'

/** Every module a Go program links for one platform, and the Go distribution itself (its runtime is in every binary). */
export function goModules(
  dir: string,
  shippedIn: string[],
  platform: { goos?: string; goarch?: string } = {},
): ThirdPartyPackage[] {
  const env: Record<string, string> = { GOFLAGS: '-mod=readonly' }
  if (platform.goos) env.GOOS = platform.goos
  if (platform.goarch) env.GOARCH = platform.goarch
  const lines = new Set(
    tool('go', ['list', '-deps', '-f', GO_LIST, './...'], dir, env)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  )
  const out: ThirdPartyPackage[] = []
  for (const line of [...lines].sort()) {
    const [path, version, moduleDir] = line.split('\t')
    if (!path || !moduleDir) throw new Error(`go list printed "${line}"`)
    out.push(
      withLicence(
        {
          ecosystem: 'go',
          name: path,
          version: version || '(replaced)',
          source: `https://pkg.go.dev/${path}`,
          texts: licenceTexts(moduleDir),
          shippedIn,
          dir: moduleDir,
        },
        null,
        '',
      ),
    )
  }
  const [goroot = '', goversion = ''] = tool('go', ['env', 'GOROOT', 'GOVERSION'], dir, env)
    .trim()
    .split('\n')
  out.push(
    withLicence(
      {
        ecosystem: 'toolchain',
        name: 'Go',
        version: goversion.replace(/^go/, ''),
        source: 'https://go.dev',
        texts: licenceTexts(goroot.trim()),
        shippedIn,
        dir: goroot.trim(),
      },
      null,
      '',
    ),
  )
  return out
}

type CargoPackage = {
  id: string
  name: string
  version: string
  source: string | null
  license: string | null
  license_file: string | null
  repository: string | null
  manifest_path: string
}
type CargoMetadata = {
  packages: CargoPackage[]
  workspace_members: string[]
  resolve: {
    root: string | null
    nodes: Array<{
      id: string
      deps: Array<{ pkg: string; dep_kinds: Array<{ kind: string | null }> }>
    }>
  } | null
}

/** The crates a crate links for `target`: its normal dependencies, and theirs, never a build or dev one. */
export function linkedCrates(meta: CargoMetadata): CargoPackage[] {
  if (!meta.resolve) throw new Error('cargo metadata resolved no dependencies')
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]))
  const seen = new Set<string>()
  const stack = meta.resolve.root ? [meta.resolve.root] : [...meta.workspace_members]
  while (stack.length) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    for (const dep of nodes.get(id)?.deps ?? [])
      if (dep.dep_kinds.some((k) => k.kind === null)) stack.push(dep.pkg)
  }
  return meta.packages
    .filter((p) => seen.has(p.id) && p.source !== null)
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

/** The Rust standard library's notices as text, from the toolchain's COPYRIGHT-library.html (or an older COPYRIGHT). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(
      /<br\s*\/?>|<\/(?:p|h[1-6]|li|div|pre|tr|dt|dd|ul|ol|section|summary|details)>/gi,
      '\n',
    )
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function rustStandardLibrary(dir: string, shippedIn: string[]): ThirdPartyPackage {
  const sysroot = tool('rustc', ['--print', 'sysroot'], dir).trim()
  const version = tool('rustc', ['--version'], dir).trim().split(/\s+/)[1] ?? 'unknown'
  const docs = join(sysroot, 'share', 'doc', 'rust')
  const texts: LicenceText[] = []
  const html = join(docs, 'COPYRIGHT-library.html')
  if (existsSync(html))
    texts.push({ file: 'COPYRIGHT-library.html', text: htmlToText(readFileSync(html, 'utf8')) })
  for (const t of licenceTexts(docs)) if (t.file !== 'COPYRIGHT.html') texts.push(t)
  for (const name of ['MIT.txt', 'Apache-2.0.txt']) {
    const text = readText(join(docs, 'licenses', name))
    if (text && !texts.some((t) => t.text === text)) texts.push({ file: `licenses/${name}`, text })
  }
  return {
    ecosystem: 'toolchain',
    name: 'Rust standard library',
    version,
    license: '(Apache-2.0 OR MIT) AND Unicode-3.0',
    licenseFrom: 'the toolchain notices (COPYRIGHT-library.html), which list the exceptions',
    source: 'https://www.rust-lang.org',
    texts,
    shippedIn,
    dir: docs,
  }
}

/** The host's target triple, as rustc reports it. */
function hostTriple(dir: string): string {
  const host = tool('rustc', ['-vV'], dir).match(/^host:\s*(\S+)/m)?.[1]
  if (!host) throw new Error('rustc -vV names no host')
  return host
}

/** Every crate a Rust program links for `target` (default: this machine), and the Rust standard library. */
export function cargoCrates(
  dir: string,
  shippedIn: string[],
  target?: string,
): ThirdPartyPackage[] {
  const triple = target ?? hostTriple(dir)
  const meta = JSON.parse(
    tool(
      'cargo',
      [
        'metadata',
        '--format-version',
        '1',
        '--locked',
        '--filter-platform',
        triple,
        '--manifest-path',
        join(dir, 'Cargo.toml'),
      ],
      dir,
    ),
  ) as CargoMetadata
  const crates = linkedCrates(meta).map((c) => {
    const crateDir = dirname(c.manifest_path)
    return withLicence(
      {
        ecosystem: 'cargo',
        name: c.name,
        version: c.version,
        source: c.repository ?? `https://crates.io/crates/${c.name}`,
        texts: licenceTexts(crateDir, c.license_file ? [c.license_file] : []),
        shippedIn,
        dir: crateDir,
      },
      c.license,
      'Cargo.toml',
    )
  })
  return [...crates, rustStandardLibrary(dir, shippedIn)]
}

// ---------------------------------------------------------------------------------------------------------------------
// Merging, settling, checking

/** One entry per package and version, with every place it ships. */
export function mergePackages(lists: ThirdPartyPackage[][]): ThirdPartyPackage[] {
  const out = new Map<string, ThirdPartyPackage>()
  for (const p of lists.flat()) {
    const k = key(p)
    const had = out.get(k)
    if (!had) {
      out.set(k, { ...p, shippedIn: [...new Set(p.shippedIn)], texts: [...p.texts] })
      continue
    }
    had.shippedIn = [...new Set([...had.shippedIn, ...p.shippedIn])]
    if (!had.license && p.license) {
      had.license = p.license
      had.licenseFrom = p.licenseFrom
    }
    for (const t of p.texts) if (!had.texts.some((h) => h.text === t.text)) had.texts.push(t)
    had.source ??= p.source
  }
  const order: Ecosystem[] = ['npm', 'go', 'cargo', 'toolchain']
  return [...out.values()].sort(
    (a, b) =>
      order.indexOf(a.ecosystem) - order.indexOf(b.ecosystem) ||
      a.name.localeCompare(b.name) ||
      a.version.localeCompare(b.version),
  )
}

export interface Clarification {
  /** Why the package's own files do not settle it, and where the answer was checked. */
  why: string
  /** The licence its project states, when the package's metadata states none or a wrong one. */
  license?: string
  /** The licence text, fetched at build time and checked byte for byte. */
  text?: { file?: string; url: string; sha256: string }
}

/** scripts/third-party-licenses.json: clarifications by "<ecosystem>:<name>@<version>". */
export interface Clarifications {
  clarifications: Record<string, Clarification>
}

export const CLARIFICATIONS_FILE = join(import.meta.dir, 'third-party-licenses.json')

export function loadClarifications(file = CLARIFICATIONS_FILE): Clarifications {
  const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<Clarifications>
  if (!data.clarifications || typeof data.clarifications !== 'object')
    throw new Error(`${file} has no "clarifications" object`)
  for (const [k, c] of Object.entries(data.clarifications)) {
    if (!/^(?:npm|go|cargo|toolchain):.+@.+$/.test(k))
      throw new Error(`${file}: "${k}" is not <ecosystem>:<name>@<version>`)
    if (!c.why) throw new Error(`${file}: "${k}" says not why`)
    if (c.text && !/^https:\/\//.test(c.text.url))
      throw new Error(`${file}: "${k}" fetches its text from a non-https address`)
    if (c.text && !/^[0-9a-f]{64}$/.test(c.text.sha256))
      throw new Error(`${file}: "${k}" has no SHA-256 for its text`)
  }
  return data as Clarifications
}

async function fetchText(url: string, sha256: string, fetchImpl: typeof fetch): Promise<string> {
  let bytes: Uint8Array
  try {
    const res = await fetchImpl(url, { redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    bytes = new Uint8Array(await res.arrayBuffer())
  } catch (err) {
    throw new Error(`could not fetch ${url}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const got = createHash('sha256').update(bytes).digest('hex')
  if (got !== sha256)
    throw new Error(`${url} is not the text that was checked: SHA-256 ${got}, expected ${sha256}`)
  return new TextDecoder().decode(bytes).replace(/\r\n?/g, '\n').trim()
}

/**
 * Every reason the list cannot ship, one line per package; empty when it can. A package's licence text is one
 * identifyLicence() names, or one scripts/third-party-licenses.json supplied (`clarified`, by package key): a package
 * whose only files are a NOTICE or a PATENTS grant has none, whatever licence its metadata declares.
 */
export function licenceProblems(
  packages: ThirdPartyPackage[],
  clarified: ReadonlySet<string> = new Set(),
): string[] {
  const problems: string[] = []
  for (const p of packages) {
    const id = `${key(p)} (in ${p.shippedIn.join(', ')})`
    if (!p.license) problems.push(`${id} declares no licence`)
    else {
      let allowed = false
      try {
        allowed = licenceAllowed(p.license)
      } catch {
        problems.push(`${id}: "${p.license}" is not an SPDX licence expression`)
        continue
      }
      if (!allowed)
        problems.push(
          `${id} is under ${p.license}, which is not on the allowlist (${ALLOWED_LICENCES.join(', ')})`,
        )
    }
    if (!p.texts.length) problems.push(`${id} carries no licence text`)
    else if (!clarified.has(key(p)) && !p.texts.some((t) => identifyLicence(t.text)))
      problems.push(
        `${id} carries no licence text: it has only ${p.texts.map((t) => t.file).join(', ')}, which ` +
          `${p.texts.length === 1 ? 'states' : 'state'} no licence this script knows; ` +
          'scripts/third-party-licenses.json can supply the text its project publishes',
      )
  }
  return problems
}

/**
 * Applies scripts/third-party-licenses.json to the list (fetching each clarified text it needs) and checks the
 * result. The packages come back merged and sorted; `problems` is empty when the list may ship.
 */
export async function settleLicences(
  lists: ThirdPartyPackage[][],
  options: { clarifications?: Clarifications; fetch?: typeof fetch } = {},
): Promise<{ packages: ThirdPartyPackage[]; problems: string[] }> {
  const clarifications = (options.clarifications ?? loadClarifications()).clarifications
  const packages = mergePackages(lists)
  const problems: string[] = []
  const clarified = new Set<string>()
  for (const p of packages) {
    const c = clarifications[key(p)]
    if (!c) continue
    if (c.license) {
      p.license = c.license
      p.licenseFrom = `scripts/third-party-licenses.json: ${c.why}`
    }
    if (c.text)
      try {
        const text = await fetchText(c.text.url, c.text.sha256, options.fetch ?? fetch)
        if (!p.texts.some((t) => t.text === text))
          p.texts.push({ file: c.text.file ?? c.text.url, text })
        clarified.add(key(p))
      } catch (err) {
        problems.push(`${key(p)}: ${err instanceof Error ? err.message : String(err)}`)
      }
  }
  return { packages, problems: [...problems, ...licenceProblems(packages, clarified)] }
}

// ---------------------------------------------------------------------------------------------------------------------
// Writing

const RULE = '='.repeat(80)

/** The THIRD-PARTY-LICENSES text: an index, then each package with its licence texts (a repeated text once). */
export function renderThirdPartyLicenses(packages: ThirdPartyPackage[], title: string): string {
  const lines: string[] = [
    'THIRD-PARTY LICENSES',
    '',
    title,
    '',
    'The third-party packages whose code is part of this copy of AgentHydra, each with its licence and the licence',
    'text it ships with. AgentHydra itself is under the licence in LICENSE, and NOTICE says where it comes from;',
    'the code it adapts from other projects, with their notices, is described in THIRD-PARTY-NOTICES.md.',
    '',
    `${packages.length} packages:`,
    '',
  ]
  const nameWidth = Math.min(48, Math.max(...packages.map((p) => label(p).length), 10))
  for (const p of packages)
    lines.push(`  ${label(p).padEnd(nameWidth)}  ${(p.license ?? '?').padEnd(28)}  ${p.ecosystem}`)
  const printed = new Map<string, string>()
  for (const p of packages) {
    lines.push('', RULE, `${label(p)} (${p.ecosystem})`, `Licence: ${p.license ?? 'none stated'}`)
    if (p.source) lines.push(`Source: ${p.source}`)
    lines.push(`In: ${p.shippedIn.join(', ')}`)
    for (const t of p.texts) {
      const seen = printed.get(t.text)
      if (seen) {
        lines.push('', `--- ${t.file}: the same text as ${seen} above ---`)
        continue
      }
      printed.set(t.text, `${label(p)}'s ${t.file}`)
      lines.push('', `--- ${t.file} ---`, '', t.text)
    }
  }
  return `${lines.join('\n')}\n`
}

/** The list as --json writes it and --merge reads it: no local folders. */
export function packageList(packages: ThirdPartyPackage[]): string {
  return `${JSON.stringify({ packages: packages.map(({ dir: _dir, ...p }) => p) }, null, 2)}\n`
}

export function readPackageList(file: string): ThirdPartyPackage[] {
  const data = JSON.parse(readFileSync(file, 'utf8')) as { packages?: ThirdPartyPackage[] }
  if (!Array.isArray(data.packages)) throw new Error(`${file} holds no package list`)
  for (const p of data.packages)
    if (
      !p.ecosystem ||
      !p.name ||
      !p.version ||
      !Array.isArray(p.texts) ||
      !Array.isArray(p.shippedIn)
    )
      throw new Error(
        `${file} has an entry that is not a package: ${JSON.stringify(p).slice(0, 120)}`,
      )
  return data.packages
}

// ---------------------------------------------------------------------------------------------------------------------
// Command line

function splitSource(value: string): { path: string; shippedIn: string[] } {
  const eq = value.indexOf('=')
  const path = eq < 0 ? value : value.slice(0, eq)
  const where =
    eq < 0
      ? []
      : value
          .slice(eq + 1)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
  return { path, shippedIn: where.length ? where : [slashes(path)] }
}

async function main(argv: string[]): Promise<number> {
  const value = (name: string) => {
    const i = argv.lastIndexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const root = resolve(value('--root') ?? '.')
  const lists: ThirdPartyPackage[][] = []
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!
    const next = argv[i + 1]
    if (!flag.startsWith('--npm-') && !['--go', '--cargo', '--merge'].includes(flag)) continue
    if (!next) throw new Error(`${flag} needs a path`)
    const { path, shippedIn } = splitSource(next)
    const at = resolve(path)
    if (flag === '--npm-tree') lists.push(npmTree(at, shippedIn))
    else if (flag === '--npm-metafile')
      lists.push(npmFromMetafile(JSON.parse(readFileSync(at, 'utf8')) as Metafile, root, shippedIn))
    else if (flag === '--npm-built')
      lists.push(npmFromBuilt(at, dirname(dirname(dirname(at))), shippedIn))
    else if (flag === '--go')
      lists.push(goModules(at, shippedIn, { goos: value('--goos'), goarch: value('--goarch') }))
    else if (flag === '--cargo') lists.push(cargoCrates(at, shippedIn, value('--target')))
    else if (flag === '--merge') lists.push(readPackageList(at))
    else throw new Error(`unknown source ${flag}`)
    i++
  }
  if (!lists.length) {
    console.error(
      'usage: bun scripts/third-party-licenses.ts [--out <file>] [--json <file>] [--title <text>] ' +
        '(--npm-tree|--npm-metafile|--npm-built|--go|--cargo|--merge) <path>[=<where it ships>] ...',
    )
    return 2
  }
  const { packages, problems } = await settleLicences(lists)
  if (problems.length) {
    console.error(
      `third-party-licenses: ${problems.length} package(s) cannot ship:\n  ${problems.join('\n  ')}`,
    )
    return 1
  }
  const out = value('--out')
  const json = value('--json')
  if (out) writeFileSync(out, renderThirdPartyLicenses(packages, value('--title') ?? 'AgentHydra'))
  if (json) writeFileSync(json, packageList(packages))
  console.log(
    `third-party-licenses: ${packages.length} package(s)${out ? `, written to ${out}` : ''}${json ? `, listed in ${json}` : ''}`,
  )
  return 0
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (err) {
    console.error(`third-party-licenses: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
}
