# Codex hub: one list of the Codex chats on all your PCs

A Codex chat lives on the PC that ran it. The Codex hub is one AgentHydra daemon, on a home server or any PC that
stays on, that each of your PCs pushes its Codex chats to. Desk then lists every PC's chats, each marked with the PC
it came from, and can continue one on its own PC while that PC is on. A small tray app sets each PC up: it gets the
hub's token from a pairing page, runs the pusher, and keeps itself and the pusher at the builds the hub hands out,
which you sign with your own key.

This page is the operator's guide: setting up the server, the proxy in front of it, the tray builds and the key. The
details of each route, header and variable are in
[REFERENCE.md, Codex chats from other PCs](REFERENCE.md#codex-chats-from-other-pcs-codex-hub).

**TL;DR**

- **The hub is the daemon with `AGENTHYDRA_CODEX_HUB_TOKEN` set.** It listens on `127.0.0.1:7787` and on nothing
  else; change the port with `PORT`.
- **Your own HTTPS proxy forwards two paths and nothing else.** `/api/codex-hub/`, where the token is the
  authentication, and `/codex-hub/pair`, only behind your own sign-in, because that page hands out the token.
- **You make the signing key, and you keep it.** No key is in this repository. It stays outside the checkout, and the
  trays and pushers refuse any build it did not sign.
- **`codex-hub-tray/build.sh` builds the tray with your addresses and public key,** the same bytes every time from the
  same commit.
- **Open the tray once on each PC.** It installs itself, opens the pairing page, and you choose Connect.
- **One token serves every PC, and it is the only lock.** Whoever has it can push and relay under any PC's name. If
  you change it, every PC must pair again.

<details>
<summary>What has been tested, and what has not</summary>

Tested, by automated tests in this repository:

- **The hub as a server, with two PCs** (`server/tests/codex-hub-multi-pc.test.ts`). The test starts the real daemon
  in a scratch HOME on a loopback port and pairs two PCs through the pairing page as the tray does. Each PC pushes its
  own chat, and the hub lists each chat under its own PC. Each PC opens a relay. These are refused, and write
  nothing: a request with no token, with a wrong one, without `Bearer`, with a network `Host`, or with the old token
  after the token was changed. A PC that pairs again then pushes with the new token. With the token and no install
  id, a request replaces a connected PC's copy and takes its relay, as [step 7](#7-the-security-model) says. It has
  run on Linux; it is skipped on Windows, where the daemon starts its tray host at boot.
- **The tray on Linux, end to end** (`codex-hub-tray/test-linux.sh`). It runs against a fake hub: installing,
  pairing, the pusher, self-update, refusing unsigned builds and builds signed with another key, moving to a new
  key, and a PC without a desktop taking a new token from `tray.json`. It runs on every change to the tray
  (`.github/workflows/codex-hub-tray.yml`).
- **`go vet` for the tray, for Linux and Windows, `go test` on Linux,** and **the reproducible build:** two builds
  from one commit, the second in another folder with an empty build cache, give the same SHA-256.

Not tested yet:

- The tray on Windows, beyond `go vet` and a build, and on macOS at all. `codex-hub-tray/test-macos.sh` exists and
  the workflow has a macOS job, but neither has run for this version.
- A real reverse proxy or sign-in in front of the hub. The checks in [Check it from outside](#check-it-from-outside)
  are how you test yours.
- More than two PCs, large chat histories over a slow link, or a hub that runs for weeks.

So treat it as a setup for your own PCs that you watch, not as a service other people depend on.

</details>

## 1. The hub on a home server

The hub is the AgentHydra daemon from a checkout of this repository, run with Bun. It needs nothing else for the hub:
the chats arrive from the PCs. Desk, the window you read them in, is set up as the README says. To continue another
PC's chat, Desk needs the same `AGENTHYDRA_CODEX_HUB_TOKEN` in its environment; a Desk the daemon starts has it.

```sh
git clone https://github.com/Jhacarreiro/AgentHydra-Community.git ~/AgentHydra-Community
cd ~/AgentHydra-Community
bun install --frozen-lockfile
```

Make the token, a long random ASCII string, and keep it in a file only you can read, outside the checkout:

```sh
umask 077
mkdir -p ~/.config/codex-hub
printf 'AGENTHYDRA_CODEX_HUB_TOKEN=%s\nPORT=7787\nAGENTHYDRA_PORT_FIXED=1\n' "$(openssl rand -hex 32)" \
  >~/.config/codex-hub/hub.env
```

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

To check that the hub is on, run this on the server. "this hub hands out no pusher build" means it is on (you add
builds in step 4). "the Codex hub is off" means the token did not reach the daemon:

```sh
. ~/.config/codex-hub/hub.env
curl -s -H "Authorization: Bearer $AGENTHYDRA_CODEX_HUB_TOKEN" \
  'http://127.0.0.1:7787/api/codex-hub/pusher?platform=linux-x64'
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
- `codex-hub/.pusher/` holds the builds the hub hands out (step 4).

The hub never holds your signing key.

## 2. Your own reverse proxy or access layer

The PCs reach the hub through a proxy you run, with HTTPS: for example Caddy or nginx on the server, a tunnel, or a
VPN. Because the API answers loopback requests only, the proxy forwards each request with a loopback `Host`. It
forwards these two paths, and nothing else:

| Path | Who opens it | What authenticates it | The proxy must |
| --- | --- | --- | --- |
| `/api/codex-hub/` | each PC's tray and pusher | the hub token (`Authorization: Bearer`), plus your access layer's own service token if it wants one | set `Host: 127.0.0.1:7787`, remove `Origin`, pass WebSocket upgrades (the relay), allow request bodies up to 16 MiB, and keep an idle WebSocket open for several minutes |
| `/codex-hub/pair` | your browser, on a PC you are setting up | **your own sign-in**, before the request reaches the hub | set `Host: 127.0.0.1:7787` and remove `Origin`; serve it only behind the sign-in, never on the `/api/codex-hub/` address and never to the home network |

Never forward anything else.

- **The rest of `/api/`** answers anyone who reaches it.
- **Desk's end of the relay, `/api/codex-relay/`,** takes the same token and runs turns on your PCs. It stays on the
  server's loopback.

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

- **The forward works and wants the token:** these should answer 401 or your access layer's refusal, then 404 or 200.

  ```sh
  curl -s -o /dev/null -w '%{http_code}\n' 'https://hub.example.test/api/codex-hub/pusher?platform=linux-x64'
  curl -s -H "Authorization: Bearer $TOKEN" 'https://hub.example.test/api/codex-hub/pusher?platform=linux-x64'
  ```

- **The pairing page is not on the hub's address:** this should answer 404.

  ```sh
  curl -s -o /dev/null -w '%{http_code}\n' https://hub.example.test/codex-hub/pair
  ```

  Open `https://inbox.example.test/codex-hub/pair` in a private window. It should show your sign-in first. After the
  sign-in it says to open it from the Codex Hub app, because it was not opened from a tray, and that is right.

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
the `toolchain` line of `go.mod`, and the go command downloads that Go if it is not the one installed:

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

`build.sh` stops when `UPDATE_KEY` is empty, unless `ALLOW_NO_KEY=1`, or when it is not a key. It warns about a
missing `HUB_URL` or `PAIR_URL`, a pairing page over `http://`, and a tray built without a key. Its output in `dist/`:

- `codex-hub-tray.exe` (Windows), `codex-hub-tray-linux-x64` and `codex-hub-tray-linux-arm64`, under the names the hub
  serves them as.
- `SHA256SUMS`.
- On a Mac (`TARGETS=macos`, which runs `build-macos.sh`): `Codex Hub.app`, its zip to hand out, and
  `codex-hub-tray-darwin-arm64` and `codex-hub-tray-darwin-x64` for the hub. A Mac build needs the Xcode command line
  tools.

### The same bytes every time

The machine that builds puts nothing of itself into a build:

- `-trimpath` leaves out the checkout's folder;
- `-buildvcs=false` leaves out the commit;
- `-buildid=` leaves out the build id;
- cgo is off for the Windows and Linux targets;
- `GOFLAGS`, `GOAMD64` and `GOARM64` from the environment are not used.

So anyone can rebuild a commit with the same addresses and key, and compare. To compare the tray a PC runs, use the
SHA-256 in its menu (Version, first eight characters) or its file. On every change to `codex-hub-tray/`, the workflow
builds twice, the second time from another folder with an empty build cache, and compares `SHA256SUMS`. On a Mac only
the two darwin builds are compared, because the zip holds file times.

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

Give each PC its tray build in a way you trust: copy it over yourself, or put it behind the same sign-in as the
pairing page. The hub's own download needs the token, which a new PC does not have yet. Before you open the file,
compare its SHA-256 with your `SHA256SUMS`.

### Pairing from the Connect button

When the tray starts without a token, it opens your pairing page in the browser, with a port and a one-time code for
this PC. You can also choose **Connect this PC** in its menu at any time.

1. The browser goes through your sign-in to the hub's page, **Connect *this PC***.
2. Choose **Connect**.
3. The page posts the hub's token to the tray's own port on `127.0.0.1`, and nowhere else.
4. The tray checks the token with the hub, saves it in `tray.json` (mode 600), fetches the pusher, and starts pushing.

The page answers "This PC is connected". The pairing link is good for 20 minutes, and only for the tray that opened
it.

The PC is listed under its computer name. On a Mac, that is its Local Hostname. Set `AGENTHYDRA_CODEX_HUB_PC` in the
user's environment to use another name. Two PCs cannot share a name: while one holds it, the hub refuses the other's
pushes. That keeps two of your own PCs apart, not someone who has the token ([step 7](#7-the-security-model)).

### Windows

1. Open `codex-hub-tray.exe` once. It needs no administrator rights.
2. It copies itself to `%LOCALAPPDATA%\codex-hub\codex-hub-tray.exe`, adds itself to the programs that start with
   Windows (`HKCU\...\Run`, value "Codex Hub"), and starts. It sits in the system tray, next to the clock.

The exe has no code-signing certificate, so SmartScreen may ask first: choose More info, then Run anyway.

### macOS

1. Unzip `codex-hub-tray-macos.zip` and open `Codex Hub.app`.
2. The app is not notarized, so the first open needs System Settings, Privacy & Security, Open Anyway.
3. It installs itself as `~/Applications/Codex Hub.app`, adds a LaunchAgent (`~/Library/LaunchAgents/<bundle id>.plist`)
   that starts it at each log in, and sits in the menu bar.

### Linux

1. `chmod +x codex-hub-tray-linux-x64` (or `-linux-arm64`), then run it once.
2. It installs itself as `~/.local/share/codex-hub/codex-hub-tray`, and adds an autostart entry
   (`~/.config/autostart/codex-hub-tray.desktop`).

On GNOME, the icon shows only with the AppIndicator extension.

On a PC without a desktop, it enables a systemd user unit (`codex-hub-tray.service`) instead. With
`loginctl enable-linger`, that unit runs from boot. Without a display, it has no browser to open, so it writes the
pairing link to its log (`~/.local/share/codex-hub/tray.log`). Open that link in a browser on that PC, or put the
token in `tray.json` yourself:

```sh
umask 077
printf '{\n  "token": "%s"\n}\n' '<the hub token>' >~/.local/share/codex-hub/tray.json
pkill -USR1 -x codex-hub-tray   # or wait for its next check, at most 10 minutes
```

### What the tray shows, and its logs

The menu's first line says how things stand:

- **Pushing this PC's Codex chats** (green).
- **Not connected** or **The hub refused the token** (amber): choose Connect this PC.
- **The hub is out of reach** (grey): the PC is away from home, or the proxy is down.
- **This build has no update key** (amber).

The tray's log is `tray.log` and the pusher's is `pusher.log`, both in the app folder above (Show the log opens the
pusher's).

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

If the old key leaked, do this at once, and change the hub token as well. Until the PCs run the build from step 4,
they still trust the old key.

The tests for this are `TestKeyRotation` (`codex-hub-tray/main_test.go`), the "moving to a new key" part of
`test-linux.sh`, and `server/tests/codex-hub-update.test.ts` for the pusher.

### Changing the hub token

The token is the only thing a PC needs to push, so changing it is how you cut off a token that got out:

1. Put the new token in `hub.env`.
2. Restart the hub (`systemctl --user restart codex-hub.service`), and Desk too if it was running, since its end of
   the relay reads the same variable.
3. Pair each PC again: choose Connect this PC, or, on a PC without a desktop, put the new token in `tray.json` as
   above.

The old token is refused at once everywhere: push, builds, relay. A PC that has not paired again shows "The hub
refused the token", and its chats stay on the hub as they were.

There is one token for every PC, so you cannot cut off a single PC. To drop one PC, change the token, pair the
others, and delete its folder in `~/.agenthydra/codex-hub/`.

### Moving the hub

A tray has the hub's address from its build. Build the new tray with the old address in `OLD_HUB_URLS`, and hand it
out from the old hub first ([REFERENCE.md, Moving the hub](REFERENCE.md#codex-chats-from-other-pcs-codex-hub)).

## 7. The security model

**What the token allows.** Anyone who has the hub token and can reach `/api/codex-hub/` can:

- **Push chats under any PC name, at any time.** That adds chats to the hub's list under that name, and replaces or
  removes the hub's copies of the chats of a PC that already has that name, even one that is connected. The chats
  on the PC itself are untouched.
- **Open the relay for any PC name.** A relay opened for a connected PC's name takes that PC's place: its own relay
  is closed, and when Desk continues a chat of that PC, what you type and approve in Desk goes to whoever opened the
  new relay instead.
- **Download the hub's pusher and tray builds.** They carry your addresses and public key, and nothing secret.

The hub's hold on a PC's name ([step 5](#pairing-from-the-connect-button)) is not a check on any of this. It keeps
two of your own PCs that send the same name from replacing each other's chats, and it works only because each
pusher sends its install id. A request can leave the id out, and the hub then takes it as it took pushes from
pushers older than install ids. So treat the token as the key to every PC's copy and relay: if it leaks, change it
and pair every PC again ([Changing the hub token](#changing-the-hub-token)).

It does not let them:

- read the hub's chat list or transcripts, which are only on the server's loopback;
- run anything on the hub;
- reach Desk's end of the relay, which takes the same token but is never forwarded. On the hub machine, that token
  lets Desk run turns on a connected PC.

Even through Desk, a PC's relay lets the hub only resume, read, start and stop turns in existing threads. It never
starts a thread, changes config or signs in. By default it also refuses a turn without approvals or outside the
sandbox (`AGENTHYDRA_CODEX_HUB_RELAY`, in [REFERENCE.md](REFERENCE.md#codex-chats-from-other-pcs-codex-hub)).

**Who has the token:**

- the hub's `hub.env`;
- each PC's `tray.json`, mode 600;
- anyone who can open the pairing page, which is why the page sits behind your sign-in.

The page is built so that another site cannot read it: it refuses a network `Host`, posts only to the tray's port on
`127.0.0.1`, and is not cached or shown in a frame. The sign-in is still what keeps it from strangers.

**Over the network, HTTPS protects the token.** The token travels in a header on every request, so use `https://`
for `HUB_URL` and `PAIR_URL`. Over `http://`, anyone on the path can read it.

**What is signed.** Every pusher and tray build the hub hands out is signed with your key, as in step 3. The tray
checks the signature before it downloads a build, and checks the bytes against the hash after.

**What is not signed:**

- the first tray you hand out, which is why you compare its SHA-256;
- the pushes, the relay's messages and the pairing page, which rely on HTTPS, the token and your sign-in.

A tray built without a key (`ALLOW_NO_KEY=1`) checks no signatures: it takes any build an `https://` hub hands it,
relying on HTTPS alone.

**Where the secrets live:**

- the hub token: in `hub.env` on the server and `tray.json` on each PC;
- the private key: only on the machine you sign on, plus your offline copy;
- neither of them in this repository, in a build, or on the hub's disk beside the builds.
