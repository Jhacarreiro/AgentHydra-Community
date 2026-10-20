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
- `node hub-updater.mjs update` — build and checksum-verify the new image while the current Hub keeps running, stop the Hub, archive its state volume, start the new image and wait for `http://127.0.0.1:7788/api/health` from the new container. `AGENTHYDRA_VERSION` in `.env` changes only after that check passes.
- `node hub-updater.mjs watch` — keep running as a supervised host process, checking every six hours by default (`AGENTHYDRA_DOCKER_UPDATE_MINUTES`, minimum five minutes). Use the host's native service supervisor (systemd on Linux or launchd on macOS) for process lifetime; this is **not** a scheduled cron job.

If the new release fails its healthcheck, the manager puts back the previous image by its ID (re-tagging it, so a rebuilt tag cannot substitute another image), restores the state archive taken before the new release started, and starts the previous release again. Each step is recorded in `.hub-update.json`; when an update is interrupted (power loss, a killed process), the next `update` or `watch` run rolls it back the same way before doing anything else. If the rollback itself fails, the journal is marked `failed` and the manager makes no further changes until you recover from the retained backup and remove `.hub-update.json`.

For hosts with a standalone `docker-compose` binary instead of the Compose plugin, set `AGENTHYDRA_DOCKER_COMPOSE=docker-compose` (or its full path); `AGENTHYDRA_DOCKER` names the Docker CLI if it is not `docker` on the manager's `PATH`. `AGENTHYDRA_DOCKER_HEALTH_URL` and `AGENTHYDRA_DOCKER_HEALTH_SECONDS` (default 90) change the healthcheck. A lock file (`.hub-update.lock`, holding the manager's process ID) prevents two updates at once; a lock left by a process that no longer runs is taken over.

The Dockerfile verifies each downloaded release archive against its published SHA256SUMS. The previous release's image is kept; older ones are removed after a successful update. The three newest state archives are kept under `.hub-backups/` with restrictive permissions. **Backups contain secrets and production state: protect them and exclude them from source control and published artifacts.** The update needs enough disk space for both images and the archive.

The manager assumes the Hub has already been installed with the steps above. The containerized native self-updater must not mutate the image. Do not deploy a second manager with the same Compose project name and volume.

## Browser integrations

A logged-in headful browser belongs on its host OS, **not inside the Hub image**. The experimental ChatGPT OpenCLI adapter expects local browser access and is disabled in Docker. A safe, authorized host-to-container browser bridge has not yet been implemented; don't expose CDP or an arbitrary-command browser endpoint over the network.
