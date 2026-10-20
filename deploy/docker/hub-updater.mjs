#!/usr/bin/env node
/** Host-side Docker Hub updater: a shipped product component, not a cron job.
 * Run 'watch' under the host service manager. No Docker socket in the Hub.
 *
 * The installed release lives in .env (AGENTHYDRA_VERSION) and only changes once the new Hub
 * answers its healthcheck. Every step in between is recorded in .hub-update.json, so an update
 * interrupted at any point is rolled back to the exact previous image and state on the next run.
 */
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const command = process.argv[2] || 'check'
const intervalMinutes = Number(process.env.AGENTHYDRA_DOCKER_UPDATE_MINUTES || 360)
const channel = process.env.AGENTHYDRA_DOCKER_RELEASES_URL || 'https://api.github.com/repos/Jhacarreiro/AgentHydra-Community/releases/latest'
const healthUrl = process.env.AGENTHYDRA_DOCKER_HEALTH_URL || 'http://127.0.0.1:7788/api/health'
const healthSeconds = Number(process.env.AGENTHYDRA_DOCKER_HEALTH_SECONDS || 90)
const dockerExecutable = process.env.AGENTHYDRA_DOCKER || 'docker'
const composeExecutable = process.env.AGENTHYDRA_DOCKER_COMPOSE || dockerExecutable
const composePrefix = composeExecutable === dockerExecutable ? ['compose'] : []
const versionFile = join(dir, '.env')
const lockFile = join(dir, '.hub-update.lock')
const journalFile = join(dir, '.hub-update.json')
const backupDir = join(dir, '.hub-backups')
const keepBackups = 3
const imageName = 'agenthydra-community-hub'
const stateMount = '/srv/agenthydra-state/.agenthydra'
const validVersion = /^20\d\d\.\d{1,2}\.\d{1,3}$/
const text = (message) => process.stdout.write(`${message}\n`)

function run(binary, args, options = {}) {
  const env = options.version ? { ...process.env, AGENTHYDRA_VERSION: options.version } : process.env
  const result = spawnSync(binary, args, { cwd: dir, env, encoding: 'utf8', timeout: options.timeout || 30_000, maxBuffer: 4 * 1024 * 1024 })
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || '').trim().split(/\r?\n/).slice(-2).join(' | ').slice(-300)
    throw new Error(`${binary} ${args.join(' ').slice(0, 80)} failed (${result.status ?? result.error?.code})${detail ? `: ${detail}` : ''}`)
  }
  return result.stdout.trim()
}
const docker = (args, opts) => run(dockerExecutable, args, opts)
// The version is passed in the environment, which takes precedence over .env in Compose interpolation,
// so building or starting a candidate never rewrites the installed version.
const compose = (version, args, opts) => run(composeExecutable, [...composePrefix, '-f', 'compose.yaml', ...args], { ...opts, version })
const tag = (version) => `${imageName}:${version}`

function currentVersion() {
  if (!existsSync(versionFile)) throw new Error('Missing deploy/docker/.env; set AGENTHYDRA_VERSION to the installed release')
  const line = readFileSync(versionFile, 'utf8').split(/\r?\n/).find(x => x.startsWith('AGENTHYDRA_VERSION='))
  const version = line?.slice('AGENTHYDRA_VERSION='.length)
  if (!validVersion.test(version || '')) throw new Error('Invalid installed release version')
  return version
}
function saveVersion(version) {
  if (!validVersion.test(version)) throw new Error('Invalid release version')
  const body = readFileSync(versionFile, 'utf8')
  if (!/^AGENTHYDRA_VERSION=/m.test(body)) throw new Error('Missing AGENTHYDRA_VERSION in .env')
  const file = `${versionFile}.new`
  writeFileSync(file, body.replace(/^AGENTHYDRA_VERSION=.*$/m, `AGENTHYDRA_VERSION=${version}`), { mode: 0o600 })
  renameSync(file, versionFile)
}
async function latest() {
  const response = await fetch(channel, { headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'agenthydra-community-docker-updater' }, signal: AbortSignal.timeout(12_000) })
  if (!response.ok) throw new Error(`Release lookup failed (${response.status})`)
  const release = await response.json()
  const version = release.tag_name?.replace(/^v/, '')
  if (release.draft || release.prerelease || !validVersion.test(version || '')) throw new Error('Latest release is not a supported stable version')
  return version
}
function compare(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Math.sign(x[i] - y[i])
  return 0
}
async function check() {
  const installed = currentVersion(), available = await latest()
  text(`installed=${installed} latest=${available} update_available=${compare(available, installed) > 0}`)
  return compare(available, installed) > 0 ? available : null
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}
function lock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockFile, 'wx', 0o600)
      writeFileSync(fd, String(process.pid))
      closeSync(fd)
      return () => rmSync(lockFile, { force: true })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const pid = Number(readFileSync(lockFile, 'utf8'))
      if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) throw new Error(`Another updater is running (pid ${pid})`)
      // The previous updater died; the journal, not the lock, says what it left behind.
      rmSync(lockFile, { force: true })
    }
  }
  throw new Error('Could not take the updater lock')
}
const readJournal = () => existsSync(journalFile) ? JSON.parse(readFileSync(journalFile, 'utf8')) : null
function writeJournal(journal) {
  const file = `${journalFile}.new`
  writeFileSync(file, JSON.stringify(journal), { mode: 0o600 })
  renameSync(file, journalFile)
}

