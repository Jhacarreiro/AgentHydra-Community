# AgentHydra Community — Docker Hub (experimental)

A generic Linux-container deployment for people running Docker Engine or Docker Desktop on Linux, macOS or Windows. The **Hub remains loopback-only inside its container**. A small gateway in the *same network namespace* forwards it to a port bound to **127.0.0.1 on the host only**. This does **not** publish a Hub to the internet or replace an authenticated reverse proxy.

**TL;DR**

- `docker compose up -d` in a folder holding this `compose.yaml` starts the newest release's published image; no clone needed.
- The hub answers only on `127.0.0.1:7788` of the host; put your own authenticated proxy in front to reach it from elsewhere.
- `hub-updater.mjs watch`, run beside Docker, installs new stable releases and puts back the previous version and its data if one fails.
- The hub never gets the Docker socket, and the browser for ChatGPT stays on the host.

## Getting started

1. Install Docker Engine + Compose plugin or Docker Desktop.
2. Put this folder's `compose.yaml` in a folder of its own and run `docker compose up -d` there. It pulls `ghcr.io/jhacarreiro/agenthydra-community-hub`, the image each Community release publishes for amd64 and arm64.
3. Check `http://127.0.0.1:7788/api/health` on **the host**. Verify the bound port is loopback only; don't expose 7788 through router, firewall or reverse proxy without an explicit authentication layer.
4. To turn the Codex hub on, copy `hub.env.example` to `hub.env` beside `compose.yaml`, generate a strong unique admin token using `openssl rand -hex 32`, make the file readable only by you, and run `docker compose up -d` again. Do not share the admin token with client PCs.

Without a `.env`, Compose runs the image tagged `latest`. A `.env` line such as `AGENTHYDRA_VERSION=2026.10.1` pins a release, and an older one goes back to it. The updater records the running release in that line on its first run and changes only that line. Keep `.env` and `hub.env` out of version control.

Without access to the registry, `docker compose build` (with the `Dockerfile` beside `compose.yaml`) makes the same image from the release archive, checked against its published SHA256SUMS.

The Hub stores its configuration and PC pairings in the named volume `hub_state`. Back it up before upgrading. Never use `docker compose down -v` unless you intentionally want to delete all Hub state.

<details>
<summary><b>Product Docker updater (host-side, no cron)</b></summary>

`hub-updater.mjs` is the **AgentHydra Community Docker update manager**. It belongs to this repository and runs on the Docker **host**, not in the Hub container. It uses the host's Docker CLI; the Hub never receives the Docker socket. Node.js 20+ and Docker Compose are required.

- `node hub-updater.mjs check` — read the latest stable Community GitHub release, compare with `AGENTHYDRA_VERSION` in the local `.env` (no writes).
- `node hub-updater.mjs update` — pull the new release's image (or, if that fails, build and checksum-verify it) while the current Hub keeps running, stop the Hub, archive its state volume, start the new image and wait for `http://127.0.0.1:7788/api/health` from the new container. `AGENTHYDRA_VERSION` in `.env` changes only after that check passes.
- `node hub-updater.mjs watch` — keep running as a supervised host process, checking every six hours by default (`AGENTHYDRA_DOCKER_UPDATE_MINUTES`, minimum five minutes). Use the host's native service supervisor (systemd on Linux or launchd on macOS) for process lifetime; this is **not** a scheduled cron job.

If the new release fails its healthcheck, the manager puts back the previous image by its ID (re-tagging it, so a rebuilt tag cannot substitute another image), restores the state archive taken before the new release started, and starts the previous release again. Each step is recorded in `.hub-update.json`; when an update is interrupted (power loss, a killed process), the next `update` or `watch` run rolls it back the same way before doing anything else. If the rollback itself fails, the journal is marked `failed` and the manager makes no further changes until you recover from the retained backup and remove `.hub-update.json`.

For hosts with a standalone `docker-compose` binary instead of the Compose plugin, set `AGENTHYDRA_DOCKER_COMPOSE=docker-compose` (or its full path); `AGENTHYDRA_DOCKER` names the Docker CLI if it is not `docker` on the manager's `PATH`. `AGENTHYDRA_DOCKER_HEALTH_URL` and `AGENTHYDRA_DOCKER_HEALTH_SECONDS` (default 90) change the healthcheck. A lock file (`.hub-update.lock`, holding the manager's process ID) prevents two updates at once; a lock left by a process that no longer runs is taken over.

The previous release's image is kept; older ones are removed after a successful update. The three newest state archives are kept under `.hub-backups/` with restrictive permissions. **Backups contain secrets and production state: protect them and exclude them from source control and published artifacts.** The update needs enough disk space for both images and the archive.

The manager assumes the Hub has already been installed with the steps above. The containerized native self-updater must not mutate the image. Do not deploy a second manager with the same Compose project name and volume.

</details>

<details>
<summary><b>ChatGPT</b></summary>

A signed-in headful browser belongs on its host OS, **not inside the Hub image**. The hub reaches ChatGPT through
the [OpenCLI](https://github.com/jackwener/opencli) Browser Bridge daemon on the host, which drives a window of that
host's own Chrome. In Desk, **Menu → ChatGPT** lists the account's conversations, shows each one with whether
ChatGPT is still thinking or writing, and sends the messages you write there (and only those, when you press Send).

To turn it on, run the Browser Bridge on the host with Chrome signed in to ChatGPT, then add to `.env`:

```sh
AGENTHYDRA_CHATGPT_ENABLED=1
# Where the hub finds the daemon; this default is the host as Docker Desktop and Colima name it.
# AGENTHYDRA_CHATGPT_BRIDGE_URL=http://host.docker.internal:19825
```

and `docker compose up -d`. The hub opens its own window in that Chrome the first time. On a hub with
`AGENTHYDRA_CODEX_HUB_TOKEN`, the ChatGPT routes take that admin token only, and a Desk on another PC reaches them
with `AGENTHYDRA_CHATGPT_HUB_URL` (the hub's address) and `AGENTHYDRA_CHATGPT_HUB_TOKEN` (or its Codex hub token).

Nothing is copied: each read asks ChatGPT, and the page in the browser reads with its own sign-in, so no token or
cookie reaches the hub. The daemon itself has no password; anything that can reach its port can drive that Chrome,
so keep it on the host's loopback and never publish it.

</details>
