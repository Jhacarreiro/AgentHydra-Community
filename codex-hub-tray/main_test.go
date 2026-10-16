package main

import (
	"encoding/json"
	"encoding/xml"
	"io"
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

func TestTokenUsable(t *testing.T) {
	// The hub takes any token its operator set, trimmed.
	for _, ok := range []string{"x", "short", "has spaces inside", "tökén ñ", "Hub_Token-0123456789~!", strings.Repeat("é", 512)} {
		if !tokenUsable(ok) {
			t.Errorf("refused %q", ok)
		}
	}
	for _, bad := range []string{"", " padded", "padded ", "two\nlines", "a\rb", "tab\there", "del\x7f", "\xff\xfe", strings.Repeat("x", 513)} {
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
	// Short, with a space and not ASCII: the hub takes such a token, so the tray does too.
	const good = "Hub tökén ~!"
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
	if c := loadConfig(); c.Token != "" || finished {
		t.Fatalf("a refused post saved %q (finished %v)", c.Token, finished)
	}
	for _, refused := range []string{"short", "refused by the hub", strings.Repeat("é", 512)} {
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
