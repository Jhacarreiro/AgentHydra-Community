//go:build linux || darwin

package main

import (
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func pusherPid(a *app) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.cmd == nil || a.cmd.Process == nil {
		return 0
	}
	return a.cmd.Process.Pid
}

func shownNow(a *app) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.shown
}

// recordingPusher puts a pusher in place that writes its environment to pusher-env as it starts, and stays up; env is
// the value it was started with for one name ("" for none).
func recordingPusher(t *testing.T) (env func(name string) string) {
	t.Helper()
	file := filepath.Join(appDir, "pusher-env")
	t.Cleanup(func() {
		for _, p := range []string{configPath, pusherExe, file, filepath.Join(appDir, "pusher.log")} {
			os.Remove(p)
		}
	})
	os.Remove(file)
	script := "#!/bin/sh\nenv >pusher-env.tmp && mv pusher-env.tmp pusher-env\nexec sleep 60\n"
	if err := os.WriteFile(pusherExe, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return func(name string) string {
		b, _ := os.ReadFile(file)
		for _, line := range strings.Split(string(b), "\n") {
			if v, ok := strings.CutPrefix(line, name+"="); ok {
				return v
			}
		}
		return ""
	}
}

// The pusher has the hub and the token in its environment from its start. A new token, from pairing or written into
// tray.json, starts it again with that one, and until then the icon does not say it is pushing. The tray has an update
// key, so that the status turns on the token and the pusher alone, not on how a build treats a plain http hub.
func TestANewTokenRestartsThePusher(t *testing.T) {
	useTestKey(t)
	var mu sync.Mutex
	accepted := "" // the hash of the token the hub takes
	accept := func(hash string) {
		mu.Lock()
		accepted = hash
		mu.Unlock()
	}
	srv, _ := stubHub(t, func(c hubCall) (int, string) {
		mu.Lock()
		defer mu.Unlock()
		if c.path == "/api/codex-hub/redeem" {
			accepted = c.text("hash")
			return 200, pcJSON("Example-PC", c.text("id"))
		}
		if pcTokenHash(c.bearer) != accepted {
			return 401, errJSON("unknown-token")
		}
		if c.path == "/api/codex-hub/whoami" {
			return 200, pcJSON("Example-PC", pcTokenID(c.bearer))
		}
		return 404, errJSON("not-found") // no builds to hand out
	})
	env := recordingPusher(t)
	first := pcConfig(srv.URL)
	accept(pcTokenHash(first.Token))
	if err := saveConfig(first); err != nil {
		t.Fatal(err)
	}
	a := newApp()
	go a.supervise()
	t.Cleanup(func() { a.stopPusher(true) })
	runsWith := func(token string, not int) func() bool {
		return func() bool {
			pid := pusherPid(a)
			return env("AGENTHYDRA_CODEX_HUB_TOKEN") == token && pid != 0 && pid != not
		}
	}
	waitFor(t, 10*time.Second, "the pusher starts with the token", runsWith(first.Token, 0))
	firstPid := pusherPid(a)

	// The hub no longer has this PC's token.
	accept("")
	a.updateOnce()
	if s := shownNow(a); s != "The hub refused the token: choose Connect this PC" {
		t.Errorf("status with the refused token: %q", s)
	}

	// Connect this PC saves a new one: the pusher starts again with it, without waiting out its backoff.
	if code, body := postCode(a.pairHandler(testOpen, func() {}), strings.Repeat("0b", 32)); code != http.StatusOK {
		t.Fatalf("pairing: %d %s", code, body)
	}
	paired := savedConfig().Token
	waitFor(t, 3*time.Second, "the pusher runs with the paired token", runsWith(paired, firstPid))
	a.updateOnce()
	if s := shownNow(a); s != "Pushing this PC's Codex chats as Example-PC" {
		t.Errorf("status once the pusher has the paired token: %q", s)
	}

	// A token written into tray.json by hand, without its name: the icon says the pusher is restarting until the next
	// check names the token and restarts it.
	second := pusherPid(a)
	hand, handID, _ := newPcToken()
	accept(pcTokenHash(hand))
	if err := saveConfig(config{Hub: srv.URL, Token: hand}); err != nil {
		t.Fatal(err)
	}
	a.refresh()
	if s := shownNow(a); s != "Restarting the pusher with the new token" {
		t.Errorf("status while the pusher has the old token: %q", s)
	}
	a.updateOnce()
	waitFor(t, 3*time.Second, "the pusher runs with the token from tray.json", runsWith(hand, second))
	a.updateOnce()
	if s := shownNow(a); s != "Pushing this PC's Codex chats as Example-PC" {
		t.Errorf("status once the pusher has the token from tray.json: %q", s)
	}
	if c := savedConfig(); c.PC != "Example-PC" || c.ID != handID || env("AGENTHYDRA_CODEX_HUB_PC") != "Example-PC" {
		t.Errorf("the token from tray.json, named: %+v, the pusher's name %q", c, env("AGENTHYDRA_CODEX_HUB_PC"))
	}
}

// A PC still on the legacy token trades it at its next check for one of its own, with the install id its pusher pushes
// with: taken, the pusher starts again with the new token, which the build check that follows uses too; a hub from
// before PC tokens leaves it the token it has, said once; refused, the PC must be paired again, and asks again at the
// next check; with no answer, the token it sent stays next, and the next check settles it.
func TestExchange(t *testing.T) {
	useTestKey(t)
	const legacy = "legacy-token-0123"
	var mu sync.Mutex
	exchangeAs := func(c hubCall) (int, string) { return 200, pcJSON("Example-PC", c.text("id")) }
	windowOpen := true
	srv, calls := stubHub(t, func(c hubCall) (int, string) {
		mu.Lock()
		exchange, open := exchangeAs, windowOpen
		mu.Unlock()
		switch {
		case c.path == "/api/codex-hub/exchange":
			return exchange(c)
		case c.path == "/api/codex-hub/whoami":
			return 401, errJSON("unknown-token")
		case isPcToken(c.bearer) || (c.bearer == legacy && open):
			return 404, errJSON("not-found") // no builds to hand out
		}
		return 401, errJSON("unauthorized")
	})
	answers := func(exchange func(hubCall) (int, string), open bool) {
		mu.Lock()
		exchangeAs, windowOpen = exchange, open
		mu.Unlock()
	}
	answer := func(status int, body string) func(hubCall) (int, string) {
		return func(hubCall) (int, string) { return status, body }
	}
	env := recordingPusher(t)
	said := captureLog(t)
	if err := saveConfig(config{Hub: srv.URL, Token: legacy}); err != nil {
		t.Fatal(err)
	}
	install := loadConfig().Install
	a := newApp()
	go a.supervise()
	t.Cleanup(func() { a.stopPusher(true) })
	runsWith := func(token string, not int) func() bool {
		return func() bool {
			pid := pusherPid(a)
			return env("AGENTHYDRA_CODEX_HUB_TOKEN") == token && pid != 0 && pid != not
		}
	}
	waitFor(t, 10*time.Second, "the pusher starts with the legacy token", runsWith(legacy, 0))
	first := pusherPid(a)

	a.updateOnce()
	ex := calls("exchange")
	if len(ex) != 1 || ex[0].bearer != legacy || ex[0].install != install || !validInstall(install) ||
		pcTokenID(ex[0].next) != ex[0].text("id") || pcTokenHash(ex[0].next) != ex[0].text("hash") {
		t.Fatalf("the exchange: %+v (install %q)", ex, install)
	}
	if c := savedConfig(); c != (config{Hub: srv.URL, Token: ex[0].next, PC: "Example-PC", ID: ex[0].text("id"), Install: install}) {
		t.Errorf("tray.json after the exchange: %+v", c)
	}
	if b := calls("pusher"); len(b) != 1 || b[0].bearer != ex[0].next {
		t.Errorf("the build check after the exchange: %+v", b)
	}
	waitFor(t, 3*time.Second, "the pusher runs with the new token", runsWith(ex[0].next, first))
	a.refresh()
	if s := shownNow(a); s != "Pushing this PC's Codex chats as Example-PC" || env("AGENTHYDRA_CODEX_HUB_PC") != "Example-PC" {
		t.Errorf("status after the exchange: %q", s)
	}

	// A hub from before PC tokens.
	answers(answer(404, errJSON("not-found")), true)
	if err := saveConfig(config{Hub: srv.URL, Token: legacy}); err != nil {
		t.Fatal(err)
	}
	asked := len(calls("exchange"))
	a.updateOnce()
	a.updateOnce()
	if n := len(calls("exchange")) - asked; n != 2 || said.count("the hub hands out no PC tokens yet") != 1 {
		t.Errorf("a hub from before PC tokens: asked %d times, said %d times", n, said.count("the hub hands out no PC tokens yet"))
	}
	if c := savedConfig(); c.Token != legacy || c.Next != "" {
		t.Errorf("a hub from before PC tokens: tray.json %+v", c)
	}
	if b := calls("pusher"); b[len(b)-1].bearer != legacy {
		t.Errorf("a hub from before PC tokens: the build check with %q", b[len(b)-1].bearer)
	}

	// The hub does not trade it (another install, or its window is shut): the PC must be paired again.
	answers(answer(401, errJSON("unauthorized")), false)
	for i := 0; i < 2; i++ {
		asked := len(calls("exchange"))
		a.updateOnce()
		if n := len(calls("exchange")) - asked; n != 1 {
			t.Errorf("refused, check %d: asked %d times", i+1, n)
		}
		if s := shownNow(a); s != "This PC must be paired again: choose Connect this PC" {
			t.Errorf("refused, check %d: status %q", i+1, s)
		}
		if c := savedConfig(); c.Token != legacy || c.Next != "" {
			t.Errorf("refused, check %d: tray.json %+v", i+1, c)
		}
	}

	// No answer: the token sent stays next, and the next check, which finds the hub does not have it, sends it again.
	answers(answer(0, ""), true)
	a.updateOnce()
	ex = calls("exchange")
	sent := ex[len(ex)-1]
	if c := savedConfig(); c.Token != legacy || c.Next != sent.next || pcTokenID(c.Next) != sent.text("id") {
		t.Errorf("no answer: tray.json %+v", c)
	}
	answers(func(c hubCall) (int, string) { return 200, pcJSON("Example-PC", c.text("id")) }, true)
	a.updateOnce()
	ex = calls("exchange")
	if again := ex[len(ex)-1]; again.text("id") != sent.text("id") || again.text("hash") != sent.text("hash") {
		t.Errorf("the next check sent %s, not the token kept (%s)", again.text("id"), sent.text("id"))
	}
	if c := savedConfig(); c.Token != sent.next || c.Next != "" {
		t.Errorf("settled: tray.json %+v", c)
	}
	if s := shownNow(a); s == "This PC must be paired again: choose Connect this PC" {
		t.Errorf("status once moved: %q", s)
	}
}

// The pusher gets the hub, this PC's token, the name the hub has it under and its install id, over the user's own
// values, and is told to leave its updates to the tray. A change of next or id is no change to it; one of the name is.
func TestPusherEnv(t *testing.T) {
	env := recordingPusher(t)
	t.Setenv("AGENTHYDRA_CODEX_HUB_PC", "Users-Own-Name")
	t.Setenv("AGENTHYDRA_CODEX_HUB_INSTALL", "users-own-install")
	t.Setenv("AGENTHYDRA_CODEX_HUB_UPDATE", "on")
	cfg := pcConfig("http://hub.example.test:18788")
	if err := saveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	install := loadConfig().Install
	a := newApp()
	go a.supervise()
	t.Cleanup(func() { a.stopPusher(true) })
	waitFor(t, 10*time.Second, "the pusher starts", func() bool { return pusherPid(a) != 0 && env("AGENTHYDRA_CODEX_HUB_TOKEN") != "" })
	for name, want := range map[string]string{
		"AGENTHYDRA_CODEX_HUB_URL":     cfg.Hub,
		"AGENTHYDRA_CODEX_HUB_TOKEN":   cfg.Token,
		"AGENTHYDRA_CODEX_HUB_PC":      "Example-PC",
		"AGENTHYDRA_CODEX_HUB_INSTALL": install,
		"AGENTHYDRA_CODEX_HUB_UPDATE":  "off",
	} {
		if got := env(name); got != want {
			t.Errorf("%s=%q, want %q", name, got, want)
		}
	}
	if !validInstall(install) {
		t.Errorf("install id %q", install)
	}

	pid := pusherPid(a)
	next, _, _ := newPcToken()
	if err := updateConfig(func(c *config) { c.Next, c.ID = next, "0123456789abcdef" }); err != nil {
		t.Fatal(err)
	}
	a.restartIfChanged(loadConfig())
	a.refresh()
	if s := shownNow(a); pusherPid(a) != pid || s != "Pushing this PC's Codex chats as Example-PC" {
		t.Errorf("after a change of next and id: pid %d (was %d), status %q", pusherPid(a), pid, s)
	}

	if err := updateConfig(func(c *config) { c.PC = "Renamed-PC" }); err != nil {
		t.Fatal(err)
	}
	a.refresh()
	if s := shownNow(a); s != "Restarting the pusher with the new token" {
		t.Errorf("after a change of the name: status %q", s)
	}
	a.restartIfChanged(loadConfig())
	waitFor(t, 3*time.Second, "the pusher runs with the new name", func() bool {
		p := pusherPid(a)
		return p != 0 && p != pid && env("AGENTHYDRA_CODEX_HUB_PC") == "Renamed-PC"
	})
}

// tray.log and pusher.log hold what pairing writes and what the pusher says: each is made at 0600, and one an earlier
// build made at 0644 is made 0600.
func TestLogModes(t *testing.T) {
	trayLog, pusherLog := filepath.Join(appDir, "tray.log"), filepath.Join(appDir, "pusher.log")
	t.Cleanup(func() {
		log.SetOutput(os.Stderr)
		for _, p := range []string{trayLog, pusherLog, pusherExe} {
			os.Remove(p)
		}
	})
	if err := os.WriteFile(pusherExe, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	a := newApp()
	for _, earlier := range []bool{false, true} {
		for _, p := range []string{trayLog, pusherLog} {
			os.Remove(p)
			if earlier {
				os.WriteFile(p, []byte("an earlier build's log\n"), 0o644)
				os.Chmod(p, 0o644)
			}
		}
		openLog()
		log.SetOutput(os.Stderr)
		cmd, err := a.startPusher(pcConfig("http://hub.example.test:18788"))
		if err != nil {
			t.Fatal(err)
		}
		cmd.Wait()
		pusherGone()
		a.mu.Lock()
		a.cmd = nil
		a.mu.Unlock()
		for _, p := range []string{trayLog, pusherLog} {
			st, err := os.Stat(p)
			if err != nil {
				t.Fatal(err)
			}
			if st.Mode().Perm() != 0o600 {
				t.Errorf("%s (an earlier one there: %v): mode %v, want 0600", filepath.Base(p), earlier, st.Mode().Perm())
			}
		}
	}
}
