/**
 * The remote gateway's configuration: where it lives on disk, the OAuth client it presents to
 * your sign-in provider, and the tunnel it opens. Everything persistent sits under `state/remote/`,
 * which the repo ignores (`state/` is runtime state, never source).
 *
 * Nothing is configured out of the box. Until `oauth` names an OpenID Connect provider of your own
 * (issuer, client id, redirect URI), the gateway serves loopback only: it refuses to open a tunnel
 * and answers 401 to any request that arrives through one. With it, the first verified sign-in
 * made at the machine itself claims the install, and that owner is persisted. A Quick Tunnel's
 * sign-in returns through a relay you run (`relay`, by default the origin of `oauth.redirectUri`);
 * a named Cloudflare tunnel (a stable hostname on your own zone) is opt-in via `tunnel`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import orchestratorPkg from '../../package.json' with { type: 'json' }
import { restrictToCurrentUser } from './fs-perms.ts'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
/** Same resolution as scripts/lib/ledgerlib._state_dir(): the env override, else <repo>/state. */
export const STATE_DIR = process.env.ORCHESTRATOR_STATE_DIR
  ? resolve(process.env.ORCHESTRATOR_STATE_DIR)
  : join(REPO_ROOT, 'state')
export const CONFIG_DIR = join(STATE_DIR, 'remote')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

/** Written once, in the orchestrator's package.json `config.remotePort`; the tray, remote.py and
 *  the named tunnels' ingress (remote_tunnel.py) read the same value. */
export const DEFAULT_PORT: number = orchestratorPkg.config.remotePort
/** The port this gateway binds: ORCH_REMOTE_PORT for one run, else DEFAULT_PORT. */
export function gatewayPort(): number {
  return Number(process.env.ORCH_REMOTE_PORT) || DEFAULT_PORT
}
/** scripts/dashboard.py's port - the read-only data layer this gateway fronts. */
export const DASHBOARD_PORT = 7799
/** The AgentHydra daemon, same env override hydralib honours. */
export const DAEMON_URL = (process.env.AGENTHYDRA_URL ?? 'http://127.0.0.1:7787').replace(
  /\/+$/,
  '',
)

export interface OAuthConfig {
  /** IdP issuer origin, e.g. https://accounts.example.com */
  issuer: string
  clientId: string
  /** The EXACT registered redirect URI a Quick Tunnel login must use (the relay's callback). */
  redirectUri: string
  /** Only for a confidential client; a public client signs in with PKCE alone. */
  clientSecret?: string
  /** Space-separated; default "openid profile email". */
  scopes?: string
  /** The owner, locked on first verified sign-in (TOFU). Either field matches. */
  ownerSub?: string
  ownerEmail?: string
}

export interface TunnelConfig {
  /** "quick" forces the free rotating tunnel even when a named one is configured. */
  provider?: 'quick' | 'named'
  /** The stable public host a named tunnel serves, e.g. "orch.example.com". */
  hostname?: string
  /** Named-tunnel connector token. Sensitive - config.json is ACL-restricted for this reason. */
  token?: string
  /** The network card cloudflared dials Cloudflare's edge from, e.g. "Ethernet", when a full-tunnel VPN blocks
   *  the edge's port 7844 (tunnel.ts edgeBindAddress). Unset dials the default way. */
  edgeInterface?: string
}

/** Ed25519 identity that signs relay announcements. The private half never leaves this disk. */
export interface RelayIdentity {
  id: string
  publicKey: string
  privateKey: string
}

export interface RelayConfig {
  /** Base URL of the relay that serves the permanent /r/<id> address; empty means the origin of
   *  `oauth.redirectUri`, where the relay answers the OAuth callback too. */
  url?: string
  identity?: RelayIdentity
}

export interface RemoteConfig {
  oauth?: OAuthConfig
  tunnel?: TunnelConfig
  relay?: RelayConfig
}

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
}

export function loadConfig(): RemoteConfig {
  let stored: RemoteConfig = {}
  try {
    stored = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as RemoteConfig
  } catch (err) {
    // A missing file is an empty config with no warning; anything else is reported as before.
    const code = (err as { code?: string }).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      console.warn(
        `[orchestrator-remote] ${CONFIG_PATH} is not valid JSON, using an empty config: ${String(err)}`,
      )
    }
  }
  return stored
}

export function saveConfig(cfg: RemoteConfig): void {
  ensureConfigDir()
  writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 })
  restrictToCurrentUser(CONFIG_PATH)
}

/** OIDC configured => a tunnel may open, and every request through it needs a signed-in owner. */
export function authEnforced(cfg: RemoteConfig): boolean {
  return !!(cfg.oauth?.issuer && cfg.oauth.clientId && cfg.oauth.redirectUri)
}

export function ownerConfigured(cfg: RemoteConfig): boolean {
  return !!(cfg.oauth?.ownerSub || cfg.oauth?.ownerEmail)
}

/** Why a tunnel must NOT be opened, or null when it may. A public URL with no auth is the machine on the open internet. */
export function tunnelStartProblem(cfg: RemoteConfig): string | null {
  if (!authEnforced(cfg)) return 'auth'
  return null
}

/** Named-tunnel credentials, or null for the default Quick Tunnel. CF_TUNNEL_TOKEN overrides the file. */
export function namedTunnel(cfg: RemoteConfig): { hostname: string; token: string } | null {
  if (cfg.tunnel?.provider === 'quick') return null
  const hostname = cfg.tunnel?.hostname?.trim()
  const token = (process.env.CF_TUNNEL_TOKEN ?? cfg.tunnel?.token ?? '').trim()
  if (!hostname || !token) return null
  return { hostname, token }
}

/** The relay's base URL: `relay.url`, else the origin of `oauth.redirectUri`, else null (none configured). */
export function relayBase(cfg: RemoteConfig): string | null {
  const url = cfg.relay?.url?.trim()
  if (url) return url.replace(/\/+$/, '')
  try {
    return cfg.oauth?.redirectUri ? new URL(cfg.oauth.redirectUri).origin : null
  } catch {
    return null
  }
}

/** Key-free projection for /api/status - hostname + token PRESENCE, never a token or a private key. */
export function redactConfig(cfg: RemoteConfig): Record<string, unknown> {
  return {
    port: gatewayPort(),
    oauth: cfg.oauth
      ? {
          issuer: cfg.oauth.issuer,
          clientId: cfg.oauth.clientId,
          redirectUri: cfg.oauth.redirectUri,
          ownerClaimed: ownerConfigured(cfg),
        }
      : null,
    tunnel: {
      provider: namedTunnel(cfg) ? 'named' : 'quick',
      hostname: cfg.tunnel?.hostname?.trim() || null,
      hasToken: !!(process.env.CF_TUNNEL_TOKEN ?? cfg.tunnel?.token ?? '').trim(),
      edgeInterface: cfg.tunnel?.edgeInterface?.trim() || null,
    },
    relay: { url: relayBase(cfg), id: cfg.relay?.identity?.id ?? null },
  }
}
