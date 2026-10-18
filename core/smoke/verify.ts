// One round of the rebuild's frontier loop (core/LOOP.md): typecheck the core, start it hidden with its own log (unless
// one already answers on CORE_PORT), wait for it, run smoke.ts --json against it, then stop the copy it started. The last
// line is smoke's stages, or a failed boot that says why (the typecheck's errors, or the core's own log).
//   bun core/smoke/verify.ts [scenario ...]
import { spawn, spawnSync } from 'node:child_process'
import { openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')
const port = process.env.CORE_PORT ?? '7789'
const base = `http://127.0.0.1:${port}/api`
const bootFail = (detail: unknown) => {
  console.log(JSON.stringify({ stages: [{ name: 'boot', status: 'fail', detail }] }))
  process.exit(1)
}
// Only the core counts as up: another server on the port (2026-10-14: the orchestrator's dashboard on 7799 answered
// /api/chats with []) fails the boot instead of being probed.
const answers = async () => {
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })
    return ((await r.json()) as { name?: string }).name === 'agenthydra-core'
  } catch {
    return false
  }
}

const tsc = spawnSync('bunx tsc --noEmit -p core/tsconfig.json', {
  cwd: root,
  encoding: 'utf8',
  shell: true,
  windowsHide: true,
})
if (tsc.status !== 0)
  bootFail({ typecheck: `${tsc.stdout}${tsc.stderr}`.trim().split('\n').slice(0, 40) })

let core: ReturnType<typeof spawn> | null = null
const log = join(tmpdir(), 'agenthydra-core.log')
if (!(await answers())) {
  const fd = openSync(log, 'w')
  core = spawn(process.execPath, [join(root, 'core', 'src', 'main.ts')], {
    cwd: root,
    env: { ...process.env, CORE_PORT: port },
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  })
  let up = false
  for (let i = 0; i < 60 && !up && core.exitCode === null; i++) {
    await Bun.sleep(500)
    up = await answers()
  }
  if (!up) {
    core.kill()
    bootFail({ log: readFileSync(log, 'utf8').trim().split('\n').slice(-30) })
  }
}
// The whole round is also kept (tmpdir/agenthydra-core-smoke.out): the loop file keeps only its frontier, and the
// next round's workers need every stage that is not green yet.
const out = join(tmpdir(), 'agenthydra-core-smoke.out')
try {
  const smoke = spawn(
    process.execPath,
    [join(import.meta.dir, 'smoke.ts'), '--json', ...process.argv.slice(2)],
    {
      cwd: root,
      env: { ...process.env, CORE_URL: base },
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    },
  )
  const chunks: Buffer[] = []
  smoke.stdout?.on('data', (b: Buffer) => {
    chunks.push(b)
    process.stdout.write(b)
  })
  await new Promise((r) => smoke.once('exit', r))
  writeFileSync(out, Buffer.concat(chunks))
} finally {
  core?.kill()
}
