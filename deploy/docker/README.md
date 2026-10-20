# AgentHydra Community — Docker Hub (experimental)

A generic Linux-container deployment for people running Docker Engine or Docker Desktop on Linux, macOS or Windows. The **Hub remains loopback-only inside its container**. A small gateway in the *same network namespace* forwards it to a port bound to **127.0.0.1 on the host only**. This does **not** publish a Hub to the internet or replace an authenticated reverse proxy.

## Getting started

1. Install Docker Engine + Compose plugin or Docker Desktop.
2. Copy `hub.env.example` to `hub.env`, generate a strong unique admin token using `openssl rand -hex 32`, and make the file readable only by you. Do not share the admin token with client PCs.
3. Select a released version with `AGENTHYDRA_VERSION` (default is the initial release) and run `docker compose up -d --build` from this directory.
4. Check `http://127.0.0.1:7788/api/health` on **the host**. Verify the bound port is loopback only; don't expose 7788 through router, firewall or reverse proxy without an explicit authentication layer.

The Hub stores its configuration and PC pairings in the named volume `hub_state`. Back it up before upgrading. Never use `docker compose down -v` unless you intentionally want to delete all Hub state.

## Updating

This installation starts from published release tarballs and Docker builds the image locally; it does not depend on the original upstream repository. Update only after a new Community release has been published. Docker images are immutable. **The in-process native self-updater must not replace container files.** Select a new tagged Community release (`AGENTHYDRA_VERSION`), verify its release checksums, run `docker compose build --pull`, then `docker compose up -d`. The Dockerfile verifies `SHA256SUMS.txt` during the build. Keep the previous tagged image and a volume backup for rollback; database migrations may not be backwards-compatible. No cron, direct Docker socket mount, or silent container self-replacement.

This is a deliberately conservative first-class Docker installation path, not automatic image updating. A future product-integrated container update experience should provide explicit confirmation, integrity checks and rollback through the supported host deployment mechanism.

## Browser integrations

A logged-in headful browser belongs on its host OS, **not inside the Hub image**. The experimental ChatGPT OpenCLI adapter expects local browser access and is disabled in Docker. A safe, authorized host-to-container browser bridge has not yet been implemented; don't expose CDP or an arbitrary-command browser endpoint over the network.
