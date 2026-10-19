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
)

// Pairing gets this PC a token of its own through the hub's page (GET /codex-hub/pair, behind the operator's sign-in):
// the tray listens on a loopback port and opens that page with the port, a one-time state, the name it pairs as and
// when its listener closes. The page's Connect button posts a one-time code back to the port, and the tray redeems
// the code with the id and hash of a token it makes for it. Nothing is typed, and no token travels: the hub keeps
// the token's hash. A hub from before PC tokens posts its own token there instead, which the tray still takes.

const pairFor = 20 * time.Minute

// tokenUsable: a hub from before PC tokens hands out the one token its operator set (trimmed, of any length), but it
// reads the Authorization header a byte to a character (Latin-1) and compares that with its own token, while this app
// sends the token's UTF-8: only an ASCII token arrives as it was sent. So this refuses an empty token, one with spaces
// at either end, one with any character but printable ASCII (a letter such as é, a line break, a tab), and, as a
// sanity limit, one over 512 characters. A PC token always passes.
func tokenUsable(t string) bool {
	if t == "" || t != strings.TrimSpace(t) || len(t) > 512 {
		return false
	}
	for i := 0; i < len(t); i++ {
		if t[i] < ' ' || t[i] > '~' {
			return false
		}
	}
	return true
}

type pairing struct {
	mu    sync.Mutex
	link  string    // the open pairing's page; "" when none is open
	until time.Time // when its listener closes
	from  string    // the paired name its link says this PC is renamed from; "" when it says none
}

// pairName is the name this PC pairs as: AGENTHYDRA_CODEX_HUB_PC, else the name the hub has it under (tray.json's pc),
// else its own (pcName).
func pairName() string {
	if n := strings.TrimSpace(os.Getenv("AGENTHYDRA_CODEX_HUB_PC")); n != "" {
		return n
	}
	if n := strings.TrimSpace(savedConfig().PC); n != "" {
		return n
	}
	return pcName()
}

// pairLink is the page's address for a listener on port: the state, the name this PC pairs as, and until, the
// listener's end in Unix seconds, which the page's code never outlives. A PC paired under another name with a token of
// its own also says that name as from, which the page words the rename by, and which the tray retires once it has
// connected; from is returned too, "" when the link names none.
func pairLink(port int, state, name string, until time.Time) (link, from string) {
	q := url.Values{
		"port":  {fmt.Sprint(port)},
		"state": {state},
		"pc":    {name},
		"until": {fmt.Sprint(until.Unix())},
	}
	if c := savedConfig(); isPcToken(c.Token) && c.PC != "" && pcKey(name) != pcKey(c.PC) {
		from = c.PC
		q.Set("from", from)
	}
	return pairURL + "?" + q.Encode(), from
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
		message("This build has no pairing page. Put a token from the hub (scripts/codex-hub-pcs.ts add) in " + configPath + ".")
		return
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Println("pair: listen:", err)
		return
	}
	b := make([]byte, 16)
	rand.Read(b)
	open := pairOpen{state: hex.EncodeToString(b), host: ln.Addr().String(), name: pairName()}
	a.pairing.until = time.Now().Add(pairFor)
	a.pairing.link, open.from = pairLink(ln.Addr().(*net.TCPAddr).Port, open.state, open.name, pairUntil(time.Now(), pageTime()))
	a.pairing.from = open.from

	srv := &http.Server{ReadHeaderTimeout: 10 * time.Second}
	done := make(chan struct{})
	var once sync.Once
	finish := func() { once.Do(func() { close(done) }) }
	mux := http.NewServeMux()
	mux.HandleFunc("/paired", a.pairHandler(open, finish))
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
		a.pairing.link, a.pairing.from = "", ""
		a.pairing.mu.Unlock()
	}()
	openURL(a.pairing.link)
}

// pairUntil is when a pairing link opened now expires, by the clock the page judges it by: the page's (page), so a PC
// whose clock runs behind does not hand out a link that has expired already, but never earlier than by this PC's
// (now), as a Date from a cache or a proxy can be behind the hub's.
func pairUntil(now, page time.Time) time.Time {
	if page.After(now) {
		now = page
	}
	return now.Add(pairFor)
}

