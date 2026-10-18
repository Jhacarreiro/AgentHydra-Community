// The project's own pages, for the window, AgentHydra's pages and Desk's connector list: the repository the
// release channel names (release-channel.json at the repository root, read by server/src/release-channel.ts).
//
// A copy, not an import: a release runs Desk's server from desk2/ as source, and the bundle holds nothing of the
// repository outside desk2/ to import. tests/release-channel-drift.test.ts holds this to release-channel.json.

/** What this project calls itself where it names its maker: the footer in hydra/src/shell (not mounted yet). */
export const PROJECT_NAME = 'AgentHydra Community'

export const PROJECT_REPO = 'Jhacarreiro/AgentHydra-Community'

export const PROJECT_HOMEPAGE = `https://github.com/${PROJECT_REPO}`

/** The CHANGELOG on main: what "What's new" and the rename notice open. */
export const CHANGELOG_URL = `${PROJECT_HOMEPAGE}/blob/main/CHANGELOG.md`
