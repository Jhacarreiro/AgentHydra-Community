package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"fyne.io/systray"
)

const (
	checkEvery = 10 * time.Minute
	// A pusher that stayed up this long was running fine; its next restart starts the backoff over.
	healthyRun = time.Minute
	maxBackoff = 5 * time.Minute
)

// app is the running tray: it owns the pusher process and the builds on disk.
type app struct {
	mu sync.Mutex
	// token is held by whatever makes, sends or settles this PC's token: a check (settleNext, exchange, named) and a
	// pairing's post (redeemCode, takeHubToken). So neither saves its next over one the other may have sent.
	token   sync.Mutex
	cmd     *exec.Cmd
	ran     pusherConfig // what cmd has in its environment
	hold    bool         // an update is swapping the pusher's file: do not start it
	since   time.Time
	hubErr  error // the last check's error (nil: the hub answered)
	blocked error // why this build takes no builds from the hub (updatesAllowed); nil when it does
	selfSHA string
	wake    chan struct{}
	check   chan struct{}
	pairing pairing
	paired  bool // pairing was opened once this run on its own
	// The updater's: per build ("pusher", "tray"), the hub's build that failed its checks here (release.seen), and
	// whether blocked was logged; and whether the hub refused to trade the legacy token for one of this PC's own
	// (exchange), so that it must be paired again.
	refused     map[string]string
	toldBlocked bool
	moveRefused bool
	// The token of the pairing's next a settle adopted last (settleNext), for a pairing posted after it; and what came
	// of the old names the renames it settled retired, which the next page that connects this PC says, as nothing else
	// shows it. Held under token.
	settled     string
	retirements []retirement

	status, restart *systray.MenuItem // nil when there is no tray to show them (Linux without a desktop session)
	shown           string
}

func newApp() *app {
	sum, _ := sha256File(trayExe)
	return &app{selfSHA: sum, wake: make(chan struct{}, 1), check: make(chan struct{}, 1), refused: map[string]string{}}
}

