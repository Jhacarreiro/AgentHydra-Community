// tests/third-party-licenses.test.ts - scripts/third-party-licenses.ts, the THIRD-PARTY-LICENSES file of a release
// bundle, run on package trees made up here: every licence text is written by the test, every name is invented.
import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  type Clarifications,
  cargoCrates,
  goModules,
  identifyLicence,
  licenceAllowed,
  licenceProblems,
  licenceTexts,
  linkedCrates,
  loadClarifications,
  mergePackages,
  npmFromBuilt,
  npmFromMetafile,
  npmTree,
  packageDirOf,
  packageList,
  parseLicence,
  readPackageList,
  renderThirdPartyLicenses,
  settleLicences,
  type ThirdPartyPackage,
} from '../scripts/third-party-licenses'
import { findRepoRoot } from './repo-root'

const ROOT = findRepoRoot(import.meta.dir)
const SCRIPT = join(ROOT, 'scripts', 'third-party-licenses.ts')
const scratch = mkdtempSync(join(tmpdir(), 'third-party-licenses-test-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

// The command, cargo and go run as child processes: each well under a second here, and a cold CI runner has been seen
// ten times slower than a developer machine.
const SPAWN_TIMEOUT_MS = 30_000

let n = 0
function tree(files: Record<string, string>): string {
  const root = join(scratch, `t${n++}`)
  mkdirSync(root, { recursive: true })
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  return root
}

const MIT = (holder: string) =>
  [
    'MIT License',
    '',
    `Copyright (c) 2024 ${holder}`,
    '',
    'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated',
    'documentation files (the "Software"), to deal in the Software without restriction, including without limitation',
    'the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software.',
    '',
    'The above copyright notice and this permission notice shall be included in all copies or substantial portions',
    'of the Software.',
    '',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.',
  ].join('\n')
const ISC = `ISC License\n\nCopyright (c) 2024 Example Owner\n\nPermission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby\ngranted, provided that the above copyright notice and this permission notice appear in all copies.\n`
const BSD = (clauses: 2 | 3) =>
  [
    'Copyright (c) 2024 Example Owner',
    'Redistribution and use in source and binary forms, with or without modification, are permitted provided that',
    'the following conditions are met:',
    '1. Redistributions of source code must retain the above copyright notice.',
    '2. Redistributions in binary form must reproduce the above copyright notice.',
    ...(clauses === 3
      ? [
          '3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or',
          '   promote products derived from this software without specific prior written permission.',
        ]
      : []),
  ].join('\n')
const APACHE =
  '                                 Apache License\n                           Version 2.0, January 2004\n'

const pkgJson = (fields: Record<string, unknown>) => `${JSON.stringify(fields)}\n`

describe('licence expressions', () => {
  test('one allowed side of an OR is enough; every side of an AND must be allowed', () => {
    expect(licenceAllowed('MIT')).toBe(true)
    expect(licenceAllowed('mit')).toBe(true)
    expect(licenceAllowed('(MIT OR GPL-3.0-only)')).toBe(true)
    expect(licenceAllowed('MIT AND GPL-3.0-only')).toBe(false)
    expect(licenceAllowed('(Apache-2.0 OR MIT) AND Unicode-3.0')).toBe(true)
    expect(licenceAllowed('MIT/Apache-2.0')).toBe(true)
    expect(licenceAllowed('Apache-2.0+')).toBe(true)
    expect(licenceAllowed('Apache-2.0 WITH LLVM-exception')).toBe(true)
    expect(licenceAllowed('GPL-2.0-only WITH Classpath-exception-2.0')).toBe(false)
    expect(licenceAllowed('UNLICENSED')).toBe(false)
    expect(licenceAllowed('LicenseRef-Proprietary')).toBe(false)
  })

  test('what is not an expression is refused, not guessed at', () => {
    expect(() => parseLicence('SEE LICENSE IN README.md')).toThrow('is not a licence expression')
    expect(() => parseLicence('MIT OR')).toThrow()
    expect(() => parseLicence('(MIT')).toThrow('unclosed')
    expect(parseLicence('A OR B AND C')).toEqual({
      op: 'OR',
      left: { id: 'A' },
      right: { op: 'AND', left: { id: 'B' }, right: { id: 'C' } },
    })
  })

  test('a licence text is named by what it says', () => {
    expect(identifyLicence(MIT('Example Owner'))).toBe('MIT')
    expect(identifyLicence(ISC)).toBe('ISC')
    expect(identifyLicence(BSD(2))).toBe('BSD-2-Clause')
    expect(identifyLicence(BSD(3))).toBe('BSD-3-Clause')
    expect(identifyLicence(APACHE)).toBe('Apache-2.0')
    expect(
      identifyLicence('This is free and unencumbered software released into the public domain.\n'),
    ).toBe('Unlicense')
    expect(identifyLicence('Additional IP Rights Grant (Patents)\n')).toBeNull()
  })
})

describe('npm packages', () => {
  test('every installed package is listed with its licence files; links and dot folders are not', () => {
    const root = tree({
      'node_modules/alpha/package.json': pkgJson({
        name: 'alpha',
        version: '1.0.0',
        license: 'MIT',
        repository: 'git+https://example.com/alpha.git',
      }),
      'node_modules/alpha/LICENSE': MIT('Example Owner'),
      'node_modules/alpha/license.js': 'module.exports = 1\n',
      'node_modules/alpha/node_modules/gamma/package.json': pkgJson({
        name: 'gamma',
        version: '2.0.0',
        licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }],
      }),
      'node_modules/alpha/node_modules/gamma/LICENSES/MIT.txt': MIT('Example Owner'),
      'node_modules/@scope/beta/package.json': pkgJson({
        name: '@scope/beta',
        version: '0.1.0',
        license: { type: 'ISC' },
      }),
      'node_modules/@scope/beta/LICENCE.md': ISC,
      'node_modules/.bin/alpha': '#!/bin/sh\n',
      'workspace/package.json': pkgJson({ name: 'own-workspace', version: '0.0.0' }),
    })
    symlinkSync(join(root, 'workspace'), join(root, 'node_modules', 'own-workspace'), 'dir')
    const found = npmTree(join(root, 'node_modules'), ['desk2/node_modules'])
    expect(found.map((p) => `${p.name}@${p.version} ${p.license}`).sort()).toEqual([
      '@scope/beta@0.1.0 ISC',
      'alpha@1.0.0 MIT',
      'gamma@2.0.0 (MIT OR Apache-2.0)',
    ])
    const alpha = found.find((p) => p.name === 'alpha')!
    expect(alpha.texts.map((t) => t.file)).toEqual(['LICENSE'])
    expect(alpha.source).toBe('https://example.com/alpha')
    expect(found.find((p) => p.name === 'gamma')!.texts.map((t) => t.file)).toEqual([
      'LICENSES/MIT.txt',
    ])
  })

  test('a package whose metadata names no licence takes the one its licence file states', () => {
    const root = tree({
      'node_modules/quiet/package.json': pkgJson({ name: 'quiet', version: '1.2.3' }),
      'node_modules/quiet/COPYING': BSD(3),
    })
    const [quiet] = npmTree(join(root, 'node_modules'), ['app/server.js'])
    expect(quiet!.license).toBe('BSD-3-Clause')
    expect(quiet!.licenseFrom).toBe('identified from COPYING')
    expect(licenceProblems([quiet!])).toEqual([])
  })

  test('the packages a bun build inlined are read from its metafile', () => {
    const root = tree({
      'node_modules/.bun/hoisted@1.0.0/node_modules/hoisted/package.json': pkgJson({
        name: 'hoisted',
        version: '1.0.0',
        license: 'MIT',
      }),
      'node_modules/.bun/hoisted@1.0.0/node_modules/hoisted/LICENSE': MIT('Example Owner'),
      'node_modules/@scope/plain/package.json': pkgJson({
        name: '@scope/plain',
        version: '3.0.0',
        license: '0BSD',
      }),
      'node_modules/@scope/plain/LICENSE': 'Permission to use...\n',
    })
    expect(packageDirOf('node_modules/@scope/plain/lib/a.js')).toBe('./node_modules/@scope/plain')
    expect(packageDirOf('/x/node_modules/.bun/p@1/node_modules/p/i.js')).toBe(
      '/x/node_modules/.bun/p@1/node_modules/p',
    )
    expect(packageDirOf('server/src/main.ts')).toBeNull()
    const found = npmFromMetafile(
      {
        inputs: {
          'server/src/main.ts': {},
          'node_modules/.bun/hoisted@1.0.0/node_modules/hoisted/dist/index.js': {},
          'node_modules/.bun/hoisted@1.0.0/node_modules/hoisted/dist/other.js': {},
          'node_modules/@scope/plain/lib/a.js': {},
        },
      },
      root,
      ['app/server.js'],
    )
    expect(found.map((p) => p.name).sort()).toEqual(['@scope/plain', 'hoisted'])
  })

  test('a vite build list is read against the app folder, and a stale one is refused', () => {
    const root = tree({
      'web/node_modules/view/package.json': pkgJson({
        name: 'view',
        version: '4.0.0',
        license: 'MIT',
      }),
      'web/node_modules/view/LICENSE': MIT('Example Owner'),
      'web/dist/.vite/third-party.json': JSON.stringify({
        packages: [{ name: 'view', version: '4.0.0', dir: 'node_modules/view' }],
      }),
      'web/dist/.vite/stale.json': JSON.stringify({
        packages: [{ name: 'view', version: '3.9.0', dir: 'node_modules/view' }],
      }),
    })
    const web = join(root, 'web')
    expect(
      npmFromBuilt(join(web, 'dist/.vite/third-party.json'), web, ['desk2/web/dist']).map(
        (p) => p.name,
      ),
    ).toEqual(['view'])
    expect(() => npmFromBuilt(join(web, 'dist/.vite/stale.json'), web, ['x'])).toThrow('rebuild')
  })
})

