//go:build linux || darwin

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestIconIsA32PixelPNG(t *testing.T) {
	for _, c := range []rgb{green, amber, grey} {
		img, err := png.Decode(bytes.NewReader(icon(c)))
		if err != nil {
			t.Fatalf("icon %v: %v", c, err)
		}
		if b := img.Bounds(); b.Dx() != 32 || b.Dy() != 32 {
			t.Fatalf("icon %v is %v", c, b)
		}
		// The ring is drawn in the status colour; the corners stay clear.
		r, g, bl, a := img.At(16, 2).RGBA()
		if a != 0xffff || r>>8 != uint32(c.r) || g>>8 != uint32(c.g) || bl>>8 != uint32(c.b) {
			t.Errorf("icon %v: ring pixel %x %x %x %x", c, r, g, bl, a)
		}
		if _, _, _, a := img.At(0, 0).RGBA(); a != 0 {
			t.Errorf("icon %v: corner alpha %x", c, a)
		}
	}
}

// buildHub serves one build at /api/codex-hub/pusher[/download], announcing sum and size whatever it sends.
func buildHub(t *testing.T, body []byte, sum string, size int64) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("platform") != platform {
			http.Error(w, `{"error":"unknown platform"}`, http.StatusBadRequest)
			return
		}
		switch r.URL.Path {
		case "/api/codex-hub/pusher":
			fmt.Fprintf(w, `{"sha256":%q,"size":%d}`, sum, size)
		case "/api/codex-hub/pusher/download":
			w.Write(body)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

const fakePusher = "#!/bin/sh\nif [ \"$1\" = --version ]; then echo codex-hub-push; exit 0; fi\nsleep 30\n"

func sumOf(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func TestDownload(t *testing.T) {
	body := []byte(fakePusher)
	dest := filepath.Join(t.TempDir(), "codex-hub-push")
	cases := []struct {
		name string
		sum  string
		size int64
		ok   bool
	}{
		{"wrong hash", strings.Repeat("0", 64), int64(len(body)), false},
		{"wrong size", sumOf(body), int64(len(body)) + 1, false},
		{"matching", sumOf(body), int64(len(body)), true},
	}
	for _, c := range cases {
		srv := buildHub(t, body, c.sum, c.size)
		cfg := config{Hub: srv.URL, Token: "token-0123456789abcdef"}
		rel, err := latest(cfg, "pusher")
		if err != nil || rel == nil {
			t.Fatalf("%s: latest: %v %v", c.name, rel, err)
		}
		next, err := download(cfg, "pusher", rel, dest)
		if !c.ok {
			if err == nil {
				t.Errorf("%s: download took it", c.name)
			}
			if exists(dest + ".new") {
				t.Errorf("%s: left %s.new", c.name, dest)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		st, err := os.Stat(next)
		if err != nil || next != dest+".new" {
			t.Fatalf("%s: %s %v", c.name, next, err)
		}
		if st.Mode().Perm()&0o100 == 0 {
			t.Errorf("%s: %s is not executable (%v)", c.name, next, st.Mode())
		}
	}
}

func TestDownloadRefusesAnUnknownPlatformAnswer(t *testing.T) {
	saved := platform
	platform = "plan9-x64"
	t.Cleanup(func() { platform = saved })
	srv := buildHub(t, nil, "", 0)
	if _, err := latest(config{Hub: srv.URL, Token: "token-0123456789abcdef"}, "pusher"); err == nil {
		t.Fatal("a 400 from the hub was taken as a build")
	}
}

func TestPlaceBundle(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "dl", "Codex Hub.app")
	exe := filepath.Join(src, "Contents", "MacOS", "codex-hub-tray")
	os.MkdirAll(filepath.Dir(exe), 0o755)
	os.WriteFile(exe, []byte("program"), 0o755)
	os.WriteFile(filepath.Join(src, "Contents", "Info.plist"), []byte(infoPlist("com.example.test")), 0o644)
	os.Symlink("MacOS/codex-hub-tray", filepath.Join(src, "Contents", "link"))
	if got := bundleOf(exe); got != resolved(src) {
		t.Fatalf("bundleOf = %q", got)
	}

	dst := filepath.Join(dir, "Applications", "Codex Hub.app")
	os.MkdirAll(dst, 0o755)
	os.WriteFile(filepath.Join(dst, "stale"), nil, 0o644)
	if err := placeBundle(exe, dst); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(filepath.Join(dst, "Contents", "MacOS", "codex-hub-tray"))
	if err != nil || st.Mode().Perm() != 0o755 {
		t.Fatalf("installed program: %v %v", st, err)
	}
	if l, err := os.Readlink(filepath.Join(dst, "Contents", "link")); err != nil || l != "MacOS/codex-hub-tray" {
		t.Errorf("symlink: %q %v", l, err)
	}
	if exists(filepath.Join(dst, "stale")) {
		t.Error("the previous bundle's files are still there")
	}
	if m, _ := filepath.Glob(filepath.Join(dir, "Applications", ".*")); len(m) != 0 {
		t.Errorf("left behind: %v", m)
	}

	// A bare build gets a bundle made around it.
	bare := filepath.Join(dir, "codex-hub-tray-darwin-arm64")
	os.WriteFile(bare, []byte("bare"), 0o755)
	if bundleOf(bare) != "" {
		t.Fatal("a bare build was taken for a bundle")
	}
	if err := placeBundle(bare, dst); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dst, "Contents", "MacOS", "codex-hub-tray")); string(b) != "bare" {
		t.Errorf("program: %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(dst, "Contents", "Info.plist")); !strings.Contains(string(b), "<string>"+bundleID+"</string>") {
		t.Errorf("Info.plist:\n%s", b)
	}
}

func TestKillStaleSparesAnotherProgram(t *testing.T) {
	// By its full path: macOS's ps names a process by what it was started as.
	sleep := mustLookPath(t, "sleep")
	other := exec.Command(sleep, "30")
	if err := other.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { other.Process.Kill(); other.Wait() })
	pidfile := filepath.Join(t.TempDir(), "pusher.pid")
	os.WriteFile(pidfile, []byte(fmt.Sprintf("%d\n", other.Process.Pid)), 0o644)
	killStale(pidfile, pusherExe)
	time.Sleep(100 * time.Millisecond)
	if err := other.Process.Signal(syscall.Signal(0)); err != nil {
		t.Fatalf("killStale killed a process that is not the pusher: %v", err)
	}
	if !isProcess(other.Process.Pid, sleep) {
		t.Error("isProcess does not recognise sleep by its path")
	}
}

func mustLookPath(t *testing.T, name string) string {
	p, err := exec.LookPath(name)
	if err != nil {
		t.Skip(name, "is not on PATH")
	}
	return p
}
