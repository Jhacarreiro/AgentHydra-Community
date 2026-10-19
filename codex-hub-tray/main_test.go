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
	"fmt"
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
	"time"
)

// Every test runs with a scratch home, so nothing reads or writes the real config.
var testHome string

// goEnv is the environment's home folders as the test started, which tell the go command where its caches are.
var goEnv []string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "codex-hub-tray-test-")
	if err != nil {
		panic(err)
	}
	testHome = dir
	// Go keeps its caches where it had them, for the test that builds the fake hub (TestContract).
	for _, name := range []string{"HOME", "USERPROFILE", "LOCALAPPDATA"} {
		if v, ok := os.LookupEnv(name); ok {
			goEnv = append(goEnv, name+"="+v)
		}
	}
	os.Setenv("HOME", dir)
	os.Setenv("USERPROFILE", dir) // the home os.UserHomeDir gives on Windows
	os.Setenv("LOCALAPPDATA", filepath.Join(dir, "AppData", "Local"))
	// The pusher's config folder (pusherConfigDir) is then the scratch home's, and the name the tray pairs as its own.
	for _, name := range []string{"XDG_DATA_HOME", "XDG_CONFIG_HOME", "AGENTHYDRA_CODEX_HUB_TOKEN", "AGENTHYDRA_HOME",
		"CCMANAGERUI_HOME", "AGENTHYDRA_CODEX_HUB_PC", "CCMANAGERUI_CODEX_HUB_PC", "AGENTHYDRA_CODEX_HUB_INSTALL"} {
		os.Unsetenv(name)
	}
	setPaths()
	os.MkdirAll(appDir, 0o755)
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

// waitFor waits until ok, failing the test once d has gone by.
func waitFor(t *testing.T, d time.Duration, what string, ok func() bool) {
	t.Helper()
	for end := time.Now().Add(d); time.Now().Before(end); time.Sleep(50 * time.Millisecond) {
		if ok() {
			return
		}
	}
	if !ok() {
		t.Fatalf("%s: not within %s", what, d)
	}
}

// syncLog is the log while a test reads it, with the tray's goroutines writing.
type syncLog struct {
	mu sync.Mutex
	b  strings.Builder
}

func (l *syncLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *syncLog) count(s string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Count(l.b.String(), s)
}

func (l *syncLog) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

