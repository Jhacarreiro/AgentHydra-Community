// Codex Hub tray app for Windows, Linux and macOS: one program that installs itself for this user, starts when the
// user logs in, keeps the pusher (server/src/codex-hub-push-main.ts) running, and keeps both builds at the ones the
// hub hands out for this platform (GET /api/codex-hub/pusher?platform=P and /api/codex-hub/tray?platform=P). A PC is
// set up by opening the program once; the hub token comes from the hub's pairing page in the browser (pair.go), so
// nothing is typed or copied. What differs per system is in os_windows.go, os_unix.go (Linux and macOS),
// os_linux.go and os_darwin.go.
//
// Build with build.sh, which makes the Windows and Linux builds, and the macOS ones on a Mac (build-macos.sh), the
// same bytes every time from the same commit: the addresses are the operator's, given at build time, with the public
// key the hub's builds are signed with (`bun scripts/codex-hub-sign.ts keygen` prints it, and `sign` signs each build
// the hub hands out), or two while moving to a new key:
//
//	HUB_URL=https://hub.example.test PAIR_URL=https://inbox.example.test/codex-hub/pair \
//	  INBOX_URL=https://inbox.example.test UPDATE_KEY=$(bun ../scripts/codex-hub-sign.ts pubkey ~/codex-hub/update.key) \
//	  ./build.sh
//
// Without UPDATE_KEY the tray takes builds only from an https hub (hub.go checkSigned). The builds go into dist/,
// which git ignores, as a build holds the operator's addresses and must not be committed; docs/CODEX-HUB.md is the
// operator's guide. What each system gets:
//
// Windows: one exe, codex-hub-tray.exe, built with -H=windowsgui; the Run key starts it.
//
// Linux, x64 or arm64, needs no C compiler; an autostart entry starts it, and GNOME shows its icon only with the
// AppIndicator extension. The hub serves it as codex-hub-tray-linux-x64 or codex-hub-tray-linux-arm64.
//
// macOS needs cgo and the Xcode command line tools, so it is built on a Mac: build-macos.sh (the same flags, from
// HUB_URL, PAIR_URL, INBOX_URL, UPDATE_KEY, OLD_HUB_URLS and BUNDLE_ID) makes, in dist/, "Codex Hub.app", which a
// LaunchAgent starts, and the hub's codex-hub-tray-darwin-arm64 and codex-hub-tray-darwin-x64.
//
// test-linux.sh and test-macos.sh run the app end to end against a fake hub.
//
// A build for a hub at a new address names the earlier addresses too, comma-separated, in OLD_HUB_URLS
// (-X main.oldHubURLs). A tray built before tray.json kept only the hub the user set saved its build's hub there when
// it paired, and a PC uses the hub in tray.json over the build's, unless it is one of these.
package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
)

// Set with -ldflags -X at build time.
var (
	hubURL   = ""
	pairURL  = ""
	inboxURL = ""
	// The operator's ed25519 public key, base64: every build the tray takes from the hub is signed with it. While the
	// operator moves to a new key, the old one and the new one, comma-separated (hub.go buildKeys).
	updateKey = ""
	// macOS: the app bundle's identifier, which also names its LaunchAgent.
	bundleID = "com.example.codex-hub-tray"
	// The hubs earlier builds were made with, comma-separated, once the hub has moved (hub.go isBuildHub).
	oldHubURLs = ""
)

// Printed by --version: how an update checks that a downloaded build starts before it takes this one's place.
const banner = "codex-hub-tray"

// appDir holds the config, the logs and the pusher; trayExe is where the tray runs once installed.
var appDir, trayExe, pusherExe, configPath string

func init() { setPaths() }

func setPaths() {
	appDir, trayExe, pusherExe = osPaths()
	configPath = filepath.Join(appDir, "tray.json")
}

func main() {
	for _, a := range os.Args[1:] {
		if a == "--version" {
			fmt.Println(banner)
			return
		}
		// The Info.plist of this build's app bundle (build-macos.sh).
		if a == "--info-plist" {
			fmt.Print(infoPlist(bundleID))
			return
		}
	}
	if err := os.MkdirAll(appDir, 0o755); err != nil {
		fatal("Could not create " + appDir + ": " + err.Error())
	}
	openLog()
	self, _ := os.Executable()
	if !samePath(self, trayExe) {
		install(self)
		return
	}
	if !singleInstance() {
		return
	}
	os.Remove(trayExe + ".old")
	os.Remove(trayExe + ".new")
	if err := unpinBuildHub(); err != nil {
		log.Println("config:", err)
	}
	startup()
	run()
}

func openLog() {
	path := filepath.Join(appDir, "tray.log")
	if st, err := os.Stat(path); err == nil && st.Size() > 2<<20 {
		os.Remove(path)
	}
	if f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644); err == nil {
		log.SetOutput(f)
	}
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
