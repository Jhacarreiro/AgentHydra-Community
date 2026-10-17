// THE RELEASE CHANNEL: which GitHub repository this build's releases come from, and what the build may do about a
// newer one. One file says it, release-channel.json at the repository root, and this module is how the code reads it.
//
// Why one file: every path that reaches for a release used to carry its own copy of the repository's name (the
// compiled updater, both launchers' repair download, install.ps1, the release scripts, the tray's and the window's
// changelog links), and every copy named upstream. A copy left behind is a build that updates itself, or repairs a
// missing folder, from somebody else's releases. So nothing names the repository except the file, and each consumer
// derives what it needs from it: the daemon here, through the JSON import below (`bun build` inlines it into
// server.js, so a release carries the channel it was built with and no file beside it can redirect it), the
// launchers through a value the build writes into them (scripts/build-launcher.ts, scripts/launcher-posix.ts), and
// the node release scripts by reading the same file (scripts/release-channel.mjs). What cannot import this keeps a
// copy: install.ps1, the tray's config (misc/AgentHydra-Tray.json), Desk's links (desk2/shared/release-links.ts,
// since a release runs Desk's server from desk2/ as source) and the release workflow.
// tests/release-channel-drift.test.ts holds every copy to the file.
//
// `updates` is what a RELEASE build does: "off" makes no update check and downloads nothing (the state while the
// repository has published no releases), "notify" checks and tells but never installs, "auto" installs when Settings
// lets it. A source checkout updates through git and is held to the repository instead (server/src/updater.ts).
import channelFile from '../../release-channel.json'

export type UpdatePolicy = 'off' | 'notify' | 'auto'

export const UPDATE_POLICIES: readonly UpdatePolicy[] = ['off', 'notify', 'auto']

export interface ReleaseChannel {
  /** `owner/name` of the GitHub repository whose releases this build belongs to. */
  repo: string
  updates: UpdatePolicy
}

// GitHub's own limits: an owner is 1-39 letters, digits and inner hyphens; a repository name is letters, digits,
// `.`, `_` and `-`. Anything else could not be a repository, and it would land inside URLs and a C# string literal.
const SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/

/** The channel in `raw`, or an Error naming what is wrong with it. A build with a bad channel must not build. */
export function parseReleaseChannel(raw: unknown, source = 'release-channel.json'): ReleaseChannel {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error(`${source} must hold a JSON object`)
  const { repo, updates } = raw as Record<string, unknown>
  if (
    typeof repo !== 'string' ||
    !SLUG.test(repo) ||
    repo.split('/')[1]?.replace(/\.+/g, '') === ''
  )
    throw new Error(
      `${source}: "repo" must be a GitHub owner/name such as Owner/Repo, not ${JSON.stringify(repo)}`,
    )
  if (typeof updates !== 'string' || !(UPDATE_POLICIES as readonly string[]).includes(updates))
    throw new Error(
      `${source}: "updates" must be one of ${UPDATE_POLICIES.map((p) => `"${p}"`).join(', ')}, not ${JSON.stringify(updates)}`,
    )
  return { repo, updates: updates as UpdatePolicy }
}

/** This build's channel, as release-channel.json said when it was built. */
export const RELEASE_CHANNEL: Readonly<ReleaseChannel> = Object.freeze(
  parseReleaseChannel(channelFile),
)

export function repoUrl(channel: ReleaseChannel = RELEASE_CHANNEL): string {
  return `https://github.com/${channel.repo}`
}

/** The page a person is sent to for downloads. */
export function releasesPage(channel: ReleaseChannel = RELEASE_CHANNEL): string {
  return `${repoUrl(channel)}/releases`
}

/** What `<base>/v<version>/<asset>` is built on: the launchers' repair download, install.ps1's assets. */
export function releaseDownloadBase(channel: ReleaseChannel = RELEASE_CHANNEL): string {
  return `${repoUrl(channel)}/releases/download`
}

/** GitHub's answer for the newest full release (never a draft, never a pre-release). */
export function latestReleaseApi(channel: ReleaseChannel = RELEASE_CHANNEL): string {
  return `https://api.github.com/repos/${channel.repo}/releases/latest`
}

export function changelogUrl(channel: ReleaseChannel = RELEASE_CHANNEL): string {
  return `${repoUrl(channel)}/blob/main/CHANGELOG.md`
}

export function issuesUrl(channel: ReleaseChannel = RELEASE_CHANNEL): string {
  return `${repoUrl(channel)}/issues`
}

/**
 * Is `url` a file of one of the channel's own releases?
 *
 * The release JSON names every asset's download URL, and whoever answers the release query writes that JSON. Taking
 * the URLs as given made the answer, not this build, decide where the code it installs comes from. So a download
 * (the archive and its SHA256SUMS.txt alike) is fetched only from `https://github.com/<repo>/releases/download/`.
 * GitHub redirects such a URL to its own storage host; the redirect is GitHub's and is followed. The path is read
 * after URL parsing, so `..` and `%2e%2e` segments cannot climb out of the repository, and owner and name compare
 * without case, as GitHub's do.
 */
export function isChannelAssetUrl(url: string, channel: ReleaseChannel = RELEASE_CHANNEL): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') return false
  if (parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash)
    return false
  const prefix = `/${channel.repo}/releases/download/`.toLowerCase()
  const path = parsed.pathname
  if (!path.toLowerCase().startsWith(prefix)) return false
  // `<tag>/<file>`, exactly: nothing more, nothing less.
  return /^[^/]+\/[^/]+$/.test(path.slice(prefix.length))
}

/** `owner/name` of a GitHub remote URL in any shape git accepts, or null for anything that is not GitHub. */
export function githubSlug(url: string): string | null {
  const m =
    /^(?:https?:\/\/|ssh:\/\/|git:\/\/)?(?:[\w.-]+@)?github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    )
  return m ? `${m[1]}/${m[2]}` : null
}

/** True when two `owner/name` slugs are the same GitHub repository (GitHub ignores case in both). */
export function sameRepo(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase()
}

/** Why a release build will not ask whether a newer release exists, or null when it may ask. */
export function checkRefusal(channel: ReleaseChannel = RELEASE_CHANNEL): string | null {
  if (channel.updates !== 'off') return null
  return `Updates are off in this build: release-channel.json says "off" for ${channel.repo}, which publishes no releases yet, so nothing was checked or downloaded.`
}

/** Why a release build will not install a newer release, or null when it may. */
export function applyRefusal(channel: ReleaseChannel = RELEASE_CHANNEL): string | null {
  if (channel.updates === 'auto') return null
  return (
    checkRefusal(channel) ??
    `This build only tells you about new releases (release-channel.json says "notify"); download the new one from ${releasesPage(channel)}.`
  )
}