// captureLog sends the log to a syncLog for the rest of the test.
func captureLog(t *testing.T) *syncLog {
	l := &syncLog{}
	log.SetOutput(l)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	// What logOnce said in an earlier test (or run, with -count) is said again here.
	logged.Range(func(k, _ any) bool { logged.Delete(k); return true })
	return l
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

// tray.json keeps every field, and is written at 0600 all at once, even over a file an earlier build left at 0644.
func TestConfigRoundTrip(t *testing.T) {
	t.Cleanup(func() { os.Remove(configPath) })
	os.Remove(configPath)
	t.Setenv("AGENTHYDRA_HOME", t.TempDir())
	hubURL = "http://hub.example.test:18788"
	t.Cleanup(func() { hubURL = "" })
	t.Setenv("AGENTHYDRA_CODEX_HUB_TOKEN", " from-the-environment-0123 ")
	if c := loadConfig(); c.Hub != hubURL || c.Token != "from-the-environment-0123" || !validInstall(c.Install) {
		t.Fatalf("defaults: %+v", c)
	}
	if err := os.WriteFile(configPath, []byte(`{"token": "old-token-0123456789"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	os.Chmod(configPath, 0o644)
	token, id, _ := newPcToken()
	next, _, _ := newPcToken()
	want := config{Hub: "http://other.example.test", Token: token, PC: "Example-PC", ID: id, Install: "install-0123456789", Next: next}
	saved := want
	saved.Hub += "/"
	if err := saveConfig(saved); err != nil {
		t.Fatal(err)
	}
	if c := savedConfig(); c != saved {
		t.Fatalf("saved %+v, read back %+v", saved, c)
	}
	if c := loadConfig(); c != want {
		t.Fatalf("loaded %+v, want %+v", c, want)
	}
	if f := savedFile(t); len(f) != 6 {
		t.Errorf("tray.json %v: want its six fields", f)
	}
	st, err := os.Stat(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && st.Mode().Perm() != 0o600 {
		t.Errorf("config file mode %v, want 0600: it holds the token", st.Mode().Perm())
	}
	if exists(configPath + ".tmp") {
		t.Error("tray.json.tmp was left behind")
	}
	// What is not set is left out.
	if err := saveConfig(config{Token: token}); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(configPath); strings.Contains(string(b), `"pc"`) || strings.Contains(string(b), `"next"`) {
		t.Errorf("tray.json with the token alone: %s", b)
	}
}

// pcConfig is the tray.json of a PC paired with a token of its own, as Example-PC.
func pcConfig(hub string) config {
	token, id, _ := newPcToken()
	return config{Hub: hub, Token: token, PC: "Example-PC", ID: id}
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

// Moving to a new key: a tray built with the old key and the new one takes a build signed with either, so the
// operator can sign with the new key once every PC runs such a build; a tray with the old key alone refuses the new
// key's builds, and one with the new key alone the old key's. One entry that is not a key refuses everything.
func TestKeyRotation(t *testing.T) {
	saved := updateKey
	t.Cleanup(func() { updateKey = saved })
	oldKey := testKey
	newKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{9}, ed25519.SeedSize))
	stranger := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{8}, ed25519.SeedSize))
	pub := func(k ed25519.PrivateKey) string {
		return base64.StdEncoding.EncodeToString(k.Public().(ed25519.PublicKey))
	}
	sum := sumOf([]byte("a build"))
	plain := config{Hub: "http://hub.example.test:18788"}
	takes := func(key ed25519.PrivateKey) error {
		return checkSigned(plain, "tray", &release{SHA256: sum, Signature: signedBy(key, "tray", sum)})
	}
	for _, c := range []struct {
		what, keys         string
		takesOld, takesNew bool
	}{
		{"the old key alone", pub(oldKey), true, false},
		{"the old key and the new one", pub(oldKey) + "," + pub(newKey), true, true},
		{"both, with spaces", " " + pub(oldKey) + " , " + pub(newKey) + " ", true, true},
		{"the new key alone", pub(newKey), false, true},
	} {
		updateKey = c.keys
		if err := updatesAllowed(plain.Hub); err != nil {
			t.Errorf("%s: %v", c.what, err)
		}
		for _, k := range []struct {
			name string
			key  ed25519.PrivateKey
			want bool
		}{{"old", oldKey, c.takesOld}, {"new", newKey, c.takesNew}, {"stranger", stranger, false}} {
			err := takes(k.key)
			if k.want != (err == nil) || (err != nil && !errors.As(err, new(badBuild))) {
				t.Errorf("%s, a build signed with the %s key: %v", c.what, k.name, err)
			}
		}
	}
	for _, keys := range []string{
		pub(oldKey) + ",",
		"," + pub(newKey),
		pub(oldKey) + ",not a key",
		pub(oldKey) + "," + base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 31)),
		" ",
	} {
		updateKey = keys
		if err := updatesAllowed("https://hub.example.test"); err != errBadKey {
			t.Errorf("keys %q: %v, want errBadKey", keys, err)
		}
		if err := takes(oldKey); err != errBadKey {
			t.Errorf("keys %q: a build signed with the old key: %v, want errBadKey", keys, err)
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
	if err := saveConfig(pcConfig(srv.URL)); err != nil {
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

// The tray's own requests carry the extra headers the pusher sends (AGENTHYDRA_CODEX_HUB_HEADERS), as a hub behind an
// access proxy needs: the build checks, the download, the token check made while pairing with a hub from before PC
// tokens, and the token's own routes. Each carries the install id, and the token as the bearer but on the redeem,
// where the code is the credential.
func TestHubRequestsCarryTheExtraHeaders(t *testing.T) {
	cfg := pcConfig("")
	cfg.Install = "install-0123456789"
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
		switch r.URL.Path {
		case "/api/codex-hub/tray/download":
			w.Write([]byte("not the announced build"))
		case "/api/codex-hub/tray", "/api/codex-hub/pusher":
			sum := strings.Repeat("ab", 32)
			json.NewEncoder(w).Encode(release{SHA256: sum, Size: 1, Signature: signedBy(testKey, "tray", sum)})
		default:
			fmt.Fprintf(w, `{"pc":"Example-PC","key":"example-pc","id":%q,"state":"revoked"}`, cfg.ID)
		}
	}))
	t.Cleanup(srv.Close)
	cfg.Hub = srv.URL
	useTestKey(t)
	t.Setenv("AGENTHYDRA_CODEX_HUB_HEADERS", `{"X-Hub-Access":"e2e-access","Authorization":"not this"}`)
	rel, err := latest(cfg, "tray")
	if err != nil || rel == nil {
		t.Fatalf("latest: %v %v", rel, err)
	}
	if err := tokenWorks(cfg); err != nil {
		t.Fatalf("tokenWorks: %v", err)
	}
	download(cfg, "tray", rel, filepath.Join(t.TempDir(), "codex-hub-tray"))
	hash := pcTokenHash(cfg.Token)
	for what, ask := range map[string]func() (pcAnswer, hubAnswer, error){
		"whoami":   func() (pcAnswer, hubAnswer, error) { return whoami(cfg) },
		"redeem":   func() (pcAnswer, hubAnswer, error) { return redeem(cfg, strings.Repeat("c", 64), cfg.ID, hash) },
		"exchange": func() (pcAnswer, hubAnswer, error) { return exchangeToken(cfg, cfg.ID, hash) },
		"retire":   func() (pcAnswer, hubAnswer, error) { return retire(cfg, "New-PC") },
	} {
		if who, a, err := ask(); err != nil || a.status != http.StatusOK || who.PC != "Example-PC" {
			t.Errorf("%s: %+v %d %v", what, who, a.status, err)
		}
	}
	for _, path := range []string{"/api/codex-hub/tray", "/api/codex-hub/pusher", "/api/codex-hub/tray/download",
		"/api/codex-hub/whoami", "/api/codex-hub/redeem", "/api/codex-hub/exchange", "/api/codex-hub/retire"} {
		h := seen[path]
		if h == nil {
			t.Errorf("%s was not asked", path)
			continue
		}
		bearer := h.Get("Authorization") == "Bearer "+cfg.Token
		if h.Get("X-Hub-Access") != "e2e-access" || h.Get(installHeader) != cfg.Install || bearer != (path != "/api/codex-hub/redeem") {
			t.Errorf("%s: X-Hub-Access %q, %s %q, Authorization %q", path, h.Get("X-Hub-Access"), installHeader,
				h.Get(installHeader), h.Get("Authorization"))
		}
	}

	// A value that is not a JSON object of strings is left out, and the request still goes.
	t.Setenv("AGENTHYDRA_CODEX_HUB_HEADERS", `X-Hub-Access: e2e-access`)
	if _, err := latest(cfg, "tray"); err == nil || !strings.Contains(err.Error(), "403") {
		t.Errorf("latest with a broken header list: %v", err)
	}
}

// The hub's refusals of a build check, by their code: a revoked token is refused (errToken) and says so (errRevoked),
// and a token of another install is errInstall. No build is none, and the hub's own trouble is neither.
func TestLatestCodes(t *testing.T) {
	var mu sync.Mutex
	var status int
	var body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.WriteHeader(status)
		io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	cfg := pcConfig(srv.URL)
	for _, c := range []struct {
		status                  int
		body                    string
		token, revoked, install bool
		none                    bool
	}{
		{401, `{"error":"revoked","code":"revoked"}`, true, true, false, false},
		{401, `{"error":"unknown-token","code":"unknown-token"}`, true, false, false, false},
		{401, `{"error":"unauthorized","code":"unauthorized"}`, true, false, false, false},
		{401, `not json`, true, false, false, false},
		{409, `{"error":"this token belongs to another install","code":"install-mismatch"}`, false, false, true, false},
		{404, `{"error":"no tray build for linux-x64","code":"not-found"}`, false, false, false, true},
		{503, `{"error":"the hub cannot read its list of PCs","code":"store-unreadable"}`, false, false, false, false},
	} {
		mu.Lock()
		status, body = c.status, c.body
		mu.Unlock()
		rel, err := latest(cfg, "tray")
		if errors.Is(err, errToken) != c.token || errors.Is(err, errRevoked) != c.revoked || errors.Is(err, errInstall) != c.install ||
			(err == nil) != c.none || rel != nil {
			t.Errorf("%d %s: %v %v", c.status, c.body, rel, err)
		}
		if c.status == 503 && (err == nil || !strings.Contains(err.Error(), "cannot read its list of PCs")) {
			t.Errorf("503: %v, want the hub's own words", err)
		}
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

// hubCall is one request a stubHub had: what it carried, and tray.json (saved) and its next as it came.
type hubCall struct {
	path, bearer, install, next string
	saved                       config
	body                        map[string]any
}

func (c hubCall) text(k string) string {
	s, _ := c.body[k].(string)
	return s
}

// stubHub answers each request as answer says: a status and a JSON body, or status 0 for a hub that closes the
// connection without answering. calls(route) is the requests it had so far for /api/codex-hub/route.
func stubHub(t *testing.T, answer func(c hubCall) (int, string)) (*httptest.Server, func(route string) []hubCall) {
	var mu sync.Mutex
	var all []hubCall
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		saved := savedConfig()
		c := hubCall{path: r.URL.Path, install: r.Header.Get(installHeader), next: saved.Next, saved: saved}
		c.bearer, _ = strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		json.NewDecoder(r.Body).Decode(&c.body)
		mu.Lock()
		all = append(all, c)
		mu.Unlock()
		status, body := answer(c)
		if status == 0 {
			if conn, _, err := w.(http.Hijacker).Hijack(); err == nil {
				conn.Close()
			}
			return
		}
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	return srv, func(route string) []hubCall {
		mu.Lock()
		defer mu.Unlock()
		var out []hubCall
		for _, c := range all {
			if c.path == "/api/codex-hub/"+route {
				out = append(out, c)
			}
		}
		return out
	}
}

// pcJSON is the hub's answer naming the PC a token id is for; errJSON, its refusal with code.
func pcJSON(pc, id string) string {
	return fmt.Sprintf(`{"pc":%q,"key":%q,"id":%q}`, pc, pcKey(pc), id)
}

func errJSON(code string) string {
	return fmt.Sprintf(`{"error":"the hub's words for %s","code":%q}`, code, code)
}

// testOpen is the pairing the tests post to: its state, its listener's address and the name its link pairs as.
var testOpen = pairOpen{state: "the-state", host: "127.0.0.1:43210", name: "Example-PC"}

// postForm posts form to h, at host, as the hub's pairing page does.
func postForm(h http.HandlerFunc, host string, form url.Values) (int, string) {
	req := httptest.NewRequest(http.MethodPost, "/paired", strings.NewReader(form.Encode()))
	req.Host = host
	req.Header.Set("content-type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	h(rec, req)
	b, _ := io.ReadAll(rec.Body)
	return rec.Code, string(b)
}

// postCode posts a code to testOpen's listener as the page does; postToken, a token as a hub from before PC tokens
// does.
func postCode(h http.HandlerFunc, code string) (int, string) {
	return postForm(h, testOpen.host, url.Values{"state": {testOpen.state}, "code": {code}})
}

func postToken(h http.HandlerFunc, token string) (int, string) {
	return postForm(h, testOpen.host, url.Values{"state": {testOpen.state}, "token": {token}})
}

// Pairing through the page. A post is taken only at this pairing's listener, by its address, with its state. Its code
// is redeemed with a token made for it, saved as next before it is sent and as the token once the hub took it; each of
// the hub's refusals gets its page. A rename retires the old name's token, with that token. The old page's token is
// taken as before, unless it is a PC token.
func TestPairHandler(t *testing.T) {
	savedGap := redeemGap
	redeemGap = 10 * time.Millisecond
	t.Cleanup(func() { redeemGap = savedGap; os.Remove(configPath) })
	// A code as the page hands one out (64 hex), and a token as a hub from before PC tokens hands one out.
	code, oldPageToken := strings.Repeat("c0de", 16), "Hub Token ~!"
	var mu sync.Mutex
	var redeemAs, retireAs, whoamiAs func(hubCall) (int, string)
	srv, calls := stubHub(t, func(c hubCall) (int, string) {
		mu.Lock()
		redeem, retire, whoami := redeemAs, retireAs, whoamiAs
		mu.Unlock()
		switch c.path {
		case "/api/codex-hub/redeem":
			return redeem(c)
		case "/api/codex-hub/retire":
			return retire(c)
		case "/api/codex-hub/whoami":
			if whoami != nil {
				return whoami(c)
			}
		case "/api/codex-hub/pusher": // the old page's token, checked as a hub from before PC tokens checks it
			if c.bearer != oldPageToken {
				return 401, errJSON("unauthorized")
			}
			return 200, `{"sha256":"` + strings.Repeat("ab", 32) + `","size":1}`
		}
		return 404, errJSON("not-found")
	})
	answers := func(redeem, retire func(hubCall) (int, string)) {
		mu.Lock()
		redeemAs, retireAs = redeem, retire
		mu.Unlock()
	}
	takes := func(pc string) func(hubCall) (int, string) {
		return func(c hubCall) (int, string) { return 200, pcJSON(pc, c.text("id")) }
	}
	answer := func(status int, body string) func(hubCall) (int, string) {
		return func(hubCall) (int, string) { return status, body }
	}
	if err := saveConfig(config{Hub: srv.URL}); err != nil {
		t.Fatal(err)
	}
	install := loadConfig().Install
	if savedConfig().Install != "" {
		t.Fatalf("tray.json has an install id before the first pairing: %+v", savedConfig())
	}
	a := newApp()
	finished := false
	h := a.pairHandler(testOpen, func() { finished = true })

	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodGet, "/paired", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET: %d", rec.Code)
	}
	for what, post := range map[string]func() (int, string){
		"another state": func() (int, string) {
			return postForm(h, testOpen.host, url.Values{"state": {"another-state"}, "code": {code}})
		},
		"no state": func() (int, string) { return postForm(h, testOpen.host, url.Values{"code": {code}}) },
		"localhost": func() (int, string) {
			return postForm(h, "localhost:43210", url.Values{"state": {"the-state"}, "code": {code}})
		},
		"another port": func() (int, string) {
			return postForm(h, "127.0.0.1:1", url.Values{"state": {"the-state"}, "code": {code}})
		},
		"another host": func() (int, string) {
			return postForm(h, "pair.example.test", url.Values{"state": {"the-state"}, "code": {code}})
		},
		"the old page's": func() (int, string) {
			return postForm(h, "example.com", url.Values{"state": {"the-state"}, "token": {oldPageToken}})
		},
	} {
		if status, body := post(); status != http.StatusBadRequest || !strings.Contains(body, "not the one this PC opened") {
			t.Errorf("%s: %d %s", what, status, body)
		}
	}
	if n := len(calls("redeem")) + len(calls("pusher")); n != 0 || finished || savedConfig() != (config{Hub: srv.URL}) {
		t.Fatalf("a post to the wrong listener: %d requests, finished %v, tray.json %+v", n, finished, savedConfig())
	}

	// The code: the token is next while the hub is asked, and the token once it took it.
	answers(takes("Example-PC"), nil)
	if status, body := postCode(h, code); status != http.StatusOK || !strings.Contains(body, "This PC is connected as Example-PC and is pushing its Codex chats.") {
		t.Fatalf("the code: %d %s", status, body)
	}
	r := calls("redeem")
	if len(r) != 1 || r[0].text("code") != code || r[0].bearer != "" || r[0].install != install || !validInstall(install) {
		t.Fatalf("redeem: %+v (install %q)", r, install)
	}
	first := r[0]
	if !isPcToken(first.next) || pcTokenID(first.next) != first.text("id") || pcTokenHash(first.next) != first.text("hash") {
		t.Errorf("tray.json's next %q while the hub was asked, for id %s hash %s", first.next, first.text("id"), first.text("hash"))
	}
	// With the install id the redeem sent, so a check that settles next sends that one; and no rename.
	if first.saved.Install != install || first.saved.RenameFrom != "" || first.saved.RenameTo != "" {
		t.Errorf("tray.json while the hub was asked: %+v, want install %s", first.saved, install)
	}
	if c := savedConfig(); c != (config{Hub: srv.URL, Token: first.next, PC: "Example-PC", ID: first.text("id"), Install: install}) {
		t.Errorf("tray.json after the code: %+v", c)
	}
	if !finished || len(calls("retire")) != 0 {
		t.Errorf("finished %v, retired %d", finished, len(calls("retire")))
	}

	// A rename: the hub took the new name's code, and the name's key is the one asked for, so the old name's token is
	// retired, with that token from this install.
	rename := func(name, from string) http.HandlerFunc {
		return a.pairHandler(pairOpen{state: testOpen.state, host: testOpen.host, name: name, from: from}, func() {})
	}
	answers(takes("New-PC"), answer(200, `{"pc":"Example-PC","key":"example-pc","state":"revoked"}`))
	if status, body := postCode(rename("New-PC", "Example-PC"), code); status != http.StatusOK ||
		!strings.Contains(body, "This PC is connected as New-PC") || !strings.Contains(body, "Example-PC was retired on the hub; its copies there stay until you forget them.") {
		t.Errorf("a rename: %d %s", status, body)
	}
	if ret := calls("retire"); len(ret) != 1 || ret[0].bearer != first.next || ret[0].install != install || ret[0].text("renamedTo") != "New-PC" {
		t.Errorf("retire: %+v", ret)
	}
	// The rename was saved with next, for a check to retire the old name if this answer had been lost.
	if r := calls("redeem"); r[len(r)-1].saved.RenameFrom != "Example-PC" || r[len(r)-1].saved.RenameTo != "New-PC" {
		t.Errorf("tray.json while the rename was asked: %+v", r[len(r)-1].saved)
	}
	if c := savedConfig(); c.RenameFrom != "" || c.RenameTo != "" {
		t.Errorf("tray.json keeps a rename after its answer: %+v", c)
	}
	if c := savedConfig(); c.PC != "New-PC" || c.Token == first.next || !isPcToken(c.Token) {
		t.Errorf("tray.json after the rename: %+v", c)
	}
	answers(takes("Third-PC"), answer(409, errJSON("install-mismatch")))
	if status, body := postCode(rename("Third-PC", "New-PC"), code); status != http.StatusOK || !strings.Contains(body, "connected as Third-PC") ||
		!strings.Contains(body, "New-PC could not be retired (the hub has this token for another install): on the hub, run `scripts/codex-hub-pcs.ts revoke New-PC`.") {
		t.Errorf("a rename the hub would not retire: %d %s", status, body)
	}
	// No retire: the hub gave the name another key (Fourth-PC-2), the link named no old name, or the old token is
	// the legacy token.
	retired := len(calls("retire"))
	answers(takes("Fourth-PC-2"), answer(200, `{}`))
	if status, body := postCode(rename("Fourth-PC", "Third-PC"), code); status != http.StatusOK || strings.Contains(body, "retire") {
		t.Errorf("another key: %d %s", status, body)
	}
	answers(takes("Fifth-PC"), answer(200, `{}`))
	if status, body := postCode(rename("Fifth-PC", ""), code); status != http.StatusOK || strings.Contains(body, "retire") {
		t.Errorf("no old name: %d %s", status, body)
	}
	if err := saveConfig(config{Hub: srv.URL, Token: "legacy-token-0123", PC: "Old-PC"}); err != nil {
		t.Fatal(err)
	}
	answers(takes("Sixth-PC"), answer(200, `{}`))
	if status, body := postCode(rename("Sixth-PC", "Old-PC"), code); status != http.StatusOK || strings.Contains(body, "retire") {
		t.Errorf("from the legacy token: %d %s", status, body)
	}
	if r := calls("redeem"); r[len(r)-1].saved.RenameFrom != "" {
		t.Errorf("a pairing from the legacy token saved a rename: %+v", r[len(r)-1].saved)
	}
	if n := len(calls("retire")); n != retired {
		t.Errorf("retired %d more", n-retired)
	}

	// The hub's refusals: their pages, next removed, and the token as it was.
	paired := savedConfig()
	for _, c := range []struct {
		what   string
		answer func(hubCall) (int, string)
		status int
		page   string
	}{
		{"a used code", answer(401, errJSON("pair-code")), 401, "This pairing link has expired or was used already. Choose Connect this PC again."},
		{"another name's", answer(409, errJSON("name-changed")), 409,
			"Example-PC changed on the hub since the page opened (another PC was paired as Example-PC, or it was revoked). Choose Connect this PC again."},
		{"the hub's own trouble", answer(500, errJSON("internal")), 500, "the hub answered 500 for the pairing: the hub&#39;s words for internal. Choose Connect this PC again."},
		{"an install that is not taken", answer(400, errJSON("install-required")), 400, "the hub answered 400 for the pairing"},
	} {
		finished = false
		before := len(calls("redeem"))
		answers(c.answer, nil)
		status, body := postCode(h, code)
		r := calls("redeem")
		if status != c.status || !strings.Contains(body, c.page) || len(r) != before+1 || r[before].next == "" {
			t.Errorf("%s: %d %s (%d requests)", c.what, status, body, len(r)-before)
		}
		if now := savedConfig(); now != paired || finished {
			t.Errorf("%s: tray.json %+v, want %+v; finished %v", c.what, now, paired, finished)
		}
	}

	// A proxy's own 5xx (no code: not the hub's) may come after the hub took the code: next stays, as with no answer.
	before := len(calls("redeem"))
	answers(answer(502, `{"error":"bad gateway"}`), nil)
	status, body := postCode(h, code)
	r = calls("redeem")[before:]
	if status != http.StatusBadGateway || !strings.Contains(body, "The hub did not answer (the hub answered 502 for the pairing") {
		t.Errorf("a proxy's 502: %d %s", status, body)
	}
	if c := savedConfig(); len(r) != 1 || c.Next != r[0].next || c.Token != paired.Token {
		t.Errorf("a proxy's 502: %d requests, tray.json %+v", len(r), c)
	}
	// So the next pairing settles it first: the hub does not have it, so it goes, and this one is redeemed.
	answers(takes("Example-PC"), nil)
	mu.Lock()
	whoamiAs = answer(401, errJSON("unknown-token"))
	mu.Unlock()
	before = len(calls("redeem"))
	if status, body := postCode(h, code); status != http.StatusOK || len(calls("redeem")) != before+1 {
		t.Errorf("a pairing after a 502: %d %s", status, body)
	}
	if w := calls("whoami"); len(w) == 0 || w[len(w)-1].bearer != r[0].next {
		t.Errorf("whoami before the pairing: %+v", w)
	}
	paired = savedConfig()
	// A second click on the page, while the listener is still open: the same answer, and nothing sent.
	sent := len(calls("redeem")) + len(calls("whoami"))
	if status, body := postCode(h, code); status != http.StatusOK || !strings.Contains(body, "This PC is connected as Example-PC") ||
		len(calls("redeem"))+len(calls("whoami")) != sent || savedConfig() != paired {
		t.Errorf("a second click: %d %s (%d requests)", status, body, len(calls("redeem"))+len(calls("whoami"))-sent)
	}
	// The posts below are of a link opened after this one.
	h = a.pairHandler(testOpen, func() { finished = true })

	// No answer: the same request twice more, then next stays, for the next check to settle.
	before = len(calls("redeem"))
	answers(answer(0, ""), nil)
	status, body = postCode(h, code)
	r = calls("redeem")[before:]
	if status != http.StatusBadGateway || !strings.Contains(body, "The hub did not answer (") ||
		!strings.Contains(body, "If it took the pairing, this PC connects by itself within 10 minutes; if not, choose Connect this PC again.") {
		t.Errorf("no answer: %d %s", status, body)
	}
	if len(r) != 3 || r[1].text("id") != r[0].text("id") || r[2].text("hash") != r[0].text("hash") {
		t.Fatalf("no answer: %d requests, want 3 of the same: %+v", len(r), r)
	}
	if c := savedConfig(); c.Next != r[0].next || pcTokenID(c.Next) != r[0].text("id") || c.Token != paired.Token {
		t.Errorf("no answer: tray.json %+v", c)
	}
	// While the hub says nothing about that next, a pairing waits: nothing is sent, and tray.json stays.
	mu.Lock()
	whoamiAs = answer(503, errJSON("store-unreadable"))
	mu.Unlock()
	waiting := savedConfig()
	before = len(calls("redeem"))
	if status, body := postCode(h, code); status != http.StatusServiceUnavailable || !strings.Contains(body, "still waiting for the hub") ||
		len(calls("redeem")) != before || savedConfig() != waiting {
		t.Errorf("a pairing over an unsettled next: %d %s, tray.json %+v", status, body, savedConfig())
	}
	// The hub has it, under this link's name: the page posted again after its answer was lost. Connected, and the new
	// code is left alone.
	mu.Lock()
	whoamiAs = func(c hubCall) (int, string) { return 200, pcJSON("Example-PC", pcTokenID(c.bearer)) }
	mu.Unlock()
	finished = false
	if status, body := postCode(h, code); status != http.StatusOK || !strings.Contains(body, "This PC is connected as Example-PC") ||
		len(calls("redeem")) != before || !finished {
		t.Errorf("a pairing whose earlier answer was lost: %d %s (%d redeems, finished %v)", status, body, len(calls("redeem"))-before, finished)
	}
	if c := savedConfig(); c.Token != waiting.Next || c.Next != "" || c.PC != "Example-PC" {
		t.Errorf("a pairing whose earlier answer was lost: tray.json %+v", c)
	}
	mu.Lock()
	whoamiAs = answer(401, errJSON("unknown-token"))
	mu.Unlock()
	h = a.pairHandler(testOpen, func() { finished = true })

	// The hub has the id already: another token, once.
	var asked int
	answers(func(c hubCall) (int, string) {
		if asked++; asked == 1 {
			return 409, errJSON("id-taken")
		}
		return 200, pcJSON("Example-PC", c.text("id"))
	}, nil)
	before = len(calls("redeem"))
	if status, body := postCode(h, code); status != http.StatusOK {
		t.Errorf("an id the hub has: %d %s", status, body)
	}
	r = calls("redeem")[before:]
	if c := savedConfig(); len(r) != 2 || r[0].text("id") == r[1].text("id") || c.ID != r[1].text("id") || c.Token != r[1].next || c.Next != "" {
		t.Errorf("an id the hub has: %d requests, tray.json %+v", len(r), c)
	}

	// The page of a hub from before PC tokens posts its own token: taken alone, checked as that hub checks it, and the
	// install id kept for the next hub. A PC token, or one this app cannot send, is no such page's.
	finished = false
	for _, bad := range []string{first.next, "", "two\nlines", "Hub tökén ~!", strings.Repeat("x", 513)} {
		if status, body := postToken(h, bad); status != http.StatusBadRequest || !strings.Contains(body, "This page did not come from your hub&#39;s current version.") {
			t.Errorf("token %q: %d %s", bad, status, body)
		}
	}
	for _, bad := range []string{"nope", strings.Repeat("C", 64), code[:62]} {
		if status, body := postCode(h, bad); status != http.StatusBadRequest || !strings.Contains(body, "current version") {
			t.Errorf("code %q: %d %s", bad, status, body)
		}
	}
	if status, body := postToken(h, "refused by the hub"); status != http.StatusUnauthorized || !strings.Contains(body, "did not take that token") {
		t.Errorf("a token the hub refuses: %d %s", status, body)
	}
	if c := savedConfig(); c.Token != r[1].next || finished {
		t.Fatalf("a refused post saved %+v (finished %v)", c, finished)
	}
	if status, body := postToken(h, oldPageToken); status != http.StatusOK || !strings.Contains(body, "This PC is connected and is pushing its Codex chats.") {
		t.Fatalf("the old page's token: %d %s", status, body)
	}
	if c := savedConfig(); c != (config{Hub: srv.URL, Token: oldPageToken, Install: install}) || !finished {
		t.Errorf("tray.json after the old page's token: %+v (finished %v)", c, finished)
	}
}

// A pairing whose answer was lost, which the hub had: whatever name the page paired it under (the link's, or the
// <name>-N it offered), a pairing posted after it finds this PC connected under that name, says what came of a
// rename, and redeems no code, whether it settles the token itself or a check settled it while this link was open
// and the hub still has it. A link opened after the check is the user's own. A check's token the post settles,
// which the hub has under the link's name, stops the code too; under another name, it does not.
func TestAPairingWhoseAnswerWasLost(t *testing.T) {
	savedGap := redeemGap
	redeemGap = 10 * time.Millisecond
	t.Cleanup(func() { redeemGap = savedGap; os.Remove(configPath) })
	code := strings.Repeat("c0de", 16)
	var mu sync.Mutex
	var redeemAs, retireAs, whoamiAs func(hubCall) (int, string)
	hubAnswers := func(redeem, retire, whoami func(hubCall) (int, string)) {
		mu.Lock()
		redeemAs, retireAs, whoamiAs = redeem, retire, whoami
		mu.Unlock()
	}
	srv, calls := stubHub(t, func(c hubCall) (int, string) {
		mu.Lock()
		redeem, retire, whoami := redeemAs, retireAs, whoamiAs
		mu.Unlock()
		switch {
		case c.path == "/api/codex-hub/redeem" && redeem != nil:
			return redeem(c)
		case c.path == "/api/codex-hub/retire" && retire != nil:
			return retire(c)
		case c.path == "/api/codex-hub/whoami" && whoami != nil:
			return whoami(c)
		}
		return 404, errJSON("not-found")
	})
	takes := func(pc string) func(hubCall) (int, string) {
		return func(c hubCall) (int, string) { return 200, pcJSON(pc, c.text("id")) }
	}
	answer := func(status int, body string) func(hubCall) (int, string) {
		return func(hubCall) (int, string) { return status, body }
	}
	// whoami as the hub that has the token it is asked with under pc.
	has := func(pc string) func(hubCall) (int, string) {
		return func(c hubCall) (int, string) { return 200, pcJSON(pc, pcTokenID(c.bearer)) }
	}
	silent, unsure := answer(0, ""), answer(503, errJSON("store-unreadable"))
	a := newApp()
	finished := false
	link := func(name, from string) http.HandlerFunc {
		return a.pairHandler(pairOpen{state: testOpen.state, host: testOpen.host, name: name, from: from}, func() { finished = true })
	}
	if err := saveConfig(config{Hub: srv.URL}); err != nil {
		t.Fatal(err)
	}
	install := loadConfig().Install
	// lose posts code on h with the redeem's answer lost, and returns the token it left as next.
	lose := func(what string, h http.HandlerFunc) string {
		t.Helper()
		hubAnswers(silent, nil, unsure)
		if status, body := postCode(h, code); status != http.StatusBadGateway {
			t.Fatalf("%s: the lost redeem: %d %s", what, status, body)
		}
		c := savedConfig()
		if !isPcToken(c.Next) || !c.Pairing {
			t.Fatalf("%s: tray.json after the lost redeem: %+v", what, c)
		}
		return c.Next
	}
	// connected posts code on h and wants this PC connected as pc with token, by no redeem, its page saying all of want.
	connected := func(what string, h http.HandlerFunc, token, pc string, want ...string) {
		t.Helper()
		finished = false
		before := len(calls("redeem"))
		status, body := postCode(h, code)
		if status != http.StatusOK || !strings.Contains(body, "This PC is connected as "+pc+" and is pushing its Codex chats.") ||
			len(calls("redeem")) != before || !finished {
			t.Errorf("%s: %d %s (%d redeems, finished %v)", what, status, body, len(calls("redeem"))-before, finished)
		}
		for _, w := range want {
			if !strings.Contains(body, w) {
				t.Errorf("%s: the page does not say %q: %s", what, w, body)
			}
		}
		if c := savedConfig(); c.Token != token || c.PC != pc || c.Next != "" || c.Pairing || c.RenameFrom != "" {
			t.Errorf("%s: tray.json %+v", what, c)
		}
	}
	// redeemed posts code on h and wants it redeemed, this PC then connected as pc with the redeem's token.
	redeemed := func(what string, h http.HandlerFunc, pc string) {
		t.Helper()
		before := len(calls("redeem"))
		status, body := postCode(h, code)
		r := calls("redeem")[before:]
		if status != http.StatusOK || !strings.Contains(body, "This PC is connected as "+pc) || len(r) != 1 {
			t.Fatalf("%s: %d %s (%d redeems)", what, status, body, len(r))
		}
		if c := savedConfig(); c.Token != r[0].next || c.PC != pc || c.Next != "" || c.Pairing {
			t.Errorf("%s: tray.json %+v", what, c)
		}
	}

	// The page offered Example-PC-2, as Example-PC is another PC's; reloaded, it offers Example-PC-3. The post of that
	// one settles the lost token, which the hub has as Example-PC-2.
	l1 := link("Example-PC", "")
	t1 := lose("the page's other name", l1)
	hubAnswers(takes("Example-PC-3"), nil, has("Example-PC-2"))
	connected("the page's other name", l1, t1, "Example-PC-2")
	// A second click on that page: the same answer, and nothing sent.
	sent := len(calls("redeem")) + len(calls("whoami"))
	if status, body := postCode(l1, code); status != http.StatusOK || !strings.Contains(body, "connected as Example-PC-2") ||
		len(calls("redeem"))+len(calls("whoami")) != sent || savedConfig().Token != t1 {
		t.Errorf("a second click: %d %s (%d requests)", status, body, len(calls("redeem"))+len(calls("whoami"))-sent)
	}
	// The same from another link, opened after this one expired: the lost token is a pairing's, whichever link sent it.
	t2 := lose("another link's", link("Office", ""))
	hubAnswers(takes("Office-3"), nil, has("Office-2"))
	connected("another link's", link("Office", ""), t2, "Office-2")

	// A check settles the lost token before the page is posted again: it was lost while this link was open, so this
	// PC is connected, once the hub says it still has it.
	byCheck := func(what, token string) {
		t.Helper()
		a.token.Lock()
		a.settleNext()
		a.token.Unlock()
		if c := savedConfig(); c.Token != token || c.Next != "" {
			t.Fatalf("%s: tray.json after the check %+v", what, c)
		}
	}
	l3 := link("Desk", "")
	t3 := lose("a check first", l3)
	hubAnswers(takes("Desk-3"), nil, has("Desk-2"))
	byCheck("a check first", t3)
	asked := len(calls("whoami"))
	connected("a check first", l3, t3, "Desk-2")
	if w := calls("whoami")[asked:]; len(w) != 1 || w[0].bearer != t3 {
		t.Errorf("a check first: whoami %+v", w)
	}
	// So it is on a link opened while the token was unsettled (after a restart, or once the first link expired),
	// whose first post was told to wait.
	t4 := lose("a link opened while it was unsettled", link("Lab", ""))
	l4 := link("Lab", "")
	hubAnswers(takes("Lab-3"), nil, unsure)
	if status, body := postCode(l4, code); status != http.StatusServiceUnavailable || !strings.Contains(body, "still waiting") {
		t.Errorf("a link opened while it was unsettled, told to wait: %d %s", status, body)
	}
	hubAnswers(takes("Lab-3"), nil, has("Lab-2"))
	byCheck("a link opened while it was unsettled", t4)
	connected("a link opened while it was unsettled", l4, t4, "Lab-2")
	// One opened after a check settled it is a pairing of the user's own, asked for with the tray showing this PC
	// connected: its code is redeemed.
	t5 := lose("a link opened after the check", link("Lab-2", ""))
	hubAnswers(takes("Lab-4"), nil, has("Lab-3"))
	byCheck("a link opened after the check", t5)
	redeemed("a link opened after the check", link("Lab-3", ""), "Lab-4")
	// A token the hub no longer has since a check settled it (revoked, forgotten, or another install's now): the same
	// link's code pairs this PC again.
	for _, gone := range []func(hubCall) (int, string){
		answer(401, errJSON("revoked")), answer(401, errJSON("unknown-token")), answer(409, errJSON("install-mismatch")),
	} {
		l6 := link("Shed", "")
		t6 := lose("gone since", l6)
		hubAnswers(takes("Shed-3"), nil, has("Shed-2"))
		byCheck("gone since", t6)
		hubAnswers(takes("Shed-3"), nil, gone)
		redeemed("gone since", l6, "Shed-3")
	}
	// While the hub does not say whether it still has it, the post waits, and nothing changes.
	l7 := link("Barn", "")
	t7 := lose("not told", l7)
	hubAnswers(takes("Barn-3"), nil, has("Barn-2"))
	byCheck("not told", t7)
	hubAnswers(takes("Barn-3"), nil, unsure)
	before := len(calls("redeem"))
	if status, body := postCode(l7, code); status != http.StatusServiceUnavailable ||
		!strings.Contains(body, "whether it has this PC&#39;s token") || len(calls("redeem")) != before || savedConfig().Token != t7 {
		t.Errorf("not told: %d %s (%d redeems), tray.json %+v", status, body, len(calls("redeem"))-before, savedConfig())
	}
	hubAnswers(takes("Barn-3"), nil, has("Barn-2"))
	connected("not told, then told", l7, t7, "Barn-2")

	// A check's token (an exchange's whose answer was lost), which the hub has under the link's name: connected. Under
	// another name, the link's code is redeemed.
	check, _, _ := newPcToken()
	if err := saveConfig(config{Hub: srv.URL, Token: "legacy-token-0123", Install: install, Next: check}); err != nil {
		t.Fatal(err)
	}
	hubAnswers(takes("Never-PC"), nil, has("Example-PC"))
	connected("a check's under the link's name", link("Example-PC", ""), check, "Example-PC")
	check, _, _ = newPcToken()
	if err := saveConfig(config{Hub: srv.URL, Token: "legacy-token-0123", Install: install, Next: check}); err != nil {
		t.Fatal(err)
	}
	hubAnswers(takes("Example-PC"), nil, has("Legacy-PC"))
	redeemed("a check's under another name", link("Example-PC", ""), "Example-PC")

	// A rename whose answer was lost: the old name's token is retired as the post settles the new one, and the page
	// says what came of that, as the rename's own answer would have.
	for _, c := range []struct {
		what   string
		retire func(hubCall) (int, string)
		want   string
	}{
		{"a rename the hub retires", answer(200, `{"pc":"Old-PC","key":"old-pc","state":"revoked"}`),
			" Old-PC was retired on the hub; its copies there stay until you forget them."},
		{"a rename the hub does not retire", answer(500, errJSON("internal")),
			" Old-PC could not be retired (the hub answered 500 for retire"},
	} {
		old, oldID, _ := newPcToken()
		if err := saveConfig(config{Hub: srv.URL, Token: old, PC: "Old-PC", ID: oldID, Install: install}); err != nil {
			t.Fatal(err)
		}
		r := link("New-PC", "Old-PC")
		next := lose(c.what, r)
		if s := savedConfig(); s.RenameFrom != "Old-PC" || s.RenameTo != "New-PC" {
			t.Fatalf("%s: tray.json after the lost redeem: %+v", c.what, s)
		}
		retired := len(calls("retire"))
		hubAnswers(takes("Never-PC"), c.retire, has("New-PC"))
		connected(c.what, r, next, "New-PC", c.want)
		if ret := calls("retire")[retired:]; len(ret) != 1 || ret[0].bearer != old || ret[0].text("renamedTo") != "New-PC" {
			t.Errorf("%s: retire %+v", c.what, ret)
		}
	}

	// A rename whose lost token a check settled, which the hub no longer has: the code pairs this PC again, and the
	// page says what came of the check's retire of the old name, sending no retire of its own, as the token this PC
	// holds is no longer the old name's.
	for _, c := range []struct {
		what, as string
		retire   func(hubCall) (int, string)
		want     string
	}{
		{"a settled rename, gone since", "New-PC", answer(500, errJSON("internal")), " Old-PC could not be retired (the hub answered 500 for retire"},
		{"a settled rename, retired, gone since", "New-PC", answer(200, `{"pc":"Old-PC","key":"old-pc","state":"revoked"}`), " Old-PC was retired on the hub"},
		// The page's other name: nothing was retired, and nothing is said of it.
		{"a rename settled as another name, gone since", "New-PC-2", nil, ""},
	} {
		old, oldID, _ := newPcToken()
		if err := saveConfig(config{Hub: srv.URL, Token: old, PC: "Old-PC", ID: oldID, Install: install}); err != nil {
			t.Fatal(err)
		}
		r := link("New-PC", "Old-PC")
		next := lose(c.what, r)
		hubAnswers(takes("Never-PC"), c.retire, has(c.as))
		byCheck(c.what, next)
		retired := len(calls("retire"))
		hubAnswers(takes("New-PC"), answer(200, `{}`), answer(401, errJSON("revoked")))
		status, body := postCode(r, code)
		if status != http.StatusOK || !strings.Contains(body, "This PC is connected as New-PC and is pushing its Codex chats.") ||
			!strings.Contains(body, c.want) || c.want == "" && strings.Contains(body, "retire") {
			t.Errorf("%s: %d %s", c.what, status, body)
		}
		if n := len(calls("retire")) - retired; n != 0 {
			t.Errorf("%s: %d retires sent with the post", c.what, n)
		}
	}

	// What came of such a retire is said by the page that connects this PC, however many posts it takes to get there:
	// the first post after the revoke had a code the revoke dropped, or lost its answer. It is said once.
	for _, c := range []struct {
		what  string
		first func(hubCall) (int, string)
		as    string
	}{
		{"a refused post first", answer(401, errJSON("pair-code")), "New-PC-2"},
		{"a lost post first", silent, "New-PC"},
	} {
		old, oldID, _ := newPcToken()
		if err := saveConfig(config{Hub: srv.URL, Token: old, PC: "Old-PC", ID: oldID, Install: install}); err != nil {
			t.Fatal(err)
		}
		r := link("New-PC", "Old-PC")
		next := lose(c.what, r)
		hubAnswers(takes("Never-PC"), answer(500, errJSON("internal")), has("New-PC"))
		byCheck(c.what, next)
		hubAnswers(c.first, nil, answer(401, errJSON("revoked")))
		if status, body := postCode(r, code); status == http.StatusOK || strings.Contains(body, "Old-PC") {
			t.Errorf("%s: %d %s", c.what, status, body)
		}
		if lost := savedConfig().Next; lost != "" {
			// The lost one's token, which the hub has: this PC is connected as it, and the page says it.
			hubAnswers(takes("Never-PC"), nil, has(c.as))
			connected(c.what, r, lost, c.as, " Old-PC could not be retired (the hub answered 500 for retire")
		} else {
			// A new code, which the hub pairs.
			hubAnswers(takes(c.as), nil, nil)
			before := len(calls("redeem"))
			if status, body := postCode(r, code); status != http.StatusOK || len(calls("redeem")) != before+1 ||
				!strings.Contains(body, "This PC is connected as "+c.as+" and is pushing its Codex chats. Old-PC could not be retired (the hub answered 500 for retire") {
				t.Errorf("%s, then paired: %d %s", c.what, status, body)
			}
		}
		hubAnswers(takes("Shed-9"), nil, nil)
		if status, body := postCode(link("Shed-9", ""), code); status != http.StatusOK || strings.Contains(body, "Old-PC") {
			t.Errorf("%s, then paired again: %d %s", c.what, status, body)
		}
	}
}

// A link's until is pairFor after now by the page's clock when that is ahead of this PC's, and by this PC's when the
// page's is behind it (a Date from a cache or a proxy).
func TestPairUntil(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	for _, c := range []struct {
		what string
		page time.Time
		want time.Time
	}{
		{"the page ahead", now.Add(time.Hour), now.Add(time.Hour + pairFor)},
		{"the page behind", now.Add(-time.Hour), now.Add(pairFor)},
		{"the same clock", now, now.Add(pairFor)},
	} {
		if got := pairUntil(now, c.page); !got.Equal(c.want) {
			t.Errorf("%s: pairUntil = %v, want %v", c.what, got, c.want)
		}
	}
}

// The page's clock: the Date of its answer to a GET (the hub's own server sends none to a HEAD), a redirect's
// included, or this PC's clock when the page gives none or does not answer.
func TestPageTime(t *testing.T) {
	saved := pairURL
	t.Cleanup(func() { pairURL = saved })
	ahead := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	for _, status := range []int{http.StatusOK, http.StatusFound} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet {
				t.Errorf("the page was asked with %s", r.Method)
			}
			w.Header().Set("Date", ahead.Format(http.TimeFormat))
			if status == http.StatusFound {
				w.Header().Set("Location", "https://sign-in.example.test/")
			}
			w.WriteHeader(status)
		}))
		pairURL = srv.URL + "/codex-hub/pair"
		if got := pageTime(); !got.Equal(ahead) {
			t.Errorf("%d: pageTime() = %v, want %v", status, got, ahead)
		}
		srv.Close()
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header()["Date"] = nil
	}))
	pairURL = srv.URL
	if got := time.Since(pageTime()); got < 0 || got > time.Minute {
		t.Errorf("no Date: pageTime() is %v from now", got)
	}
	srv.Close()
	pairURL = srv.URL
	if got := time.Since(pageTime()); got < 0 || got > time.Minute {
		t.Errorf("no answer: pageTime() is %v from now", got)
	}
}

// The page's address always says when the listener closes, and names an old name (from) only for a PC with a token of
// its own paired under a name of another key. The name it pairs as is AGENTHYDRA_CODEX_HUB_PC, else the hub's name
// for this PC, else its own.
func TestPairURL(t *testing.T) {
	saved := pairURL
	pairURL = "https://inbox.example.test/codex-hub/pair"
	t.Cleanup(func() { pairURL = saved; os.Remove(configPath) })
	until := time.Unix(1700000000, 0)
	token, _, _ := newPcToken()
	for _, c := range []struct {
		what       string
		saved      config
		name, from string
	}{
		{"not paired", config{}, "Example-PC", ""},
		{"the legacy token, another name", config{Token: "legacy-token-0123", PC: "Old-PC"}, "New-PC", ""},
		{"a PC token, the same name", config{Token: token, PC: "Example-PC"}, "Example-PC", ""},
		{"a PC token, a name of the same key", config{Token: token, PC: "Office PC"}, "office-pc", ""},
		{"a PC token without a name", config{Token: token}, "New-PC", ""},
		{"a PC token, renamed", config{Token: token, PC: "Old-PC"}, "New-PC", "Old-PC"},
	} {
		if err := saveConfig(c.saved); err != nil {
			t.Fatal(err)
		}
		link, from := pairLink(43210, "the-state", c.name, until)
		u, err := url.Parse(link)
		if err != nil || !strings.HasPrefix(link, pairURL+"?") {
			t.Errorf("%s: %s %v", c.what, link, err)
			continue
		}
		q := u.Query()
		if q.Get("port") != "43210" || q.Get("state") != "the-state" || q.Get("pc") != c.name || q.Get("until") != "1700000000" ||
			from != c.from || q.Get("from") != c.from || q.Has("from") != (c.from != "") {
			t.Errorf("%s: %s (from %q)", c.what, link, from)
		}
	}

	if err := saveConfig(config{}); err != nil {
		t.Fatal(err)
	}
	if got := pairName(); got != pcName() {
		t.Errorf("pairName() unpaired = %q, want %q", got, pcName())
	}
	if err := saveConfig(config{Token: token, PC: "Hub-Name"}); err != nil {
		t.Fatal(err)
	}
	if got := pairName(); got != "Hub-Name" {
		t.Errorf("pairName() paired = %q", got)
	}
	t.Setenv("AGENTHYDRA_CODEX_HUB_PC", "Env-Name")
	if got := pairName(); got != "Env-Name" {
		t.Errorf("pairName() with AGENTHYDRA_CODEX_HUB_PC = %q", got)
	}
}

// A token the tray asked the hub to take (next) is settled at the next check: the hub has it, so it is the token; the
// hub does not have it and the PC has a token of its own, so it goes; the hub does not have it and the PC still has
// the legacy token, so the exchange is sent again as it was; no answer, or any refusal but a 401, so it is asked about
// again.
func TestSettleNext(t *testing.T) {
	t.Cleanup(func() { os.Remove(configPath) })
	var mu sync.Mutex
	var whoamiAs, exchangeAs, retireAs func(hubCall) (int, string)
	srv, calls := stubHub(t, func(c hubCall) (int, string) {
		mu.Lock()
		whoami, exchange := whoamiAs, exchangeAs
		mu.Unlock()
		switch c.path {
		case "/api/codex-hub/whoami":
			return whoami(c)
		case "/api/codex-hub/exchange":
			return exchange(c)
		case "/api/codex-hub/retire":
			mu.Lock()
			retire := retireAs
			mu.Unlock()
			if retire != nil {
				return retire(c)
			}
			return 200, `{"pc":"Old-PC","key":"old-pc","state":"revoked"}`
		}
		return 404, errJSON("not-found")
	})
	answers := func(whoami, exchange func(hubCall) (int, string)) {
		mu.Lock()
		whoamiAs, exchangeAs = whoami, exchange
		mu.Unlock()
	}
	answer := func(status int, body string) func(hubCall) (int, string) {
		return func(hubCall) (int, string) { return status, body }
	}
	const legacy = "legacy-token-0123"
	next, id, hash := newPcToken()
	a := newApp()
	settle := func(saved config) map[string]string {
		t.Helper()
		if err := saveConfig(saved); err != nil {
			t.Fatal(err)
		}
		a.settleNext()
		return savedFile(t)
	}

	answers(func(c hubCall) (int, string) {
		if c.bearer != next {
			return 401, errJSON("unknown-token")
		}
		return 200, pcJSON("Example-PC", pcTokenID(c.bearer))
	}, nil)
	f := settle(config{Hub: srv.URL, Token: legacy, Next: next})
	if f["token"] != next || f["pc"] != "Example-PC" || f["id"] != id || f["next"] != "" || !validInstall(f["install"]) {
		t.Errorf("a token the hub has: tray.json %v", f)
	}
	if w := calls("whoami"); len(w) != 1 || w[0].install != f["install"] {
		t.Errorf("whoami: %+v", w)
	}

	for _, not := range []func(hubCall) (int, string){
		answer(401, errJSON("unknown-token")),
		answer(401, errJSON("revoked")),
		answer(409, errJSON("install-mismatch")),
	} {
		answers(not, answer(500, errJSON("internal")))
		own := pcConfig(srv.URL)
		own.Next = next
		if f := settle(own); f["token"] != own.Token || f["pc"] != own.PC || f["next"] != "" {
			t.Errorf("a token the hub does not have, with a PC token: tray.json %v", f)
		}
	}
	if n := len(calls("exchange")); n != 0 {
		t.Errorf("exchanged %d times with a PC token", n)
	}

	answers(answer(401, errJSON("unknown-token")), func(c hubCall) (int, string) { return 200, pcJSON("Example-PC", c.text("id")) })
	f = settle(config{Hub: srv.URL, Token: legacy, Next: next})
	if ex := calls("exchange"); len(ex) != 1 || ex[0].text("id") != id || ex[0].text("hash") != hash || ex[0].bearer != legacy || ex[0].install == "" {
		t.Errorf("the exchange sent again: %+v", ex)
	}
	if f["token"] != next || f["id"] != id || f["next"] != "" {
		t.Errorf("the exchange sent again: tray.json %v", f)
	}
	// A pairing's next the hub does not have, on a PC that still has the legacy token, is sent as an exchange: the
	// token is a check's from then on, even while that exchange's answer is lost too.
	answers(answer(401, errJSON("unknown-token")), answer(0, ""))
	f = settle(config{Hub: srv.URL, Token: legacy, Next: next, Pairing: true})
	if c := savedConfig(); f["next"] != next || f["token"] != legacy || c.Pairing {
		t.Errorf("a pairing's next sent as an exchange: tray.json %+v", c)
	}

	// A rename whose answer was lost: its redeem saved the link's old name and new one with next, and the hub has the
	// token under the new one's key. The old name's token, which this PC holds, is retired, as an answered rename
	// retires it; one the hub has revoked already counts as retired. With no rename saved (whatever
	// AGENTHYDRA_CODEX_HUB_PC says now), or under another key than the link's (the page's "another PC" choice), nothing
	// is.
	has := func(pc string) func(hubCall) (int, string) {
		return func(c hubCall) (int, string) { return 200, pcJSON(pc, pcTokenID(c.bearer)) }
	}
	said := captureLog(t)
	for _, c := range []struct {
		what, from, to, env, has string
		retires                  bool
		retire                   func(hubCall) (int, string)
	}{
		{"a rename", "Old-PC", "New-PC", "", "New-PC", true, nil},
		{"a rename retired already", "Old-PC", "New-PC", "", "New-PC", true, answer(401, errJSON("revoked"))},
		{"a rename, with the name set back since", "Old-PC", "New-PC", "Old-PC", "New-PC", true, nil},
		{"a rename the hub gave another key", "Old-PC", "New-PC", "", "New-PC-2", false, nil},
		{"no rename saved", "", "", "", "Old-PC", false, nil},
		{"no rename saved, a new name set since", "", "", "New-PC", "New-PC", false, nil},
	} {
		t.Setenv("AGENTHYDRA_CODEX_HUB_PC", c.env)
		answers(has(c.has), nil)
		mu.Lock()
		retireAs = c.retire
		mu.Unlock()
		old := pcConfig(srv.URL)
		old.PC, old.Next, old.RenameFrom, old.RenameTo = "Old-PC", next, c.from, c.to
		retired := len(calls("retire"))
		if f := settle(old); f["token"] != next || f["pc"] != c.has || f["next"] != "" || f["renameFrom"] != "" || f["renameTo"] != "" {
			t.Errorf("%s: tray.json %v", c.what, f)
		}
		r := calls("retire")[retired:]
		if !c.retires && len(r) != 0 {
			t.Errorf("%s: retired %+v", c.what, r)
		}
		if c.retires && (len(r) != 1 || r[0].bearer != old.Token || r[0].text("renamedTo") != c.has || r[0].install == "") {
			t.Errorf("%s: the rename's retire %+v", c.what, r)
		}
	}
	if said.count("could not retire") != 0 || said.count("Old-PC's token (chp_") != 3 {
		t.Errorf("the retires said: %d could not, %d did", said.count("could not retire"), said.count("Old-PC's token (chp_"))
	}
	// A token in the user's environment only (tray.json has none): no rename was saved for it, so nothing is retired.
	t.Setenv("AGENTHYDRA_CODEX_HUB_PC", "New-PC")
	envOwn := pcConfig(srv.URL)
	t.Setenv("AGENTHYDRA_CODEX_HUB_TOKEN", envOwn.Token)
	answers(has("New-PC"), nil)
	retired := len(calls("retire"))
	if f := settle(config{Hub: srv.URL, PC: "Old-PC", ID: envOwn.ID, Next: next}); f["token"] != next || f["pc"] != "New-PC" {
		t.Errorf("the environment's token: tray.json %v", f)
	}
	if n := len(calls("retire")) - retired; n != 0 {
		t.Errorf("the environment's token: retired %d", n)
	}
	t.Setenv("AGENTHYDRA_CODEX_HUB_TOKEN", "")
	t.Setenv("AGENTHYDRA_CODEX_HUB_PC", "")
	mu.Lock()
	retireAs = nil
	mu.Unlock()

	for what, no := range map[string]func(hubCall) (int, string){
		"no answer":                 answer(0, ""),
		"the hub's trouble":         answer(503, errJSON("store-unreadable")),
		"an unreadable answer":      answer(200, `{"pc":"Example-PC","id":"0000000000000000"}`),
		"a proxy's refusal":         answer(403, errJSON("forbidden")),
		"too many requests":         answer(429, errJSON("rate-limited")),
		"a hub with no admin token": answer(404, errJSON("hub-off")),
		"a proxy's own 401":         answer(401, `{"error":"sign in"}`),
		"a 409 of another kind":     answer(409, errJSON("name-taken")),
	} {
		answers(no, answer(500, errJSON("internal")))
		exchanged := len(calls("exchange"))
		if f := settle(config{Hub: srv.URL, Token: legacy, Next: next}); f["next"] != next || f["token"] != legacy {
			t.Errorf("%s: tray.json %v", what, f)
		}
		if n := len(calls("exchange")); n != exchanged {
			t.Errorf("%s: exchanged", what)
		}
	}
}

// A PC token with no name in tray.json, or with another token's id there (one written in by hand), gets both from
// whoami at the next check; one that has them is not asked about.
func TestWhoamiFillsPC(t *testing.T) {
	t.Cleanup(func() { os.Remove(configPath) })
	srv, calls := stubHub(t, func(c hubCall) (int, string) {
		if c.path == "/api/codex-hub/whoami" && isPcToken(c.bearer) {
			return 200, pcJSON("Hand-PC", pcTokenID(c.bearer))
		}
		return 404, errJSON("not-found")
	})
	token, id, _ := newPcToken()
	a := newApp()
	for _, saved := range []config{
		{Hub: srv.URL, Token: token},
		{Hub: srv.URL, Token: token, PC: "Hand-PC", ID: "0123456789abcdef"},
		{Hub: srv.URL, Token: token, ID: id},
	} {
		if err := saveConfig(saved); err != nil {
			t.Fatal(err)
		}
		asked := len(calls("whoami"))
		a.updateOnce()
		if f := savedFile(t); f["token"] != token || f["pc"] != "Hand-PC" || f["id"] != id || !validInstall(f["install"]) {
			t.Errorf("tray.json %+v after the check: %v", saved, f)
		}
		if w := calls("whoami"); len(w) != asked+1 || w[asked].bearer != token {
			t.Errorf("tray.json %+v: whoami asked %d times", saved, len(w)-asked)
		}
	}
	asked := len(calls("whoami"))
	a.updateOnce()
	if n := len(calls("whoami")); n != asked {
		t.Errorf("a named token was asked about %d times", n-asked)
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
	srv, _ := stubHub(t, func(c hubCall) (int, string) { return 200, pcJSON("Example-PC", c.text("id")) })
	saved := hubURL
	t.Cleanup(func() { hubURL = saved; os.Remove(configPath) })
	os.Remove(configPath)
	hubURL = srv.URL + "/"
	a := newApp()
	if code, body := postCode(a.pairHandler(testOpen, func() {}), strings.Repeat("0a", 32)); code != http.StatusOK {
		t.Fatalf("pairing: %d %s", code, body)
	}
	f := savedFile(t)
	if !isPcToken(f["token"]) || f["pc"] != "Example-PC" || f["hub"] != "" {
		t.Errorf("tray.json %v: want the token, its name and no hub", f)
	}
	hubURL = "https://hub-next.example.test"
	if c := loadConfig(); c.Hub != hubURL || c.Token != f["token"] {
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

	const mine = "http://192.0.2.5:18788"
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

// A build for a hub that moved names the hubs earlier builds had (-X main.oldHubURLs): a tray.json in which one of
// them saved its own hub is unpinned by that build too, so the PC takes the new hub without first running a build
// with the old one.
func TestAnEarlierBuildsHubIsNotKeptAsTheUsers(t *testing.T) {
	savedHub, savedOld := hubURL, oldHubURLs
	t.Cleanup(func() { hubURL, oldHubURLs = savedHub, savedOld; os.Remove(configPath) })
	hubURL = "https://hub-next.example.test"
	oldHubURLs = "http://hub-first.example.test:18788, http://hub.example.test:18788/"
	const token = "Hub Token ~!"
	if err := os.WriteFile(configPath, []byte(`{"hub": "http://hub.example.test:18788", "token": "`+token+`"}`), 0o600); err != nil {
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
	if c := loadConfig(); c.Hub != hubURL || c.Token != token {
		t.Errorf("with the new build's hub: %+v", c)
	}

	// A hub the user set, that no build had, stays; so does one when the list is empty.
	for _, old := range []string{oldHubURLs, ""} {
		oldHubURLs = old
		const mine = "http://192.0.2.5:18788"
		if err := saveConfig(config{Hub: mine, Token: token}); err != nil {
			t.Fatal(err)
		}
		if err := unpinBuildHub(); err != nil {
			t.Fatal(err)
		}
		if c := loadConfig(); c.Hub != mine {
			t.Errorf("oldHubURLs %q: the user's hub is not the one used: %+v", old, c)
		}
	}
}

func TestServiceUnit(t *testing.T) {
	u := serviceUnit("/home/me/.local/share/codex-hub/codex-hub-tray")
	for _, line := range []string{
		"[Service]",
		"ExecStart=/home/me/.local/share/codex-hub/codex-hub-tray",
		"Restart=on-failure",
		"[Install]",
		"WantedBy=default.target",
	} {
		if !strings.Contains(u, "\n"+line+"\n") {
			t.Errorf("unit has no %q:\n%s", line, u)
		}
	}
	for in, want := range map[string]string{
		"/home/me/tray":         "/home/me/tray",
		"/home/me/My Apps/tray": `"/home/me/My Apps/tray"`,
		"/home/me/100%/tray":    "/home/me/100%%/tray",
		`/home/me/a"b\c/tray`:   `"/home/me/a\"b\\c/tray"`,
	} {
		if got := systemdExec(in); got != want {
			t.Errorf("systemdExec(%q) = %s, want %s", in, got, want)
		}
	}
}
