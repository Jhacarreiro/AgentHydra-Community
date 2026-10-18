/**
 * The steps of scripts/package-release.ts that decide what a bundle holds, kept apart from its command line so
 * tests/package-release.test.ts can run them on a small tree.
 */
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'

/**
 * The files every bundle carries at its root: the licence, the notice of where this project comes from, the notices
 * for adapted code, the licence texts.
 */
export const LICENCE_FILES = ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md', 'LICENSES'] as const

/** Copies LICENSE, NOTICE, THIRD-PARTY-NOTICES.md and LICENSES/ from the checkout to the bundle's root. */
export function stageLicenceFiles(root: string, stage: string): void {
  for (const name of LICENCE_FILES) {
    const from = join(root, name)
    if (!existsSync(from))
      throw new Error(`${name} is missing from the checkout, and every bundle carries it`)
    cpSync(from, join(stage, name), { recursive: true })
  }
}

/** The alias Desk's server imports the daemon's own modules by (desk2/tsconfig.base.json). */
export const SERVER_ALIAS = '@agenthydra/server/'
/** Where a bundle keeps those modules, bundled, inside desk2/: the in-app update reconciles desk2/ as a whole. */
export const SERVER_MODULES_DIR = 'agenthydra-server'
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') out.push(...sourceFiles(p))
    } else if (/\.(?:[cm]?[jt]sx?)$/.test(e.name) && !/\.d\.[cm]?ts$/.test(e.name)) out.push(p)
  }
  return out
}

/** Every source file under `dir` (TypeScript and JavaScript, no declarations), sorted. */
export function sourceFilesUnder(dir: string): string[] {
  return sourceFiles(dir).sort()
}

/** The paths after SERVER_ALIAS that `files` import at run time (type-only imports are erased, so not counted). */
export function aliasedImports(files: string[]): string[] {
  const found = new Set<string>()
  for (const file of files) {
    const loader = file.endsWith('x') ? 'tsx' : file.endsWith('ts') ? 'ts' : 'js'
    const transpiler = new Bun.Transpiler({ loader })
    for (const imp of transpiler.scanImports(readFileSync(file, 'utf8')))
      if (imp.path.startsWith(SERVER_ALIAS)) found.add(imp.path.slice(SERVER_ALIAS.length))
  }
  return [...found].sort()
}

type BuildLog = { message?: string; position?: { file?: string; line?: number } | null }

function describeLogs(logs: BuildLog[], base: string): string[] {
  return logs.map((l) => {
    const file = l.position?.file ? relative(base, l.position.file).replaceAll('\\', '/') : ''
    return `${file}${l.position?.line ? `:${l.position.line}` : ''}: ${l.message ?? String(l)}`
  })
}

/** What `bun build --metafile` writes: the inputs are paths relative to the folder the build ran in. */
export interface Metafile {
  inputs: Record<string, unknown>
}

/**
 * Bundles the daemon modules Desk imports (`subpaths` under server/src) into <desk2>/agenthydra-server/, one file per
 * import, at the same path under it, with what they share in chunks beside them and their npm packages inlined.
 * Returns the build's metafile, its inputs relative to `root`, for the licence list.
 */
export async function bundleServerModules(
  root: string,
  desk2: string,
  subpaths: string[],
): Promise<Metafile> {
  const serverSrc = join(root, 'server', 'src')
  const entrypoints = subpaths.map((sub) => Bun.resolveSync(`./${sub}`, serverSrc))
  const outdir = join(desk2, SERVER_MODULES_DIR)
  rmSync(outdir, { recursive: true, force: true })
  const cwd = process.cwd()
  // The metafile's paths are relative to the working folder: the checkout's root, as for the daemon's build.
  process.chdir(root)
  try {
    const built = await Bun.build({
      entrypoints,
      root: serverSrc,
      outdir,
      target: 'bun',
      splitting: true,
      sourcemap: 'none',
      metafile: true,
      throw: false,
    })
    if (!built.success)
      throw new Error(
        `bundling the AgentHydra modules Desk imports failed:\n  ${describeLogs(built.logs, root).join('\n  ')}`,
      )
    for (const sub of subpaths) {
      const out = join(outdir, `${sub}.js`)
      if (!existsSync(out))
        throw new Error(`${SERVER_ALIAS}${sub} did not come out as ${relative(desk2, out)}`)
    }
    return (built as unknown as { metafile: Metafile }).metafile
  } finally {
    process.chdir(cwd)
  }
}

/** The line in desk2/tsconfig.base.json that maps the alias to the checkout's server/src. */
const ALIAS_IN_CHECKOUT = '"@agenthydra/server/*": ["../server/src/*"]'

/** Points the staged desk2/tsconfig.base.json's alias at agenthydra-server/. */
export function pointAliasAtBundle(tsconfigPath: string): void {
  const text = readFileSync(tsconfigPath, 'utf8')
  if (!text.includes(ALIAS_IN_CHECKOUT))
    throw new Error(`${tsconfigPath} does not map the alias as ${ALIAS_IN_CHECKOUT}`)
  writeFileSync(
    tsconfigPath,
    text.replace(ALIAS_IN_CHECKOUT, `"@agenthydra/server/*": ["./${SERVER_MODULES_DIR}/*"]`),
  )
}

// What a runtime never loads from node_modules: type declarations, source maps, human docs and the
// folders packages keep their own tests and samples in, at the package's root only (a dist/examples
// or lib/test deeper down can be code a package imports), and test files by name at any depth.
// License files stay.
const PRUNE_DIRS = new Set(['test', 'tests', '__tests__', 'docs', 'example', 'examples'])
const PRUNE_FILE =
  /(\.map|\.d\.[cm]?ts|\.(test|spec)\.[cm]?[jt]sx?)$|^(readme|changelog)(\.[^.]*)?\.md$/i

