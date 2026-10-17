package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

// Every test runs with a scratch home, so nothing reads or writes the real config.
var testHome string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "codex-hub-tray-test-")
	if err != nil {
		panic(err)
	}
	testHome = dir
	os.Setenv("HOME", dir)
	os.Setenv("LOCALAPPDATA", filepath.Join(dir, "AppData", "Local"))
	os.Unsetenv("XDG_DATA_HOME")
	os.Unsetenv("XDG_CONFIG_HOME")
	os.Unsetenv("AGENTHYDRA_CODEX_HUB_TOKEN")
	setPaths()
	os.MkdirAll(appDir, 0o755)
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

func TestPlatformName(t *testing.T) {
	for _, c := range []struct{ goos, goarch, want string }{
		{"windows", "amd64", "windows-x64"},
		{"linux", "amd64", "linux-x64"},
		{"linux", "arm64", "linux-arm64"},
		{"darwin", "amd64", "darwin-x64"},
		{"darwin", "arm64", "darwin-arm64"},
	} {
		if got := platformName(c.goos, c.goarch); got != c.want {
			t.Errorf("platformName(%s, %s) = %s, want %s", c.goos, c.goarch, got, c.want)
		}
	}
}

func TestPathsAreUnderHome(t *testing.T) {
	for _, p := range []string{appDir, trayExe, pusherExe, configPath} {
		if !strings.HasPrefix(p, testHome) {
			t.Errorf("%s is not under the test home %s", p, testHome)
		}
	}
}

func TestConfigRoundTrip(t *testing.T) {
	t.Cleanup(func() { os.Remove(configPath) })
	os.Remove(configPath)
	hubURL = "http://hub.example.test:18788"
	t.Cleanup(func() { hubURL = "" })
	t.Setenv("AGENTHYDRA_CODEX_HUB_TOKEN", " from-the-environment-0123 ")
	if c := loadConfig(); c.Hub != hubURL || c.Token != "from-the-environment-0123" {
		t.Fatalf("defaults: %+v", c)
	}
	if err := saveConfig(config{Hub: "http://other.example.test/", Token: "saved-token-0123456789"}); err != nil {
		t.Fatal(err)
	}
	if c := loadConfig(); c.Hub != "http://other.example.test" || c.Token != "saved-token-0123456789" {
		t.Fatalf("saved: %+v", c)
	}
	st, err := os.Stat(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && st.Mode().Perm() != 0o600 {
		t.Errorf("config file mode %v, want 0600: it holds the token", st.Mode().Perm())
	}
}

// testKey stands in for the operator's key; useTestKey builds the tray with its public half for one test.
var testKey = ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, ed25519.SeedSize))

func useTestKey(t *testing.T) {
	saved := updateKey
	updateKey = base64.StdEncoding.EncodeToString(testKey.Public().(ed25519.PublicKey))
	t.Cleanup(func() { updateKey = saved })
}

// signedFor is the signature key gives the build of name for plat whose hash is sum; signedBy, for this platform.
func signedFor(key ed25519.PrivateKey, name, plat, sum string) string {
	return base64.StdEncoding.EncodeToString(ed25519.Sign(key, buildSignedText(name, plat, sum)))
}

func signedBy(key ed25519.PrivateKey, name, sum string) string {
	return signedFor(key, name, platform, sum)
}

func sumOf(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// The same key and build as tests/codex-hub-sign.test.ts, which signs them with scripts/codex-hub-sign.ts: the seed
// is the bytes 0 to 31, the build the text "example build", the pusher's for linux-x64.
func TestBuildSignatureVector(t *testing.T) {
	const (
		public = "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg="
		sig    = "bwOwxxI7hsyg9pKJlH3lbMjIC0EG5u9wQyR5soqZ5JPQz8V1M65jodrtlDz5pOlAZLxWw8h9E26hEg67SqpcCA=="
	)
	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = byte(i)
	}
	if got := base64.StdEncoding.EncodeToString(ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)); got != public {
		t.Fatalf("public key %s", got)
	}
	saved, savedKey := platform, updateKey
	platform, updateKey = "linux-x64", public
	t.Cleanup(func() { platform, updateKey = saved, savedKey })
	c := config{Hub: "http://hub.example.test"}
	rel := &release{SHA256: sumOf([]byte("example build")), Signature: sig + "\n"}
	if err := checkSigned(c, "pusher", rel); err != nil {
		t.Fatalf("the signature the script made: %v", err)
	}
	if err := checkSigned(c, "tray", rel); !errors.As(err, new(badBuild)) {
		t.Errorf("taken as the tray's: %v", err)
	}
	platform = "linux-arm64"
	if err := checkSigned(c, "pusher", rel); !errors.As(err, new(badBuild)) {
		t.Errorf("taken on another platform: %v", err)
	}
}