function hubContainer(version, { running = false } = {}) {
  const id = compose(version, ['ps', ...(running ? [] : ['-a']), '-q', 'hub'])
  return id.split(/\s+/)[0] || null
}
function stateVolume(container) {
  const name = docker(['inspect', '-f', `{{range .Mounts}}{{if eq .Destination "${stateMount}"}}{{.Name}}{{end}}{{end}}`, container])
  if (!name) throw new Error('Hub state volume not found')
  return name
}
function makeBackup(journal) {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  const basename = `hub-${journal.from}-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`
  // Written under a temporary name and checked before it counts as a backup.
  docker(['run', '--rm', '--network', 'none', '-v', `${journal.volume}:/state:ro`, '-v', `${backupDir}:/backup`, '--user', '0', '--entrypoint', '/bin/sh', journal.fromImage,
    '-c', 'set -eu; umask 077; tar -czf "/backup/$1.partial" -C /state .; tar -tzf "/backup/$1.partial" >/dev/null; mv "/backup/$1.partial" "/backup/$1"', 'backup', basename], { timeout: 300_000 })
  if (!existsSync(join(backupDir, basename))) throw new Error('State backup not found after archival')
  return basename
}
function restoreBackup(journal) {
  // Untar-over is not a rollback: remove files created by the failed release first. The Hub is stopped.
  docker(['run', '--rm', '--network', 'none', '-v', `${journal.volume}:/state`, '-v', `${backupDir}:/backup:ro`, '--user', '0', '--entrypoint', '/bin/sh', journal.fromImage,
    '-c', 'set -eu; tar -tzf "/backup/$1" >/dev/null; cd /state; find . -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -xzpf "/backup/$1"', 'restore', journal.backup], { timeout: 300_000 })
}
function pruneBackups() {
  const backups = readdirSync(backupDir).filter(name => /^hub-.*\.tar\.gz$/.test(name))
    .sort((a, b) => statSync(join(backupDir, a)).mtimeMs - statSync(join(backupDir, b)).mtimeMs)
  for (const name of backups.slice(0, -keepBackups)) rmSync(join(backupDir, name), { force: true })
  for (const name of readdirSync(backupDir).filter(name => name.endsWith('.partial'))) rmSync(join(backupDir, name), { force: true })
}
function pruneImages(keep) {
  const tags = docker(['images', imageName, '--format', '{{.Tag}}']).split(/\s+/).filter(Boolean)
  for (const old of tags.filter(x => !keep.includes(x))) {
    try { docker(['image', 'rm', tag(old)]) } catch { /* still referenced; keep it */ }
  }
}
async function healthy(version, imageId) {
  const deadline = Date.now() + healthSeconds * 1000
  do {
    try {
      const container = hubContainer(version, { running: true })
      if (container && docker(['inspect', '-f', '{{.Image}}', container]) === imageId) {
        const response = await fetch(healthUrl, { signal: AbortSignal.timeout(3000), cache: 'no-store' })
        if (response.ok) return true
      }
    } catch { /* wait for startup */ }
    await new Promise(resolve => setTimeout(resolve, Math.min(2500, healthSeconds * 250)))
  } while (Date.now() < deadline)
  return false
}

