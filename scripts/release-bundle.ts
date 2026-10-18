/**
 * The steps of scripts/package-release.ts that decide what a bundle holds, kept apart from its command line so
 * tests/package-release.test.ts can run them on a small tree.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

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
