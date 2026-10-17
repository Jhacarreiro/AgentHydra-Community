import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { releaseDownloadBase } from '../server/src/release-channel'

/**
 * The Linux and macOS launcher (`agenthydra` at the top of a release bundle). Its source is
 * launcher/posix/agenthydra, with the release version and the download base its repair uses left as
 * placeholders the packager fills. The base is the release channel's downloads (release-channel.json).
 */
const SOURCE = join(import.meta.dir, '..', 'launcher', 'posix', 'agenthydra')
const PLACEHOLDER = '@VERSION@'
const BASE_PLACEHOLDER = '@RELEASE_BASE@'

/** Writes the launcher with `version` and `releaseBase` baked in and mode 0755. */
export function writePosixLauncher({
  outfile,
  version,
  releaseBase = releaseDownloadBase(),
}: {
  outfile: string
  version: string
  releaseBase?: string
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
  const text = readFileSync(SOURCE, 'utf8')
  for (const placeholder of [PLACEHOLDER, BASE_PLACEHOLDER])
    if (!text.includes(placeholder)) throw new Error(`${SOURCE} has no ${placeholder} to fill`)
  mkdirSync(dirname(outfile), { recursive: true })
  writeFileSync(outfile, text.replace(PLACEHOLDER, version).replace(BASE_PLACEHOLDER, releaseBase))
  chmodSync(outfile, 0o755)
}
