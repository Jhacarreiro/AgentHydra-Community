// tests/package-release.test.ts - the steps scripts/package-release.ts takes to decide what a release bundle holds
// (scripts/release-bundle.ts), run on small trees in a temp folder rather than on a real build.
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  aliasedImports,
  bundleServerModules,
  LICENCE_FILES,
  pointAliasAtBundle,
  pruneNodeModules,
  SDK_PACKAGE,
  SERVER_MODULES_DIR,
  sdkPinFromLock,
  sourceFilesUnder,
  stageLicenceFiles,
  unresolvedImports,
} from '../scripts/release-bundle'
import { findRepoRoot } from './repo-root'

const scratch = mkdtempSync(join(tmpdir(), 'package-release-test-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

let n = 0
function tree(files: Record<string, string>): string {
  const root = join(scratch, `t${n++}`)
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  return root
}

/** A checkout in miniature: the daemon's server/src, and a desk2/ whose server imports two of its modules. */
const CHECKOUT = {
  'server/src/greet.ts': `import { name } from './name'\nexport const greet = () => \`hello \${name()}\`\n`,
  'server/src/name.ts': `import { readFileSync } from 'node:fs'\nexport const name = () => typeof readFileSync === 'function' ? 'desk' : '?'\n`,
  'server/src/kinds/types.ts': 'export type Kind = string\n',
  'desk2/tsconfig.base.json': `{\n  "compilerOptions": {\n    // the alias\n    "paths": { "@shared/*": ["./shared/*"], "@agenthydra/server/*": ["../server/src/*"] }\n  }\n}\n`,
  'desk2/server/tsconfig.json': '{ "extends": "../tsconfig.base.json" }\n',
  'desk2/server/src/main.ts': [
    "import type { Kind } from '@agenthydra/server/kinds/types'",
    "import { greet } from '@agenthydra/server/greet'",
    'const kind: Kind = greet()',
    'console.log(kind)',
    "export const later = () => import('@agenthydra/server/name')",
    '',
  ].join('\n'),
}

describe('the daemon modules Desk imports', () => {
  test('only run-time imports of the alias are counted, dynamic ones included', () => {
    const root = tree(CHECKOUT)
    expect(aliasedImports(sourceFilesUnder(join(root, 'desk2/server/src')))).toEqual([
      'greet',
      'name',
    ])
  })

  test('a staged desk2 without them is caught before it ships', async () => {
    const root = tree(CHECKOUT)
    // A bundle: desk2/ alone, no server/src beside it.
    const stage = tree(
      Object.fromEntries(Object.entries(CHECKOUT).filter(([rel]) => rel.startsWith('desk2/'))),
    )
    const missing = unresolvedImports(join(stage, 'desk2/server/src'))
    expect(missing.join('\n')).toContain('@agenthydra/server/greet')

    const subpaths = aliasedImports(sourceFilesUnder(join(stage, 'desk2/server/src')))
    const meta = await bundleServerModules(root, join(stage, 'desk2'), subpaths)
    pointAliasAtBundle(join(stage, 'desk2/tsconfig.base.json'))
    expect(Object.keys(meta.inputs).sort()).toEqual(['server/src/greet.ts', 'server/src/name.ts'])
    expect(readFileSync(join(stage, 'desk2/tsconfig.base.json'), 'utf8')).toContain(
      `"@agenthydra/server/*": ["./${SERVER_MODULES_DIR}/*"]`,
    )
    expect(unresolvedImports(join(stage, 'desk2/server/src'))).toEqual([])

    const run = Bun.spawnSync([process.execPath, join(stage, 'desk2/server/src/main.ts')], {
      cwd: scratch,
    })
    expect(run.stdout.toString().trim()).toBe('hello desk')
  })

  test('a tsconfig that maps the alias some other way is refused, not rewritten', () => {
    const root = tree({
      'desk2/tsconfig.base.json':
        '{ "compilerOptions": { "paths": { "@agenthydra/server/*": ["../x/*"] } } }',
    })
    expect(() => pointAliasAtBundle(join(root, 'desk2/tsconfig.base.json'))).toThrow(
      'does not map the alias',
    )
  })

  test('a module that fails to bundle fails the step and names the file', async () => {
    const root = tree({
      'server/src/broken.ts': "import { nope } from './missing'\nexport { nope }\n",
    })
    const stage = tree({ 'desk2/x': '' })
    await expect(bundleServerModules(root, join(stage, 'desk2'), ['broken'])).rejects.toThrow(
      'server/src/broken.ts',
    )
  })
})

describe('the licence files', () => {
  test('every bundle gets LICENSE, THIRD-PARTY-NOTICES.md and LICENSES/ from the checkout', () => {
    const root = findRepoRoot(import.meta.dir)
    const stage = tree({ 'app/server.js': '' })
    stageLicenceFiles(root, stage)
    for (const name of LICENCE_FILES) expect(existsSync(join(stage, name))).toBe(true)
    expect(readFileSync(join(stage, 'LICENSE'), 'utf8')).toBe(
      readFileSync(join(root, 'LICENSE'), 'utf8'),
    )
    expect(existsSync(join(stage, 'LICENSES/Apache-2.0.txt'))).toBe(true)
  })

  test('a checkout without one of them cannot be packaged', () => {
    const root = tree({ LICENSE: 'MIT', 'LICENSES/x.txt': 'x' })
    expect(() => stageLicenceFiles(root, tree({ x: '' }))).toThrow(
      'THIRD-PARTY-NOTICES.md is missing',
    )
  })
})

describe('the Agent SDK', () => {
  test('pruning drops the SDK and its platform packages, and what no runtime loads; licences stay', () => {
    const root = tree({
      'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs': '',
      'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude': '',
      'node_modules/@anthropic-ai/sdk/index.js': '',
      'node_modules/@anthropic-ai/sdk/LICENSE': 'MIT',
      'node_modules/@example/claude-agent-sdk-tools/index.js': '',
      'node_modules/zod/index.d.ts': '',
      'node_modules/zod/index.js': '',
      'node_modules/zod/README.md': '',
      'node_modules/zod/tests/a.js': '',
      'node_modules/zod/lib/tests/kept.js': '',
    })
    pruneNodeModules(join(root, 'node_modules'))
    const left = (rel: string) => existsSync(join(root, 'node_modules', rel))
    expect(left('@anthropic-ai/claude-agent-sdk')).toBe(false)
    expect(left('@anthropic-ai/claude-agent-sdk-linux-x64')).toBe(false)
    expect(left('@anthropic-ai/sdk/index.js')).toBe(true)
    expect(left('@anthropic-ai/sdk/LICENSE')).toBe(true)
    expect(left('@example/claude-agent-sdk-tools/index.js')).toBe(true)
    expect(left('zod/index.js')).toBe(true)
    expect(left('zod/index.d.ts') || left('zod/README.md') || left('zod/tests')).toBe(false)
    expect(left('zod/lib/tests/kept.js')).toBe(true)
  })

  const integrity = `sha512-${'A'.repeat(86)}==`
  const lock = [
    '{',
    '  "workspaces": { "server": { "dependencies": { "@anthropic-ai/claude-agent-sdk": "1.2.3" } } },',
    '  "packages": {',
    `    "${SDK_PACKAGE}": ["${SDK_PACKAGE}@1.2.3", "", { "optionalDependencies": { "${SDK_PACKAGE}-linux-x64": "1.2.3" }, "peerDependencies": { "zod": "^4.0.0" } }, "${integrity}"],`,
    '  }',
    '}',
  ].join('\n')

  test('the pin is the version and sha512 bun.lock resolved, with what Desk needs before it has the SDK', () => {
    expect(sdkPinFromLock(lock, { version: '1.2.3', claudeCodeVersion: '9.0.0' })).toEqual({
      name: SDK_PACKAGE,
      version: '1.2.3',
      integrity,
      claudeCodeVersion: '9.0.0',
      optionalDependencies: { [`${SDK_PACKAGE}-linux-x64`]: '1.2.3' },
    })
  })

  test('an install that is not the locked version, or a lock without a checksum, gives no pin', () => {
    expect(() => sdkPinFromLock(lock, { version: '1.2.4' })).toThrow('not the 1.2.3 bun.lock pins')
    expect(() => sdkPinFromLock(lock.replace(integrity, 'sha1-abc'), { version: '1.2.3' })).toThrow(
      'no sha512 checksum',
    )
    expect(() => sdkPinFromLock('{}', { version: '1.2.3' })).toThrow('no entry')
  })

  test("the real desk2/bun.lock pins the SDK Desk's server depends on", () => {
    const root = findRepoRoot(import.meta.dir)
    const server = JSON.parse(readFileSync(join(root, 'desk2/server/package.json'), 'utf8'))
    const version = server.dependencies[SDK_PACKAGE]
    const pin = sdkPinFromLock(readFileSync(join(root, 'desk2/bun.lock'), 'utf8'), { version })
    expect(pin.version).toBe(version)
    expect(Object.keys(pin.optionalDependencies).length).toBeGreaterThan(0)
  })
})
