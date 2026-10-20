# AgentHydra Community — Docker Hub (experimental)

A generic Linux-container deployment for people running Docker Engine or Docker Desktop on Linux, macOS or Windows. The **Hub remains loopback-only inside its container**. A small gateway in the *same network namespace* forwards it to a port bound to **127.0.0.1 on the host only**. This does **not** publish a Hub to the internet or replace an authenticated reverse proxy.

## Getting started

1. Install Docker Engine + Compose plugin or Docker Desktop.
2. Copy `hub.env.example` to `hub.env`, generate a strong unique admin token using `openssl rand -hex 32`, and make the file readable only by you. Do not share the admin token with client PCs.
3. Create a local `.env` containing `AGENTHYDRA_VERSION=2026.10.0` (or a newer verified release). Run `docker compose up -d --build` from this directory. The updater reads and changes only this version line. Keep `.env` and `hub.env` out of version control.
4. Check `http://127.0.0.1:7788/api/health` on **the host**. Verify the bound port is loopback only; don't expose 7788 through router, firewall or reverse proxy without an explicit authentication layer.

The Hub stores its configuration and PC pairings in the named volume `hub_state`. Back it up before upgrading. Never use `docker compose down -v` unless you intentionally want to delete all Hub state.

## Product Docker updater (host-side, no cron)

`hub-updater.mjs` is the **AgentHydra Community Docker update manager**. It belongs to this repository and runs on the Docker **host**, not in the Hub container. It uses the host's Docker CLI; the Hub never receives the Docker socket. Node.js 20+ and Docker Compose are required.

- `node hub-updater.mjs check` — read the latest stable Community GitHub release, compare with `AGENTHYDRA_VERSION` in the local `.env` (no writes).
- `node hub-updater.mjs update` — build and checksum-verify the new image, stop the Hub for a consistent volume backup, bring up the new image, verify `http://127.0.0.1:7788/api/health`, and roll back the image and state archive on failure.
- `node hub-updater.mjs watch` — keep running as a supervised host process, checking every six hours by default (`AGENTHYDRA_DOCKER_UPDATE_MINUTES`, minimum five minutes). Use the host's native service supervisor (systemd on Linux or launchd on macOS) for process lifetime; this is **not** a scheduled cron job. The manager is the implementation, not a custom per-server updater.

For hosts with legacy `docker-compose` instead of the Compose plugin, set `AGENTHYDRA_DOCKER_COMPOSE=docker-compose`. The Docker CLI must be in the manager's `PATH`. Do not run two updater instances simultaneously; the lock directory prevents concurrent updates.

The Dockerfile verifies each downloaded release archive against its published SHA256SUMS. The previous immutable image is retained, and backups are written under `.hub-backups/` with restrictive permissions. **Backups contain secrets and production state: protect them and exclude them from source control and published artifacts.** The backup and rollback require enough disk space for both images and the archive. A DB schema migration that cannot safely downgrade may require manual recovery from the backup; the manager reports a hard error if automated rollback fails.

The manager currently assumes the Hub has already been installed and that its local health endpoint is available on 127.0.0.1:7788. The containerized native self-updater must not mutate the image. Do not deploy a second manager with the same Compose project name and volume.

## Browser integrations

A logged-in headful browser belongs on its host OS, **not inside the Hub image**. The experimental ChatGPT OpenCLI adapter expects local browser access and is disabled in Docker. A safe, authorized host-to-container browser bridge has not yet been implemented; don't expose CDP or an arbitrary-command browser endpoint over the network.