// pageTime is now by the clock of the server the pairing page is on: the Date of its answer to a GET of the page (not
// a HEAD, which the hub's own server answers with none), taken as it comes (a redirect to a sign-in page has one too),
// or now by this PC's clock when there is no answer. Its body is not read. No hub headers go with it: the page may be
// on another host than the hub.
func pageTime() time.Time {
	now := time.Now()
	req, err := http.NewRequest(http.MethodGet, pairURL, nil)
	if err != nil {
		return now
	}
	cl := &http.Client{
		Timeout:       5 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	res, err := cl.Do(req)
	if err != nil {
		return now
	}
	res.Body.Close()
	at, err := http.ParseTime(res.Header.Get("Date"))
	if err != nil {
		return now
	}
	return at
}

// pairOpen is what one open pairing's posts are checked against: its state, the address its listener has (the Host
// a post must name, so a page elsewhere cannot reach it by another name), the name its link pairs as, and the name
// its link said this PC is renamed from.
type pairOpen struct {
	state, host, name, from string
}

// retirement is what came of retiring a rename's old name (from): err is nil when it was retired.
type retirement struct {
	from string
	err  error
}

// linkPosts is what one link's posts share, held under a.token: the pairings' tokens whose answer was lost while the
// link was open (one still unsettled when it opened, and those its own posts sent), and the token and page of the post
// that connected this PC, which a post after it (a second click, while the listener is still open) is answered with.
// A token settled before the link opened is not a lost one: a pairing posted on it is the user's own, made with the
// tray showing this PC connected.
type linkPosts struct {
	lost        map[string]bool
	token, page string
}

var pairCode = regexp.MustCompile(`^[0-9a-f]{64}$`)

// pairHandler takes the hub page's post for this pairing: a code, which it redeems with a token it makes, or the
// token a hub from before PC tokens posts.
func (a *app) pairHandler(open pairOpen, finish func()) http.HandlerFunc {
	posts := &linkPosts{lost: map[string]bool{}}
	if c := savedConfig(); c.Pairing && c.Next != "" {
		posts.lost[c.Next] = true
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			page(w, http.StatusMethodNotAllowed, "Open the hub's pairing page from the Codex Hub menu.")
			return
		}
		if r.Host != open.host || subtle.ConstantTimeCompare([]byte(r.PostFormValue("state")), []byte(open.state)) != 1 {
			page(w, http.StatusBadRequest, "This pairing link is not the one this PC opened. Choose Connect this PC in the Codex Hub menu again.")
			return
		}
		code, token := r.PostFormValue("code"), r.PostFormValue("token")
		switch {
		case pairCode.MatchString(code):
			a.redeemCode(w, open, posts, code, finish)
		case code == "" && tokenUsable(token) && !isPcToken(token):
			a.takeHubToken(w, token, finish)
		default:
			page(w, http.StatusBadRequest, "This page did not come from your hub's current version.")
		}
	}
}

