import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { builtPackages, cssPackageFiles, packageDirOf } from '../../scripts/third-party-modules'

const temps: string[] = []

afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'desk-third-party-'))
  temps.push(root)
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  return root
}

const pkg = (name: string, version: string) => JSON.stringify({ name, version, license: 'MIT' })

test('a module id names the package folder it came from, scoped or not, through the store bun installs into', () => {
  expect(packageDirOf('/app/node_modules/vue/dist/vue.runtime.js')).toBe('/app/node_modules/vue')
  expect(packageDirOf('\0/app/node_modules/@scope/kit/index.js?commonjs-proxy')).toBe('/app/node_modules/@scope/kit')
  expect(packageDirOf('/app/node_modules/.bun/vue@3.5.0/node_modules/vue/index.js')).toBe(
    '/app/node_modules/.bun/vue@3.5.0/node_modules/vue',
  )
  expect(packageDirOf('C:\\app\\node_modules\\vue\\index.js')).toBe('C:/app/node_modules/vue')
  expect(packageDirOf('/app/src/main.ts')).toBeNull()
  expect(packageDirOf('/app/node_modules/.vite/deps/chunk.js')).toBeNull()
})

test("the packages an app's own stylesheet imports are found, through its relative imports, comments skipped", () => {
  const root = tree({
    'node_modules/tailwindcss/package.json': pkg('tailwindcss', '4.0.0'),
    'node_modules/tailwindcss/index.css': '',
    'node_modules/@fontsource-variable/inter/package.json': pkg('@fontsource-variable/inter', '5.0.0'),
    'node_modules/typography/package.json': pkg('typography', '1.0.0'),
    'node_modules/unused/package.json': pkg('unused', '1.0.0'),
    'src/style.css': "@import 'tailwindcss';\n@import './fonts.css';\n/* @import 'unused'; */\n@plugin \"typography\";\n",
    'src/fonts.css': "@import url('@fontsource-variable/inter/index.css');\n@import url('https://example.test/x.css');\n",
  })
  const files = cssPackageFiles(join(root, 'src/style.css'))
  expect(builtPackages(files, root).map((p) => `${p.name}@${p.version} ${p.dir}`)).toEqual([
    '@fontsource-variable/inter@5.0.0 node_modules/@fontsource-variable/inter',
    'tailwindcss@4.0.0 node_modules/tailwindcss',
    'typography@1.0.0 node_modules/typography',
  ])
})

test('each package is listed once per version, folder relative to the app', () => {
  const root = tree({
    'node_modules/vue/package.json': pkg('vue', '3.5.0'),
    'node_modules/kit/node_modules/vue/package.json': pkg('vue', '3.4.0'),
  })
  const listed = builtPackages(
    [
      join(root, 'node_modules/vue/dist/a.js'),
      join(root, 'node_modules/vue/dist/b.js'),
      join(root, 'node_modules/kit/node_modules/vue/index.js'),
      join(root, 'src/main.ts'),
    ],
    root,
  )
  expect(listed).toEqual([
    { name: 'vue', version: '3.4.0', dir: 'node_modules/kit/node_modules/vue' },
    { name: 'vue', version: '3.5.0', dir: 'node_modules/vue' },
  ])
})
