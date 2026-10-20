# Getting started with AgentHydra Community

Choose the path that matches what you want. **You do not need a hub to use AgentHydra on one computer.** The Codex hub is an optional, self-hosted addition, not a cloud account or an included hosted service.

## A. Install on one PC (no server required)

**Windows x64 — easiest first install**

1. Open the [latest Community release](https://github.com/Jhacarreiro/AgentHydra-Community/releases/latest) and download `AgentHydra-<version>-windows-x64.zip` from **Assets**.
2. Right-click the ZIP and choose **Extract All**. Keep the extracted folder together; do not copy the executable out of it.
3. Open `AgentHydra.exe` **inside the extracted folder**. Windows may display a security prompt for an unsigned build; verify the file came from this project's release rather than bypassing warnings for an unknown download.
4. The first launch needs an internet connection to download the pinned Bun runtime, and features may need additional tools on first use. Sign into the coding tools you use. Your local sessions should then appear in the window.

**Alternative:** a standalone Windows `.exe` is available for users with an internet connection; it fetches the remaining application files. The **complete ZIP** is recommended for troubleshooting and offline preparation (the app may still need Bun or other tools online).

**Verify your download:** download `SHA256SUMS.txt` from the same release, calculate the SHA-256 of the ZIP using Windows PowerShell `Get-FileHash -Algorithm SHA256`, and compare it with the matching filename in the checksum file. Do not run an unexpected download if they differ.

**Installed copy:** the optional [Windows PowerShell installer](https://github.com/Jhacarreiro/AgentHydra-Community/blob/main/install.ps1) downloads the release ZIP, verifies its checksum and installs under your user profile, without Administrator rights. Read the script before running it. See [README — Install](../README.md#install).

**macOS / Linux:** download the tarball matching your OS and architecture from the same release. Consult [README — Install](../README.md#install) for prerequisites and source installation. The PowerShell installer is Windows-only.

**No hub setup is needed** to use AgentHydra on one PC. Only follow section B if you specifically want the self-hosted multi-PC feature.

## B. See Codex chats from several PCs in one place

This requires **two separate installations**: one always-on AgentHydra hub, plus a client on each participating PC. Merely installing the normal Windows app does not automatically connect multiple PCs.

1. Install and start the Community daemon on a computer that remains on. Follow [Codex hub: server setup](CODEX-HUB.md#1-the-hub-on-a-home-server) to create its separate **admin token** and run it as a service. **Never give the admin token to a client PC.**
2. Configure a reverse proxy with HTTPS. Allow the PC API path `/api/codex-hub/`; put `/codex-hub/pair` behind your own sign-in. Follow [proxy and access instructions](CODEX-HUB.md#2-your-own-reverse-proxy-or-access-layer). Do **not** expose a pairing page openly on the internet.
3. Create your own update-signing key and build a tray app for your hub's address and public key; the release cannot contain a universal preconfigured tray. Follow [signing](CODEX-HUB.md#3-the-signing-key), [building](CODEX-HUB.md#4-building-the-tray-and-the-builds-the-hub-hands-out) and [publishing your signed builds](CODEX-HUB.md#sign-then-put-the-builds-on-the-hub).
4. Transfer the resulting tray app and its required licence files to each PC using a trusted channel. Verify its checksum. Start it once on each PC, then choose **Connect this PC** and approve the one-time pairing code on your protected hub page. Follow [pairing steps](CODEX-HUB.md#5-setting-up-a-pc-install-the-tray-and-connect).
5. Verify that two PCs show up with separate identities, that each PC's chats appear in Desk, and that you can continue a chat while that PC is online. Test revocation of **one** PC without disconnecting the other; see [PC administration](CODEX-HUB.md#listing-pcs-and-revoking-one).

**What this does not provide yet:** a ready-to-download universal tray, a managed hub service, automated reverse-proxy configuration or zero-configuration multi-PC installation. Expect to administer your own server, TLS, sign-in and signing keys. This path is intended for technical self-hosters.

## C. If something goes wrong

| Symptom | Check first |
| --- | --- |
| Windows EXE opens but parts of the app are missing | Extract the **full ZIP**, with its accompanying directories. A standalone launcher can fetch the app only when the network and release downloads are available. |
| First launch cannot fetch Bun or a tool | Check network access and the app's error message. The release does **not** bundle Bun or all coding tools. |
| Hub is up but a PC cannot pair | Check HTTPS, reverse-proxy routing, your authentication gate, and the one-time pairing link's expiry. |
| PC was revoked or reinstalled | Follow the [re-pairing/replacement procedure](CODEX-HUB.md#pairing-from-the-connect-button); do not share the admin token or another PC's token. |
| Tray builds or updates are refused | Check that they were built for **your hub** and signed with **your signing key**, not the project's generic release. |

For deeper technical details and platform-specific prerequisites, use [the operator guide](CODEX-HUB.md) and the [reference](REFERENCE.md). For an installation issue, open a [GitHub issue](https://github.com/Jhacarreiro/AgentHydra-Community/issues) with your operating system, release version, the exact error text and steps to reproduce. **Never attach tokens, sign-in data, private URLs or full configuration files.**

## Managed macOS Hub (experimental)

On the Mac that will host the Hub, first extract a Community macOS release archive into a stable directory. Verify the version with `./agenthydra --version`. The Hub uses its own built-in GitHub release updater; it is **not** updated by launchd or cron.

From the source repository, run `scripts/install-hub-macos.sh /absolute/path/to/extracted/AgentHydra --dry-run` to check the intended service location, then run with `--enable-native-updates` to register a per-user launchd service and enable the product's own updater in Settings. Optionally set `AGENTHYDRA_CHATGPT_OPENCLI` to the absolute path of your existing OpenCLI binary when running the installer; the managed service will inherit that executable path without importing browser credentials. The installer backs up an existing plist, validates the new one and logs to `~/Library/Logs/AgentHydraCommunity`. It does not provision authentication, reverse proxy, tokens, or DNS. Those require separate operator-specific setup.

Do not install two daemons on the same data directory or port. Validate the new Mac Hub and clients before disabling an older installation. The current release might predate this script; use a release that contains this installer and the desired features.