// redeemCode makes this PC a token and redeems the page's code with it. The token is saved as next before it is
// sent, so an answer lost on the way is settled at the next check (settleNext), and as the token only once the hub
// has answered that it took it. posts is what this link's posts share.
func (a *app) redeemCode(w http.ResponseWriter, open pairOpen, posts *linkPosts, code string, finish func()) {
	a.token.Lock()
	defer a.token.Unlock()
	// A second post of this link's page after one connected this PC: the same answer, and nothing sent.
	if posts.token != "" && savedConfig().Token == posts.token {
		page(w, http.StatusOK, posts.page)
		return
	}
	// connected answers the post that connects this PC, adding what came of the renames a check retired that no page has
	// said yet.
	connected := func(token, text string) {
		for _, r := range a.retirements {
			text += renamed(r.from, r.err)
		}
		a.retirements = nil
		posts.token, posts.page = token, text
		page(w, http.StatusOK, text)
		finish()
	}
	// A next from before (a check's or a pairing's whose answer was lost) may be a token the hub has: settled first, so
	// this one never takes its place. While the hub says nothing about it, this pairing waits.
	had := savedConfig()
	if loadConfig().Next != "" {
		a.settleNext()
		if loadConfig().Next != "" {
			page(w, http.StatusServiceUnavailable, "This PC is still waiting for the hub to say whether it took the token it sent last. Nothing changed: choose Connect this PC again in a few minutes.")
			return
		}
	}
	// The hub had a pairing's token whose answer was lost, settled just now or, if it was lost while this link was
	// open, by a check since: this PC is connected under the name that pairing chose (the link's, or another the page
	// offered), and the page's new code, which would pair it a second time, is left. So it is when this post settled a
	// check's token that the hub has under this link's name.
	now := savedConfig()
	settled := now.Token != had.Token
	pairings := isPcToken(now.Token) && a.settled == now.Token && (settled || posts.lost[now.Token])
	// One a check settled before this post: the hub may have revoked it since, and then this code pairs the PC again.
	if pairings && !settled {
		_, ans, err := whoami(loadConfig())
		switch {
		case err == nil && ans.status == http.StatusOK:
		case err == nil && (ans.status == http.StatusUnauthorized && (ans.code == "unknown-token" || ans.code == "revoked") ||
			ans.status == http.StatusConflict && ans.code == "install-mismatch"):
			pairings, a.settled = false, ""
		default:
			page(w, http.StatusServiceUnavailable, "This PC is still waiting for the hub to say whether it has this PC's token. Nothing changed: choose Connect this PC again in a few minutes.")
			return
		}
	}
	if isPcToken(now.Token) && (pairings || settled && pcKey(now.PC) == pcKey(open.name)) {
		a.settled = ""
		connected(now.Token, "This PC is connected as "+now.PC+" and is pushing its Codex chats.")
		go a.kick()
		return
	}
	before := savedConfig()
	cfg := loadConfig()
	// A rename (5.3), saved with next: a check that settles it retires the old name as this answer would. Only while
	// the token this PC holds is still the old name's: one it took since (a lost pairing's) is not.
	from, to := "", ""
	if isPcToken(before.Token) && open.from != "" && pcKey(before.PC) == pcKey(open.from) {
		from, to = open.from, open.name
	}
	var who pcAnswer
	var ans hubAnswer
	var token string
	var err error
	for try := 1; ; try++ {
		var id, hash string
		token, id, hash = newPcToken()
		if err := updateConfig(func(c *config) {
			c.Next, c.Install, c.RenameFrom, c.RenameTo, c.Pairing = token, cfg.Install, from, to, true
		}); err != nil {
			page(w, http.StatusInternalServerError, "Could not save the token: "+err.Error())
			return
		}
		who, ans, err = redeem(cfg, code, id, hash)
		// The hub has that id already: another token, made once.
		if err != nil || try == 2 || ans.status != http.StatusConflict || ans.code != "id-taken" {
			break
		}
	}
	// No answer, or none from the hub itself (a proxy's 5xx, with no code, may come after the hub took it): next stays,
	// for the next check to ask the hub about.
	if err == nil && ans.status >= 500 && ans.code == "" {
		err = ans.refusal("the pairing")
	}
	if err != nil {
		posts.lost[token] = true
		log.Println("pair: the hub did not answer the redeem:", err)
		page(w, http.StatusBadGateway, "The hub did not answer ("+err.Error()+"). If it took the pairing, this PC connects by itself within 10 minutes; if not, choose Connect this PC again.")
		return
	}
	if ans.status != http.StatusOK {
		dropNext(token)
		switch {
		case ans.status == http.StatusUnauthorized && ans.code == "pair-code":
			page(w, http.StatusUnauthorized, "This pairing link has expired or was used already. Choose Connect this PC again.")
		case ans.status == http.StatusConflict && ans.code == "name-changed":
			page(w, http.StatusConflict, open.name+" changed on the hub since the page opened (another PC was paired as "+open.name+", or it was revoked). Choose Connect this PC again.")
		default:
			status := ans.status
			if status < 400 {
				status = http.StatusBadGateway
			}
			page(w, status, ans.refusal("the pairing").Error()+". Choose Connect this PC again.")
		}
		log.Printf("pair: the hub refused the code (%d %s)", ans.status, ans.code)
		return
	}
	if err := updateConfig(func(c *config) {
		c.Token, c.PC, c.ID, c.Install, c.Next = token, who.PC, who.ID, cfg.Install, ""
		c.RenameFrom, c.RenameTo, c.Pairing = "", "", false
	}); err != nil {
		page(w, http.StatusInternalServerError, "Could not save the token: "+err.Error())
		return
	}
	log.Printf("pair: connected as %s (chp_%s)", who.PC, who.ID)
	text := "This PC is connected as " + who.PC + " and is pushing its Codex chats."
	// A rename: the token this PC had is the old name's, which only this PC can retire, from its install.
	if from != "" && who.Key == pcKey(to) {
		old := cfg
		old.Token = before.Token
		text += renamed(from, retireOld("pair", old, from, who.PC))
	}
	connected(token, text)
	// The running pusher has the token it was started with; it starts again with this one.
	started := loadConfig()
	go func() {
		a.restartIfChanged(started)
		a.kick()
	}()
}

