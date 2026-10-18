import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  RELEASE_CHANNEL,
  releaseDownloadBase,
  UPDATE_POLICIES,
  type UpdatePolicy,
} from '../server/src/release-channel'

/**
 * The Linux and macOS launcher (`agenthydra` at the top of a release bundle). Its source is
 * launcher/posix/agenthydra, with the release version, the download base its repair uses and the
 * channel's updates policy left as placeholders the packager fills. The base and the policy are the
 * release channel's (release-channel.json): under "off" the channel has no release, and the launcher
 * names a missing part instead of downloading it.
 */
const SOURCE = join(import.meta.dir, '..', 'launcher', 'posix', 'agenthydra')
const PLACEHOLDER = '@VERSION@'
const BASE_PLACEHOLDER = '@RELEASE_BASE@'
const UPDATES_PLACEHOLDER = '@UPDATES@'

/** Writes the launcher with `version`, `releaseBase` and `updates` baked in and mode 0755. */
export function writePosixLauncher({
  outfile,
  version,
  releaseBase = releaseDownloadBase(),
  updates = RELEASE_CHANNEL.updates,
}: {
  outfile: string
  version: string
  releaseBase?: string
  updates?: UpdatePolicy
}): void {
  // The version lands inside single quotes in a shell script, so only a plain version string may pass.
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) {
    throw new Error(
      `launcher version must be a plain version string, got ${JSON.stringify(version)}`,
    )
  }
  // The base is the unquoted default of a ${VAR:-...} expansion: no character the shell would read.
  if (!/^https:\/\/[A-Za-z0-9./_-]+$/.test(releaseBase)) {
    throw new Error(
      `launcher download base must be a plain https URL, got ${JSON.stringify(releaseBase)}`,
    )
  }
  // The policy lands inside single quotes too, and the launcher only knows these three words.
  if (!(UPDATE_POLICIES as readonly string[]).includes(updates)) {
    throw new Error(
      `launcher updates policy must be one of ${UPDATE_POLICIES.join(', ')}, got ${JSON.stringify(updates)}`,
    )
  }
  const text = readFileSync(SOURCE, 'utf8')
  for (const placeholder of [PLACEHOLDER, BASE_PLACEHOLDER, UPDATES_PLACEHOLDER])
    if (!text.includes(placeholder)) throw new Error(`${SOURCE} has no ${placeholder} to fill`)
  mkdirSync(dirname(outfile), { recursive: true })
  writeFileSync(
    outfile,
    text
      .replace(PLACEHOLDER, version)
      .replace(BASE_PLACEHOLDER, releaseBase)
      .replace(UPDATES_PLACEHOLDER, updates),
  )
  chmodSync(outfile, 0o755)
}