// What the tray takes: with a key, a build signed with it for that name and this platform; without one, a build from
// an https hub only. A refusal for a build's signature is a bad build (remembered); one for this tray's key is not.
func TestCheckSigned(t *testing.T) {
	useTestKey(t)
	stranger := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{8}, ed25519.SeedSize))
	sum := sumOf([]byte("a build"))
	plain := config{Hub: "http://hub.example.test:18788"}
	for _, c := range []struct {
		what, name, sig string
		ok              bool
	}{
		{"signed", "pusher", signedBy(testKey, "pusher", sum), true},
		{"the tray, signed", "tray", signedBy(testKey, "tray", sum), true},
		{"signed with another key", "pusher", signedBy(stranger, "pusher", sum), false},
		{"signed for the tray", "pusher", signedBy(testKey, "tray", sum), false},
		{"signed over another hash", "pusher", signedBy(testKey, "pusher", sumOf([]byte("other"))), false},
		{"signed for another platform", "pusher", signedFor(testKey, "pusher", "windows-arm64", sum), false},
		{"not signed", "pusher", "", false},
		{"not base64", "pusher", "not a signature", false},
	} {
		err := checkSigned(plain, c.name, &release{SHA256: sum, Signature: c.sig})
		if c.ok != (err == nil) || (!c.ok && !errors.As(err, new(badBuild))) {
			t.Errorf("%s: %v", c.what, err)
		}
	}
	other := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 31))
	for _, c := range []struct {
		key, hub string
		want     error
	}{
		{"", "http://hub.example.test:18788", errNoKey},
		{"", "https://hub.example.test", nil},
		{"", "HTTPS://hub.example.test", nil},
		{"", "", errNoKey},
		{other, "https://hub.example.test", errBadKey},
		{"not base64!", "https://hub.example.test", errBadKey},
	} {
		updateKey = c.key
		if err := updatesAllowed(c.hub); err != c.want {
			t.Errorf("key %q, hub %q: %v, want %v", c.key, c.hub, err, c.want)
		}
		// Unsigned: without a key only the https hub's build is taken.
		err := checkSigned(config{Hub: c.hub}, "pusher", &release{SHA256: sum})
		if err != c.want || errors.As(err, new(badBuild)) {
			t.Errorf("key %q, hub %q: checkSigned %v", c.key, c.hub, err)
		}
	}
}

// A tray built without a key, whose hub is http, takes nothing: it says so once in the log and in amber, and never
// asks the hub for a build file.
func TestNoKeyOverHTTPTakesNothing(t *testing.T) {
	var mu sync.Mutex
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.URL.Path)
		mu.Unlock()
		json.NewEncoder(w).Encode(release{SHA256: strings.Repeat("ab", 32), Size: 1})
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() { os.Remove(configPath) })
	if err := saveConfig(config{Hub: srv.URL, Token: "token-0123456789abcdef"}); err != nil {
		t.Fatal(err)
	}
	var logged bytes.Buffer
	log.SetOutput(&logged)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	a := newApp()
	for i := 0; i < 3; i++ {
		a.updateOnce()
	}
	if n := strings.Count(logged.String(), "update: this build has no update key"); n != 1 {
		t.Errorf("logged the missing key %d times:\n%s", n, logged.String())
	}
	if !strings.Contains(a.shown, "no update key") {
		t.Errorf("status %q", a.shown)
	}
	for _, p := range paths {
		if p != "/api/codex-hub/pusher" {
			t.Errorf("asked the hub for %s", p)
		}
	}
	if exists(pusherExe) || exists(pusherExe+".new") {
		t.Error("a pusher was put in place")
	}
}

