package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestIsPcToken(t *testing.T) {
	id, secret := strings.Repeat("0a", 8), strings.Repeat("f1", 32)
	if !isPcToken("chp_"+id+"_"+secret) || pcTokenID("chp_"+id+"_"+secret) != id {
		t.Errorf("a PC token is not one")
	}
	for _, bad := range []string{
		"", "chp_", "chp_" + id, "chp_" + id + "_",
		"chp_" + id + "_" + secret + "0", "chp_" + id[:15] + "_" + secret + "0",
		"chp_" + strings.ToUpper(id) + "_" + secret, "chp_" + id + "_" + strings.ToUpper(secret),
		"CHP_" + id + "_" + secret, "chp-" + id + "_" + secret, " chp_" + id + "_" + secret, "chp_" + id + "_" + secret + "\n",
		"Hub Token ~!", "e2e-Token_0123456789abcdef",
	} {
		if isPcToken(bad) || pcTokenID(bad) != "" {
			t.Errorf("%q is taken as a PC token", bad)
		}
	}
}

// A token the tray makes: the shape, its id in it, and the hash the hub keeps, the SHA-256 of the whole token.
func TestNewPcToken(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 20; i++ {
		token, id, hash := newPcToken()
		sum := sha256.Sum256([]byte(token))
		if !isPcToken(token) || pcTokenID(token) != id || !strings.HasPrefix(token, "chp_"+id+"_") || hash != hex.EncodeToString(sum[:]) {
			t.Fatalf("token %s, id %s, hash %s", token, id, hash)
		}
		if seen[token] || seen[id] {
			t.Fatalf("made %s twice", token)
		}
		seen[token], seen[id] = true, true
	}
	// The hash of one token, as the hub computes it (sha256 of the token's UTF-8, in lower-case hex).
	if got := pcTokenHash("chp_0123456789abcdef_" + strings.Repeat("0", 64)); got != "e1f1dd235858993aad164cc8f821b933b8f209358de1b2793a4e7e11eb02f980" {
		t.Errorf("hash %s", got)
	}
}

// pcKey is the hub's hubPcKey: the cases in testdata/pckey.json, which the hub's tests read too, and the characters
// whose lower case Go and JavaScript disagree on.
func TestPcKey(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("testdata", "pckey.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		PC  string  `json:"pc"`
		Key *string `json:"key"`
	}
	if err := json.Unmarshal(b, &cases); err != nil || len(cases) < 10 {
		t.Fatalf("pckey.json: %d cases, %v", len(cases), err)
	}
	cases = append(cases, struct {
		PC  string  `json:"pc"`
		Key *string `json:"key"`
	}{"İa", ptr("i-a")}, struct {
		PC  string  `json:"pc"`
		Key *string `json:"key"`
	}{"İ", ptr("i")})
	for _, c := range cases {
		want := ""
		if c.Key != nil {
			want = *c.Key
		}
		if got := pcKey(c.PC); got != want {
			t.Errorf("pcKey(%q) = %q, want %q", c.PC, got, want)
		}
	}
}

func ptr(s string) *string { return &s }

// unsetenv unsets name for the rest of the test.
func unsetenv(t *testing.T, name string) {
	t.Setenv(name, "")
	os.Unsetenv(name)
}

