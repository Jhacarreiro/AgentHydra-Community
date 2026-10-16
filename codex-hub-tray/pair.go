package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"html"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

// Pairing gets the hub token from the hub's own page (GET /codex-hub/pair, behind the operator's sign-in): the tray
// listens on a loopback port, opens that page with the port and a one-time state, and the page's Connect button
// posts the token back to the port. Nothing is typed, and the token never reaches the address bar.

const pairFor = 20 * time.Minute

// tokenUsable: the hub takes any token its operator set (trimmed, of any length and characters), so this refuses
// only what cannot be the hub's or cannot go as it is into the Authorization header and the pusher's environment: an
// empty token, one with spaces at either end (the hub trims its own), one with a line break or another control
// character, and, as a sanity limit, one over 512 characters.
func tokenUsable(t string) bool {
	if t == "" || t != strings.TrimSpace(t) || !utf8.ValidString(t) || utf8.RuneCountInString(t) > 512 {
		return false
	}
	return !strings.ContainsFunc(t, unicode.IsControl)
}

type pairing struct {
	mu   sync.Mutex
	link string // the open pairing's page; "" when none is open
}

// pair opens the hub's pairing page, starting a listener for it unless one is open already.
func (a *app) pair() {
	a.pairing.mu.Lock()
	defer a.pairing.mu.Unlock()
	if a.pairing.link != "" {
		openURL(a.pairing.link)
		return
	}
	if pairURL == "" {
		message("This build has no pairing page. Set the hub token in " + configPath + ".")
		return
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Println("pair: listen:", err)
		return
	}
	b := make([]byte, 16)
	rand.Read(b)
	state := hex.EncodeToString(b)
	q := url.Values{
		"port":  {fmt.Sprint(ln.Addr().(*net.TCPAddr).Port)},
		"state": {state},
		"pc":    {pcName()},
	}
	a.pairing.link = pairURL + "?" + q.Encode()

	srv := &http.Server{ReadHeaderTimeout: 10 * time.Second}
	done := make(chan struct{})
	var once sync.Once
	finish := func() { once.Do(func() { close(done) }) }
	mux := http.NewServeMux()
	mux.HandleFunc("/paired", a.pairHandler(state, finish))
	srv.Handler = mux
	go srv.Serve(ln)
	go func() {
		select {
		case <-done:
			time.Sleep(2 * time.Second)
		case <-time.After(pairFor):
		}
		srv.Close()
		a.pairing.mu.Lock()
		a.pairing.link = ""
		a.pairing.mu.Unlock()
	}()
	openURL(a.pairing.link)
}

// pairHandler takes the hub page's post of the token for this pairing's state, checks the token with the hub and
// saves it.
func (a *app) pairHandler(state string, finish func()) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			page(w, http.StatusMethodNotAllowed, "Open the hub's pairing page from the Codex Hub menu.")
			return
		}
		got, token := r.PostFormValue("state"), r.PostFormValue("token")
		if subtle.ConstantTimeCompare([]byte(got), []byte(state)) != 1 {
			page(w, http.StatusBadRequest, "This pairing link is not the one this PC opened. Choose Connect this PC in the Codex Hub menu again.")
			return
		}
		if !tokenUsable(token) {
			page(w, http.StatusBadRequest, "The hub's token has a shape this app cannot use: it is empty, over 512 characters, has spaces at either end, or has a line break or another control character. Give the hub another token, then choose Connect this PC again.")
			return
		}
		c := loadConfig()
		c.Token = token
		err := tokenWorks(c)
		if errors.Is(err, errToken) {
			page(w, http.StatusUnauthorized, "The hub did not take that token. Choose Connect this PC again.")
			return
		}
		if serr := saveConfig(c); serr != nil {
			page(w, http.StatusInternalServerError, "Could not save the token: "+serr.Error())
			return
		}
		log.Println("pair: token saved")
		if err != nil {
			page(w, http.StatusOK, "This PC is connected. The hub did not answer just now ("+err.Error()+"); the app keeps trying. You can close this tab.")
		} else {
			page(w, http.StatusOK, "This PC is connected and is pushing its Codex chats. You can close this tab.")
		}
		finish()
		a.kick()
	}
}

// pcName is what the pairing page calls this PC: the name its pusher is listed under in the inbox (defaultPcName in
// server/src/core/codex-hub-push.ts), so the two agree.
func pcName() string {
	if n := strings.TrimSpace(os.Getenv("AGENTHYDRA_CODEX_HUB_PC")); n != "" {
		return n
	}
	host, _ := os.Hostname()
	return pcNameFrom(host, runtime.GOOS, localHostName)
}

var hostSuffix = regexp.MustCompile(`(?i)(?:\.(?:local|lan|home|localdomain))+$`)

// pcNameFrom: a Mac's Bonjour name, which stays the same on every network, else its hostname's first label; elsewhere
// the hostname less a trailing .local, .lan, .home or .localdomain.
func pcNameFrom(host, goos string, bonjour func() string) string {
	if goos == "darwin" {
		if n := bonjour(); n != "" {
			return n
		}
		if first, _, _ := strings.Cut(host, "."); first != "" {
			return first
		}
		return host
	}
	if n := hostSuffix.ReplaceAllString(host, ""); n != "" {
		return n
	}
	return host
}

func page(w http.ResponseWriter, status int, text string) {
	w.Header().Set("content-type", "text/html; charset=utf-8")
	w.Header().Set("cache-control", "no-store")
	w.WriteHeader(status)
	fmt.Fprintf(w, `<!doctype html><html lang="en"><meta charset="utf-8"><title>Codex Hub</title>
<body style="font:16px system-ui,sans-serif;max-width:440px;margin:48px auto;padding:0 16px"><h1>Codex Hub</h1><p>%s</p></body></html>`,
		html.EscapeString(text))
}
