// server/src/core/codex-hub-signature.ts — the signature on a pusher or tray build that a Codex hub hands out.
//
// A PC runs the build its hub hands out (codex-hub-update.ts, codex-hub-tray/), and the hash it checks a download
// against comes from the same address. Over plain http anyone on the way can answer both, so the hash proves nothing.
// Each build is signed instead, away from the hub, with the operator's ed25519 key: scripts/codex-hub-sign.ts writes
// `<build>.sig` beside the build in the hub's .pusher folder, the hub serves it with the hash (`signature`, base64)
// and never holds the private key, and each PC has the public key from its own build or configuration.
//
// The signed text names the build and its platform beside its SHA-256 (lowercase hex), so a signature holds for one
// use only: a tray build is never taken as the pusher, nor one platform's build on another.
//
//   codex-hub-build v1\n<pusher|tray>\n<platform>\n<sha256>\n
//
// Nothing here reads the configuration, so the signing script can load this module on its own.

import { createPublicKey, type KeyObject, sign, verify } from 'node:crypto'

/** The platforms a build is handed out for, named as `bun build --compile --target=bun-<platform>` names them. */
export const HUB_PLATFORMS = [
  'windows-x64',
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
] as const

export type HubBuildName = 'pusher' | 'tray'

/** The text a build's signature signs. */
export function buildSignedText(name: HubBuildName, platform: string, sha256: string): string {
  return `codex-hub-build v1\n${name}\n${platform}\n${sha256}\n`
}

/** The public key in its base64 form (the raw 32 bytes, as a build is given it); null for anything else. */
export function updateKeyFrom(text: string): KeyObject | null {
  const b64 = text.trim()
  const raw = Buffer.from(b64, 'base64')
  if (raw.length !== 32 || raw.toString('base64') !== b64) return null
  try {
    return createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
      format: 'jwk',
    })
  } catch {
    return null
  }
}

/** The base64 form of an ed25519 key's public half, private or public key given (its JWK has `x` either way). */
export function updateKeyText(key: KeyObject): string {
  const { x } = key.export({ format: 'jwk' }) as { x: string }
  return Buffer.from(x, 'base64url').toString('base64')
}

/** The signature (base64) of the build of name for platform whose SHA-256 is sha256. */
export function signBuild(
  privateKey: KeyObject,
  name: HubBuildName,
  platform: string,
  sha256: string,
): string {
  return sign(null, Buffer.from(buildSignedText(name, platform, sha256)), privateKey).toString(
    'base64',
  )
}

/** Whether signature (base64) is key's for the build of name for platform whose SHA-256 is sha256. */
export function buildSignatureValid(
  key: KeyObject,
  name: HubBuildName,
  platform: string,
  sha256: string,
  signature: string,
): boolean {
  const sig = Buffer.from(signature.trim(), 'base64')
  if (sig.length !== 64) return false
  try {
    return verify(null, Buffer.from(buildSignedText(name, platform, sha256)), key, sig)
  } catch {
    return false
  }
}

/**
 * The build a file in the hub's .pusher folder holds, by its name (codex-hub.ts hubBuildFile): codex-hub-push.exe
 * and codex-hub-tray.exe for windows-x64, codex-hub-push-<platform> and codex-hub-tray-<platform> for the others;
 * null for any other name.
 */
export function hubBuildOf(fileName: string): { name: HubBuildName; platform: string } | null {
  const m = /^codex-hub-(push|tray)(?:\.exe|-([a-z0-9-]+))$/.exec(fileName)
  if (!m) return null
  const platform = m[2] ?? 'windows-x64'
  if (m[2] === 'windows-x64' || !(HUB_PLATFORMS as readonly string[]).includes(platform))
    return null
  return { name: m[1] === 'push' ? 'pusher' : 'tray', platform }
}
