//go:build linux || darwin

package main

import (
	"bytes"
	"crypto/ed25519"
	"errors"
	"fmt"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
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

// buildHub serves one build as both the pusher and the tray (/api/codex-hub/{pusher,tray}[/download]), announcing
// sum and size whatever it sends, signed with testKey for the build asked for (the test calls useTestKey).
func buildHub(t *testing.T, body []byte, sum string, size int64) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("platform") != platform {
			http.Error(w, `{"error":"unknown platform"}`, http.StatusBadRequest)
			return
		}
		switch r.URL.Path {
		case "/api/codex-hub/pusher", "/api/codex-hub/tray":
			name := strings.TrimPrefix(r.URL.Path, "/api/codex-hub/")
			fmt.Fprintf(w, `{"sha256":%q,"size":%d,"signature":%q}`, sum, size, signedBy(testKey, name, sum))
		case "/api/codex-hub/pusher/download", "/api/codex-hub/tray/download":
			w.Write(body)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

const fakePusher = "#!/bin/sh\nif [ \"$1\" = --version ]; then echo codex-hub-push; exit 0; fi\nsleep 30\n"

func TestDownload(t *testing.T) {
	useTestKey(t)
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
			if !errors.As(err, new(badBuild)) {
				t.Errorf("%s: download took it, or not as a bad build: %v", c.name, err)
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

// A build is taken only as the build its --version says it is: the tray's build in the pusher's place starts as well,
// and so does the pusher's in the tray's.
func TestDownloadTakesOnlyTheBuildItWasFetchedAs(t *testing.T) {
	useTestKey(t)
	dest := filepath.Join(t.TempDir(), "build")
	for _, c := range []struct {
		name, prints string
		ok           bool
	}{
		{"pusher", "codex-hub-push", true},
		{"tray", "codex-hub-tray", true},
		{"pusher", "codex-hub-tray", false},
		{"tray", "codex-hub-push", false},
		{"pusher", "codex-hub-pusher", false},
		{"tray", "codex-hub-tray-next", false},
	} {
		body := []byte("#!/bin/sh\nif [ \"$1\" = --version ]; then echo " + c.prints + "; exit 0; fi\nsleep 30\n")
		srv := buildHub(t, body, sumOf(body), int64(len(body)))
		cfg := config{Hub: srv.URL, Token: "token-0123456789abcdef"}
		rel, err := latest(cfg, c.name)
		if err != nil || rel == nil {
			t.Fatalf("%s printing %s: latest: %v %v", c.name, c.prints, rel, err)
		}
		next, err := download(cfg, c.name, rel, dest)
		switch {
		case c.ok && err != nil:
			t.Errorf("%s printing %s: refused: %v", c.name, c.prints, err)
		case !c.ok && !errors.As(err, new(badBuild)):
			t.Errorf("%s printing %s: taken, or not as a bad build: %v", c.name, c.prints, err)
		case !c.ok && exists(dest+".new"):
			t.Errorf("%s printing %s: left %s.new", c.name, c.prints, dest)
		}
		os.Remove(next)
	}
}

// A build that fails its checks is fetched once, not at every check, until the hub hands out another; a download that
// fails on the way is tried again.
func TestABrokenBuildIsFetchedOnce(t *testing.T) {
	var mu sync.Mutex
	var body []byte
	status, downloads := http.StatusOK, 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		b, code := body, status
		if r.URL.Path == "/api/codex-hub/pusher/download" {
			downloads++
		}
		mu.Unlock()
		switch r.URL.Path {
		case "/api/codex-hub/pusher":
			fmt.Fprintf(w, `{"sha256":%q,"size":%d,"signature":%q}`, sumOf(b), len(b), signedBy(testKey, "pusher", sumOf(b)))
		case "/api/codex-hub/pusher/download":
			w.WriteHeader(code)
			w.Write(b)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() { os.Remove(configPath); os.Remove(pusherExe) })
	useTestKey(t)
	if err := saveConfig(config{Hub: srv.URL, Token: "token-0123456789abcdef"}); err != nil {
		t.Fatal(err)
	}
	a := newApp()
	for _, step := range []struct {
		what      string
		body      []byte
		status    int
		downloads int // in all, after two checks
		installed bool
	}{
		{"a build that does not start", []byte("#!/bin/sh\nexit 3\n"), http.StatusOK, 1, false},
		{"a Windows program", append([]byte("MZ\x90\x00"), make([]byte, 1<<20)...), http.StatusOK, 2, false},
		{"a download the hub fails", []byte(fakePusher), http.StatusServiceUnavailable, 4, false},
		{"the same build, served", []byte(fakePusher), http.StatusOK, 5, true},
	} {
		mu.Lock()
		body, status = step.body, step.status
		mu.Unlock()
		a.updateOnce()
		a.updateOnce()
		mu.Lock()
		got := downloads
		mu.Unlock()
		if got != step.downloads {
			t.Errorf("%s: %d downloads in all, want %d", step.what, got, step.downloads)
		}
		if exists(pusherExe) != step.installed || exists(pusherExe+".new") {
			t.Errorf("%s: pusher in place %v (want %v), .new left %v", step.what, exists(pusherExe), step.installed,
				exists(pusherExe+".new"))
		}
	}
	if have, _ := sha256File(pusherExe); have != sumOf([]byte(fakePusher)) {
		t.Error("the build that works is not the one in place")
	}
}

// With a key, a build is fetched only with its signature for that build on this platform: one that has none, or one
// for another key, build or hash, is refused before a byte of it comes down, once, and taken once it is signed.
func TestOnlyASignedBuildIsFetched(t *testing.T) {
	useTestKey(t)
	stranger := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{9}, ed25519.SeedSize))
	body := []byte(fakePusher)
	var mu sync.Mutex
	sig, downloads := "", 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch r.URL.Path {
		case "/api/codex-hub/pusher":
			fmt.Fprintf(w, `{"sha256":%q,"size":%d,"signature":%q}`, sumOf(body), len(body), sig)
		case "/api/codex-hub/pusher/download":
			downloads++
			w.Write(body)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() { os.Remove(configPath); os.Remove(pusherExe) })
	os.Remove(pusherExe)
	if err := saveConfig(config{Hub: srv.URL, Token: "token-0123456789abcdef"}); err != nil {
		t.Fatal(err)
	}
	a := newApp()
	for _, c := range []struct{ what, sig string }{
		{"not signed", ""},
		{"signed with another key", signedBy(stranger, "pusher", sumOf(body))},
		{"signed for the tray", signedBy(testKey, "tray", sumOf(body))},
		{"signed over another build", signedBy(testKey, "pusher", sumOf([]byte("another build")))},
		{"signed for another platform", signedFor(testKey, "pusher", "windows-arm64", sumOf(body))},
	} {
		mu.Lock()
		sig = c.sig
		mu.Unlock()
		a.updateOnce()
		a.updateOnce()
		if a.refused["pusher"] != sumOf(body)+" "+c.sig {
			t.Errorf("%s: not remembered as refused (%q)", c.what, a.refused["pusher"])
		}
		if exists(pusherExe) || exists(pusherExe+".new") {
			t.Fatalf("%s: a pusher was put in place", c.what)
		}
	}
	mu.Lock()
	sig = signedBy(testKey, "pusher", sumOf(body))
	mu.Unlock()
	a.updateOnce()
	mu.Lock()
	defer mu.Unlock()
	if downloads != 1 {
		t.Errorf("%d downloads, want only the signed one's", downloads)
	}
	if have, _ := sha256File(pusherExe); have != sumOf(body) {
		t.Error("the signed build is not in place")
	}
}

// A tray built without a key takes a build from an https hub, unsigned.
func TestNoKeyOverHTTPSIsTaken(t *testing.T) {
	body := []byte(fakePusher)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/codex-hub/pusher":
			fmt.Fprintf(w, `{"sha256":%q,"size":%d}`, sumOf(body), len(body))
		case "/api/codex-hub/pusher/download":
			w.Write(body)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	saved, savedLong := client.Transport, downloadClient.Transport
	client.Transport, downloadClient.Transport = srv.Client().Transport, srv.Client().Transport
	t.Cleanup(func() { client.Transport, downloadClient.Transport = saved, savedLong })
	if updateKey != "" {
		t.Fatal("this test is for a build without a key")
	}
	cfg := config{Hub: srv.URL, Token: "token-0123456789abcdef"}
	rel, err := latest(cfg, "pusher")
	if err != nil || rel == nil {
		t.Fatalf("latest: %v %v", rel, err)
	}
	next, err := download(cfg, "pusher", rel, filepath.Join(t.TempDir(), "codex-hub-push"))
	if err != nil {
		t.Fatalf("download over https: %v", err)
	}
	os.Remove(next)
}

// A build's --version runs with the hub's address and token set empty: one that does not know the flag (an older
// pusher put back on the hub) stops at its own check instead of running as a second pusher for this PC.
func TestVersionCheckGetsNoHubSettings(t *testing.T) {
	names := []string{"AGENTHYDRA_CODEX_HUB_URL", "AGENTHYDRA_CODEX_HUB_TOKEN", "CCMANAGERUI_CODEX_HUB_URL",
		"CCMANAGERUI_CODEX_HUB_TOKEN"}
	for _, name := range names {
		t.Setenv(name, "from-the-tray")
	}
	exe := filepath.Join(t.TempDir(), "build")
	if err := os.WriteFile(exe, []byte("#!/bin/sh\nenv\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	out, err := runVersion(exe)
	if err != nil {
		t.Fatal(err)
	}
	given := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		if k, v, ok := strings.Cut(line, "="); ok {
			given[k] = v
		}
	}
	for _, name := range names {
		if v, ok := given[name]; !ok || v != "" {
			t.Errorf("the build was given %s=%q (set %v), not an empty one", name, v, ok)
		}
	}
	if given["PATH"] == "" {
		t.Error("the build was given no PATH")
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
