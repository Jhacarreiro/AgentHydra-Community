// The npm packages a vite build put into its output, written into it as .vite/third-party.json, for the licence list a
// release carries (scripts/third-party-licenses.ts at the repository root reads it, and scripts/package-release.ts leaves
// the file out of the bundle). A package counts when one of its files is a module of an emitted chunk, the source of an
// emitted asset (a font), or a stylesheet the app's own CSS imports: Tailwind compiles `@import 'tailwindcss'` and the
// fonts' CSS itself, so those files never reach the build as modules.

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

export const THIRD_PARTY_FILE = '.vite/third-party.json'

export interface BuiltPackage {
  name: string
  version: string
  /** The package's folder, relative to the app's folder (desk2/web, desk2/hydra), with forward slashes. */
  dir: string
}

const slashes = (path: string) => path.replace(/\\/g, '/')

/** The package folder a file belongs to (the path up to node_modules/<name> or node_modules/@scope/<name>), or null. */
export function packageDirOf(file: string): string | null {
  const path = slashes(file).replace(/^\0/, '').replace(/[?#].*$/, '')
  const at = path.lastIndexOf('/node_modules/')
  if (at < 0) return null
  const rest = path.slice(at + '/node_modules/'.length).split('/')
  const depth = rest[0]?.startsWith('@') ? 2 : 1
  if (rest.length <= depth || !rest[0] || rest[0].startsWith('.')) return null
  return `${path.slice(0, at)}/node_modules/${rest.slice(0, depth).join('/')}`
}

/** Where `name` resolves from `from`, as node walks up node_modules folders: its real folder, or null. */
function findPackage(name: string, from: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    if (dirname(dir) === dir) return null
  }
}

const CSS_IMPORT = /@(?:import|plugin)\s+(?:url\(\s*)?(['"])([^'"]+)\1/g

/**
 * The packages a stylesheet of the app's own pulls in through `@import` and `@plugin`, following its relative imports.
 * Returns a file inside each package (its package.json), for packageDirOf.
 */
export function cssPackageFiles(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file) || !existsSync(file)) return []
  seen.add(file)
  const out: string[] = []
  const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of css.matchAll(CSS_IMPORT)) {
    const spec = m[2]!
    if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) continue
    if (spec.startsWith('.') || spec.startsWith('/')) {
      const next = resolve(dirname(file), spec)
      if (!slashes(next).includes('/node_modules/')) out.push(...cssPackageFiles(next, seen))
      continue
    }
    const parts = spec.split('/')
    const dir = findPackage(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!, dirname(file))
    if (dir) out.push(join(dir, 'package.json'))
  }
  return out
}

/** Every package `files` came from, once per name and version. */
export function builtPackages(files: Iterable<string>, root: string): BuiltPackage[] {
  const dirs = new Set<string>()
  for (const file of files) {
    const dir = packageDirOf(file)
    if (dir) dirs.add(dir)
  }
  const out = new Map<string, BuiltPackage>()
  for (const dir of dirs) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string }
    if (!pkg.name || !pkg.version) throw new Error(`${dir}/package.json names no package and version`)
    out.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, version: pkg.version, dir: slashes(relative(root, dir)) })
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

/**
 * The part of vite's plugin interface this uses, written out: the file is also loaded by Desk's server tests, whose
 * workspace has no vite to import the types from.
 */
type BuildOutput =
  | { type: 'asset'; originalFileNames?: readonly string[] }
  | { type: 'chunk'; moduleIds: readonly string[] }
interface ThirdPartyPlugin {
  name: string
  apply: 'build'
  configResolved(config: { root: string }): void
  generateBundle(
    this: { emitFile(file: { type: 'asset'; fileName: string; source: string }): string },
    options: unknown,
    bundle: Record<string, BuildOutput>,
  ): void
}

export function thirdPartyModules(): ThirdPartyPlugin {
  let root = process.cwd()
  return {
    name: 'agenthydra:third-party-modules',
    apply: 'build',
    configResolved(config) {
      root = config.root
    },
    generateBundle(_options, bundle) {
      const files = new Set<string>()
      const seen = new Set<string>()
      for (const out of Object.values(bundle)) {
        if (out.type === 'asset') {
          for (const name of out.originalFileNames ?? []) files.add(resolve(root, name))
          continue
        }
        for (const id of out.moduleIds) {
          files.add(id)
          const path = id.replace(/^\0/, '').replace(/[?#].*$/, '')
          if (path.endsWith('.css') && !slashes(path).includes('/node_modules/')) for (const f of cssPackageFiles(path, seen)) files.add(f)
        }
      }
      const packages = builtPackages(files, root)
      this.emitFile({ type: 'asset', fileName: THIRD_PARTY_FILE, source: `${JSON.stringify({ packages }, null, 2)}\n` })
    },
  }
}