// kick starts the pusher now if it is waiting to start, and runs an update check (after pairing, or from the menu).
func (a *app) kick() {
	for _, ch := range []chan struct{}{a.wake, a.check} {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

func onReady() {
	a := newApp()
	systray.SetIcon(icon(grey))
	if runtime.GOOS != "darwin" { // on macOS the title would sit next to the icon in the menu bar
		systray.SetTitle("Codex Hub")
	}
	systray.SetTooltip("Codex Hub: starting")
	a.status = systray.AddMenuItem("Starting", "")
	a.status.Disable()
	version := systray.AddMenuItem("Version "+short(a.selfSHA), "This build's SHA-256")
	version.Disable()
	systray.AddSeparator()
	inbox := systray.AddMenuItem("Open the inbox", "")
	if inboxURL == "" {
		inbox.Hide()
	}
	pairItem := systray.AddMenuItem("Connect this PC", "Get a token of its own for this PC from the hub's pairing page")
	a.restart = systray.AddMenuItem("Restart the pusher", "")
	logs := systray.AddMenuItem("Show the log", "")
	systray.AddSeparator()
	quit := systray.AddMenuItem("Quit", quitHint)

	go func() {
		for {
			select {
			case <-inbox.ClickedCh:
				openURL(inboxURL)
			case <-pairItem.ClickedCh:
				a.pair()
			case <-a.restart.ClickedCh:
				a.stopPusher(false)
				a.kick()
			case <-logs.ClickedCh:
				openURL(filepath.Join(appDir, "pusher.log"))
			case <-quit.ClickedCh:
				quitTray()
			}
		}
	}()
	current.Store(a)
	go a.supervise()
	go a.updates()
}

var current atomic.Pointer[app]

func onExit() {
	if a := current.Load(); a != nil {
		a.stopPusher(true)
	}
}

// show sets the icon and the status line; the tooltip carries the same text. Without a tray it goes to the log.
func (a *app) show(c rgb, text string) {
	if a.status == nil {
		a.mu.Lock()
		changed := a.shown != text
		a.shown = text
		a.mu.Unlock()
		if changed {
			log.Println("status:", text)
		}
		return
	}
	systray.SetIcon(icon(c))
	systray.SetTooltip("Codex Hub: " + text)
	a.status.SetTitle(text)
}

// refresh shows what is true now: no token, a token the hub revoked, holds for another install or refused, a PC the
// hub would not move off the legacy token, the hub out of reach, or pushing. Pushing is the pusher's: it is shown only
// while the pusher runs with the hub, token, name and install id the check was made with.
func (a *app) refresh() {
	cfg := loadConfig()
	a.mu.Lock()
	running, hubErr, blocked, moveRefused := a.cmd != nil, a.hubErr, a.blocked, a.moveRefused
	stale := running && a.ran != cfg.pusher()
	a.mu.Unlock()
	switch {
	case cfg.Token == "" && cfg.Next == "":
		a.show(amber, "Not connected: choose Connect this PC")
	case errors.Is(hubErr, errRevoked):
		a.show(amber, "The hub revoked this PC: choose Connect this PC to pair it again")
	case errors.Is(hubErr, errInstall):
		a.show(amber, "This token belongs to another install: choose Connect this PC")
	case moveRefused && !isPcToken(cfg.Token):
		a.show(amber, "This PC must be paired again: choose Connect this PC")
	case errors.Is(hubErr, errToken):
		a.show(amber, "The hub refused the token: choose Connect this PC")
	case errors.Is(blocked, errNoKey):
		a.show(amber, "This build has no update key: it takes no builds over http")
	case blocked != nil:
		a.show(amber, "This build's update key is not valid: it takes no builds")
	case !running:
		a.show(amber, "The pusher is not running; restarting it")
	case stale:
		a.show(amber, "Restarting the pusher with the new token")
	case hubErr != nil:
		a.show(grey, "The hub is out of reach (away from home?)")
	case cfg.PC != "":
		a.show(green, "Pushing this PC's Codex chats as "+cfg.PC)
	default:
		a.show(green, "Pushing this PC's Codex chats")
	}
}

// supervise keeps the pusher running, restarting it with a growing pause when it keeps failing.
func (a *app) supervise() {
	backoff := 5 * time.Second
	for {
		cfg := loadConfig()
		if cfg.Token == "" {
			a.refresh()
			// A token the hub may have taken (next) is settled at the next check, not paired again.
			if !a.paired && cfg.Next == "" {
				a.paired = true
				a.pair()
			}
			a.sleep(time.Minute)
			continue
		}
		if !exists(pusherExe) {
			a.refresh()
			a.nudgeCheck()
			a.sleep(time.Minute)
			continue
		}
		cmd, err := a.startPusher(cfg)
		if errors.Is(err, errHold) {
			a.sleep(time.Minute) // release() wakes this
			continue
		}
		if err != nil {
			log.Println("pusher: start:", err)
			a.refresh()
			a.sleep(backoff)
			backoff = min(backoff*2, maxBackoff)
			continue
		}
		a.refresh()
		started := time.Now()
		err = cmd.Wait()
		pusherGone()
		a.mu.Lock()
		a.cmd = nil
		a.mu.Unlock()
		log.Printf("pusher: exited after %s: %v", time.Since(started).Round(time.Second), err)
		if time.Since(started) > healthyRun {
			backoff = 5 * time.Second
		}
		a.refresh()
		a.sleep(backoff)
		backoff = min(backoff*2, maxBackoff)
	}
}

func (a *app) sleep(d time.Duration) {
	select {
	case <-a.wake:
	case <-time.After(d):
	}
}

func (a *app) nudgeCheck() {
	select {
	case a.check <- struct{}{}:
	default:
	}
}

var errHold = errors.New("an update is replacing the pusher")

func (a *app) startPusher(cfg config) (*exec.Cmd, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.hold {
		return nil, errHold
	}
	logPath := filepath.Join(appDir, "pusher.log")
	if st, err := os.Stat(logPath); err == nil && st.Size() > 8<<20 {
		os.Rename(logPath, logPath+".1")
	}
	out, err := openPrivate(logPath)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(pusherExe)
	cmd.Dir = appDir
	cmd.Env = pusherEnv(cfg)
	cmd.Stdout, cmd.Stderr = out, out
	cmd.SysProcAttr = pusherAttr()
	if err := cmd.Start(); err != nil {
		out.Close()
		return nil, err
	}
	out.Close() // the child has its own handle
	adoptPusher(cmd.Process)
	a.cmd, a.ran, a.since = cmd, cfg.pusher(), time.Now()
	return cmd, nil
}

// pusherEnv is the pusher's environment: the tray's, then the hub, this PC's token, the name the hub has it under and
// its install id, which win over the user's own (the last of a name is the one a program gets).
func pusherEnv(cfg config) []string {
	env := append(os.Environ(), "AGENTHYDRA_CODEX_HUB_URL="+cfg.Hub, "AGENTHYDRA_CODEX_HUB_TOKEN="+cfg.Token)
	if cfg.PC != "" {
		env = append(env, "AGENTHYDRA_CODEX_HUB_PC="+cfg.PC)
	}
	if cfg.Install != "" {
		env = append(env, "AGENTHYDRA_CODEX_HUB_INSTALL="+cfg.Install)
	}
	// The tray keeps the pusher's build current.
	return append(env, "AGENTHYDRA_CODEX_HUB_UPDATE=off")
}

// restartIfChanged ends a pusher started with another hub, token, name or install id than cfg's (pairing saved a new
// token, or tray.json was edited): it would go on using the old ones from its environment, refused by the hub, and
// never exit. The supervisor, woken, starts it again with cfg's.
func (a *app) restartIfChanged(cfg config) {
	a.mu.Lock()
	old := a.cmd
	if old == nil || old.Process == nil || a.ran == cfg.pusher() {
		a.mu.Unlock()
		return
	}
	log.Println("pusher: the hub or the token changed; restarting it")
	killPusher(old.Process)
	a.mu.Unlock()
	for i := 0; i < 50; i++ {
		a.mu.Lock()
		gone := a.cmd != old
		a.mu.Unlock()
		if gone {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	select {
	case a.wake <- struct{}{}:
	default:
	}
}

// stopPusher ends the running pusher and waits until its file is free; hold keeps it stopped until release.
func (a *app) stopPusher(hold bool) {
	a.mu.Lock()
	if hold {
		a.hold = true
	}
	if a.cmd != nil && a.cmd.Process != nil {
		killPusher(a.cmd.Process)
	}
	a.mu.Unlock()
	for i := 0; i < 50; i++ {
		a.mu.Lock()
		gone := a.cmd == nil
		a.mu.Unlock()
		if gone {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func (a *app) release() {
	a.mu.Lock()
	a.hold = false
	a.mu.Unlock()
	a.kick()
}

// updates checks the hub's builds at start, every few minutes, and when asked.
func (a *app) updates() {
	for {
		a.updateOnce()
		select {
		case <-a.check:
		case <-time.After(checkEvery):
		}
	}
}

// updateOnce is one check: the token first (a token the hub may have taken, the legacy token traded for one of this
// PC's own, the name the hub has it under), then the hub's builds, asked for with the token as it is now. A next that
// is still unsettled is the one token the hub may have: no new one is made over it, and settleNext sends it again.
func (a *app) updateOnce() {
	a.token.Lock()
	a.settleNext()
	if cfg := loadConfig(); cfg.Token != "" && !isPcToken(cfg.Token) && cfg.Next == "" {
		a.exchange(cfg, "")
	}
	cfg := loadConfig()
	if isPcToken(cfg.Token) {
		a.mu.Lock()
		a.moveRefused = false
		a.mu.Unlock()
		if cfg.PC == "" || cfg.ID != pcTokenID(cfg.Token) {
			cfg = a.named(cfg)
		}
	}
	a.token.Unlock()
	a.restartIfChanged(cfg)
	if cfg.Token == "" {
		return
	}
	rel, err := latest(cfg, "pusher")
	blocked := updatesAllowed(cfg.Hub)
	a.mu.Lock()
	a.hubErr, a.blocked = err, blocked
	a.mu.Unlock()
	a.refresh()
	if blocked != nil {
		// Nothing it would fetch could be told from a stranger's program: it keeps the builds it has.
		if !a.toldBlocked {
			a.toldBlocked = true
			log.Printf("update: %v; keeping the builds this PC has", blocked)
		}
		return
	}
	a.toldBlocked = false
	if err != nil {
		log.Println("update: pusher:", err)
		return
	}
	if rel != nil && a.refused["pusher"] != rel.seen() {
		if have, _ := sha256File(pusherExe); have != rel.SHA256 {
			if err := a.swapPusher(cfg, rel); err != nil {
				log.Println("update: pusher:", err)
			} else {
				log.Println("update: pusher now", short(rel.SHA256))
			}
		}
	}
	rel, err = latest(cfg, "tray")
	if err != nil || rel == nil || rel.SHA256 == a.selfSHA || a.refused["tray"] == rel.seen() {
		if err != nil {
			log.Println("update: tray:", err)
		}
		return
	}
	next, err := a.fetch(cfg, "tray", rel, trayExe)
	if err != nil {
		log.Println("update: tray:", err)
		return
	}
	a.replaceSelf(next, rel)
}

// settleNext settles a token the tray asked the hub to take and has no answer for (next: a redeem or an exchange
// whose answer was lost, or a tray stopped in between): whoami with it says whether the hub has it. The hub answers a
// repeat of either with the same id and hash the same way, so an exchange the hub did not take is sent again as it was.
// Only the hub's own answers for a PC token settle it: 200, it has it; 401 unknown-token or revoked, or 409
// install-mismatch, it does not have it for this PC. Anything else (no answer, a 5xx, a proxy's own 401, 403 or 429,
// a hub started without its admin token) keeps it for the next check. The caller holds a.token.
func (a *app) settleNext() {
	cfg := loadConfig()
	if cfg.Next == "" {
		return
	}
	// tray.json's own token, before it changes: the one a rename retires, as redeemCode's before is.
	old := savedConfig()
	next := cfg
	next.Token = cfg.Next
	who, ans, err := whoami(next)
	notHeld := err == nil &&
		(ans.status == http.StatusUnauthorized && (ans.code == "unknown-token" || ans.code == "revoked") ||
			ans.status == http.StatusConflict && ans.code == "install-mismatch")
	switch {
	case err == nil && ans.status == http.StatusOK:
		adopted := false
		if err := updateConfig(func(c *config) {
			if c.Next == cfg.Next {
				c.Token, c.PC, c.ID, c.Install, c.Next = cfg.Next, who.PC, who.ID, cfg.Install, ""
				c.RenameFrom, c.RenameTo, c.Pairing = "", "", false
				adopted = true
			}
		}); err != nil {
			log.Println("config:", err)
			return
		}
		if !adopted {
			return
		}
		log.Printf("token: the hub has chp_%s, for %s", who.ID, who.PC)
		if cfg.Pairing {
			a.settled = cfg.Next
		}
		// A rename whose redeem answer was lost, retired as redeemCode retires one: its link named this PC's old name,
		// and the hub has the token under the key of the name that link paired as.
		if cfg.RenameFrom != "" && isPcToken(old.Token) && who.Key == pcKey(cfg.RenameTo) {
			retiring := cfg
			retiring.Token = old.Token
			a.retirements = append(a.retirements, retirement{cfg.RenameFrom, retireOld("token", retiring, cfg.RenameFrom, who.PC)})
		}
		a.restartIfChanged(loadConfig())
	case notHeld && cfg.Token != "" && !isPcToken(cfg.Token):
		a.exchange(cfg, cfg.Next)
	case notHeld:
		dropNext(cfg.Next)
	default:
		if err == nil {
			err = ans.refusal("whoami")
		}
		log.Printf("token: the hub did not say whether it took chp_%s (%v); asking again at the next check", pcTokenID(cfg.Next), err)
	}
}

// exchange trades the legacy token in cfg for a token of this PC's own, once, while the hub's migration window is
// open (POST /api/codex-hub/exchange): the hub finds the PC by the install id, which must be the one its pusher has
// pushed with. token is a token to send again (settleNext), or "" for a new one. Saved as next first, as a redeem's.
// Refused (401), the PC keeps the legacy token, says it must be paired again, and asks again at the next check; a hub
// from before PC tokens (404) is left alone with the token it takes. The caller holds a.token.
func (a *app) exchange(cfg config, token string) {
	for try := 1; ; try++ {
		if token == "" {
			token, _, _ = newPcToken()
		}
		if err := updateConfig(func(c *config) {
			c.Next, c.Install, c.RenameFrom, c.RenameTo, c.Pairing = token, cfg.Install, "", "", false
		}); err != nil {
			log.Println("config:", err)
			return
		}
		id := pcTokenID(token)
		who, ans, err := exchangeToken(cfg, id, pcTokenHash(token))
		switch {
		case err != nil || ans.status >= 500:
			if err == nil {
				err = ans.refusal("the exchange")
			}
			log.Printf("token: the hub did not answer the exchange (%v); asking again at the next check", err)
		case ans.status == http.StatusOK:
			if err := updateConfig(func(c *config) {
				c.Token, c.PC, c.ID, c.Install, c.Next = token, who.PC, who.ID, cfg.Install, ""
				c.RenameFrom, c.RenameTo, c.Pairing = "", "", false
			}); err != nil {
				log.Println("config:", err)
				return
			}
			a.setMoveRefused(false)
			log.Printf("token: this PC moved to a token of its own, as %s (chp_%s)", who.PC, id)
			a.restartIfChanged(loadConfig())
		case ans.status == http.StatusConflict && ans.code == "id-taken" && try == 1:
			token = ""
			continue
		case ans.status == http.StatusUnauthorized:
			dropNext(token)
			a.setMoveRefused(true)
			log.Println("token: the hub did not trade the old shared token for one of this PC's own; pair this PC again")
		case ans.status == http.StatusNotFound:
			dropNext(token)
			a.setMoveRefused(false)
			logOnce("token: the hub hands out no PC tokens yet; this PC keeps the token it has")
		default:
			dropNext(token)
			log.Println("token: the exchange:", ans.refusal("the exchange"))
		}
		return
	}
}

func (a *app) setMoveRefused(refused bool) {
	a.mu.Lock()
	a.moveRefused = refused
	a.mu.Unlock()
}

// named fills in the name and id the hub has a PC token under, from whoami, for a token whose tray.json has no pc or
// another token's id: one written in by hand. It is cfg as it is then.
func (a *app) named(cfg config) config {
	who, ans, err := whoami(cfg)
	if err == nil && ans.status != http.StatusOK {
		err = ans.refusal("whoami")
	}
	if err != nil {
		log.Println("token: whoami:", err)
		return cfg
	}
	if err := updateConfig(func(c *config) {
		if c.Token == cfg.Token || c.Token == "" { // "": the token is the user environment's
			c.PC, c.ID = who.PC, who.ID
			if !validInstall(c.Install) {
				c.Install = cfg.Install
			}
		}
	}); err != nil {
		log.Println("config:", err)
		return cfg
	}
	log.Printf("token: the hub has this PC's token as %s (chp_%s)", who.PC, who.ID)
	return loadConfig()
}

// fetch downloads the hub's build of name. One that fails its checks is not fetched again until the hub hands out
// another: it would fail the same way, and a PC without a pusher checks every minute (a pusher build is 60-90 MB).
func (a *app) fetch(cfg config, name string, rel *release, dest string) (string, error) {
	next, err := download(cfg, name, rel, dest)
	if errors.As(err, new(badBuild)) {
		a.refused[name] = rel.seen()
		return "", fmt.Errorf("%w (not fetched again until the hub has another %s build or signature)", err, name)
	}
	return next, err
}

func (a *app) swapPusher(cfg config, rel *release) error {
	next, err := a.fetch(cfg, "pusher", rel, pusherExe)
	if err != nil {
		return err
	}
	a.stopPusher(true)
	defer a.release()
	os.Remove(pusherExe + ".old")
	if exists(pusherExe) {
		if err := os.Rename(pusherExe, pusherExe+".old"); err != nil {
			os.Remove(next)
			return err
		}
	}
	if err := os.Rename(next, pusherExe); err != nil {
		os.Rename(pusherExe+".old", pusherExe)
		return err
	}
	os.Remove(pusherExe + ".old")
	return nil
}

func short(sum string) string {
	if len(sum) < 8 {
		return "unknown"
	}
	return sum[:8]
}

// versionTimeout is how long a build's --version may take: the antivirus scans a new exe on its first start.
var versionTimeout = 2 * time.Minute

// errSlowStart: a build's --version did not end within versionTimeout, which says nothing against the build.
var errSlowStart = errors.New("it did not end in time")

// runVersion starts a build with --version and gives it versionTimeout to end. The hub's address and token are set
// empty for it (a PC set up by the earlier script has them in its user environment): a build that does not know
// --version, such as an older pusher put back on the hub, then stops at its own check instead of running as this PC's
// second pusher. Empty, not left out: a pusher reads a .env in its working folder for what is not set at all.
func runVersion(exe string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), versionTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, "--version")
	cmd.Env = append(os.Environ(), "AGENTHYDRA_CODEX_HUB_URL=", "AGENTHYDRA_CODEX_HUB_TOKEN=",
		"CCMANAGERUI_CODEX_HUB_URL=", "CCMANAGERUI_CODEX_HUB_TOKEN=")
	cmd.SysProcAttr = hiddenAttr()
	out, err := cmd.Output()
	if ctx.Err() != nil {
		return "", fmt.Errorf("%s --version: %w", filepath.Base(exe), errSlowStart)
	}
	if err != nil {
		return "", fmt.Errorf("%s --version: %w", filepath.Base(exe), err)
	}
	return string(out), nil
}