// The install id: the pusher's file, found where the pusher finds it, and made the way it makes it when it is not
// there; tray.json's once it has one, written back into the pusher's file; and tray.json's alone when that file can be
// neither read nor made.
func TestPusherInstall(t *testing.T) {
	t.Cleanup(func() { os.Remove(configPath) })
	os.Remove(configPath)
	unix := runtime.GOOS != "windows"
	modeOf := func(p string) os.FileMode {
		st, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		return st.Mode().Perm()
	}

	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	unsetenv(t, "AGENTHYDRA_HOME")
	unsetenv(t, "CCMANAGERUI_HOME")
	hydra, manager := filepath.Join(home, ".agenthydra"), filepath.Join(home, ".ccmanagerui")
	set, other := filepath.Join(t.TempDir(), "set"), filepath.Join(t.TempDir(), "other")
	for _, c := range []struct {
		what string
		step func()
		want string
	}{
		{"neither folder", func() {}, hydra},
		{"only the old folder", func() { os.Mkdir(manager, 0o700) }, manager},
		{"both folders", func() { os.Mkdir(hydra, 0o700) }, hydra},
		{"CCMANAGERUI_HOME", func() { t.Setenv("CCMANAGERUI_HOME", other) }, other},
		{"AGENTHYDRA_HOME, trimmed, over CCMANAGERUI_HOME", func() { t.Setenv("AGENTHYDRA_HOME", " "+set+" ") }, set},
		{"AGENTHYDRA_HOME set empty, which hides CCMANAGERUI_HOME", func() { t.Setenv("AGENTHYDRA_HOME", "") }, hydra},
		{"a relative AGENTHYDRA_HOME, the pusher's in its working folder", func() { t.Setenv("AGENTHYDRA_HOME", "rel") }, filepath.Join(appDir, "rel")},
	} {
		c.step()
		if got := pusherConfigDir(); got != c.want {
			t.Errorf("%s: %s, want %s", c.what, got, c.want)
		}
	}
	if got := pusherInstallFile(); got != filepath.Join(appDir, "rel", "codex-hub-push-install") {
		t.Errorf("pusherInstallFile() = %s", got)
	}

	// Not there: made at 0600 with a new id, in a folder made 0700, and the same id after; tray.json is left alone.
	dir := filepath.Join(t.TempDir(), "config", "agenthydra")
	file := filepath.Join(dir, "codex-hub-push-install")
	t.Setenv("AGENTHYDRA_HOME", dir)
	id := ensureInstall()
	if b, err := os.ReadFile(file); err != nil || string(b) != id+"\n" || !validInstall(id) {
		t.Fatalf("the pusher's file: %q %v, id %q", b, err, id)
	}
	if unix && (modeOf(file) != 0o600 || modeOf(dir) != 0o700) {
		t.Errorf("the file at %v, its folder at %v", modeOf(file), modeOf(dir))
	}
	if again := ensureInstall(); again != id || exists(configPath) {
		t.Errorf("the second time: %q, want %q (tray.json made: %v)", again, id, exists(configPath))
	}
	// There already, at 0644: its id, and the file made 0600.
	os.WriteFile(file, []byte("  existing-install-01\n"), 0o644)
	os.Chmod(file, 0o644)
	if got := ensureInstall(); got != "existing-install-01" {
		t.Errorf("an existing file: %q", got)
	}
	if unix && modeOf(file) != 0o600 {
		t.Errorf("an existing file left at %v", modeOf(file))
	}
	// One that holds no id: a new one, as the pusher would give it.
	os.WriteFile(file, []byte("not an id!\n"), 0o600)
	if got := ensureInstall(); !validInstall(got) || got == "existing-install-01" {
		t.Errorf("a file with no id: %q", got)
	} else if b, _ := os.ReadFile(file); string(b) != got+"\n" {
		t.Errorf("a file with no id now holds %q, the tray sends %q", b, got)
	}

	// tray.json's id is the one, written back into a pusher's file that went or holds another.
	const kept = "tray-json-install-1"
	if err := saveConfig(config{Install: kept}); err != nil {
		t.Fatal(err)
	}
	for what, step := range map[string]func(){
		"gone":           func() { os.RemoveAll(dir) },
		"another id":     func() { os.WriteFile(file, []byte("other-install-0001\n"), 0o600) },
		"another id too": func() { os.WriteFile(file, []byte("other-install-0002"), 0o644) },
	} {
		step()
		if got := ensureInstall(); got != kept {
			t.Errorf("%s: %q, want tray.json's", what, got)
		}
		if b, _ := os.ReadFile(file); string(b) != kept+"\n" {
			t.Errorf("%s: the pusher's file holds %q", what, b)
		}
		if unix && modeOf(file) != 0o600 {
			t.Errorf("%s: the pusher's file at %v", what, modeOf(file))
		}
	}

	// A folder that cannot be made, under a file: a new id, kept in tray.json alone, and the same one after.
	token, _, _ := newPcToken()
	if err := saveConfig(config{Token: token}); err != nil {
		t.Fatal(err)
	}
	blocker := filepath.Join(t.TempDir(), "a-file")
	os.WriteFile(blocker, nil, 0o600)
	t.Setenv("AGENTHYDRA_HOME", filepath.Join(blocker, "agenthydra"))
	said := captureLog(t)
	id = ensureInstall()
	if c := savedConfig(); !validInstall(id) || c.Install != id || c.Token != token {
		t.Errorf("an unwritable folder: %q, tray.json %+v", id, c)
	}
	if again := ensureInstall(); again != id {
		t.Errorf("an unwritable folder, the second time: %q, want %q", again, id)
	}
	if n := said.count("the pusher's install file " + filepath.Join(blocker, "agenthydra", "codex-hub-push-install") + " cannot be written ("); n != 1 {
		t.Errorf("said %d times that the file cannot be written", n)
	}

	// At start, a PC token without an install id in tray.json (one written in by hand) gets the pusher's; the
	// legacy token does not.
	t.Setenv("AGENTHYDRA_HOME", dir)
	for _, c := range []struct {
		token string
		keeps bool
	}{{token, true}, {"legacy-token-0123", false}} {
		if err := saveConfig(config{Token: c.token}); err != nil {
			t.Fatal(err)
		}
		keepInstall()
		if got := savedConfig().Install; (got == kept) != c.keeps || (got != "" && got != kept) {
			t.Errorf("token %q: tray.json's install %q after the start", c.token, got)
		}
	}
}