// fakeHub answers GET /api/codex-hub/pusher for one token, recording the platform each request named.
func fakeHub(t *testing.T, token string, platforms *[]string) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*platforms = append(*platforms, r.URL.Query().Get("platform"))
		if r.Header.Get("Authorization") != "Bearer "+token {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		json.NewEncoder(w).Encode(release{SHA256: strings.Repeat("ab", 32), Size: 1})
	}))
	t.Cleanup(srv.Close)
	return srv
}

// The tray's own requests carry the extra headers the pusher sends (AGENTHYDRA_CODEX_HUB_HEADERS), as a hub behind an
// access proxy needs: the build checks, the download and the token check made while pairing.
func TestHubRequestsCarryTheExtraHeaders(t *testing.T) {
	var mu sync.Mutex
	seen := map[string]http.Header{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen[r.URL.Path] = r.Header.Clone()
		mu.Unlock()
		if r.Header.Get("X-Hub-Access") != "e2e-access" {
			http.Error(w, "the access proxy wants its header", http.StatusForbidden)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/download") {
			w.Write([]byte("not the announced build"))
			return
		}
		sum := strings.Repeat("ab", 32)
		json.NewEncoder(w).Encode(release{SHA256: sum, Size: 1, Signature: signedBy(testKey, "tray", sum)})
	}))
	t.Cleanup(srv.Close)
	useTestKey(t)
	cfg := config{Hub: srv.URL, Token: "token-0123456789abcdef"}
	t.Setenv("AGENTHYDRA_CODEX_HUB_HEADERS", `{"X-Hub-Access":"e2e-access","Authorization":"not this"}`)
	rel, err := latest(cfg, "tray")
	if err != nil || rel == nil {
		t.Fatalf("latest: %v %v", rel, err)
	}
	if err := tokenWorks(cfg); err != nil {
		t.Fatalf("tokenWorks: %v", err)
	}
	download(cfg, "tray", rel, filepath.Join(t.TempDir(), "codex-hub-tray"))
	for _, path := range []string{"/api/codex-hub/tray", "/api/codex-hub/pusher", "/api/codex-hub/tray/download"} {
		h := seen[path]
		if h == nil {
			t.Errorf("%s was not asked", path)
			continue
		}
		if h.Get("X-Hub-Access") != "e2e-access" || h.Get("Authorization") != "Bearer "+cfg.Token {
			t.Errorf("%s: X-Hub-Access %q, Authorization %q", path, h.Get("X-Hub-Access"), h.Get("Authorization"))
		}
	}

	// A value that is not a JSON object of strings is left out, and the request still goes.
	t.Setenv("AGENTHYDRA_CODEX_HUB_HEADERS", `X-Hub-Access: e2e-access`)
	if _, err := latest(cfg, "tray"); err == nil || !strings.Contains(err.Error(), "403") {
		t.Errorf("latest with a broken header list: %v", err)
	}
}

func TestTokenUsable(t *testing.T) {
	// The hub takes any token its operator set, trimmed; this app can send it when it is printable ASCII.
	var printable []byte
	for c := byte(' ' + 1); c <= '~'; c++ {
		printable = append(printable, c)
	}
	for _, ok := range []string{"x", "short", "has spaces inside", "Hub_Token-0123456789~!", string(printable), strings.Repeat("x", 512)} {
		if !tokenUsable(ok) {
			t.Errorf("refused %q", ok)
		}
	}
	for _, bad := range []string{"", " padded", "padded ", "two\nlines", "a\rb", "tab\there", "del\x7f", "\xff\xfe", strings.Repeat("x", 513),
		// The hub reads the header a byte to a character, so these never match its token.
		"tökén ñ", "no\u00a0break", "dash\u2010", strings.Repeat("é", 256)} {
		if tokenUsable(bad) {
			t.Errorf("took %q", bad)
		}
	}
}

