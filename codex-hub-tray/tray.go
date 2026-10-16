package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
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
	mu      sync.Mutex
	cmd     *exec.Cmd
	hold    bool // an update is swapping the pusher's file: do not start it
	since   time.Time
	hubErr  error // the last check's error (nil: the hub answered)
	selfSHA string
	wake    chan struct{}
	check   chan struct{}
	pairing pairing
	paired  bool // pairing was opened once this run on its own

	status, restart *systray.MenuItem
}

func newApp() *app {
	sum, _ := sha256File(trayExe)
	return &app{selfSHA: sum, wake: make(chan struct{}, 1), check: make(chan struct{}, 1)}
}

// kick restarts the pusher now and runs an update check (after pairing, or from the menu).
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
	systray.SetTitle("Codex Hub")
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
	pairItem := systray.AddMenuItem("Connect this PC", "Get the hub's token from its pairing page")
	a.restart = systray.AddMenuItem("Restart the pusher", "")
	logs := systray.AddMenuItem("Show the log", "")
	systray.AddSeparator()
	quit := systray.AddMenuItem("Quit", "Stops pushing until Windows starts again")

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
				systray.Quit()
			}
		}
	}()
	current = a
	go a.supervise()
	go a.updates()
}

var current *app

func onExit() {
	if current != nil {
		current.stopPusher(true)
	}
}

// show sets the icon and the status line; the tooltip carries the same text.
func (a *app) show(c rgb, text string) {
	systray.SetIcon(icon(c))
	systray.SetTooltip("Codex Hub: " + text)
	a.status.SetTitle(text)
}

// refresh shows what is true now: no token, a refused token, the hub out of reach, or pushing.
func (a *app) refresh() {
	cfg := loadConfig()
	a.mu.Lock()
	running, hubErr := a.cmd != nil, a.hubErr
	a.mu.Unlock()
	switch {
	case cfg.Token == "":
		a.show(amber, "Not connected: choose Connect this PC")
	case errors.Is(hubErr, errToken):
		a.show(amber, "The hub refused the token: choose Connect this PC")
	case !running:
		a.show(amber, "The pusher is not running; restarting it")
	case hubErr != nil:
		a.show(grey, "The hub is out of reach (away from home?)")
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
			if !a.paired {
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
	out, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(pusherExe)
	cmd.Dir = appDir
	cmd.Env = append(os.Environ(),
		"AGENTHYDRA_CODEX_HUB_URL="+cfg.Hub,
		"AGENTHYDRA_CODEX_HUB_TOKEN="+cfg.Token,
		// The tray keeps the pusher's build current.
		"AGENTHYDRA_CODEX_HUB_UPDATE=off",
	)
	cmd.Stdout, cmd.Stderr = out, out
	cmd.SysProcAttr = hiddenAttr()
	if err := cmd.Start(); err != nil {
		out.Close()
		return nil, err
	}
	out.Close() // the child has its own handle
	joinJob(cmd.Process)
	a.cmd, a.since = cmd, time.Now()
	return cmd, nil
}

// stopPusher ends the running pusher and waits until its file is free; hold keeps it stopped until release.
func (a *app) stopPusher(hold bool) {
	a.mu.Lock()
	if hold {
		a.hold = true
	}
	if a.cmd != nil && a.cmd.Process != nil {
		a.cmd.Process.Kill()
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

func (a *app) updateOnce() {
	cfg := loadConfig()
	if cfg.Token == "" {
		return
	}
	rel, err := latest(cfg, "pusher")
	a.mu.Lock()
	a.hubErr = err
	a.mu.Unlock()
	a.refresh()
	if err != nil {
		log.Println("update: pusher:", err)
		return
	}
	if rel != nil {
		if have, _ := sha256File(pusherExe); have != rel.SHA256 {
			if err := a.swapPusher(cfg, rel); err != nil {
				log.Println("update: pusher:", err)
			} else {
				log.Println("update: pusher now", short(rel.SHA256))
			}
		}
	}
	rel, err = latest(cfg, "tray")
	if err != nil || rel == nil || rel.SHA256 == a.selfSHA {
		if err != nil {
			log.Println("update: tray:", err)
		}
		return
	}
	next, err := download(cfg, "tray", rel, trayExe)
	if err != nil {
		log.Println("update: tray:", err)
		return
	}
	// A running exe can be renamed but not overwritten: this one moves to .old (the new build removes it), the new
	// one takes its name and starts, waiting on the mutex until this one has exited.
	os.Remove(trayExe + ".old")
	if err := os.Rename(trayExe, trayExe+".old"); err != nil {
		log.Println("update: tray:", err)
		os.Remove(next)
		return
	}
	if err := os.Rename(next, trayExe); err != nil {
		os.Rename(trayExe+".old", trayExe)
		log.Println("update: tray:", err)
		return
	}
	if err := startDetached(trayExe); err != nil {
		log.Println("update: tray: start:", err)
		return
	}
	log.Println("update: tray now", short(rel.SHA256))
	systray.Quit()
}

func (a *app) swapPusher(cfg config, rel *release) error {
	next, err := download(cfg, "pusher", rel, pusherExe)
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

// runVersion starts a build with --version, giving the antivirus time for a new exe's first scan.
func runVersion(exe string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, "--version")
	cmd.SysProcAttr = hiddenAttr()
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("%s --version: %w", filepath.Base(exe), err)
	}
	return string(out), nil
}
