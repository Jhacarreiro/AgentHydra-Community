package main

import (
	"bytes"
	"log"
	"os"
	"path/filepath"
	"strings"
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

// fakeSystemctl puts a systemctl on PATH that records its arguments, one call a line, and fails the calls whose
// arguments are fail.
func fakeSystemctl(t *testing.T, fail string) (calls func() []string) {
	t.Helper()
	bin := t.TempDir()
	record := filepath.Join(bin, "calls")
	script := "#!/bin/sh\necho \"$*\" >>'" + record + "'\n[ \"$*\" != '" + fail + "' ]\n"
	if err := os.WriteFile(filepath.Join(bin, "systemctl"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	return func() []string {
		b, _ := os.ReadFile(record)
		return strings.Fields(strings.ReplaceAll(strings.TrimSpace(string(b)), " ", "_"))
	}
}

// said captures what say writes to the log.
func said(t *testing.T) *bytes.Buffer {
	var b bytes.Buffer
	log.SetOutput(&b)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	return &b
}

// Without a desktop the autostart entry never runs, so systemd starts the tray: a --user unit, enabled and started.
// An install over it writes the same unit and starts the new build in the old one's place.
func TestStartServiceWithoutADesktop(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(t.TempDir(), "conf"))
	calls := fakeSystemctl(t, "")
	out := said(t)
	var want []string
	for round := 1; round <= 2; round++ {
		if !startService() {
			t.Fatalf("install %d: systemd did not start it:\n%s", round, out)
		}
		want = append(want, "--user_daemon-reload", "--user_enable_codex-hub-tray.service", "--user_restart_codex-hub-tray.service")
		if got := calls(); strings.Join(got, " ") != strings.Join(want, " ") {
			t.Errorf("install %d: systemctl calls %v, want %v", round, got, want)
		}
		b, err := os.ReadFile(servicePath())
		if err != nil || string(b) != serviceUnit(trayExe) {
			t.Fatalf("install %d: unit %q %v", round, b, err)
		}
		if units, _ := filepath.Glob(filepath.Join(filepath.Dir(servicePath()), "*")); len(units) != 1 {
			t.Errorf("install %d: units %v", round, units)
		}
	}
	if want := filepath.Join(os.Getenv("XDG_CONFIG_HOME"), "systemd", "user", "codex-hub-tray.service"); servicePath() != want {
		t.Errorf("unit at %s, want %s", servicePath(), want)
	}
	for _, s := range []string{"systemd starts it: now, at each log in", servicePath(), "loginctl enable-linger"} {
		if !strings.Contains(out.String(), s) {
			t.Errorf("it does not say %q:\n%s", s, out)
		}
	}
}

// When systemd cannot start it, or there is no systemctl, the install starts the tray itself and says plainly that
// nothing starts it again after a reboot.
func TestStartServiceSaysWhenNothingStartsItAgain(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(t.TempDir(), "conf"))
	fakeSystemctl(t, "--user enable codex-hub-tray.service")
	out := said(t)
	if startService() {
		t.Fatal("an enable that failed was taken")
	}
	if !strings.Contains(out.String(), "will not start again after a reboot") {
		t.Errorf("with enable failing it does not say so:\n%s", out)
	}

	t.Setenv("XDG_CONFIG_HOME", filepath.Join(t.TempDir(), "conf"))
	t.Setenv("PATH", t.TempDir())
	out.Reset()
	if startService() {
		t.Fatal("started without a systemctl")
	}
	if !strings.Contains(out.String(), "will not start again after a reboot") {
		t.Errorf("without systemctl it does not say so:\n%s", out)
	}
	if exists(servicePath()) {
		t.Error("a unit was written for a systemd that is not there")
	}
}