// The pairing page names the PC as the pusher does (defaultPcName in server/src/core/codex-hub-push.ts).
func TestPcNameFrom(t *testing.T) {
	bonjour := func() string { return "Example-Mac" }
	none := func() string { return "" }
	for _, c := range []struct {
		host, goos string
		bonjour    func() string
		want       string
	}{
		{"Example-Mac.lan", "darwin", bonjour, "Example-Mac"},
		{"Example-Mac.fritz.box", "darwin", none, "Example-Mac"},
		{"Example-PC.local", "linux", none, "Example-PC"},
		{"example-pc.home.lan", "linux", none, "example-pc"},
		{"build.example.test", "linux", none, "build.example.test"},
		{"EXAMPLE-PC", "windows", none, "EXAMPLE-PC"},
		{".local", "linux", none, ".local"},
	} {
		if got := pcNameFrom(c.host, c.goos, c.bonjour); got != c.want {
			t.Errorf("pcNameFrom(%q, %s) = %q, want %q", c.host, c.goos, got, c.want)
		}
	}
	t.Setenv("AGENTHYDRA_CODEX_HUB_PC", "Named-PC")
	if got := pcName(); got != "Named-PC" {
		t.Errorf("pcName() with AGENTHYDRA_CODEX_HUB_PC = %q", got)
	}
}

func TestPairHandler(t *testing.T) {
	// Short, with a space and punctuation: the hub takes such a token, so the tray does too.
	const good = "Hub Token ~!"
	var platforms []string
	srv := fakeHub(t, good, &platforms)
	t.Cleanup(func() { os.Remove(configPath) })
	if err := saveConfig(config{Hub: srv.URL}); err != nil {
		t.Fatal(err)
	}
	a := newApp()
	finished := false
	h := a.pairHandler("the-state", func() { finished = true })
	post := func(state, token string) (int, string) {
		form := url.Values{"state": {state}, "token": {token}}
		req := httptest.NewRequest(http.MethodPost, "/paired", strings.NewReader(form.Encode()))
		req.Header.Set("content-type", "application/x-www-form-urlencoded")
		rec := httptest.NewRecorder()
		h(rec, req)
		b, _ := io.ReadAll(rec.Body)
		return rec.Code, string(b)
	}

	if code, body := post("another-state", good); code != http.StatusBadRequest || !strings.Contains(body, "not the one this PC opened") {
		t.Errorf("wrong state: %d %s", code, body)
	}
	// A token the tray cannot use gets its own message, not the one for a forged post.
	for _, bad := range []string{"", "two\nlines", strings.Repeat("x", 513)} {
		if code, body := post("the-state", bad); code != http.StatusBadRequest || !strings.Contains(body, "shape this app cannot use") {
			t.Errorf("token %q: %d %s", bad, code, body)
		}
	}
	// One that is not ASCII is refused here, saying why, rather than sent for the hub to refuse.
	if code, body := post("the-state", "Hub tökén ~!"); code != http.StatusBadRequest || !strings.Contains(body, "ASCII") {
		t.Errorf("a token that is not ASCII: %d %s", code, body)
	}
	if c := loadConfig(); c.Token != "" || finished {
		t.Fatalf("a refused post saved %q (finished %v)", c.Token, finished)
	}
	for _, refused := range []string{"short", "refused by the hub", strings.Repeat("x", 512)} {
		if code, body := post("the-state", refused); code != http.StatusUnauthorized || !strings.Contains(body, "did not take that token") {
			t.Errorf("token the hub refuses (%q): %d %s", refused, code, body)
		}
	}
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodGet, "/paired", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET: %d", rec.Code)
	}

	if code, body := post("the-state", good); code != http.StatusOK {
		t.Fatalf("valid post: %d %s", code, body)
	}
	if c := loadConfig(); c.Token != good || c.Hub != srv.URL {
		t.Fatalf("saved config: %+v", c)
	}
	if !finished {
		t.Error("a valid post did not finish the pairing")
	}
	for _, p := range platforms {
		if p != platform {
			t.Errorf("the hub was asked for platform %q, want %q", p, platform)
		}
	}
}

