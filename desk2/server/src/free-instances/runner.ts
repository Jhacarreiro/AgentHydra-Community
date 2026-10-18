import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { FreeConfig, FreeHarnessCommand, FreeRequest } from '@shared/free-instances'
import { SpawnLaunchError, spawnOff, type SpawnOffResult } from '../lib/spawn-off'

export interface RunOutput { code: number; stdout: string }
export type FreeRunRequest = Omit<FreeRequest, 'command'> & { command: FreeHarnessCommand }
export type FreeRunner = (config: FreeConfig, request: FreeRunRequest, signal: AbortSignal) => Promise<RunOutput>

/** No shell, credentials in argv, browser fallback, or automatic message retries. */
export function commandArgs(config: FreeConfig, request: FreeRunRequest): string[] {
  const args = [join(config.harnessDir, 'desk_entry.py'), request.command]
  // The harness refuses --json with forget, and forget prints a sentence: its exit code is the result.
  if (request.command === 'forget') return [...args, '--provider', request.provider, '--request-timeout', '120']
  // Sign-in: desk_entry prints the JSON itself, and the harness refuses --json and --brief with login.
  if (request.command === 'login') return [...args, '--provider', request.provider, '--timeout', '900']
  if (request.chatId) args.push(request.chatId)
  args.push('--provider', request.provider, '--json', '--brief', '--request-timeout', '120')
  if (request.command === 'chat' || request.command === 'resume') args.push('--stdin')
  // Registry aliases are restricted; Desk keeps the friendly display name separately.
  if (request.name) args.push('--name', `desk-${createHash('sha256').update(request.name).digest('hex').slice(0, 24)}`)
  if (request.webSearch) args.push('--web-search')
  if (request.model) args.push('--prefer', request.model)
  return args
}

/** The spawn runs on the spawn-off worker, so a busy PC cannot stall the server's loop while Python starts. */
export const runFree: FreeRunner = async (config, request, signal) => {
  if (signal.aborted) throw new Error('stopped')
  let out: SpawnOffResult
  try {
    out = await spawnOff({
      cmd: [config.python, ...commandArgs(config, request)],
      cwd: config.harnessDir,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', CLAUDFREE_STATE_DIR: config.stateDir, CLAUDFREE_CACHE_DIR: config.cacheDir },
      stdin: request.prompt ?? '',
      maxBytes: 8 * 1024 * 1024,
      timeoutMs: request.command === 'login' ? 960_000 : 300_000,
      stderr: 'ignore',
      killTree: true,
    }, signal)
  } catch (err) {
    if (err instanceof SpawnLaunchError) throw new Error('launch_failed')
    throw err
  }
  if (out.aborted || out.capped || out.timedOut) throw new Error('stopped')
  return { code: out.code, stdout: Buffer.from(out.stdout).toString('utf8') }
}