// contractCase is one case of testdata/contract.json (written with the hub; server/tests/codex-hub-auth.test.ts runs
// the same cases against the hub).
type contractCase struct {
	Name, Method, Path, Bearer, Install, Body, Setup string
	Want                                             struct {
		Status int
		Code   string
	}
}

// goCommand is the go command to build a test's helper with.
func goCommand(t *testing.T) string {
	if p, err := exec.LookPath("go"); err == nil {
		return p
	}
	if p := filepath.Join(runtime.GOROOT(), "bin", "go"); exists(p) || exists(p+".exe") {
		return p
	}
	t.Skip("no go command to build testdata/fakehub with")
	return ""
}

// testdata/fakehub answers each case of testdata/contract.json as the hub does, set up as the hub's own run of them
// sets it up: a PC name and an install id ("bound") of its own for each case, another id ("other"), and the legacy
// token's window open throughout. So what test-linux.sh and test-macos.sh pair, move and refuse with is the hub's.
func TestContract(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("testdata", "contract.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []contractCase
	if err := json.Unmarshal(b, &cases); err != nil || len(cases) < 30 {
		t.Fatalf("contract.json: %d cases, %v", len(cases), err)
	}
	dir := t.TempDir()
	exe := filepath.Join(dir, "fakehub")
	if runtime.GOOS == "windows" {
		exe += ".exe"
	}
	build := exec.Command(goCommand(t), "build", "-o", exe, "./testdata/fakehub")
	build.Env = append(os.Environ(), goEnv...)
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("building the fake hub: %v\n%s", err, out)
	}
	const admin, legacy = "contract-admin-token", "contract-legacy-token"
	builds, addrFile := filepath.Join(dir, "builds"), filepath.Join(dir, "hub.addr")
	os.Mkdir(builds, 0o755)
	out := &syncLog{}
	fake := exec.Command(exe, "-dir", builds, "-admin", admin, "-legacy", legacy, "-addr-file", addrFile)
	fake.Stdout, fake.Stderr = out, out
	if err := fake.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { fake.Process.Kill(); fake.Wait() })
	var hub string
	waitFor(t, 20*time.Second, "the fake hub starts", func() bool {
		b, _ := os.ReadFile(addrFile)
		hub = strings.TrimSpace(string(b))
		return strings.HasSuffix(string(b), "\n")
	})
	cl := &http.Client{Timeout: 10 * time.Second}
	send := func(method, path, bearer, install string, body any) (int, string) {
		t.Helper()
		var payload io.Reader
		if body != nil {
			j, _ := json.Marshal(body)
			payload = bytes.NewReader(j)
		}
		req, _ := http.NewRequest(method, hub+path, payload)
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		if install != "" {
			req.Header.Set(installHeader, install)
		}
		res, err := cl.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		text, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(text)
	}
	// control is the hub's page or command line, as the fake does it (/fake/...); it answers the value it makes.
	control := func(action, pc, install string) string {
		t.Helper()
		status, text := send("POST", "/fake/"+action+"?"+url.Values{"pc": {pc}, "install": {install}}.Encode(), "", "", nil)
		if status != http.StatusOK {
			t.Fatalf("/fake/%s for %s: %d %s", action, pc, status, text)
		}
		return strings.TrimSpace(text)
	}
	pending := func() []string {
		t.Helper()
		_, text := send("GET", "/fake/state", "", "", nil)
		var state struct{ Pending []string }
		if err := json.Unmarshal([]byte(text), &state); err != nil {
			t.Fatalf("/fake/state: %s", text)
		}
		return state.Pending
	}
	for i, c := range cases {
		pc := fmt.Sprintf("Contract-%d", i+1)
		bound, otherInstall := newInstallID(), newInstallID()
		install := map[string]string{"bound": bound, "other": otherInstall, "none": ""}[c.Install]
		bearer := ""
		switch c.Bearer {
		case "pc", "pc-revoked":
			bearer = control("add", pc, bound)
			if c.Bearer == "pc-revoked" {
				control("revoke", pc, "")
			}
		case "pc-unknown":
			bearer, _, _ = newPcToken()
		case "admin":
			bearer = admin
		case "legacy":
			bearer = legacy
		}
		switch c.Setup {
		case "pending":
			control("pending", pc, bound)
		case "nothing-pending":
			if p := pending(); len(p) != 0 {
				t.Fatalf("%s: pending %v", c.Name, p)
			}
		}
		code := strings.Repeat("0", 64) // one the hub never made
		if c.Setup == "code" || c.Setup == "code-used" {
			code = control("pair-code", pc, "")
		}
		if c.Setup == "code-used" {
			_, id, hash := newPcToken()
			if status, text := send("POST", "/api/codex-hub/redeem", "", bound, map[string]string{"code": code, "id": id, "hash": hash}); status != 200 {
				t.Fatalf("%s: the first redeem: %d %s", c.Name, status, text)
			}
		}
		_, id, hash := newPcToken()
		bodies := map[string]map[string]any{
			"/api/codex-hub/redeem": {
				"valid": map[string]string{"code": code, "id": id, "hash": hash},
				"bad":   map[string]string{"code": "nope", "id": id, "hash": hash},
			},
			"/api/codex-hub/exchange": {"valid": map[string]string{"id": id, "hash": hash}, "bad": map[string]string{"id": "x"}},
			"/api/codex-hub/retire":   {"valid": map[string]string{}, "bad": map[string]any{"renamedTo": 5}},
		}
		var body any
		if c.Body != "" {
			body = bodies[c.Path][c.Body]
		}
		status, text := send(c.Method, c.Path, bearer, install, body)
		var got struct{ Code string }
		json.Unmarshal([]byte(text), &got)
		if status != c.Want.Status || (c.Want.Code != "" && got.Code != c.Want.Code) {
			t.Errorf("%s: %d %s, want %d %s", c.Name, status, text, c.Want.Status, c.Want.Code)
		}
		// The case's PC goes, and with it anything it left pending.
		send("POST", "/fake/revoke?pc="+url.QueryEscape(pc), "", "", nil)
	}
	if p := pending(); len(p) != 0 {
		t.Errorf("pending at the end: %v", p)
	}
	if t.Failed() {
		t.Logf("the fake hub's log:\n%s", out.String())
	}
}
