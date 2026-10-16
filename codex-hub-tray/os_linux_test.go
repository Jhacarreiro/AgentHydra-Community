package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLinuxPaths(t *testing.T) {
	t.Cleanup(setPaths)
	t.Setenv("XDG_DATA_HOME", "relative/ignored")
	t.Setenv("XDG_CONFIG_HOME", "")
	setPaths()
	if want := filepath.Join(testHome, ".local", "share", "codex-hub"); appDir != want {
		t.Errorf("appDir %s, want %s", appDir, want)
	}
	if want := filepath.Join(testHome, ".config", "autostart", "codex-hub-tray.desktop"); autostartPath() != want {
		t.Errorf("autostart %s, want %s", autostartPath(), want)
	}
	data := filepath.Join(testHome, "data")
	t.Setenv("XDG_DATA_HOME", data)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(testHome, "conf"))
	setPaths()
	if appDir != filepath.Join(data, "codex-hub") || trayExe != filepath.Join(data, "codex-hub", "codex-hub-tray") ||
		pusherExe != filepath.Join(data, "codex-hub", "codex-hub-push") {
		t.Errorf("paths %s %s %s", appDir, trayExe, pusherExe)
	}
	if autostartPath() != filepath.Join(testHome, "conf", "autostart", "codex-hub-tray.desktop") {
		t.Errorf("autostart %s", autostartPath())
	}
}

func TestHasBus(t *testing.T) {
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", "")
	t.Setenv("XDG_RUNTIME_DIR", "")
	if hasBus() {
		t.Error("a bus with no address and no runtime dir")
	}
	rt := t.TempDir()
	t.Setenv("XDG_RUNTIME_DIR", rt)
	if hasBus() {
		t.Error("a bus with an empty runtime dir")
	}
	os.WriteFile(filepath.Join(rt, "bus"), nil, 0o600)
	if !hasBus() {
		t.Error("no bus with $XDG_RUNTIME_DIR/bus")
	}
}