const pkg = (over: Partial<ThirdPartyPackage>): ThirdPartyPackage => ({
  ecosystem: 'npm',
  name: 'example',
  version: '1.0.0',
  license: 'MIT',
  licenseFrom: 'package.json',
  texts: [{ file: 'LICENSE', text: MIT('Example Owner') }],
  shippedIn: ['desk2/node_modules'],
  ...over,
})

describe('what fails the build', () => {
  test('no licence, a licence off the allowlist, a name that is not SPDX, and no text', () => {
    const problems = licenceProblems([
      pkg({ name: 'fine' }),
      pkg({ name: 'nameless', license: null, licenseFrom: 'nowhere' }),
      pkg({ name: 'copyleft', license: 'GPL-3.0-only' }),
      pkg({ name: 'readme', license: 'SEE LICENSE IN README.md' }),
      pkg({ name: 'textless', texts: [] }),
    ])
    expect(problems).toEqual([
      'npm:nameless@1.0.0 (in desk2/node_modules) declares no licence',
      expect.stringContaining(
        'npm:copyleft@1.0.0 (in desk2/node_modules) is under GPL-3.0-only, which is not on the allowlist',
      ),
      'npm:readme@1.0.0 (in desk2/node_modules): "SEE LICENSE IN README.md" is not an SPDX licence expression',
      'npm:textless@1.0.0 (in desk2/node_modules) carries no licence text',
    ])
  })

  const text = 'MIT License\n\nCopyright (c) 2024 Example Owner\n'
  const sha256 = createHash('sha256').update(text).digest('hex')
  const clarified = (sha: string): Clarifications => ({
    clarifications: {
      'npm:textless@1.0.0': {
        why: 'its repository carries the licence its package.json names',
        text: {
          file: 'LICENSE (example repository)',
          url: 'https://example.test/LICENSE',
          sha256: sha,
        },
      },
      'npm:renamed@1.0.0': { why: 'its project states MIT', license: 'MIT' },
    },
  })
  const serve = (async (url: string | URL | Request) =>
    String(url) === 'https://example.test/LICENSE'
      ? new Response(text)
      : new Response('gone', { status: 404 })) as typeof fetch

  test('a clarified text is fetched, checked against its SHA-256 and shipped', async () => {
    const { packages, problems } = await settleLicences(
      [[pkg({ name: 'textless', texts: [] }), pkg({ name: 'renamed', license: 'Custom' })]],
      { clarifications: clarified(sha256), fetch: serve },
    )
    expect(problems).toEqual([])
    const textless = packages.find((p) => p.name === 'textless')!
    expect(textless.texts).toEqual([{ file: 'LICENSE (example repository)', text: text.trim() }])
    const renamed = packages.find((p) => p.name === 'renamed')!
    expect(renamed.license).toBe('MIT')
    expect(renamed.licenseFrom).toContain('its project states MIT')
  })

  test('a text that changed since it was checked fails the build', async () => {
    const { problems } = await settleLicences([[pkg({ name: 'textless', texts: [] })]], {
      clarifications: clarified('0'.repeat(64)),
      fetch: serve,
    })
    expect(problems.join('\n')).toContain('is not the text that was checked')
    expect(problems.join('\n')).toContain('carries no licence text')
  })

  test('offline, a clarified text cannot be fetched and the build says so', async () => {
    const offline = (async () => {
      throw new TypeError('Unable to connect')
    }) as unknown as typeof fetch
    const { problems } = await settleLicences([[pkg({ name: 'textless', texts: [] })]], {
      clarifications: clarified(sha256),
      fetch: offline,
    })
    expect(problems[0]).toBe(
      'npm:textless@1.0.0: could not fetch https://example.test/LICENSE: Unable to connect',
    )
  })

  test('a clarification is for one version only', async () => {
    const { problems } = await settleLicences(
      [[pkg({ name: 'textless', version: '1.0.1', texts: [] })]],
      {
        clarifications: clarified(sha256),
        fetch: serve,
      },
    )
    expect(problems).toEqual(['npm:textless@1.0.1 (in desk2/node_modules) carries no licence text'])
  })

  test('the clarifications file loads, and one that fetches over http or has no checksum is refused', () => {
    expect(Object.keys(loadClarifications().clarifications).length).toBeGreaterThan(0)
    const bad = (c: unknown) => {
      const dir = tree({ 'c.json': JSON.stringify({ clarifications: c }) })
      return () => loadClarifications(join(dir, 'c.json'))
    }
    expect(
      bad({
        'npm:x@1': { why: 'w', text: { url: 'http://example.test/L', sha256: 'a'.repeat(64) } },
      }),
    ).toThrow('non-https')
    expect(
      bad({ 'npm:x@1': { why: 'w', text: { url: 'https://example.test/L', sha256: '' } } }),
    ).toThrow('SHA-256')
    expect(bad({ 'x@1': { why: 'w' } })).toThrow('is not <ecosystem>')
  })
})

