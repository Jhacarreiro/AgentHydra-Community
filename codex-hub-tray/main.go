// Codex Hub tray app for Windows, Linux and macOS: one program that installs itself for this user, starts when the
// user logs in, keeps the pusher (server/src/codex-hub-push-main.ts) running, and keeps both builds at the ones the
// hub hands out for this platform (GET /api/codex-hub/pusher?platform=P and /api/codex-hub/tray?platform=P). A PC is
// set up by opening the program once; the hub token comes from the hub's pairing page in the browser (pair.go), so
// nothing is typed or copied. What differs per system is in os_windows.go, os_unix.go (Linux and macOS),
// os_linux.go and os_darwin.go.
//
// Build (the addresses are the operator's, given at build time, with the public key the hub's builds are signed with:
// `bun scripts/codex-hub-sign.ts keygen` prints it, and `sign` signs each build the hub hands out):
//
//	FLAGS="-X main.hubURL=http://hub:18788 -X main.pairURL=https://inbox.example/codex-hub/pair \
//	  -X main.inboxURL=https://inbox.example -X main.updateKey=$(bun ../scripts/codex-hub-sign.ts pubkey hub-update.key)"
//
// Without updateKey the tray takes builds only from an https hub (hub.go checkSigned).
//
// Windows: one exe; the Run key starts it.
//
//	GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w -H=windowsgui $FLAGS" -o codex-hub-tray.exe .
//
// Linux, x64 or arm64, needs no C compiler; an autostart entry starts it, and GNOME shows its icon only with the
// AppIndicator extension. The hub serves it as codex-hub-tray-linux-x64 or codex-hub-tray-linux-arm64.
//
//	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w $FLAGS" -o codex-hub-tray-linux-x64 .
//
// macOS needs cgo and the Xcode command line tools, so it is built on a Mac: build-macos.sh (the same flags, from
// HUB_URL, PAIR_URL, INBOX_URL, UPDATE_KEY and BUNDLE_ID) makes "Codex Hub.app", which a LaunchAgent starts, and the
// hub's codex-hub-tray-darwin-arm64 and codex-hub-tray-darwin-x64.
//
// test-linux.sh and test-macos.sh run the app end to end against a fake hub.
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
	// The operator's ed25519 public key, base64: every build the tray takes from the hub is signed with it.
	updateKey = ""
	// macOS: the app bundle's identifier, which also names its LaunchAgent.
	bundleID = "com.example.codex-hub-tray"
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