func TestExeSystem(t *testing.T) {
	for head, want := range map[string]string{
		"MZ\x90\x00":       "windows",
		"\x7fELF\x02":      "linux",
		"\xcf\xfa\xed\xfe": "darwin", // arm64 and x64
		"\xfe\xed\xfa\xce": "darwin",
		"\xca\xfe\xba\xbe": "darwin", // universal
		"#!/bin/sh":        "",
		"MZ":               "windows",
		"\x7fEL":           "",
		"":                 "",
	} {
		if got := exeSystem([]byte(head)); got != want {
			t.Errorf("exeSystem(%q) = %q, want %q", head, got, want)
		}
	}
}

// The supervisor and the updater both show a status, so two goroutines ask for icons at once (go test -race).
func TestIconsFromTwoGoroutines(t *testing.T) {
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for _, c := range []rgb{green, amber, grey, green} {
				if len(icon(c)) == 0 {
					t.Errorf("no icon for %v", c)
				}
			}
		}()
	}
	wg.Wait()
}

func TestDesktopEntry(t *testing.T) {
	e := desktopEntry("/home/me/.local/share/codex-hub/codex-hub-tray")
	for _, line := range []string{
		"[Desktop Entry]",
		"Type=Application",
		"Exec=/home/me/.local/share/codex-hub/codex-hub-tray",
		"X-GNOME-Autostart-enabled=true",
	} {
		if !strings.Contains(e, line+"\n") {
			t.Errorf("entry has no %q:\n%s", line, e)
		}
	}
	for in, want := range map[string]string{
		"/home/me/My Apps/tray":  `"/home/me/My Apps/tray"`,
		"/home/me/100%/tray":     `"/home/me/100%%/tray"`,
		`/home/me/a"b$c/tray`:    `"/home/me/a\\"b\\$c/tray"`,
		`/home/me/back\slash/tr`: `"/home/me/back\\\\slash/tr"`,
	} {
		if got := desktopExec(in); got != want {
			t.Errorf("desktopExec(%q) = %s, want %s", in, got, want)
		}
	}
}

// plistValues reads a plist's top-level dict as key -> value: a string's text, or the element's name for anything
// else (true, false, dict, array). It fails the test unless the plist is well-formed XML.
func plistValues(t *testing.T, doc string) map[string]string {
	t.Helper()
	var p struct {
		Dict struct {
			Items []struct {
				XMLName xml.Name
				Text    string `xml:",chardata"`
			} `xml:",any"`
		} `xml:"dict"`
	}
	d := xml.NewDecoder(strings.NewReader(doc))
	d.Strict = true
	if err := d.Decode(&p); err != nil {
		t.Fatalf("plist is not well-formed: %v\n%s", err, doc)
	}
	out := map[string]string{}
	items := p.Dict.Items
	for i := 0; i+1 < len(items); i += 2 {
		if items[i].XMLName.Local != "key" {
			t.Fatalf("expected a key, got %s", items[i].XMLName.Local)
		}
		v := items[i+1].XMLName.Local
		if v == "string" {
			v = items[i+1].Text
		}
		out[items[i].Text] = v
	}
	return out
}

func TestLaunchAgentPlist(t *testing.T) {
	exe := "/Users/me/Applications/Codex Hub.app/Contents/MacOS/codex-hub-tray"
	doc := launchAgentPlist("com.example.codex-hub-tray", exe)
	v := plistValues(t, doc)
	for k, want := range map[string]string{
		"Label":                  "com.example.codex-hub-tray",
		"RunAtLoad":              "true",
		"LimitLoadToSessionType": "Aqua",
		"ProcessType":            "Interactive",
		"KeepAlive":              "dict",
		"ProgramArguments":       "array",
	} {
		if v[k] != want {
			t.Errorf("%s = %q, want %q", k, v[k], want)
		}
	}
	for _, s := range []string{"<string>" + exe + "</string>", "<key>SuccessfulExit</key>\n\t\t<false/>"} {
		if !strings.Contains(doc, s) {
			t.Errorf("plist has no %q:\n%s", s, doc)
		}
	}
	if doc := launchAgentPlist("a&b", "/Users/me/<odd>/tray"); !strings.Contains(doc, "a&amp;b") || !strings.Contains(doc, "&lt;odd&gt;") {
		t.Errorf("not escaped:\n%s", doc)
	} else {
		plistValues(t, doc)
	}
}

