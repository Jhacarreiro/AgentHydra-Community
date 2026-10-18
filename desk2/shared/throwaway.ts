// The live probe's throwaway folder (core/smoke/smoke.ts runs every chat it makes in a folder under
// tmpdir()/agenthydra-smoke). Nothing in it is ever shown: not as an outside session, not in the window's chat list
// (owner, 2026-10-14, after a probe round filled the sidebar until its cleanup ran: "sick and tired of you asking me to
// clean this shit up").

export const THROWAWAY_DIR = 'agenthydra-smoke'

/** A folder in the probe's throwaway tree, however it is written ('\\?\C:\...', forward slashes, any case). */
export function isThrowawayCwd(cwd: string | null | undefined): boolean {
  return !!cwd && /(^|[\\/])agenthydra-smoke([\\/]|$)/i.test(cwd)
}
