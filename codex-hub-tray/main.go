// Codex Hub tray app for Windows: one exe that installs itself for this user, starts with Windows, keeps
// codex-hub-push.exe (server/src/codex-hub-push-main.ts) running, and keeps both builds at the ones the hub hands
// out (GET /api/codex-hub/pusher and /api/codex-hub/tray). A PC is set up by opening the exe once; the hub token
// comes from the hub's pairing page in the browser (pair.go), so nothing is typed or copied.
//
// Build (the addresses are the operator's, given at build time):
//
//	GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w -H=windowsgui -X main.hubURL=http://hub:18788 \
//	  -X main.pairURL=https://inbox.example/codex-hub/pair -X main.inboxURL=https://inbox.example" -o codex-hub-tray.exe .
package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"fyne.io/systray"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// Set with -ldflags -X at build time.
var (
	hubURL   = ""
	pairURL  = ""
	inboxURL = ""
)

// Printed by --version: how an update checks that a downloaded build starts before it takes this one's place.
const banner = "codex-hub-tray"

const (
	runKey    = `Software\Microsoft\Windows\CurrentVersion\Run`
	runValue  = "Codex Hub"
	mutexName = `Local\CodexHubTray`
	// The scheduled task an earlier setup (install-codex-hub.ps1) made; the tray takes its place.
	oldTask = "Codex hub push"
)

var (
	appDir    = filepath.Join(os.Getenv("LOCALAPPDATA"), "codex-hub")
	trayExe   = filepath.Join(appDir, "codex-hub-tray.exe")
	pusherExe = filepath.Join(appDir, "codex-hub-push.exe")
)

func main() {
	for _, a := range os.Args[1:] {
		if a == "--version" {
			fmt.Println(banner)
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
	if !takeMutex() {
		return
	}
	os.Remove(trayExe + ".old")
	os.Remove(trayExe + ".new")
	// A pusher left by a tray that was killed, or by the earlier scheduled task.
	hidden("taskkill", "/F", "/IM", "codex-hub-push.exe")
	if k, _, err := registry.CreateKey(registry.CURRENT_USER, runKey, registry.SET_VALUE); err == nil {
		k.SetStringValue(runValue, `"`+trayExe+`"`)
		k.Close()
	}
	systray.Run(onReady, onExit)
}

// install copies a downloaded exe to its place, replacing a running tray and the earlier scheduled-task setup,
// and starts it there.
func install(from string) {
	first := !exists(trayExe)
	hidden("taskkill", "/F", "/IM", "codex-hub-tray.exe", "/FI", fmt.Sprintf("PID ne %d", os.Getpid()))
	hidden("taskkill", "/F", "/IM", "codex-hub-push.exe")
	hidden("schtasks", "/Delete", "/TN", oldTask, "/F")
	time.Sleep(time.Second)
	os.Remove(trayExe + ".old")
	if exists(trayExe) {
		os.Rename(trayExe, trayExe+".old")
	}
	if err := copyFile(from, trayExe); err != nil {
		fatal("Could not install to " + trayExe + ": " + err.Error())
	}
	if err := startDetached(trayExe); err != nil {
		fatal("Could not start Codex Hub: " + err.Error())
	}
	if first {
		message("Codex Hub is installed and starts with Windows. It sits in the system tray, next to the clock.\n\nIf the browser opens the hub's pairing page, choose Connect there to link this PC.")
	}
}

// takeMutex makes this the only tray; a build that just replaced the previous one waits for it to exit.
func takeMutex() bool {
	name, _ := windows.UTF16PtrFromString(mutexName)
	for i := 0; i < 40; i++ {
		h, err := windows.CreateMutex(nil, false, name)
		if err == nil {
			return true
		}
		if h != 0 {
			windows.CloseHandle(h)
		}
		time.Sleep(500 * time.Millisecond)
	}
	return false
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

func samePath(a, b string) bool {
	return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func message(text string) {
	t, _ := windows.UTF16PtrFromString(text)
	c, _ := windows.UTF16PtrFromString("Codex Hub")
	windows.MessageBox(0, t, c, windows.MB_OK|windows.MB_ICONINFORMATION)
}

func fatal(text string) {
	log.Println(text)
	t, _ := windows.UTF16PtrFromString(text)
	c, _ := windows.UTF16PtrFromString("Codex Hub")
	windows.MessageBox(0, t, c, windows.MB_OK|windows.MB_ICONERROR)
	os.Exit(1)
}

func openURL(u string) {
	verb, _ := windows.UTF16PtrFromString("open")
	target, _ := windows.UTF16PtrFromString(u)
	windows.ShellExecute(0, verb, target, nil, nil, windows.SW_SHOWNORMAL)
}