func TestInfoPlist(t *testing.T) {
	v := plistValues(t, infoPlist("com.example.codex-hub-tray"))
	for k, want := range map[string]string{
		"CFBundleIdentifier":  "com.example.codex-hub-tray",
		"CFBundleExecutable":  "codex-hub-tray",
		"CFBundlePackageType": "APPL",
		"LSUIElement":         "true",
	} {
		if v[k] != want {
			t.Errorf("%s = %q, want %q", k, v[k], want)
		}
	}
}

// postToken posts token to h as the hub's pairing page does, for this pairing's state.
func postToken(h http.HandlerFunc, state, token string) (int, string) {
	form := url.Values{"state": {state}, "token": {token}}
	req := httptest.NewRequest(http.MethodPost, "/paired", strings.NewReader(form.Encode()))
	req.Header.Set("content-type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	h(rec, req)
	b, _ := io.ReadAll(rec.Body)
	return rec.Code, string(b)
}

// savedFile is tray.json as it is on disk.
func savedFile(t *testing.T) map[string]string {
	t.Helper()
	b, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]string
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("tray.json: %v\n%s", err, b)
	}
	return m
}

// Pairing saves the token alone: the hub stays the build's (-X main.hubURL), so the hub a later build names is the
// one the PC uses.
func TestPairingLeavesTheHubToTheBuild(t *testing.T) {
	const token = "Hub Token ~!"
	var platforms []string
	srv := fakeHub(t, token, &platforms)
	saved := hubURL
	t.Cleanup(func() { hubURL = saved; os.Remove(configPath) })
	os.Remove(configPath)
	hubURL = srv.URL + "/"
	a := newApp()
	if code, body := postToken(a.pairHandler("the-state", func() {}), "the-state", token); code != http.StatusOK {
		t.Fatalf("pairing: %d %s", code, body)
	}
	if f := savedFile(t); f["token"] != token || f["hub"] != "" {
		t.Errorf("tray.json %v: want the token and no hub", f)
	}
	hubURL = "https://hub-next.example.test"
	if c := loadConfig(); c.Hub != hubURL || c.Token != token {
		t.Errorf("with the next build's hub: %+v", c)
	}
}

// A tray.json in which an earlier build saved its own hub with the token: that hub is the build's, not one the user
// chose, so it does not count, and the start takes it out of the file before a build with another hub comes. A hub
// the user set stays.
func TestTheBuildsHubIsNotKeptAsTheUsers(t *testing.T) {
	saved := hubURL
	t.Cleanup(func() { hubURL = saved; os.Remove(configPath) })
	hubURL = "http://hub.example.test:18788"
	const token = "Hub Token ~!"
	if err := os.WriteFile(configPath, []byte(`{"hub": "http://hub.example.test:18788/", "token": "`+token+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if c := savedConfig(); c.Hub != "" || c.Token != token {
		t.Errorf("savedConfig %+v: want the token and no hub", c)
	}
	if err := unpinBuildHub(); err != nil {
		t.Fatal(err)
	}
	if f := savedFile(t); f["token"] != token || f["hub"] != "" {
		t.Errorf("tray.json %v after the start: want the token and no hub", f)
	}
	hubURL = "https://hub-next.example.test"
	if c := loadConfig(); c.Hub != hubURL || c.Token != token {
		t.Errorf("with the next build's hub: %+v", c)
	}

	const mine = "http://10.0.0.5:18788"
	if err := saveConfig(config{Hub: mine, Token: token}); err != nil {
		t.Fatal(err)
	}
	if err := unpinBuildHub(); err != nil {
		t.Fatal(err)
	}
	if f := savedFile(t); f["hub"] != mine {
		t.Errorf("the user's hub was dropped: %v", f)
	}
	if c := loadConfig(); c.Hub != mine {
		t.Errorf("the user's hub is not the one used: %+v", c)
	}
}