describe('the file', () => {
  test('one entry per package with every place it ships; a repeated text is printed once; no local folders', () => {
    const apache = { file: 'LICENSE', text: APACHE.trim() }
    const merged = mergePackages([
      [pkg({ name: 'one', license: 'Apache-2.0', texts: [apache], dir: '/home/example/one' })],
      [pkg({ name: 'one', license: 'Apache-2.0', texts: [apache], shippedIn: ['app/server.js'] })],
      [pkg({ name: 'two', license: 'Apache-2.0', texts: [apache] })],
    ])
    expect(merged.map((p) => `${p.name} ${p.shippedIn.join('+')}`)).toEqual([
      'one desk2/node_modules+app/server.js',
      'two desk2/node_modules',
    ])
    const text = renderThirdPartyLicenses(merged, 'AgentHydra 2026.10.0 for linux-x64')
    expect(text).toContain('AgentHydra 2026.10.0 for linux-x64')
    expect(text).toContain('2 packages:')
    expect(text.split('Apache License').length - 1).toBe(1)
    expect(text).toContain("--- LICENSE: the same text as one 1.0.0's LICENSE above ---")
    expect(text).not.toContain('/home/example')
    expect(packageList(merged)).not.toContain('/home/example')
  })

  test('a list written with --json merges back in', () => {
    const dir = tree({})
    const file = join(dir, 'natives.json')
    writeFileSync(
      file,
      packageList([pkg({ ecosystem: 'cargo', name: 'crate', shippedIn: ['misc/x.exe'] })]),
    )
    const back = readPackageList(file)
    expect(back[0]!.name).toBe('crate')
    expect(
      mergePackages([back, [pkg({ ecosystem: 'cargo', name: 'crate', shippedIn: ['y.exe'] })]])[0]!
        .shippedIn,
    ).toEqual(['misc/x.exe', 'y.exe'])
    writeFileSync(file, JSON.stringify({ packages: [{ name: 'half' }] }))
    expect(() => readPackageList(file)).toThrow('not a package')
  })

  test(
    'the command writes the file, and writes nothing when a package cannot ship',
    () => {
      const ok = tree({
        'node_modules/alpha/package.json': pkgJson({
          name: 'alpha',
          version: '1.0.0',
          license: 'MIT',
        }),
        'node_modules/alpha/LICENSE': MIT('Example Owner'),
      })
      const out = join(ok, 'THIRD-PARTY-LICENSES')
      const good = Bun.spawnSync([
        process.execPath,
        SCRIPT,
        '--npm-tree',
        `${join(ok, 'node_modules')}=desk2/node_modules`,
        '--out',
        out,
        '--title',
        'Example',
      ])
      expect(good.exitCode).toBe(0)
      expect(readFileSync(out, 'utf8')).toContain('alpha 1.0.0 (npm)')

      const bad = tree({
        'node_modules/closed/package.json': pkgJson({
          name: 'closed',
          version: '1.0.0',
          license: 'UNLICENSED',
        }),
        'node_modules/closed/LICENSE': 'All rights reserved.\n',
      })
      const refused = Bun.spawnSync([
        process.execPath,
        SCRIPT,
        '--npm-tree',
        join(bad, 'node_modules'),
        '--out',
        join(bad, 'OUT'),
      ])
      expect(refused.exitCode).toBe(1)
      expect(refused.stderr.toString()).toContain('npm:closed@1.0.0')
      expect(existsSync(join(bad, 'OUT'))).toBe(false)
    },
    SPAWN_TIMEOUT_MS,
  )
})

