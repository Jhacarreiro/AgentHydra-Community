import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  launchLocaleArgs,
  resolveDesktopLocale,
  setProfileLocale,
} from '../src/claude-desktop-locale'

const dirs: string[] = []

async function profile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-locale-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})

test('setProfileLocale changes only the locale key and keeps every other key', async () => {
  const dir = await profile()
  const before = {
    locale: 'es-419',
    oauthRefresh: 'kept',
    nested: { a: [1, 2], b: null },
    launchDebugger: false,
  }
  await writeFile(join(dir, 'config.json'), JSON.stringify(before))

  expect(await setProfileLocale(dir, 'en-US')).toBe('written')

  const after = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))
  expect(after).toEqual({ ...before, locale: 'en-US' })
  expect(await readdir(dir)).toEqual(['config.json'])
})

test('setProfileLocale does nothing when the locale already matches', async () => {
  const dir = await profile()
  const text = JSON.stringify({ locale: 'en-US', keep: 1 })
  await writeFile(join(dir, 'config.json'), text)

  expect(await setProfileLocale(dir, 'en-US')).toBe('unchanged')
  expect(await readFile(join(dir, 'config.json'), 'utf8')).toBe(text)
})

test('setProfileLocale creates config.json when the profile has none yet', async () => {
  const dir = await profile()

  expect(await setProfileLocale(dir, 'en-US')).toBe('written')
  expect(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))).toEqual({ locale: 'en-US' })
})

test('setProfileLocale refuses a config it cannot parse and leaves its bytes untouched', async () => {
  const dir = await profile()
  const broken = '{"locale": "es-419", "oauth": '
  await writeFile(join(dir, 'config.json'), broken)

  await expect(setProfileLocale(dir, 'en-US')).rejects.toThrow()
  expect(await readFile(join(dir, 'config.json'), 'utf8')).toBe(broken)
})

test('launchLocaleArgs passes the locale to the shell as --lang', () => {
  expect(launchLocaleArgs('en-US')).toEqual(['--lang=en-US'])
})

test('resolveDesktopLocale: system uses the OS language, explicit tags win, bad input falls back to en-US', () => {
  expect(resolveDesktopLocale('system', 'en-US')).toBe('en-US')
  expect(resolveDesktopLocale(undefined, 'de-DE')).toBe('de-DE')
  expect(resolveDesktopLocale('system', undefined)).toBe('en-US')
  expect(resolveDesktopLocale('system', 'not a locale!')).toBe('en-US')
  expect(resolveDesktopLocale('fr-FR', 'en-US')).toBe('fr-FR')
  expect(resolveDesktopLocale('../escape', 'en-US')).toBe('en-US')
})
