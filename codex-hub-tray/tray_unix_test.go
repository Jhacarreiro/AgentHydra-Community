//go:build linux || darwin

package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

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

// The pusher has the hub and the token in its environment from its start. A new token, from pairing or written into
// tray.json, starts it again with that one, and until then the icon does not say it is pushing.
func TestANewTokenRestartsThePusher(t *testing.T) {
	var mu sync.Mutex
	accepted := "old-token-0123"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		ok := r.Header.Get("Authorization") == "Bearer "+accepted
		mu.Unlock()
		if !ok {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		http.NotFound(w, r) // no builds to hand out
	}))
	t.Cleanup(srv.Close)
	accept := func(token string) {
		mu.Lock()
		accepted = token
		mu.Unlock()
	}
	tokenFile := filepath.Join(appDir, "pusher-token")
	t.Cleanup(func() {
		for _, p := range []string{configPath, pusherExe, tokenFile, filepath.Join(appDir, "pusher.log")} {
			os.Remove(p)
		}
	})
	script := "#!/bin/sh\nprintf '%s\\n' \"$AGENTHYDRA_CODEX_HUB_TOKEN\" >pusher-token\nexec sleep 60\n"
	if err := os.WriteFile(pusherExe, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := saveConfig(config{Hub: srv.URL, Token: "old-token-0123"}); err != nil {
		t.Fatal(err)
	}
	a := newApp()
	go a.supervise()
	t.Cleanup(func() { a.stopPusher(true) })
	runsWith := func(token string, not int) func() bool {
		return func() bool {
			b, _ := os.ReadFile(tokenFile)
			pid := pusherPid(a)
			return strings.TrimSpace(string(b)) == token && pid != 0 && pid != not
		}
	}
	waitFor(t, 10*time.Second, "the pusher starts with the token", runsWith("old-token-0123", 0))
	first := pusherPid(a)

	// The hub has a new token: this PC's is refused.
	accept("new-token-4567")
	a.updateOnce()
	if s := shownNow(a); s != "The hub refused the token: choose Connect this PC" {
		t.Errorf("status with the refused token: %q", s)
	}

	// Connect this PC saves the new one: the pusher starts again with it, without waiting out its backoff.
	if code, body := postToken(a.pairHandler("the-state", func() {}), "the-state", "new-token-4567"); code != http.StatusOK {
		t.Fatalf("pairing: %d %s", code, body)
	}
	waitFor(t, 3*time.Second, "the pusher runs with the paired token", runsWith("new-token-4567", first))
	a.updateOnce()
	if s := shownNow(a); s != "Pushing this PC's Codex chats" {
		t.Errorf("status once the pusher has the paired token: %q", s)
	}

	// A token written into tray.json by hand: the icon says the pusher is restarting until the next check restarts it.
	second := pusherPid(a)
	accept("hand-token-89ab")
	if err := saveConfig(config{Hub: srv.URL, Token: "hand-token-89ab"}); err != nil {
		t.Fatal(err)
	}
	a.refresh()
	if s := shownNow(a); s != "Restarting the pusher with the new token" {
		t.Errorf("status while the pusher has the old token: %q", s)
	}
	a.updateOnce()
	waitFor(t, 3*time.Second, "the pusher runs with the token from tray.json", runsWith("hand-token-89ab", second))
	a.updateOnce()
	if s := shownNow(a); s != "Pushing this PC's Codex chats" {
		t.Errorf("status once the pusher has the token from tray.json: %q", s)
	}
}