describe('Rust and Go programs', () => {
  test('only normal dependencies count: no build or dev ones, and no crate of the workspace itself', () => {
    const p = (id: string, source: string | null = 'registry+https://example.test') => ({
      id,
      name: id,
      version: '1.0.0',
      source,
      license: 'MIT',
      license_file: null,
      repository: null,
      manifest_path: `/crates/${id}/Cargo.toml`,
    })
    const dep = (pkg: string, ...kinds: Array<string | null>) => ({
      pkg,
      dep_kinds: kinds.map((kind) => ({ kind })),
    })
    const crates = linkedCrates({
      packages: [
        p('app', null),
        p('linked'),
        p('deep'),
        p('builder'),
        p('tester'),
        p('local', null),
      ],
      workspace_members: ['app'],
      resolve: {
        root: 'app',
        nodes: [
          {
            id: 'app',
            deps: [
              dep('linked', null),
              dep('builder', 'build'),
              dep('tester', 'dev'),
              dep('local', null),
            ],
          },
          { id: 'linked', deps: [dep('deep', null, 'build')] },
          { id: 'builder', deps: [] },
        ],
      },
    })
    expect(crates.map((c) => c.name)).toEqual(['deep', 'linked'])
  })

  test('a crate keeps the licence file its Cargo.toml names, whatever it is called', () => {
    const dir = tree({ 'TERMS.txt': MIT('Example Owner'), 'LICENSE-APACHE': APACHE })
    expect(licenceTexts(dir, ['TERMS.txt']).map((t) => t.file)).toEqual([
      'LICENSE-APACHE',
      'TERMS.txt',
    ])
  })

  test.skipIf(!Bun.which('cargo') || !Bun.which('rustc'))(
    "a crate with no dependencies still ships the Rust standard library's licences",
    () => {
      const found = cargoCrates(join(ROOT, 'misc/climayte-runner-native'), [
        'app/misc/climayte-runner.exe',
      ])
      expect(found.map((p) => p.name)).toEqual(['Rust standard library'])
      expect(found[0]!.texts.length).toBeGreaterThan(0)
      expect(licenceProblems(found)).toEqual([])
    },
    SPAWN_TIMEOUT_MS,
  )

  test.skipIf(!Bun.which('go'))(
    "a Go program ships Go's own licence",
    () => {
      const dir = tree({
        'go.mod': 'module example.test/tray\n\ngo 1.21\n',
        'main.go': 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("tray") }\n',
      })
      const found = goModules(dir, ['codex-hub-tray'], { goos: 'windows', goarch: 'amd64' })
      expect(found.map((p) => `${p.ecosystem} ${p.name} ${p.license}`)).toEqual([
        'toolchain Go BSD-3-Clause',
      ])
      expect(found[0]!.texts.map((t) => t.file)).toContain('LICENSE')
    },
    SPAWN_TIMEOUT_MS,
  )
})
