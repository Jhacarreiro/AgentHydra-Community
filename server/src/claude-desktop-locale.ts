// The Claude Desktop shell's language, set before each launch so menus, the tray and settings
// windows open in English on this PC (owner, 2026-10-13: "always use English where possible").
//
// The shell reads its language from the profile's config.json `locale` key first, then the OS
// language, then en-US (index.chunk: Mdt/Edt). The account page then calls requestLocaleChange with
// the ACCOUNT's language, so the chat page follows each account's own setting; this only fixes the
// shell until that happens. `--lang` sets Chromium's language for the page's navigator.language.

import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** `system` = the OS language. An explicit BCP-47 tag (e.g. `de-DE`) is used as given. */
export const DEFAULT_DESKTOP_LOCALE = 'system'
const FALLBACK_LOCALE = 'en-US'
const LOCALE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/

/** The language the shell should use: an explicit tag, the OS language for `system`, else en-US. */
export function resolveDesktopLocale(
  setting: string | undefined,
  osLocale: string | undefined,
): string {
  const wanted = (setting ?? DEFAULT_DESKTOP_LOCALE).trim()
  if (wanted !== DEFAULT_DESKTOP_LOCALE) return LOCALE_TAG.test(wanted) ? wanted : FALLBACK_LOCALE
  return osLocale && LOCALE_TAG.test(osLocale) ? osLocale : FALLBACK_LOCALE
}

/** This launch's language: AGENTHYDRA_DESKTOP_LOCALE when set, else the OS language (en-US on this PC). */
export function desktopLocaleForLaunch(env: NodeJS.ProcessEnv = process.env): string {
  return resolveDesktopLocale(
    env.AGENTHYDRA_DESKTOP_LOCALE,
    Intl.DateTimeFormat().resolvedOptions().locale,
  )
}

/** Chromium's language switch for the launch. */
export function launchLocaleArgs(locale: string): string[] {
  return [`--lang=${locale}`]
}

/**
 * Sets the profile's `locale` in config.json and changes nothing else. The file is replaced
 * through a temp file and a rename, so a crash cannot leave half a file. A config that does not
 * parse as a JSON object is refused and left as it is. Returns whether the file was written.
 */
export async function setProfileLocale(
  profileDir: string,
  locale: string,
): Promise<'written' | 'unchanged'> {
  const file = join(profileDir, 'config.json')
  let config: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw Error('config.json is not a JSON object; left unchanged')
    }
    config = parsed as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (config.locale === locale) return 'unchanged'
  config.locale = locale
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`)
  await rename(temp, file)
  return 'written'
}
