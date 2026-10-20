// tests/docker-hub-updater.test.ts - deploy/docker/hub-updater.mjs against a fake Docker CLI that keeps
// images, the hub container and its state volume in a scratch folder. Checks what an operator relies on:
// a failed build never stops the running Hub, a failed new release comes back as the exact previous image
// and state, and an update killed half-way is rolled back by the next run.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from './repo-root'

const FROM = '2026.10.0'
const TO = '2026.10.1'

// The fake Docker CLI. State is a JSON file; the volume is a real folder so backup and restore are real tars.
const FAKE_DOCKER = String.raw`;(() => {
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const stateFile = process.env.FAKE_DOCKER_STATE
const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
const save = () => fs.writeFileSync(stateFile, JSON.stringify(s))
const args = process.argv.slice(2)
const version = process.env.AGENTHYDRA_VERSION
const out = (x) => { if (x) process.stdout.write(x + '\n') }
const fail = (why) => { process.stderr.write(why + '\n'); process.exit(1) }
const step = (name) => {
  s.calls.push(name + (version ? ':' + version : ''))
  save()
  if (process.env.FAKE_KILL_AT === name + ':' + version) process.kill(process.ppid, 'SIGKILL')
  if (s.fail === name + ':' + version) fail('injected ' + name + ' failure')
}
const hub = s.hub
if (args[0] === 'compose') {
  const rest = args.slice(3)
  if (rest[0] === 'ps') return out(hub && (hub.running || rest.includes('-a')) ? hub.id : '')
  if (rest[0] === 'build') {
    step('build')
    s.images['agenthydra-community-hub:' + version] = 'sha256:' + version + '-' + (s.seq++)
    if (s.repointOnBuild) s.images['agenthydra-community-hub:' + s.repointOnBuild] = 'sha256:rebuilt-elsewhere'
    return save()
  }
  if (rest[0] === 'stop') { step('stop'); if (hub) hub.running = false; return save() }
  if (rest[0] === 'up') {
    step('up')
    const ref = 'agenthydra-community-hub:' + version
    const imageId = s.images[ref]
    if (!imageId) fail('no such image ' + ref)
    if (!hub || hub.imageId !== imageId || hub.image !== ref) s.hub = { id: 'c' + (s.seq++), image: ref, imageId, running: true }
    else hub.running = true
    // A new release migrates the state it is given.
    if (version === s.migrates) {
      fs.writeFileSync(path.join(s.volume, 'migrated'), version)
      fs.writeFileSync(path.join(s.volume, 'db'), 'schema-' + version)
    }
    return save()
  }
  fail('unexpected compose ' + rest.join(' '))
}
if (args[0] === 'inspect') {
  const format = args[2]
  if (!hub || args[3] !== hub.id) fail('no such container')
  if (format.includes('.Mounts')) return out('hub_state')
  if (format === '{{.Config.Image}}') return out(hub.image)
  if (format === '{{.Image}}') return out(hub.imageId)
}
if (args[0] === 'image' && args[1] === 'inspect') return s.images[args[4]] ? out(s.images[args[4]]) : fail('no such image')
if (args[0] === 'image' && args[1] === 'rm') { delete s.images[args[2]]; return save() }
if (args[0] === 'images') return out(Object.keys(s.images).map(x => x.split(':')[1]).join('\n'))
if (args[0] === 'tag') { s.images[args[2]] = args[1]; return save() }
if (args[0] === 'run') {
  const mounts = args.flatMap((x, i) => args[i - 1] === '-v' ? [x] : [])
  if (!mounts.some(m => m.startsWith('hub_state:'))) fail('state volume not mounted')
  const backupDir = mounts.find(m => m.split(':')[1] === '/backup').split(':')[0]
  const action = args[args.length - 2], name = args[args.length - 1]
  step(action)
  if (action === 'backup') execFileSync('tar', ['-czf', path.join(backupDir, name), '-C', s.volume, '.'])
  else {
    for (const entry of fs.readdirSync(s.volume)) fs.rmSync(path.join(s.volume, entry), { recursive: true })
    execFileSync('tar', ['-xzf', path.join(backupDir, name), '-C', s.volume])
  }
  return
}
fail('unexpected docker ' + args.join(' '))
})()
`

type FakeState = {
  hub: { id: string; image: string; imageId: string; running: boolean } | null
  images: Record<string, string>
  volume: string
  calls: string[]
  seq: number
  fail?: string
  migrates?: string
  repointOnBuild?: string
  unhealthy?: string[]
}

let dir: string
let stateFile: string
let server: ReturnType<typeof Bun.serve>
let latestTag = `v${TO}`

const readState = (): FakeState => JSON.parse(readFileSync(stateFile, 'utf8'))
const writeState = (patch: Partial<FakeState>) =>
  writeFileSync(stateFile, JSON.stringify({ ...readState(), ...patch }))
const installed = () => readFileSync(join(dir, '.env'), 'utf8')
const volumeFiles = () =>
  Object.fromEntries(
    readdirSync(readState().volume)
      .sort()
      .map((f) => [f, readFileSync(join(readState().volume, f), 'utf8')]),
  )

// Asynchronous, because the release and health endpoints are served from this process.
async function updater(command: string, env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, join(dir, 'hub-updater.mjs'), command], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      AGENTHYDRA_DOCKER: join(dir, 'fake-docker'),
      AGENTHYDRA_DOCKER_RELEASES_URL: `http://127.0.0.1:${server.port}/release`,
      AGENTHYDRA_DOCKER_HEALTH_URL: `http://127.0.0.1:${server.port}/health`,
      AGENTHYDRA_DOCKER_HEALTH_SECONDS: '1',
      FAKE_DOCKER_STATE: stateFile,
      ...env,
    },
  })
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  await child.exited
  return { status: child.exitCode, signal: child.signalCode, stdout, stderr }
}