// renamed is the page's sentence on a rename's old name: retired (err nil), or not, and what to run then.
func renamed(from string, err error) string {
	if err == nil {
		return " " + from + " was retired on the hub; its copies there stay until you forget them."
	}
	return " " + from + " could not be retired (" + err.Error() + "): on the hub, run `scripts/codex-hub-pcs.ts revoke " + from + "`."
}

// retireOld has the hub retire old's token, this PC's under oldName, after the PC was paired as newName: only this
// PC can, from its install. A token the hub answers revoked or unknown-token for is retired already (a check that
// settled the rename first, or a revoke). Nil when the old name is retired; logged under what either way.
func retireOld(what string, old config, oldName, newName string) error {
	_, ans, err := retire(old, newName)
	switch {
	case err != nil:
	case ans.status == http.StatusOK:
		log.Printf("%s: retired %s's token (chp_%s)", what, oldName, pcTokenID(old.Token))
		return nil
	case ans.status == http.StatusUnauthorized && (ans.code == "revoked" || ans.code == "unknown-token"):
		log.Printf("%s: %s's token (chp_%s) was retired already", what, oldName, pcTokenID(old.Token))
		return nil
	default:
		err = ans.refusal("retire")
	}
	log.Printf("%s: could not retire %s's token (%v): on the hub, run `scripts/codex-hub-pcs.ts revoke %s`", what, oldName, err, oldName)
	return err
}

// takeHubToken saves the token a hub from before PC tokens posts (one rolled back to it): checked with the hub as
// such a hub checks it, and saved alone, as that hub has no pc or id for it. The install id stays for the next hub.
func (a *app) takeHubToken(w http.ResponseWriter, token string, finish func()) {
	a.token.Lock()
	defer a.token.Unlock()
	check := loadConfig()
	check.Token = token
	err := tokenWorks(check)
	if errors.Is(err, errToken) {
		page(w, http.StatusUnauthorized, "The hub did not take that token. Choose Connect this PC again.")
		return
	}
	// Only what the user set, and now the token: the hub stays the build's unless they set another.
	if serr := updateConfig(func(c *config) {
		c.Token, c.PC, c.ID, c.Next, c.RenameFrom, c.RenameTo, c.Pairing = token, "", "", "", "", "", false
	}); serr != nil {
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
	// The running pusher has the token it was started with; it starts again with this one.
	now := loadConfig()
	go func() {
		a.restartIfChanged(now)
		a.kick()
	}()
}

// dropNext removes next from tray.json while it is still token: the hub did not take it.
func dropNext(token string) {
	if err := updateConfig(func(c *config) {
		if c.Next == token {
			c.Next, c.RenameFrom, c.RenameTo, c.Pairing = "", "", "", false
		}
	}); err != nil {
		log.Println("config:", err)
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
