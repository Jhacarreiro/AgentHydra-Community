package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/godbus/dbus/v5"
)

func osPaths() (dir, tray, pusher string) {
	dir = filepath.Join(xdgDir("XDG_DATA_HOME", ".local/share"), "codex-hub")
	return dir, filepath.Join(dir, "codex-hub-tray"), filepath.Join(dir, "codex-hub-push")
}

// xdgDir is the XDG base directory env names, or its default under the home folder (a relative value does not count).
func xdgDir(env, def string) string {
	if d := os.Getenv(env); filepath.IsAbs(d) {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, def)
}

func autostartPath() string {
	return filepath.Join(xdgDir("XDG_CONFIG_HOME", ".config"), "autostart", "codex-hub-tray.desktop")
}

func writeAutostart() error {
	return writeFileIfChanged(autostartPath(), desktopEntry(trayExe))
}

// install copies a downloaded build to its place, replacing a running tray, adds the autostart entry and starts it.
func install(from string) {
	first := !exists(trayExe)
	stopRunningTray()
	killStale(pidPath(), pusherExe)
	// A running program's file cannot be written over, but it can be renamed over.
	next := trayExe + ".new"
	os.Remove(next)
	err := copyFile(from, next)
	if err == nil {
		err = os.Rename(next, trayExe)
	}
	if err != nil {
		os.Remove(next)
		fatal("Could not install to " + trayExe + ": " + err.Error())
	}
	say("Installed Codex Hub at " + trayExe)
	if err := writeAutostart(); err != nil {
		say("Could not add it to the programs that start at log in (" + autostartPath() + "): " + err.Error())
	} else {
		say("It starts when you log in: " + autostartPath())
	}
	if err := startDetached(trayExe); err != nil {
		fatal("Could not start Codex Hub: " + err.Error())
	}
	say("Started it; its log is " + filepath.Join(appDir, "tray.log"))
	if !hasBus() {
		say("There is no desktop session here, so it runs without an icon.")
	}
	if !hasDisplay() {
		say("To connect this PC, open the pairing address it writes to that log in a browser on this PC, or put the hub token in " + configPath + ".")
	}
	if first {
		message("Codex Hub is installed and starts when you log in. It sits in the system tray (on GNOME, with the AppIndicator extension).\n\nIf the browser opens the hub's pairing page, choose Connect there to link this PC.")
	}
}

// hasBus: a desktop session's D-Bus, which the tray icon goes through.
func hasBus() bool {
	if os.Getenv("DBUS_SESSION_BUS_ADDRESS") != "" {
		return true
	}
	rt := os.Getenv("XDG_RUNTIME_DIR")
	return rt != "" && exists(filepath.Join(rt, "bus"))
}

// trayAvailable: the session bus answers. Without it systray.Run cannot work (its Quit panics).
func trayAvailable() bool {
	if !hasBus() {
		return false
	}
	_, err := dbus.SessionBus() // systray's own connection is this one
	return err == nil
}

func hasDisplay() bool {
	return os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != ""
}

func pusherAttr() *syscall.SysProcAttr {
	// The pusher gets SIGTERM if this tray dies, however it dies.
	return &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGTERM}
}

// isProcess: pid runs exe (a program replaced on disk since shows as "exe (deleted)").
func isProcess(pid int, exe string) bool {
	p, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid))
	return err == nil && samePath(strings.TrimSuffix(p, " (deleted)"), exe)
}

func message(text string) {
	if p, err := exec.LookPath("notify-send"); err == nil {
		log.Println(text)
		if spawn(p, "--app-name=Codex Hub", "Codex Hub", text) == nil {
			return
		}
	}
	tell(text)
}

func fatal(text string) {
	log.Println(text)
	fmt.Fprintln(os.Stderr, text)
	if p, err := exec.LookPath("notify-send"); err == nil {
		exec.Command(p, "--app-name=Codex Hub", "--urgency=critical", "Codex Hub", text).Run()
	}
	os.Exit(1)
}

// openURL opens a page or a file in the desktop's browser or app for it; with no display, it says where to go.
func openURL(u string) {
	if !hasDisplay() {
		log.Println("open in a browser on this PC:", u)
		fmt.Println("Codex Hub: open in a browser on this PC:", u)
		return
	}
	if err := spawn("xdg-open", u); err != nil {
		log.Println("open:", err)
	}
}
