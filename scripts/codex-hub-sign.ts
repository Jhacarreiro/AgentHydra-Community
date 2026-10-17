#!/usr/bin/env bun
// scripts/codex-hub-sign.ts — signs the pusher and tray builds a Codex hub hands out, away from the hub.
//
// A PC takes a build from its hub only with a signature from the operator's ed25519 key over that build's name,
// platform and SHA-256 (server/src/core/codex-hub-signature.ts). The private key stays with whoever makes the builds;
// the hub only serves the `<build>.sig` written here, put beside the build in its .pusher folder. Each PC has the
// public key from its own build: the tray's `-X main.updateKey=<key>`, the pusher's
// `--define AGENTHYDRA_CODEX_HUB_UPDATE_KEY='"<key>"'` or its AGENTHYDRA_CODEX_HUB_UPDATE_KEY.
//
//   bun scripts/codex-hub-sign.ts keygen <private-key-file>           a new key, never over an existing file;
//                                                                     prints its public key (base64, 32 bytes)
//   bun scripts/codex-hub-sign.ts pubkey <private-key-file>           prints the public key again
//   bun scripts/codex-hub-sign.ts sign <private-key-file> <build>...  writes <build>.sig beside each build
//
// A build must have the name the hub serves it under, which says what it is: codex-hub-push.exe and
// codex-hub-tray.exe for Windows, codex-hub-push-<platform> and codex-hub-tray-<platform> for linux-x64,
// linux-arm64, darwin-x64 and darwin-arm64. Sign a macOS build after codesign, which changes the file. Put the .sig
// in place with its build or before it: a PC that checks in between refuses the build until its signature is there.

import { createHash, createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { createReadStream, readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { hubBuildOf, signBuild, updateKeyText } from '../server/src/core/codex-hub-signature'

const USAGE = `usage: bun scripts/codex-hub-sign.ts keygen <private-key-file>
       bun scripts/codex-hub-sign.ts pubkey <private-key-file>
       bun scripts/codex-hub-sign.ts sign <private-key-file> <build>...`

function fail(text: string): never {
  console.error(text)
  process.exit(1)
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

function readKey(path: string): KeyObject {
  let key: KeyObject
  try {
    key = createPrivateKey(readFileSync(path))
  } catch (error) {
    fail(`Could not read a private key from ${path}: ${message(error)}`)
  }
  if (key.asymmetricKeyType !== 'ed25519')
    fail(`${path} holds a ${key.asymmetricKeyType} key, not ed25519.`)
  return key
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

const [command, keyFile, ...rest] = process.argv.slice(2)
if (!keyFile) fail(USAGE)

if (command === 'keygen' && rest.length === 0) {
  const { privateKey } = generateKeyPairSync('ed25519')
  try {
    // wx: an existing key is never written over; the builds signed with it would no longer verify anywhere.
    writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
      mode: 0o600,
      flag: 'wx',
    })
  } catch (error) {
    fail(
      (error as NodeJS.ErrnoException).code === 'EEXIST'
        ? `${keyFile} exists already; keygen does not write over a key.`
        : `Could not write ${keyFile}: ${message(error)}`,
    )
  }
  console.log(updateKeyText(privateKey))
} else if (command === 'pubkey' && rest.length === 0) {
  console.log(updateKeyText(readKey(keyFile)))
} else if (command === 'sign' && rest.length > 0) {
  const key = readKey(keyFile)
  // Every name is checked before anything is written.
  const builds = rest.map((file) => {
    const build = hubBuildOf(basename(file))
    if (!build)
      fail(
        `${file}: not a name the hub serves a build under (codex-hub-push.exe, codex-hub-tray.exe, ` +
          'codex-hub-push-<platform>, codex-hub-tray-<platform>).',
      )
    return { file, ...build }
  })
  for (const { file, name, platform } of builds) {
    let sha256: string
    try {
      sha256 = await sha256Of(file)
    } catch (error) {
      fail(`Could not read ${file}: ${message(error)}`)
    }
    writeFileSync(`${file}.sig`, `${signBuild(key, name, platform, sha256)}\n`)
    console.log(`${file}.sig: ${name} for ${platform}, sha256 ${sha256}`)
  }
  console.log(`public key ${updateKeyText(key)}`)
} else {
  fail(USAGE)
}
