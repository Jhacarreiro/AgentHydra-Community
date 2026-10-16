package main

import (
	"bytes"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// The tray runs from an app bundle in the user's Applications folder; its config, logs and pusher are in
// Application Support.
const bundleName = "Codex Hub.app"

func homeDir() string {
	h, _ := os.UserHomeDir()
	return h
}

func osPaths() (dir, tray, pusher string) {
	dir = filepath.Join(homeDir(), "Library", "Application Support", "codex-hub")
	return dir, filepath.Join(bundleDir(), "Contents", "MacOS", "codex-hub-tray"), filepath.Join(dir, "codex-hub-push")
}

func bundleDir() string { return filepath.Join(homeDir(), "Applications", bundleName) }

func launchAgentPath() string {
	return filepath.Join(homeDir(), "Library", "LaunchAgents", bundleID+".plist")
}

// writeAutostart writes the LaunchAgent that starts the tray at log in. It is loaded at the next log in, or by
// install now.
func writeAutostart() error {
	return writeFileIfChanged(launchAgentPath(), launchAgentPlist(bundleID, trayExe))
}

// install puts the app bundle this program is in (or, for a bare build, a bundle made around it) at
// ~/Applications/Codex Hub.app, replacing a running tray, and has launchd start it now and at each log in.
func install(from string) {
	first := !exists(trayExe)
	domain := "gui/" + strconv.Itoa(os.Getuid())
	exec.Command("launchctl", "bootout", domain+"/"+bundleID).Run() // the one launchd runs now, if any
	stopRunningTray()
	killStale(pidPath(), pusherExe)
	if err := placeBundle(from, bundleDir()); err != nil {
		fatal("Could not install to " + bundleDir() + ": " + err.Error())
	}
	say("Installed Codex Hub at " + bundleDir())
	if err := writeAutostart(); err != nil {
		fatal("Could not write " + launchAgentPath() + ": " + err.Error())
	}
	say("It starts when you log in: " + launchAgentPath())
	if err := bootstrap(domain); err != nil {
		log.Println("launchctl bootstrap:", err)
		if err := exec.Command("open", "-a", bundleDir()).Run(); err != nil {
			fatal("Could not start Codex Hub: " + err.Error())
		}
	}
	say("Started it; its log is " + filepath.Join(appDir, "tray.log"))
	if first {
		dialog("Codex Hub is installed in your Applications folder and starts when you log in. It sits in the menu bar, near the clock.\n\nIf the browser opens the hub's pairing page, choose Connect there to link this Mac.", "note")
	}
}

// bootstrap loads the LaunchAgent into the user's session, which starts the tray (RunAtLoad). A bootout just before
// can take a moment to finish.
func bootstrap(domain string) error {
	var err error
	for i := 0; i < 3; i++ {
		out, e := exec.Command("launchctl", "bootstrap", domain, launchAgentPath()).CombinedOutput()
		if e == nil {
			return nil
		}
		err = fmt.Errorf("%v: %s", e, bytes.TrimSpace(out))
		time.Sleep(time.Second)
	}
	return err
}

// trayAvailable: the menu bar is always there.
func trayAvailable() bool { return true }

func pusherAttr() *syscall.SysProcAttr {
	// macOS has no parent-death signal: the group is killed when the tray stops, or by the next tray from the pidfile.
	return &syscall.SysProcAttr{Setpgid: true}
}

// isProcess: pid runs exe, by the path it was started with.
func isProcess(pid int, exe string) bool {
	out, err := exec.Command("ps", "-o", "comm=", "-p", strconv.Itoa(pid)).Output()
	return err == nil && samePath(strings.TrimSpace(string(out)), exe)
}

// osascript runs an AppleScript that gets its text as an argument, so nothing in it needs quoting.
func osascript(script string, args ...string) *exec.Cmd {
	return exec.Command("osascript", append([]string{"-e", "on run argv", "-e", script, "-e", "end run"}, args...)...)
}

func message(text string) {
	log.Println(text)
	cmd := osascript(`display notification (item 1 of argv) with title "Codex Hub"`, text)
	if err := cmd.Start(); err == nil {
		go cmd.Wait()
	}
}

// dialog shows text until it is dismissed; icon is note or stop.
func dialog(text, icon string) {
	osascript(`display dialog (item 1 of argv) with title "Codex Hub" buttons {"OK"} default button "OK" with icon `+icon, text).Run()
}

func fatal(text string) {
	log.Println(text)
	fmt.Fprintln(os.Stderr, text)
	dialog(text, "stop")
	os.Exit(1)
}

func openURL(u string) {
	if err := spawn("open", u); err != nil {
		log.Println("open:", err)
	}
}