/** The package a release does not ship: Desk fetches it on first need (desk2/server/src/host/sdk-package.ts). */
export const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk'
/** desk2/<this> names the SDK version a bundle fetches and the checksum it must match. */
export const SDK_PIN_FILE = 'sdk-pin.json'
/** The SDK and its Claude Code platform packages (claude-agent-sdk-win32-x64 and the rest), inside @anthropic-ai/. */
const SDK_DIR = /^claude-agent-sdk(?:-.+)?$/

/** True when `name` inside `parent` is a package's root: node_modules/<pkg> or node_modules/@scope/<pkg>. */
function isPackageRoot(parent: string, name: string): boolean {
  const base = basename(parent)
  if (base === 'node_modules') return !name.startsWith('@') && !name.startsWith('.')
  return base.startsWith('@') && basename(dirname(parent)) === 'node_modules'
}

/**
 * Trims a production node_modules in place. The Agent SDK goes, with every Claude Code platform package: the SDK's
 * licence reserves all rights, so a bundle carries its pin and Desk downloads exactly that copy on first need, and
 * each platform package carries a 200 MB binary Desk resolves or downloads itself.
 */
export function pruneNodeModules(dir: string, packageRoot = false): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      const sdk = basename(dir) === '@anthropic-ai' && SDK_DIR.test(e.name)
      if ((packageRoot && PRUNE_DIRS.has(e.name)) || sdk) {
        rmSync(p, { recursive: true, force: true })
      } else {
        pruneNodeModules(p, isPackageRoot(dir, e.name))
      }
    } else if (PRUNE_FILE.test(e.name)) {
      rmSync(p, { force: true })
    }
  }
}

/** desk2/sdk-pin.json: exactly what Desk downloads, and what it needs to know before it has. */
export interface SdkPin {
  name: string
  version: string
  /** The npm tarball's checksum, as bun.lock records it (sha512-<base64>). */
  integrity: string
  /** The Claude Code release the SDK runs, from its package.json, when it says. */
  claudeCodeVersion?: string
  /** The SDK's platform packages and the versions it pins: which Claude Code binary Desk downloads. */
  optionalDependencies: Record<string, string>
}

/**
 * The pin for the SDK that `lock` (desk2/bun.lock's text) resolved. `installed` is the package.json the bundle's install
 * put in node_modules, which must be that same version.
 */
export function sdkPinFromLock(
  lock: string,
  installed: { version?: string; claudeCodeVersion?: string },
): SdkPin {
  const esc = SDK_PACKAGE.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  const line = lock.match(new RegExp(`^\\s*"${esc}": (\\[.*\\]),?\\s*$`, 'm'))?.[1]
  if (!line) throw new Error(`bun.lock has no entry for ${SDK_PACKAGE}`)
  let entry: unknown[]
  try {
    entry = JSON.parse(line) as unknown[]
  } catch {
    throw new Error(`bun.lock's entry for ${SDK_PACKAGE} is not one line of JSON`)
  }
  const [spec, , meta, integrity] = entry as [string, string, Record<string, unknown>, string]
  const version = spec?.startsWith(`${SDK_PACKAGE}@`) ? spec.slice(SDK_PACKAGE.length + 1) : ''
  if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version))
    throw new Error(`bun.lock's ${SDK_PACKAGE} version is "${version}"`)
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity))
    throw new Error(`bun.lock has no sha512 checksum for ${SDK_PACKAGE}@${version}`)
  if (installed.version !== version)
    throw new Error(
      `the bundle's install put ${SDK_PACKAGE}@${installed.version} in node_modules, not the ${version} bun.lock pins`,
    )
  return {
    name: SDK_PACKAGE,
    version,
    integrity,
    ...(installed.claudeCodeVersion ? { claudeCodeVersion: installed.claudeCodeVersion } : {}),
    optionalDependencies: (meta?.optionalDependencies ?? {}) as Record<string, string>,
  }
}

async function unresolvedHere(dir: string, external: string[]): Promise<string[]> {
  const built = await Bun.build({
    entrypoints: sourceFilesUnder(dir),
    target: 'bun',
    external,
    throw: false,
  })
  return built.success ? [] : describeLogs(built.logs, dir)
}

/**
 * Every import of every file under `dir` that does not resolve inside the staged tree, as "file:line: message";
 * empty when all of them do. `external` names packages the bundle fetches later instead of shipping. It runs in a
 * process of its own: Bun keeps each tsconfig it has read for the life of a process, so a check made here after
 * pointAliasAtBundle could still be resolving through the alias as it was.
 */
export function unresolvedImports(dir: string, external: string[] = []): string[] {
  const r = Bun.spawnSync(
    [
      process.execPath,
      import.meta.path,
      'unresolved',
      dir,
      ...external.flatMap((e) => ['--external', e]),
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  if (r.exitCode !== 0)
    throw new Error(`the import check failed to run: ${r.stderr.toString().trim()}`)
  return JSON.parse(r.stdout.toString()) as string[]
}

if (import.meta.main && process.argv[2] === 'unresolved' && process.argv[3]) {
  const args = process.argv.slice(4)
  const external = args.filter((_, i) => args[i - 1] === '--external')
  console.log(JSON.stringify(await unresolvedHere(process.argv[3], external)))
}
