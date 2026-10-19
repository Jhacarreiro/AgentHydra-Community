# Codex hub: one list of the Codex chats on all your PCs

A Codex chat lives on the PC that ran it. The Codex hub is one AgentHydra daemon, on a home server or any PC that
stays on, that each of your PCs pushes its Codex chats to. Desk then lists every PC's chats, each marked with the PC
it came from, and can continue one on its own PC while that PC is on. A small tray app sets each PC up: it gets a
token of its own from a pairing page, runs the pusher, and keeps itself and the pusher at the builds the hub hands
out, which you sign with your own key.

This page is the operator's guide: setting up the server, the proxy in front of it, the tray builds and the key. The
details of each route, header and variable are in
[REFERENCE.md, Codex chats from other PCs](REFERENCE.md#codex-chats-from-other-pcs-codex-hub).

**TL;DR**

- **The hub is the daemon with `AGENTHYDRA_CODEX_HUB_TOKEN` set.** That value is your own admin token, and no PC is
  ever given it. The hub listens on `127.0.0.1:7787` and on nothing else; change the port with `PORT`.
- **Your own HTTPS proxy forwards two paths and nothing else.** `/api/codex-hub/`, where each PC's own token is the
  authentication, and `/codex-hub/pair`, only behind your own sign-in, because that page hands out one-time pairing
  codes.
- **You make the signing key, and you keep it.** No key is in this repository. It stays outside the checkout, and the
  trays and pushers refuse any build it did not sign.
- **`codex-hub-tray/build.sh` builds the tray with your addresses and public key,** the same bytes every time from the
  same commit.
- **Open the tray once on each PC.** It installs itself, opens the pairing page, and you choose Connect. The tray
  makes a token of its own, and the hub keeps only its hash.
- **Each PC has a token of its own; revoke one with `scripts/codex-hub-pcs.ts` without touching the others.** A
  PC's token pushes and relays as that PC alone, and changing the admin token pairs no PC again.
- **A hub that ran before PCs had tokens of their own moves them over by themselves** while a migration window you
  open lasts: [Moving PCs to tokens of their own](#moving-pcs-to-tokens-of-their-own).

<details>
<summary>What has been tested, and what has not</summary>

Tested, by automated tests in this repository:

- **The hub as a server, with two PCs** (`server/tests/codex-hub-multi-pc.test.ts`). The test starts the real daemon
  in a scratch HOME on a loopback port and pairs two PCs through the pairing page as the tray does: each gets a token
  of its own, pushes its own chat, and the hub lists each chat under its own PC. Each PC opens a relay. These are
  refused, and write nothing: a request with no token, with a wrong one, without `Bearer`, with a network `Host`, or
  with the admin token. One PC's token in a push that names the other PC writes under its own PC, and its relay
  opens as its own. The test then revokes one PC with `scripts/codex-hub-pcs.ts`: its relay closes, its push and
  build check are refused as revoked, and the other PC goes on; paired again, it gets a new token, and the old one is
  unknown. A restart with a new admin token keeps both PCs' tokens. Last, a PC that pushed with the shared token of
  before moves to a token of its own while the migration window is open, and only then. It has run on Linux; it is
  skipped on Windows, where the daemon starts its tray host at boot.
- **Every route and refusal of the hub, in process** (`server/tests/codex-hub-auth.test.ts` and
  `codex-hub-pcs.test.ts`): who may call what, each state of the pairing page, pairing codes and confirmations,
  revoking, retiring and forgetting, the migration window, and a revoke that races a push or a relay. The pusher's
  side is `codex-hub-push-auth.test.ts`: its install id's file, what it says for each refusal, and its relay's waits.
- **The tray on Linux, end to end** (`codex-hub-tray/test-linux.sh`). It runs against a fake hub: installing,
  pairing with a code, the pusher, self-update, refusing unsigned builds and builds signed with another key, moving
  to a new key, a PC without a desktop taking a token from `add` in its `tray.json`, moving off the shared token, a
  tray from before tokens of their own updating itself and then moving, and a revoke. It also pairs, moves and
  revokes PCs against the real hub (`scripts/codex-hub-test-daemon.ts`). It runs on every change to the tray or to
  the hub's side of what it talks to (`.github/workflows/codex-hub-tray.yml`).
- **`go vet` for the tray, for Linux and Windows, `go test` on Linux,** and **the reproducible build:** two builds
  from one commit, the second in another folder with an empty build cache, give the same SHA-256.

Not tested yet:

- The tray on Windows, beyond `go vet` and a build, and on macOS at all. `codex-hub-tray/test-macos.sh` exists and
  the workflow has a macOS job, but neither has run for this version.
- A real reverse proxy or sign-in in front of the hub. The checks in [Check it from outside](#check-it-from-outside)
  are how you test yours.
- More than a few PCs, large chat histories over a slow link, or a hub that runs for weeks.

So treat it as a setup for your own PCs that you watch, not as a service other people depend on.

</details>

## 1. The hub on a home server

The hub is the AgentHydra daemon from a checkout of this repository, run with Bun. It needs nothing else for the hub:
the chats arrive from the PCs. Desk, the window you read them in, is set up as the README says. To continue another
PC's chat, Desk needs the hub's `AGENTHYDRA_CODEX_HUB_TOKEN`, the admin token, in its environment; a Desk the daemon
starts has it.

```sh
git clone https://github.com/Jhacarreiro/AgentHydra-Community.git ~/AgentHydra-Community
cd ~/AgentHydra-Community
bun install --frozen-lockfile
```

Make the admin token, a long random ASCII string, and keep it in a file only you can read, outside the checkout. It
turns the hub on, and Desk and the hub's command line use it on the server. No PC is ever given it, and the routes the
PCs use refuse it:

```sh
umask 077
mkdir -p ~/.config/codex-hub
printf 'AGENTHYDRA_CODEX_HUB_TOKEN=%s\nPORT=7787\nAGENTHYDRA_PORT_FIXED=1\n' "$(openssl rand -hex 32)" \
  >~/.config/codex-hub/hub.env
```

**A hub that ran before PCs had tokens of their own** has in its `hub.env` the token all its PCs share. Do not keep
that value as the admin token: before you update such a hub, read
[Moving PCs to tokens of their own](#moving-pcs-to-tokens-of-their-own).

Then run the daemon with that file, for example as a systemd user service
(`~/.config/systemd/user/codex-hub.service`):

```ini
[Unit]
Description=AgentHydra Codex hub
After=network-online.target

[Service]
WorkingDirectory=%h/AgentHydra-Community
EnvironmentFile=%h/.config/codex-hub/hub.env
ExecStart=%h/.bun/bin/bun run start
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now codex-hub.service
loginctl enable-linger   # keeps it running while you are logged out, and starts it at boot
curl -s http://127.0.0.1:7787/api/health
```

To check that the hub is on, run its command line on the server, from the checkout. `legacy window: off` with no
line after it means the hub is on and has no PC yet. "the hub at … is off" means the token did not reach the daemon,
and "the hub is not running at …" that nothing answers on that port:

```sh
cd ~/AgentHydra-Community
bun --env-file ~/.config/codex-hub/hub.env scripts/codex-hub-pcs.ts list
```

### The port

- **7787 by default.** Change it with `PORT=<port>` in the environment file, or `--port <port>` on the command line,
  which wins over `PORT`.
- **`AGENTHYDRA_PORT_FIXED=1` binds exactly that port.** Without it, a daemon that finds its port taken waits five
  seconds, then moves to the next free port above it. Your proxy does not forward that port. The setting also skips
  the check for another daemon already running, so let the service manager be the one thing that starts it.
- **It binds loopback only.** `HOST` may be `127.0.0.1`, `localhost` or `::1`, and the daemon refuses to start with
  anything else. The rest of its API has no authentication, by design, so it must never face the network.

### What the hub keeps

Everything is in the daemon's config folder: `~/.agenthydra`, or `AGENTHYDRA_HOME`.

- `codex-hub/<pc>/` holds each PC's copy of its chats.
- `codex-hub/.pcs.json` (mode 600) holds what the hub knows of each PC's token: its id and its SHA-256, the install
  id it is bound to, and when and how it was paired, first used or revoked. It never holds a token, a pairing code or
  the admin token.
- `codex-hub/.pusher/` holds the builds the hub hands out (step 4).

Keep the folder private (`chmod 700 ~/.agenthydra/codex-hub`), and back it up. When you copy or move it, copy the
whole folder with its dot-files: a hub without its `.pcs.json` knows none of its PCs' tokens, and every PC must pair
again. The hub never writes over a `.pcs.json` it cannot read (one that does not parse, or is of another version):
until you restore it and restart the hub, it refuses every PC's token with 503.

The hub never holds your signing key.

## 2. Your own reverse proxy or access layer

The PCs reach the hub through a proxy you run, with HTTPS: for example Caddy or nginx on the server, a tunnel, or a
VPN. Because the API answers loopback requests only, the proxy forwards each request with a loopback `Host`. It
forwards these two paths, and nothing else:

| Path | Who opens it | What authenticates it | The proxy must |
| --- | --- | --- | --- |
| `/api/codex-hub/` | each PC's tray and pusher | that PC's own token (`Authorization: Bearer`), sent with its install id, plus your access layer's own service token if it wants one | set `Host: 127.0.0.1:7787`, remove `Origin`, pass WebSocket upgrades (the relay), allow request bodies up to 16 MiB, and keep an idle WebSocket open for several minutes |
| `/codex-hub/pair` | your browser, on a PC you are setting up | **your own sign-in**, before the request reaches the hub | set `Host: 127.0.0.1:7787` and remove `Origin`; serve it only behind the sign-in, never on the `/api/codex-hub/` address and never to the home network |

Never forward anything else.

- **The rest of `/api/`** answers anyone who reaches it.
- **`/api/codex-relay/`** holds Desk's end of the relay, which runs turns on your PCs, and the admin API, which lists,
  revokes and forgets them. Both take the admin token, and they stay on the server's loopback.

If your access layer needs a header of its own on every request, such as a service token, put it on each PC as
`AGENTHYDRA_CODEX_HUB_HEADERS`, a JSON object. The tray sends it on its own requests and passes it on to the pusher.

The table is what the hub needs. This Caddy sketch shows those rules; it has not been run against a hub here. Check
your own proxy with the requests in the next section, whatever you use:

```caddy
hub.example.test {
	handle /api/codex-hub/* {
		reverse_proxy 127.0.0.1:7787 {
			header_up Host {upstream_hostport}
			header_up -Origin
		}
	}
	handle {
		respond 404
	}
}

inbox.example.test {
	# Your sign-in comes first here (forward_auth to your identity provider, or your access layer's own).
	handle /codex-hub/pair {
		reverse_proxy 127.0.0.1:7787 {
			header_up Host {upstream_hostport}
			header_up -Origin
		}
	}
}
```

nginx needs these too: `client_max_body_size 16m` (its default is 1 MiB), `proxy_http_version 1.1` with the
`Upgrade` and `Connection` headers for WebSockets, and a `proxy_read_timeout` of several minutes (its default is 60
seconds). A relay that is cut connects again, but Desk loses a session that was running on it.

### Check it from outside

Run these from a machine outside your network, with your addresses.

- **No other path:** this should not answer 200.

  ```sh
  curl -s -o /dev/null -w '%{http_code}\n' https://hub.example.test/api/health
  ```

- **No way out of the forward:** this should not answer 200 either.

  ```sh
  curl -s -o /dev/null -w '%{http_code}\n' --path-as-is 'https://hub.example.test/api/codex-hub/../health'
  ```

- **The forward works and wants a PC's token.** Make a token for the check on the hub first; it prints the token:

  ```sh
  bun --env-file ~/.config/codex-hub/hub.env scripts/codex-hub-pcs.ts add outside-check
  ```

  With that token in `$TOKEN`, these should answer 401 or your access layer's refusal, then 404 ("this hub hands out
  no pusher build") or 200:

  ```sh
  curl -s -o /dev/null -w '%{http_code}\n' 'https://hub.example.test/api/codex-hub/pusher?platform=linux-x64'
  curl -s -H "Authorization: Bearer $TOKEN" 'https://hub.example.test/api/codex-hub/pusher?platform=linux-x64'
  ```

- **The admin token opens nothing there, and neither does a made-up pairing code:** with the admin token in
  `$ADMIN`, both should answer 401.

  ```sh
  curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $ADMIN" \
    'https://hub.example.test/api/codex-hub/pusher?platform=linux-x64'
  curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' \
    -H 'x-codex-hub-install: outside-check' \
    -d "{\"code\":\"$(openssl rand -hex 32)\",\"id\":\"$(openssl rand -hex 8)\",\"hash\":\"$(openssl rand -hex 32)\"}" \
    https://hub.example.test/api/codex-hub/redeem
  ```

- **The pairing page is not on the hub's address:** this should answer 404.

  ```sh
  curl -s -o /dev/null -w '%{http_code}\n' https://hub.example.test/codex-hub/pair
  ```

  Open `https://inbox.example.test/codex-hub/pair` in a private window. It should show your sign-in first. After the
  sign-in it says to open it from the Codex Hub app, because it was not opened from a tray, and that is right.

When you are done, forget the check's PC on the hub, which removes its token:

```sh
bun --env-file ~/.config/codex-hub/hub.env scripts/codex-hub-pcs.ts forget outside-check
```

## 3. The signing key

Each PC takes a build from the hub only if your ed25519 key signed it. The key is yours. This repository holds no
key. The workflow builds with an example key, whose private half is the bytes 0 to 31, and signs nothing.
`.gitignore` ignores any `*.key` file, in case one is made inside the checkout anyway.

Make the key on the machine you build on, outside the checkout:

```sh
mkdir -p ~/codex-hub && chmod 700 ~/codex-hub
bun scripts/codex-hub-sign.ts keygen ~/codex-hub/update.key     # prints the public key
bun scripts/codex-hub-sign.ts pubkey ~/codex-hub/update.key     # prints it again, any time
```

- **`keygen` never writes over an existing file,** and it writes the key with mode 600.
- **Keep a copy offline,** for example in a password manager or on an encrypted drive. Without the key, no PC takes a
  new build, and each must be set up again by hand with a tray built for a new key.
- **Never put it on the hub or in CI.** The hub only serves the signatures.

What a signature covers: the text `codex-hub-build v1`, then whether it is the pusher or the tray, the platform, and
the build's SHA-256. A signature is good for that one build, under that one name, on that one platform. A tray or
pusher refuses these before it downloads anything, logs the refusal once, and keeps the build it has:

- a build that is not signed;
- a build signed with another key;
- a build signed for the other program or for another platform.

A downloaded build must also match the hash, and it must start and print its own name with `--version` before it
replaces the running one.

A tray built without a key checks no signatures: it takes any build an `https://` hub hands it, relying on HTTPS
alone, and none over `http://`, where its menu says so in amber. So `build.sh` stops when `UPDATE_KEY` is empty, and
makes such a tray only when you set `ALLOW_NO_KEY=1`.

## 4. Building the tray, and the builds the hub hands out

The tray is Go (`codex-hub-tray/`). `build.sh` builds it with your addresses and public key. It uses the Go named on
the `toolchain` line of `go.mod`, and the go command downloads that Go if it is not the one installed. It also needs
Bun, which writes each build's licence file:

```sh
cd codex-hub-tray
HUB_URL=https://hub.example.test \
PAIR_URL=https://inbox.example.test/codex-hub/pair \
INBOX_URL=https://inbox.example.test \
UPDATE_KEY=$(bun ../scripts/codex-hub-sign.ts pubkey ~/codex-hub/update.key) \
./build.sh
```

Give the variables on the `./build.sh` line, as here, or `export` them first. A variable set on a line of its own
and not exported never reaches `build.sh`.

| Variable | What it is |
| --- | --- |
| `HUB_URL` | the hub's `/api/codex-hub/` address, without the path |
| `PAIR_URL` | the pairing page behind your sign-in; without it, a PC takes its token only from its `tray.json` |
| `INBOX_URL` | what the menu's Open the inbox opens; without it, the item is hidden |
| `UPDATE_KEY` | your public key, or two, comma-separated, while you move to a new key (step 6); required |
| `ALLOW_NO_KEY` | `1` to build without `UPDATE_KEY`, a tray that takes unsigned builds from an `https://` hub (step 3) |
| `OLD_HUB_URLS` | the hub's earlier addresses, comma-separated, once it has moved ([REFERENCE.md](REFERENCE.md#codex-chats-from-other-pcs-codex-hub)) |
| `BUNDLE_ID` | macOS only: the app's identifier, which also names its LaunchAgent |
| `TARGETS` | `windows-x64 linux-x64 linux-arm64` by default, plus `macos` on a Mac |
| `OUT` | the output folder, `dist` by default, which git ignores (a build holds your addresses) |
| `REPO_ROOT` | the AgentHydra checkout `codex-hub-tray/` is in, `..` by default; set it to build from a copy elsewhere |

`build.sh` stops when `UPDATE_KEY` is empty, unless `ALLOW_NO_KEY=1`, or when it is not a key. It warns about a
missing `HUB_URL` or `PAIR_URL`, a pairing page over `http://`, and a tray built without a key. Its output in `dist/`:

- `codex-hub-tray.exe` (Windows), `codex-hub-tray-linux-x64` and `codex-hub-tray-linux-arm64`, under the names the hub
  serves them as.
- `THIRD-PARTY-LICENSES-windows-x64.txt`, `-linux-x64.txt` and `-linux-arm64.txt`: the licence and licence text of
  each Go module that build links (`fyne.io/systray` everywhere, `golang.org/x/sys` on Windows, `godbus/dbus` on
  Linux), and Go's own. `LICENSE` is AgentHydra's, and `NOTICE` says where this project comes from. These ship with
  each build: hand them out with it (step 5).
- `SHA256SUMS`, of the builds and the licence files.
- On a Mac (`TARGETS=macos`, which runs `build-macos.sh`): `Codex Hub.app`, its zip to hand out, and
  `codex-hub-tray-darwin-arm64` and `codex-hub-tray-darwin-x64` for the hub. A Mac build needs the Xcode command line
  tools and Bun. `THIRD-PARTY-LICENSES-macos.txt` lists what either architecture links; it is also inside the app,
  with `LICENSE` and `NOTICE`, in `Contents/Resources`, so the zip and every Mac that installs from it carry them.
  The darwin builds and that file go into `SHA256SUMS`; the zip's hash goes into `SHA256SUMS-macos-zip` (see below).

### The same bytes every time

The machine that builds puts nothing of itself into a build:

- `-trimpath` leaves out the checkout's folder;
- `-buildvcs=false` leaves out the commit;
- `-buildid=` leaves out the build id;
- cgo is off for the Windows and Linux targets;
- `GOFLAGS`, `GOAMD64` and `GOARM64` from the environment are not used.

The licence files come from the same `go.mod` and Go, so they are the same text every time too. So anyone can rebuild
a commit with the same addresses and key, and compare. To compare the tray a PC runs, use the SHA-256 in its menu
(Version, first eight characters) or its file. On every change to `codex-hub-tray/`, the workflow builds twice, the
second time from another folder with an empty build cache, and compares `SHA256SUMS`. On a Mac only the two darwin
builds and the licence file are compared. The zip holds file times, so it is not the same bytes twice: its hash is kept
apart, in `SHA256SUMS-macos-zip`, only for checking that the copy you hand a Mac is the one you built.

### The pusher builds

The tray runs the compiled pusher and fetches it from the hub, so the hub needs a pusher build for every platform
your trays run on. From the repository's root:

```sh
KEYS=$(bun scripts/codex-hub-sign.ts pubkey ~/codex-hub/update.key)
for p in windows-x64 linux-x64 linux-arm64 darwin-x64 darwin-arm64; do
  name=codex-hub-push-$p; [ "$p" = windows-x64 ] && name=codex-hub-push.exe
  bun build --compile --target=bun-$p --define "AGENTHYDRA_CODEX_HUB_UPDATE_KEY=\"${KEYS:?}\"" \
    --outfile "dist/$name" server/src/codex-hub-push-main.ts
done
```

- **The key compiled in matters only for a pusher that runs on its own,** without the tray. The tray checks each
  pusher build itself.
- **A pusher build holds the name of its output file.** Build it under the name the hub serves it as. Two linux-x64
  builds of one commit, with the same Bun (1.4.3) and the same output name, came out the same here, even from another
  folder. Only the tray is compared in CI.

### Sign, then put the builds on the hub

Sign each build after the last thing that changes it. For a Mac, that is `codesign`, which `build-macos.sh` runs on
the tray, and which you run on a Mac pusher if you codesign it. From the repository's root:

```sh
bun scripts/codex-hub-sign.ts sign ~/codex-hub/update.key \
  codex-hub-tray/dist/codex-hub-tray.exe codex-hub-tray/dist/codex-hub-tray-linux-x64 \
  codex-hub-tray/dist/codex-hub-tray-linux-arm64 \
  dist/codex-hub-push.exe dist/codex-hub-push-linux-x64 dist/codex-hub-push-linux-arm64 \
  dist/codex-hub-push-darwin-x64 dist/codex-hub-push-darwin-arm64
```

The script writes `<build>.sig` beside each build. It takes the program and platform from the file's name. If any
name is not one the hub serves, it signs nothing, so name the builds rather than using a pattern that also matches
the zip or a `.sig`.

Copy each `.sig` into `~/.agenthydra/codex-hub/.pusher/` on the hub first, and then its build. Copy into a folder
beside it and move the file in, so that no PC fetches half a file. The hub looks at both files at each request,
so nothing needs a restart. PCs check at start and every 10 minutes. On Linux and macOS, `kill -USR1` on a tray
makes it check now.

## 5. Setting up a PC: install the tray and connect

Give each PC its tray build in a way you trust, with `LICENSE`, `NOTICE` and the `THIRD-PARTY-LICENSES` file for its
system (a Mac's zip has them inside): copy them over yourself, or put them behind the same sign-in as the pairing
page. The hub's updates replace only the program, so when an update changes a licence file (a new module or Go
version in `go.mod`), hand out the new one too. The hub's own download needs a PC's token, which a new PC does not
have yet. Before you open the file, compare its SHA-256 with your `SHA256SUMS`, or, for a Mac's zip, with your
`SHA256SUMS-macos-zip`.

### Pairing from the Connect button

When the tray starts without a token, it opens your pairing page in the browser, with a port and a one-time state
for this PC, the name it pairs as, and when its link expires. You can also choose **Connect this PC** in its menu at
any time.

1. The browser goes through your sign-in to the hub's page, **Connect *the PC's name***.
2. Choose **Connect**.
3. The page posts a one-time pairing code to the tray's own port on `127.0.0.1`, and nowhere else.
4. The tray makes a token of its own, and redeems the code with the token's id and SHA-256: the hub keeps those, and
   no token travels either way. Once the hub has taken it, the tray saves the token in `tray.json` (mode 600),
   fetches the pusher, and starts pushing.

The page answers "This PC is connected as *its name* and is pushing its Codex chats." The pairing link is good for 20
minutes, once, and only for the tray that opened it.

The PC is listed under its computer name. On a Mac, that is its Local Hostname. Set `AGENTHYDRA_CODEX_HUB_PC` in the
user's environment, before you choose Connect, to use another name. Two PCs cannot share a name: a token acts for the
one name it was paired as, and only from the install of the pusher it was first used with, so another PC that sends
it is refused.

**A name already in use.** When the hub has a PC by that name already (one with a token, or one that still pushes
with the shared token of before), the page says when and how it was paired, its last push, and whether it is online
now. It offers two choices:

- **This is another PC: connect it as *name*-2** comes first (the first free number up to 99). The tray keeps that
  name and passes it to its pusher. This is how two machines called `ubuntu`, or WSL beside its Windows PC, become
  `ubuntu` and `ubuntu-2`.
- **This is *name* itself, set up again: replace its token…** leads to a second page that says what replacing does:
  the PC's current token stops at once, its relay closes and any Desk session on it ends, and its copies on the hub
  stay until this PC's pushes replace them. **Connect and replace** does it. Use it for a PC whose `tray.json` was
  lost, or that was installed again.

**Renaming a PC.** Set `AGENTHYDRA_CODEX_HUB_PC` to the new name, restart the tray, and choose Connect this PC. The
page says it renames the old name to the new one. Once the tray is connected under the new name, it retires its old
token on the hub, and the page says so; the old name's copies stay, revoked, until you forget them (`forget`, in
[Listing PCs and revoking one](#listing-pcs-and-revoking-one)). The hub has no rename of its own: a PC's name is its
folder there, and Desk's id for it.

### Windows

1. Open `codex-hub-tray.exe` once. It needs no administrator rights.
2. It copies itself to `%LOCALAPPDATA%\codex-hub\codex-hub-tray.exe`, adds itself to the programs that start with
   Windows (`HKCU\...\Run`, value "Codex Hub"), and starts. It sits in the system tray, next to the clock.

The exe has no code-signing certificate, so SmartScreen may ask first: choose More info, then Run anyway.

### macOS

1. Check the zip: `shasum -a 256 codex-hub-tray-macos.zip` prints the hash in your `SHA256SUMS-macos-zip`. Or put
   that file beside the zip and run `shasum -a 256 -c SHA256SUMS-macos-zip`, which says OK.
2. Unzip `codex-hub-tray-macos.zip` and open `Codex Hub.app`.
3. The app is not notarized, so the first open needs System Settings, Privacy & Security, Open Anyway.
4. It installs itself as `~/Applications/Codex Hub.app`, adds a LaunchAgent (`~/Library/LaunchAgents/<bundle id>.plist`)
   that starts it at each log in, and sits in the menu bar.

### Linux

1. `chmod +x codex-hub-tray-linux-x64` (or `-linux-arm64`), then run it once.
2. It installs itself as `~/.local/share/codex-hub/codex-hub-tray`, and adds an autostart entry
   (`~/.config/autostart/codex-hub-tray.desktop`).

On GNOME, the icon shows only with the AppIndicator extension.

On a PC without a desktop, it enables a systemd user unit (`codex-hub-tray.service`) instead. With
`loginctl enable-linger`, that unit runs from boot. Without a display, it has no browser to open, so it writes the
pairing link to its log (`~/.local/share/codex-hub/tray.log`, mode 600). Open that link in a browser on that PC, or
give the PC a token made on the hub, which prints it:

```sh
bun --env-file ~/.config/codex-hub/hub.env scripts/codex-hub-pcs.ts add <the PC's name>
```

Then, on the PC:

```sh
umask 077
printf '{\n  "hub": "%s",\n  "token": "%s"\n}\n' 'https://hub.example.test' '<the token>' \
  >~/.local/share/codex-hub/tray.json
pkill -USR1 -x codex-hub-tray   # or wait for its next check, at most 10 minutes
```

This writes the whole file. `tray.json` holds the hub's address as well as the token, so give both, the address as
in your `HUB_URL`: a tray built without `HUB_URL` has no other place to find its hub, and one built with it takes
that address as its own. To change only the token in a file that is already there, edit its `"token"` line instead.
At its next check the tray asks the hub what it has the token under, which binds the token to this PC's install, and
adds the PC's name. Use the token at once: until then, whoever sends it first with an install id binds it.

### What the tray shows, and its logs

The menu's first line says how things stand:

- **Pushing this PC's Codex chats as *its name*** (green).
- **Not connected: choose Connect this PC** (amber).
- **The hub revoked this PC: choose Connect this PC to pair it again** (amber): you revoked it on the hub.
- **This token belongs to another install: choose Connect this PC** (amber): the token was first used from
  another install of the pusher, for example a token copied by hand from another PC's `tray.json`.
- **This PC must be paired again: choose Connect this PC** (amber): the PC still has the shared token of before, and
  the hub would not move it to a token of its own
  ([Moving PCs to tokens of their own](#moving-pcs-to-tokens-of-their-own)).
- **The hub refused the token: choose Connect this PC** (amber): the hub does not know the token, for example
  because the PC was paired again from another install.
- **The hub is out of reach (away from home?)** (grey): the PC is away from home, or the proxy is down.
- **This build has no update key: it takes no builds over http** (amber).

The tray's log is `tray.log` and the pusher's is `pusher.log`, both in the app folder above, both mode 600 (Show the
log opens the pusher's).

### Removing it

Choose Quit, then remove what it installed:

- **Windows:** the "Codex Hub" Run value, which you can also turn off in Settings, Apps, Startup, and
  `%LOCALAPPDATA%\codex-hub`.
- **macOS:** `launchctl bootout gui/$(id -u)/<bundle id>`, the plist in `~/Library/LaunchAgents`,
  `~/Applications/Codex Hub.app` and `~/Library/Application Support/codex-hub`.
- **Linux:** `systemctl --user disable --now codex-hub-tray.service` if it was enabled, the unit and
  the autostart entry under `~/.config`, and `~/.local/share/codex-hub`.

## 6. Changing things later

### Moving to a new signing key

A build can trust two keys at once. That is how the PCs move to a new key without being set up again:

1. **Make the new key:**

   ```sh
   bun scripts/codex-hub-sign.ts keygen ~/codex-hub/update-2.key
   ```

2. **Build with both keys, and sign with the old one.** Build the tray, and the pushers, with both public keys, then
   sign them with the **old** key and put them on the hub. From the repository's root, with your addresses as in
   step 4:

   ```sh
   export UPDATE_KEY=$(bun scripts/codex-hub-sign.ts pubkey ~/codex-hub/update.key ~/codex-hub/update-2.key)
   echo "$UPDATE_KEY"    # two keys, comma-separated
   HUB_URL=https://hub.example.test PAIR_URL=https://inbox.example.test/codex-hub/pair \
     INBOX_URL=https://inbox.example.test codex-hub-tray/build.sh
   for p in windows-x64 linux-x64 linux-arm64 darwin-x64 darwin-arm64; do
     name=codex-hub-push-$p; [ "$p" = windows-x64 ] && name=codex-hub-push.exe
     bun build --compile --target=bun-$p --define "AGENTHYDRA_CODEX_HUB_UPDATE_KEY=\"${UPDATE_KEY:?}\"" \
       --outfile "dist/$name" server/src/codex-hub-push-main.ts
   done
   ```

   Then sign the tray and pusher builds with `~/codex-hub/update.key`, as in step 4. Every PC takes this build,
   because the old key signed it, and from then on it trusts both keys. The menu's Version line shows a build's
   SHA-256, not its keys, so check that the `echo` above prints both before you sign.
3. **Wait until every PC runs it.** Check the menu's Version line, or `update: tray now <sha>` in `tray.log`. A PC
   that is off takes the build when it is back.
4. **Build with the new key alone, and sign with the new key.** Run step 2's commands with
   `export UPDATE_KEY=$(bun scripts/codex-hub-sign.ts pubkey ~/codex-hub/update-2.key)`, then sign with
   `~/codex-hub/update-2.key`. Put those builds on the hub. The PCs take them.
5. **Retire the old key file,** offline or deleted.

A PC that missed step 2 has only the old key. It refuses the new builds and keeps the one it has, which is logged.
Install a current tray on it by hand. It installs over the running one and keeps its token.

If the old key leaked, do this at once. Until the PCs run the build from step 4, they still trust the old key.

The tests for this are `TestKeyRotation` (`codex-hub-tray/main_test.go`), the "moving to a new key" part of
`test-linux.sh`, and `server/tests/codex-hub-update.test.ts` for the pusher.

### Changing the admin token

No PC holds the admin token, so changing it pairs no PC again:

1. Put a new `AGENTHYDRA_CODEX_HUB_TOKEN` in `hub.env` (`openssl rand -hex 32`).
2. Restart the hub (`systemctl --user restart codex-hub.service`), and Desk too if it was running, since its end of
   the relay reads the same variable.

The old admin token then opens nothing. Every PC keeps its token, and the command line reads the new one from
`hub.env`. To cut off one PC, revoke it instead (next section).

### Listing PCs and revoking one

Each PC has a token of its own, so you list them, give one a token or cut one off on the hub itself, with
`scripts/codex-hub-pcs.ts`. It runs on the server, from the checkout, with the admin token from `hub.env`, and talks
to the hub on its loopback only: `http://127.0.0.1:$PORT`, else port 7787, or the address you give with `--hub`.
Desk has no page for this; a chat in Desk whose PC you revoked says that it was revoked.

```sh
bun --env-file ~/.config/codex-hub/hub.env scripts/codex-hub-pcs.ts list [--json]
bun --env-file ~/.config/codex-hub/hub.env scripts/codex-hub-pcs.ts add <pc> [--replace] [--json]
bun --env-file ~/.config/codex-hub/hub.env scripts/codex-hub-pcs.ts revoke <pc>
bun --env-file ~/.config/codex-hub/hub.env scripts/codex-hub-pcs.ts forget <pc>
```

- **`list`** first says whether the migration window is open (`legacy window: open until <date>, N pending`,
  `closed on <date>`, or `off`), then gives a line for each PC: its name and state, its token's id, when and how it
  was paired and from what address, when the token was first used, its last push, whether its relay is on, the
  start of its install id, and when it was revoked and why. A state is `token` (a token of its own), `pending` (it
  still pushes with the shared token of before, and may move), `revoked`, or `unpaired` (copies here and no token),
  with the reason it cannot move by itself: `no-install`, `old`, `claimed`, `duplicate:<key>` or `window-closed`.
  `CONTESTED <date>` marks a PC for which a second exchange came after it had moved: if that PC did not send it, pair
  it again through the page and change the legacy token.
- **`add <pc>`** makes a token for a PC that has no tray, or no desktop, and prints the token alone (with `--json`,
  `{ token, pc, key, id }`); the hub is sent only its id and hash. Put it in that PC's `tray.json`
  ([Linux](#linux) shows how), or in a daemon's or standalone pusher's `AGENTHYDRA_CODEX_HUB_TOKEN`, and restart
  that pusher. Use it at once: until its first request with an install id, whoever sends it first binds it to their
  install. A name that has a token, or is pending, is refused unless you add `--replace`, which stops its current
  token at once and closes its relay.
- **`revoke <pc>`** cuts one PC off at once, and touches no other. Its relay closes and every Desk session on it ends.
  Its next push, build check and whoami are refused as revoked, so it takes no more updates. Its tray says "The hub
  revoked this PC: choose Connect this PC to pair it again" (a tray from before tokens of their own says "The hub
  refused the token"), and its pusher logs "the hub revoked this PC's token; pair it again". Its chats stay listed on
  the hub until you forget it. Revoking a pending PC stops it from moving.
- **`forget <pc>`** also removes the PC's record and its copies from the hub. Forget a PC that was lost or stolen,
  once it is revoked: whatever was pushed with a stolen token is the thief's content, and Desk lists and searches it
  like your own chats.

`<pc>` is a name or a key: `revoke` and `forget` take its key, and `add` keeps the name as you typed it. The same
requests with `curl` are in [REFERENCE.md](REFERENCE.md#codex-chats-from-other-pcs-codex-hub).

### Moving PCs to tokens of their own

A hub set up before PCs had tokens of their own let every PC push with one shared token. Now the hub refuses that
token unless you open a migration window for it. While the window is open, each PC that was pushing with it moves to
a token of its own by itself, and `list` shows them go. A hub set up after this change has nothing to move.

**What the window allows.** The shared token, now the legacy token, then acts only for a **pending** PC: one whose
folder on the hub

- names the install id its pusher sent (a folder whose pusher sent none cannot move by itself);
- was pushed to in the 30 days before the window opened, or since;
- has no token of its own, and an install id that no other PC's token has taken;
- and is the newest folder with that install id (so one Mac kept under two names moves once).

For a pending PC, and only with that PC's own install id, the legacy token pushes, opens the relay, and trades
itself once for a token the tray made. It also gets the builds while any PC is pending, since an old tray fetches
the tray that can move with it. Anything else it asks for is a bare 401, and once the window has closed it opens
nothing anywhere.

**The steps:**

1. **Check, then back up.** On the new checkout, run the hub's tests, the multi-PC test among them
   (`bun test server/tests/codex-hub`), and back up `~/.agenthydra/codex-hub/` with its dot-files. If the hub
   updates its own checkout, turn that off until step 2 is done, or do step 2 in the same sitting.
2. **Update the hub, and give it a new admin token in the same restart.** In `hub.env`, rename
   `AGENTHYDRA_CODEX_HUB_TOKEN=<old>` to `AGENTHYDRA_CODEX_HUB_LEGACY_TOKEN=<old>`, and add a new
   `AGENTHYDRA_CODEX_HUB_TOKEN` (`openssl rand -hex 32`). The old value is on every PC and in their backups, so it
   must not stay the admin token: a legacy token equal to the admin token is ignored, and the hub's log says so.
   Restart the hub and Desk. The start log, or `list`, then names the pending PCs, each with its last push, and the
   folders that cannot move by themselves, with the reason. Forget a stale folder with `forget`; revoke a pending PC
   only to stop it from moving. A folder whose name is not a PC's key, such as a copy renamed `office-pc.bak` by
   hand, is left out of the list, the window and pairing, and the start log names it: move it out of the hub's
   folder.
3. **Publish the new builds,** the pusher's and the tray's for each platform (step 4), one platform at a time. Linux
   first: send `kill -USR1` to that PC's tray, and `list` shows it as `token`, paired by `exchange`. Then Windows,
   where the menu's Restart the pusher runs a check at once (Windows has no SIGUSR1). Then both darwin builds. A tray
   from before this change fetches the new pusher and the new tray with the legacy token and replaces itself, and the
   new tray moves as it starts.
4. **Give a token to each pusher that runs without a tray,** a daemon's or a standalone one: pushers never move by
   themselves. Run `add <pc> --replace`, put the token in that PC's `AGENTHYDRA_CODEX_HUB_TOKEN`, and restart its
   pusher, before the window closes. Such a PC is pending while it pushes with the old token, and `add` refuses a
   pending name without `--replace`; its pushes with the old token stop there, until its pusher restarts with the new
   one.
5. **Watch `list` until nothing is pending.** The window closes 7 days after the hub first saw the legacy token, or at
   `AGENTHYDRA_CODEX_HUB_LEGACY_UNTIL`, an ISO 8601 date or date-time, earlier or later. The start is kept in
   `.pcs.json`, so setting the legacy token again after the window has closed reopens nothing unless you move that
   date too. For a PC that is off, move it later, or let the window close and fix the PC when it is back (below).
6. **Close the window.** Remove `AGENTHYDRA_CODEX_HUB_LEGACY_TOKEN` and `AGENTHYDRA_CODEX_HUB_LEGACY_UNTIL` from
   `hub.env`, and restart the hub: the old value is then nowhere on it. On each PC you may also remove an
   `AGENTHYDRA_CODEX_HUB_TOKEN` that a setup from before the tray put in the user's environment; it is worthless now.

The migration trusts the old shared token together with each PC's install id, and the install id is no secret: it
sat in a file anyone on the PC could read. If you think the old token leaked, do not migrate: set no legacy token,
and pair each PC through the page instead.

**A PC that missed the window.** While the window is open, a PC that is off stays pending as long as its last push
was within 30 days of the window's start, and moves when it is back. Once the window has closed, or for a PC that
cannot move by itself (`list` says why), do one of these:

- while the legacy token is still in `hub.env`, move `AGENTHYDRA_CODEX_HUB_LEGACY_UNTIL` later and restart the hub
  (a folder past the 30 days still needs one of the next two);
- run `add <pc>` on the hub (`--replace` when the name has a token or is still pending), and write that token into
  the PC's `tray.json`
  by hand, keeping `"hub"`: even a tray from before this change takes it and updates itself, and the new tray fills
  in the rest;
- or install the current tray on it by hand, over the old one, and choose Connect this PC.

`revoke <pc>` stops a PC from moving, and `forget <pc>` also removes its copies: it can then come back only by
pairing.

**The order, and no way back.** The safe order is the hub first, with the legacy token set in the same restart, then
the builds within the window. A hub that restarts on the new code without the legacy token, one that updated itself
for example, refuses every PC that has not moved, which shows "The hub refused the token": add the setting, restart,
and they come back. There is no rollback after the first exchange, though. A hub rolled back to before this change
refuses every token of a PC's own, and each moved PC then needs Connect this PC, which the current tray takes from
the old page too. So run the tests (step 1) before you publish the builds (step 3). To roll back anyway, put back the
old `hub.env` with the old checkout: `AGENTHYDRA_CODEX_HUB_TOKEN=<old>` again, and no legacy settings. Otherwise the
old hub takes the new admin token as its one shared token: it refuses every PC that has not moved, and its pairing
page hands that token to each PC that pairs. To update again later, make a new admin token as in step 2, move
`AGENTHYDRA_CODEX_HUB_LEGACY_UNTIL` later, and pair again the PCs that had moved.

### Moving the hub

A tray has the hub's address from its build. Build the new tray with the old address in `OLD_HUB_URLS`, and hand it
out from the old hub first ([REFERENCE.md, Moving the hub](REFERENCE.md#codex-chats-from-other-pcs-codex-hub)). Copy
the whole `codex-hub/` folder to the new server, dot-files included, so that it keeps every PC's token
([What the hub keeps](#what-the-hub-keeps)).

## 7. The security model

**What a PC's token allows.** From wherever `/api/codex-hub/` is reached, a PC's token allows that PC's own pushes,
which replace that PC's copies on the hub, its own relay, the builds, asking the hub what it has the token under
(whoami), and retiring itself. It allows nothing for any other PC: whatever name a push or a relay sends, the hub
takes the PC from the token.

- **It is bound to one install of the pusher,** the one it was first used with. A push, relay or retire that sends
  another install id is refused, so a second pusher on the same PC, or a token copied into another PC's `tray.json`,
  does not act as that PC by mistake. The install id is no second secret, though: whoami answers it to the token
  itself, and before this change it sat in a file anyone on the PC could read. So treat a PC's token as that PC.
  Whoever has it can act as that PC, and as no other, until you revoke it, and a revoke cuts them off at once.
- **The tray makes the token on the PC,** and sends the hub only its id and SHA-256. No token travels from the hub,
  and the hub keeps none.

**What the admin token allows,** on the hub's loopback only: Desk's end of the relay, which runs turns on a connected
PC, and the admin API, which lists, gives tokens to, revokes and forgets PCs. `/api/codex-hub/` refuses it, and no PC
is ever given it.

**What the legacy token allows:** nothing, unless the migration window is open, and then only for pending PCs, each
only with its own install id: their pushes and relay, the builds, and one exchange each for a token of its own. As the
install id is not a secret, what protects the window is the legacy token itself, the window being short, and the
`CONTESTED` mark that `list` shows on a PC whose exchange came second. If that token may have leaked, pair the PCs
instead of moving them.

Every refusal of a value that does not have the shape of a PC's token is the same bare 401, whatever the reason, so
an answer never tells the admin token from any other such value. The legacy token gets that 401 too outside its
window; while the window is open, a malformed request with it gets the 400 any malformed request gets
(`install-required`, `bad-request`). The hub's log says why, at most once a minute for each route and reason, and
names a token by its id only.

**The pairing page hands out one-time codes, not tokens.** A code lasts 20 minutes and never past the tray's
listener, is used once, at most 32 are outstanding, and it is bound to one name and to the token it may replace.
Replacing a PC that has a token, or a pending one, takes a second page that only the first one leads to. The page is
built so that another site cannot read it: it refuses a network `Host`, posts only to the tray's port on
`127.0.0.1`, and is not cached or shown in a frame. Your sign-in is still what keeps it from strangers: whoever
passes it can pair a PC, which is what it is for.

A PC's token does not let anyone:

- read the hub's chat list or transcripts, which are only on the server's loopback;
- run anything on the hub;
- reach Desk's end of the relay or the admin API, which are never forwarded.

Even through Desk, a PC's relay lets the hub only resume, read, start and stop turns in existing threads. It never
starts a thread, changes config or signs in. By default it also refuses a turn without approvals or outside the
sandbox (`AGENTHYDRA_CODEX_HUB_RELAY`, in [REFERENCE.md](REFERENCE.md#codex-chats-from-other-pcs-codex-hub)). The
commands a relayed turn runs do not see the tokens: every `codex app-server` AgentHydra starts has the
`AGENTHYDRA_CODEX_HUB_*` settings, and their `CCMANAGERUI_` names, taken out of its environment.

**Who holds what:**

- the admin token: `hub.env` and Desk's environment, on the server;
- the legacy token: `hub.env` while you keep it there, and the PCs that have not moved;
- each PC's token, with its install id: that PC's `tray.json` (mode 600), or a pusher's environment;
- the tokens' hashes: the hub's `.pcs.json` (mode 600);
- the signing key: only the machine you sign on, plus your offline copy, never this repository, a build, or the hub's
  disk beside the builds.

**When something leaks.** A PC's token: revoke that PC and pair it again. The admin token: change it and restart the
hub and Desk ([Changing the admin token](#changing-the-admin-token)); no PC is affected. The hub's `.pcs.json`: it
holds hashes of 256-bit secrets, so there is nothing to do but note it. The signing key:
[Moving to a new signing key](#moving-to-a-new-signing-key).

**Over the network, HTTPS protects the tokens.** A token travels in a header on every request, and a pairing code in
the page, so use `https://` for `HUB_URL` and `PAIR_URL`. Over `http://`, anyone on the path can read them.

**What is signed.** Every pusher and tray build the hub hands out is signed with your key, as in step 3. The tray
checks the signature before it downloads a build, and checks the bytes against the hash after.

**What is not signed:**

- the first tray you hand out, which is why you compare its SHA-256;
- the pushes, the relay's messages and the pairing page, which rely on HTTPS, the PCs' tokens and your sign-in.

A tray built without a key (`ALLOW_NO_KEY=1`) checks no signatures: it takes any build an `https://` hub hands it,
relying on HTTPS alone.
