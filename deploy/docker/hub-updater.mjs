#!/usr/bin/env node
/** Host-side Docker Hub updater: a shipped product component, not a cron job.
 * Run 'watch' under the host service manager. No Docker socket in the Hub.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const command = process.argv[2] || 'check'
const intervalMinutes = Number(process.env.AGENTHYDRA_DOCKER_UPDATE_MINUTES || 360)
const channel = 'https://api.github.com/repos/Jhacarreiro/AgentHydra-Community/releases/latest'
const versionFile = join(dir, '.env')
const lockDir = join(dir, '.hub-update.lock')
const backupDir = join(dir, '.hub-backups')
const composeExecutable = process.env.AGENTHYDRA_DOCKER_COMPOSE || 'docker'
const composePrefix = composeExecutable === 'docker' ? ['compose'] : []
const validVersion = /^20\d\d\.\d{1,2}\.\d{1,3}$/
const text = (message) => process.stdout.write(`${message}\n`)

function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, { cwd: dir, encoding: 'utf8', timeout: options.timeout || 15_000, maxBuffer: 512 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`${binary} ${args[0]} failed (${result.status ?? result.error?.code})`)
  return result.stdout.trim()
}
function compose(args, opts) { return run(composeExecutable, [...composePrefix, '-f', 'compose.yaml', ...args], opts) }
function currentVersion() {
  if (!existsSync(versionFile)) throw new Error('Missing deploy/docker/.env; set AGENTHYDRA_VERSION to the installed release')
  const line = readFileSync(versionFile, 'utf8').split(/\r?\n/).find(x => x.startsWith('AGENTHYDRA_VERSION='))
  const version = line?.slice('AGENTHYDRA_VERSION='.length)
  if (!validVersion.test(version || '')) throw new Error('Invalid installed release version')
  return version
}
function saveVersion(version) {
  if (!validVersion.test(version)) throw new Error('Invalid release version')
  const body = existsSync(versionFile) ? readFileSync(versionFile, 'utf8') : ''
  if (!/^AGENTHYDRA_VERSION=/m.test(body)) throw new Error('Missing AGENTHYDRA_VERSION in .env')
  const next = body.replace(/^AGENTHYDRA_VERSION=.*$/m, `AGENTHYDRA_VERSION=${version}`)
  const file = `${versionFile}.new`
  writeFileSync(file, next, { mode: 0o600 })
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
function lock() { mkdirSync(lockDir); return () => rmSync(lockDir, { recursive: true, force: true }) }
function runningHub() {
  const id = compose(['ps', '-q', 'hub'])
  if (!id) throw new Error('Hub is not deployed; use the Docker installation instructions first')
  return id
}
function makeBackup(hub, image, version) {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  const basename = `hub-${version}-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`
  const target = join(backupDir, basename)
  run('docker', ['run', '--rm', '--network', 'none', '--volumes-from', hub, '-v', `${backupDir}:/backup`, '--user', '0', '--entrypoint', '/bin/sh', image, '-c', 'umask 077; tar -czf "$1" -C /srv/agenthydra-state/.agenthydra .; chmod 600 "$1"', 'backup', `/backup/${basename}`], { timeout: 120_000 })
  if (!existsSync(target)) throw new Error('State backup not found after archival')
  return basename
}
function restoreBackup(hub, image, basename) {
  // Untar-over is not a rollback: remove files created by the failed release first.
  // The hub is stopped; the operation is restricted to its existing state volume.
  run('docker', ['run', '--rm', '--network', 'none', '--volumes-from', hub,
    '-v', `${backupDir}:/backup:ro`, '--user', '0', '--entrypoint', '/bin/sh', image,
    '-c', 'set -eu; cd /srv/agenthydra-state/.agenthydra; find . -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -xzf "$1"',
    'restore', `/backup/${basename}`], { timeout: 120_000 })
}
async function health() {
  for (let i = 0; i < 12; i++) {
    try {
      const response = await fetch('http://127.0.0.1:7788/api/health', { signal: AbortSignal.timeout(3000), cache: 'no-store' })
      if (response.ok) return true
    } catch { /* wait for startup */ }
    await new Promise(resolve => setTimeout(resolve, 2500))
  }
  return false
}
async function update() {
  const unlock = lock()
  const old = currentVersion()
  let backup
  let stopped = false
  try {
    const release = await check()
    if (!release) return
    const hub = runningHub()
    const image = run('docker', ['inspect', '-f', '{{.Config.Image}}', hub])
    // Build and checksum-verify BEFORE stopping the running service.
    saveVersion(release)
    try { compose(['build', 'hub'], { timeout: 1_200_000 }) }
    catch (error) { saveVersion(old); throw error }
    saveVersion(old)
    compose(['stop', 'hub'], { timeout: 45_000 })
    stopped = true
    backup = makeBackup(hub, image, old)
    saveVersion(release)
    compose(['up', '-d', '--no-build'], { timeout: 120_000 })
    if (!await health()) throw new Error('New Hub failed healthcheck')
    text(`updated=${release} backup=${backup}`)
  } catch (error) {
    if (stopped) {
      text('Update failed; attempting rollback')
      try {
        compose(['stop', 'hub'], { timeout: 45_000 })
        const hub = runningHub()
        const oldImage = `agenthydra-community-hub:${old}`
        if (backup) restoreBackup(hub, oldImage, backup)
        saveVersion(old)
        compose(['up', '-d', '--no-build'], { timeout: 120_000 })
        if (!await health()) throw new Error('Rollback healthcheck failed')
        text('Rollback complete')
      } catch { throw new Error('UPDATE AND ROLLBACK FAILED — manual recovery required; backup retained') }
    } else saveVersion(old)
    throw error
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
