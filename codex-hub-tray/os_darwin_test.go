package main

import (
	"path/filepath"
	"testing"
)

func TestDarwinPaths(t *testing.T) {
	if want := filepath.Join(testHome, "Library", "Application Support", "codex-hub"); appDir != want {
		t.Errorf("appDir %s, want %s", appDir, want)
	}
	if want := filepath.Join(testHome, "Applications", "Codex Hub.app", "Contents", "MacOS", "codex-hub-tray"); trayExe != want {
		t.Errorf("trayExe %s, want %s", trayExe, want)
	}
	if want := filepath.Join(appDir, "codex-hub-push"); pusherExe != want {
		t.Errorf("pusherExe %s, want %s", pusherExe, want)
	}
	if want := filepath.Join(testHome, "Library", "LaunchAgents", bundleID+".plist"); launchAgentPath() != want {
		t.Errorf("LaunchAgent %s, want %s", launchAgentPath(), want)
	}
	if bundleOf(trayExe) != bundleDir() {
		t.Errorf("bundleOf(%s) = %s", trayExe, bundleOf(trayExe))
	}
}