describe.skipIf(process.platform === 'win32')('Docker Hub updater', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hub-updater-'))
    copyFileSync(join(REPO_ROOT, 'deploy/docker/hub-updater.mjs'), join(dir, 'hub-updater.mjs'))
    writeFileSync(join(dir, 'fake-docker'), `#!${process.execPath}\n${FAKE_DOCKER}`)
    chmodSync(join(dir, 'fake-docker'), 0o755)
    writeFileSync(join(dir, '.env'), `COMPOSE_PROJECT_NAME=hub\nAGENTHYDRA_VERSION=${FROM}\n`)
    const volume = join(dir, 'volume')
    mkdirSync(volume)
    writeFileSync(join(volume, 'db'), `schema-${FROM}`)
    writeFileSync(join(volume, 'pairings'), 'pc-1')
    stateFile = join(dir, 'state.json')
    const oldRef = `agenthydra-community-hub:${FROM}`
    writeFileSync(
      stateFile,
      JSON.stringify({
        hub: { id: 'c0', image: oldRef, imageId: 'sha256:original', running: true },
        images: { [oldRef]: 'sha256:original' },
        volume,
        calls: [],
        seq: 1,
        migrates: TO,
      } satisfies FakeState),
    )
    latestTag = `v${TO}`
    server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === '/release')
          return Response.json({ tag_name: latestTag, draft: false, prerelease: false })
        const s = readState()
        const version = s.hub?.image.split(':')[1] ?? ''
        return new Response(null, {
          status: s.hub?.running && !s.unhealthy?.includes(version) ? 200 : 503,
        })
      },
    })
  })
  afterEach(() => server.stop(true))

  test('a healthy new release becomes the installed one, keeping the previous image and a backup', async () => {
    const r = await updater('update')
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(installed()).toBe(`COMPOSE_PROJECT_NAME=hub\nAGENTHYDRA_VERSION=${TO}\n`)
    const s = readState()
    expect(s.hub?.image).toBe(`agenthydra-community-hub:${TO}`)
    expect(s.images[`agenthydra-community-hub:${FROM}`]).toBe('sha256:original')
    expect(
      readdirSync(join(dir, '.hub-backups')).filter((f) => f.endsWith('.tar.gz')),
    ).toHaveLength(1)
    expect(existsSync(join(dir, '.hub-update.json'))).toBe(false)
    expect(existsSync(join(dir, '.hub-update.lock'))).toBe(false)
  })

  test('a failed build leaves the running Hub alone', async () => {
    writeState({ fail: `build:${TO}` })
    const r = await updater('update')
    expect(r.status).toBe(1)
    const s = readState()
    expect(s.calls).not.toContain(`stop:${FROM}`)
    expect(s.hub).toEqual({
      id: 'c0',
      image: `agenthydra-community-hub:${FROM}`,
      imageId: 'sha256:original',
      running: true,
    })
    expect(installed()).toContain(`AGENTHYDRA_VERSION=${FROM}`)
    expect(existsSync(join(dir, '.hub-update.json'))).toBe(false)
  })

  test('an unhealthy new release is rolled back to the exact previous image and state', async () => {
    const before = volumeFiles()
    // Something re-tags the old version while the new one builds; the rollback must not trust the tag.
    writeState({ unhealthy: [TO], repointOnBuild: FROM })
    const r = await updater('update')
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('Rollback complete')
    const s = readState()
    expect(s.hub?.imageId).toBe('sha256:original')
    expect(s.hub?.running).toBe(true)
    expect(volumeFiles()).toEqual(before)
    expect(installed()).toContain(`AGENTHYDRA_VERSION=${FROM}`)
    expect(existsSync(join(dir, '.hub-update.json'))).toBe(false)
  })

  test('an update killed after the new release started is rolled back by the next run', async () => {
    const before = volumeFiles()
    const killed = await updater('update', { FAKE_KILL_AT: `up:${TO}` })
    expect(killed.signal).toBe('SIGKILL')
    expect(JSON.parse(readFileSync(join(dir, '.hub-update.json'), 'utf8')).phase).toBe('started')
    expect(existsSync(join(dir, '.hub-update.lock'))).toBe(true)
    latestTag = `v${FROM}`
    const r = await updater('update')
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Rollback complete')
    const s = readState()
    expect(s.hub?.imageId).toBe('sha256:original')
    expect(s.hub?.running).toBe(true)
    expect(volumeFiles()).toEqual(before)
    expect(installed()).toContain(`AGENTHYDRA_VERSION=${FROM}`)
    expect(existsSync(join(dir, '.hub-update.json'))).toBe(false)
    expect(existsSync(join(dir, '.hub-update.lock'))).toBe(false)
  })

  test('a failed rollback stops further automatic updates', async () => {
    writeState({ unhealthy: [TO, FROM] })
    const r = await updater('update')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('manual recovery required')
    expect(JSON.parse(readFileSync(join(dir, '.hub-update.json'), 'utf8')).phase).toBe('failed')
    const again = await updater('update')
    expect(again.status).toBe(1)
    expect(again.stderr).toContain('needs manual recovery')
    expect(readState().calls.filter((c) => c.startsWith('build'))).toHaveLength(1)
  })
})
