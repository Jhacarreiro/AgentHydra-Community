# Getting started with AgentHydra Community

Choose the path that matches what you want. **You do not need a hub to use AgentHydra on one computer.** The Codex hub is an optional, self-hosted addition, not a cloud account or an included hosted service.

## A. Use AgentHydra on one Windows PC

1. Go to the [latest official Community release](https://github.com/Jhacarreiro/AgentHydra-Community/releases/latest). Download the **Windows x64 ZIP** (not the standalone EXE), then extract the **whole ZIP** into a folder you can keep.
2. Open `AgentHydra.exe` in that extracted folder. Do not move the EXE away from its `app`, `desk2`, `misc` and `orchestrator` folders.
3. On the first launch, allow the app to fetch its pinned Bun runtime if it asks; that requires internet access. Additional coding tools may be downloaded only when you first use features that need them. Sign in to the coding tools themselves as needed; AgentHydra is not an account provider.
4. Open the app and check that your local sessions appear. A single-PC install is now complete.

**Prefer an installed copy with a Start Menu shortcut?** Download the repository's [Windows installer script](https://github.com/Jhacarreiro/AgentHydra-Community/blob/main/install.ps1) and run it in PowerShell. It downloads the latest release ZIP, checks its SHA-256 against the release checksums and installs under your user profile without Administrator rights. Read the script before running it. The full command and details are in [README — Install](../README.md#install).

**Linux or macOS:** use the matching release tarball. For developer installations from source, see [README — Install](../README.md#install). The Windows installer script does not support these platforms.

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
| Windows EXE opens but parts of the app are missing | Extract the **full ZIP**, with its accompanying directories. Do not run only the standalone launcher in an offline environment. |
| First launch cannot fetch Bun or a tool | Check network access and the app's error message. The release does **not** bundle Bun or all coding tools. |
| Hub is up but a PC cannot pair | Check HTTPS, reverse-proxy routing, your authentication gate, and the one-time pairing link's expiry. |
| PC was revoked or reinstalled | Follow the [re-pairing/replacement procedure](CODEX-HUB.md#pairing-from-the-connect-button); do not share the admin token or another PC's token. |
| Tray builds or updates are refused | Check that they were built for **your hub** and signed with **your signing key**, not the project's generic release. |

For deeper technical details and platform-specific prerequisites, use [the operator guide](CODEX-HUB.md) and the [reference](REFERENCE.md). For an installation issue, open a [GitHub issue](https://github.com/Jhacarreiro/AgentHydra-Community/issues) with your operating system, release version, the exact error text and steps to reproduce. **Never attach tokens, sign-in data, private URLs or full configuration files.**