/** Put the previous release back exactly: its image (by ID, re-tagged), and its state if the new one ran. */
async function rollback(journal) {
  text(`Rolling back to ${journal.from}`)
  try {
    try { compose(journal.from, ['stop', 'hub'], { timeout: 60_000 }) } catch { /* may already be gone */ }
    if (journal.phase === 'started' && journal.backup) restoreBackup(journal)
    docker(['tag', journal.fromImage, tag(journal.from)])
    compose(journal.from, ['up', '-d', '--no-build'], { timeout: 180_000 })
    if (!await healthy(journal.from, journal.fromImage)) throw new Error('Rollback healthcheck failed')
  } catch (error) {
    writeJournal({ ...journal, phase: 'failed', error: error.message })
    throw new Error(`UPDATE AND ROLLBACK FAILED (${error.message}); manual recovery required; journal and backup retained`)
  }
  rmSync(journalFile, { force: true })
  text('Rollback complete')
}
async function recover() {
  const journal = readJournal()
  if (!journal) return
  if (journal.phase === 'failed') throw new Error(`A previous update needs manual recovery: ${journal.error}; see ${journalFile}`)
  if (journal.phase === 'healthy') {
    saveVersion(journal.to)
    rmSync(journalFile, { force: true })
    text(`Finished interrupted update to ${journal.to}`)
    return
  }
  // Interrupted while building: the running Hub was never stopped.
  if (journal.phase === 'building') return rmSync(journalFile, { force: true })
  text(`Recovering interrupted update ${journal.from} -> ${journal.to} (${journal.phase})`)
  await rollback(journal)
}

async function update() {
  const unlock = lock()
  try {
    await recover()
    const from = currentVersion()
    const to = await check()
    if (!to) return
    const container = hubContainer(from, { running: true })
    if (!container) throw new Error('Hub is not running; start it with the Docker installation instructions first')
    if (docker(['inspect', '-f', '{{.Config.Image}}', container]) !== tag(from)) throw new Error('Running image does not match the installed release; manual reconciliation required')
    const journal = { phase: 'building', from, to, fromImage: docker(['inspect', '-f', '{{.Image}}', container]), volume: stateVolume(container) }
    writeJournal(journal)
    try {
      // Build and checksum-verify BEFORE stopping the running service.
      compose(to, ['build', 'hub'], { timeout: 1_800_000 })
      journal.toImage = docker(['image', 'inspect', '-f', '{{.Id}}', tag(to)])
      if (journal.toImage === journal.fromImage) throw new Error('New release built to the running image')
      journal.phase = 'stopping'
      writeJournal(journal)
      compose(from, ['stop', 'hub'], { timeout: 60_000 })
      journal.phase = 'stopped'
      writeJournal(journal)
      journal.backup = makeBackup(journal)
      journal.phase = 'started'
      writeJournal(journal)
      compose(to, ['up', '-d', '--no-build'], { timeout: 180_000 })
      if (!await healthy(to, journal.toImage)) throw new Error('New Hub failed healthcheck')
    } catch (error) {
      text(`Update to ${to} failed: ${error.message}`)
      if (journal.phase === 'building') rmSync(journalFile, { force: true })
      else await rollback(journal)
      throw error
    }
    writeJournal({ ...journal, phase: 'healthy' })
    saveVersion(to)
    rmSync(journalFile, { force: true })
    pruneBackups()
    pruneImages([to, from])
    text(`updated=${to} backup=${journal.backup}`)
  } finally { unlock() }
}

async function main() {
  if (command === 'check') await check()
  else if (command === 'update') await update()
  else if (command === 'watch') {
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5) throw new Error('Invalid update interval')
    for (;;) {
      try { await update() } catch (err) { process.stderr.write(`Update check failed: ${err.message}\n`) }
      await new Promise(resolve => setTimeout(resolve, intervalMinutes * 60_000))
    }
  } else throw new Error('Usage: node hub-updater.mjs check|update|watch')
}
main().catch(err => { process.stderr.write(`${err.message}\n`); process.exitCode = 1 })
