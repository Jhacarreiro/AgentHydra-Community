//go:build linux || darwin

package main

import (
	"bytes"
	"fmt"
	"image"
	"image/png"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"fyne.io/systray"
)

// The builds the tray writes are programs it runs.
const exeMode = 0o755

const quitHint = "Stops pushing until you log in again"

// headless: no tray to show the icon on (Linux without a desktop session); the pusher and the updates run the same.
var headless bool

// lock is the tray.lock this tray holds an flock on, kept here for the life of the process (a collected *os.File
// would close and let go of it). It also carries the tray's pid, for an install that replaces the tray.
var lock *os.File

func lockPath() string { return filepath.Join(appDir, "tray.lock") }

// pidPath names the running pusher, for the next tray when this one was killed before it could stop it.
func pidPath() string { return filepath.Join(appDir, "pusher.pid") }

// singleInstance makes this the only tray; a build that just replaced the previous one waits for it to exit.
func singleInstance() bool {
	f, err := os.OpenFile(lockPath(), os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		log.Println("lock:", err)
		return false
	}
	for i := 0; i < 40; i++ {
		if syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) == nil {
			f.Truncate(0)
			f.WriteAt([]byte(strconv.Itoa(os.Getpid())+"\n"), 0)
			lock = f
			return true
		}
		time.Sleep(500 * time.Millisecond)
	}
	f.Close()
	tell("Codex Hub is already running.")
	return false
}

// startup clears what a previous run left, and on macOS writes the LaunchAgent again (refreshAutostart).
func startup() {
	// A pusher left by a tray that was killed (on Linux the parent-death signal has usually ended it already).
	killStale(pidPath(), pusherExe)
	os.Remove(pidPath())
	if err := refreshAutostart(); err != nil {
		log.Println("autostart:", err)
	}
	log.Printf("tray: started, pid %d", os.Getpid())
}

func run() {
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP, syscall.SIGUSR1)
	go func() {
		for s := range sig {
			if s == syscall.SIGUSR1 { // check the hub's builds now
				if a := current.Load(); a != nil {
					a.nudgeCheck()
				}
				continue
			}
			log.Println("tray: stopping on", s)
			if a := current.Load(); a != nil {
				a.stopPusher(true)
			}
			os.Exit(0)
		}
	}()
	if !trayAvailable() {
		log.Println("tray: no desktop session to show an icon in; running without one")
		headless = true
		a := newApp()
		current.Store(a)
		go a.updates()
		a.supervise()
		return
	}
	systray.Run(onReady, onExit)
}

// quitTray stops the pusher and ends the tray. It stops the pusher itself because on macOS systray.Quit ends the
// process without calling onExit, and nothing else would: the pusher is in a process group of its own.
func quitTray() {
	if a := current.Load(); a != nil {
		a.stopPusher(true)
	}
	if headless {
		os.Exit(0)
	}
	systray.Quit()
}

// replaceSelf puts the verified build at next in this one's place and runs it in this process. The rename is
// atomic and leaves the running program's file alone; exec keeps the pid, so the session or launchd job that
// started the tray still has it. The lock's descriptor closes on exec (Go opens files close-on-exec), so the new
// build takes the lock at once; if exec fails, this one still holds it.
func (a *app) replaceSelf(next string, rel *release) {
	if err := os.Rename(next, trayExe); err != nil {
		log.Println("update: tray:", err)
		os.Remove(next)
		return
	}
	log.Println("update: tray now", short(rel.SHA256))
	a.stopPusher(true)
	err := syscall.Exec(trayExe, append([]string{trayExe}, os.Args[1:]...), os.Environ())
	log.Println("update: tray: restart:", err)
	// As on Windows: the new build starts and waits on the lock until this one has exited.
	if err := startDetached(trayExe); err != nil {
		log.Println("update: tray: start:", err)
		a.release() // nothing takes over: this build keeps running
		return
	}
	quitTray()
}

func samePath(a, b string) bool {
	return resolved(a) == resolved(b)
}

func resolved(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	return filepath.Clean(p)
}

// hiddenAttr: there is no console window to hide here.
func hiddenAttr() *syscall.SysProcAttr { return nil }

// startDetached starts a program in a session of its own, so it outlives this one and the terminal it ran in.
func startDetached(exe string, args ...string) error {
	cmd := exec.Command(exe, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// spawn starts a helper (a browser, a notification) without waiting for it, and reaps it when it exits.
func spawn(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}

// adoptPusher records a started pusher (pusherAttr puts it in a process group of its own); pusherGone is told when
// it has exited.
func adoptPusher(p *os.Process) {
	os.WriteFile(pidPath(), []byte(strconv.Itoa(p.Pid)+"\n"), 0o644)
}

func pusherGone() { os.Remove(pidPath()) }

// killPusher ends the pusher and whatever it started.
func killPusher(p *os.Process) {
	syscall.Kill(-p.Pid, syscall.SIGKILL)
	p.Kill()
}

// killStale ends the process a pidfile names, but only while it is still exe: the pid may have gone to another
// program since.
func killStale(pidfile, exe string) {
	b, err := os.ReadFile(pidfile)
	pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || pid <= 1 || pid == os.Getpid() || !isProcess(pid, exe) {
		return
	}
	log.Printf("killing the %s left running (pid %d)", filepath.Base(exe), pid)
	syscall.Kill(-pid, syscall.SIGKILL)
	syscall.Kill(pid, syscall.SIGKILL)
}

// stopRunningTray ends the installed tray that holds the lock, so a new copy can take its place: it stops its
// pusher on SIGTERM, and gets SIGKILL after ten seconds.
func stopRunningTray() {
	b, err := os.ReadFile(lockPath())
	pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || pid <= 1 || pid == os.Getpid() || !isProcess(pid, trayExe) {
		return
	}
	say(fmt.Sprintf("Stopping the Codex Hub that is running (pid %d)", pid))
	syscall.Kill(pid, syscall.SIGTERM)
	for i := 0; i < 50 && isProcess(pid, trayExe); i++ {
		time.Sleep(200 * time.Millisecond)
	}
	if isProcess(pid, trayExe) {
		syscall.Kill(pid, syscall.SIGKILL)
	}
}

func isTerminal(f *os.File) bool {
	st, err := f.Stat()
	return err == nil && st.Mode()&os.ModeCharDevice != 0
}

// say reports a step of the install, to whoever ran it and to the log.
func say(text string) {
	fmt.Println(text)
	log.Println(text)
}

// tell is a message for the log, also printed when a terminal ran the tray.
func tell(text string) {
	log.Println(text)
	if isTerminal(os.Stdout) {
		fmt.Println(text)
	}
}

// encodeIcon writes the drawn icon as a PNG, which the tray here decodes (an .ico would show blank).
func encodeIcon(img *image.NRGBA) []byte {
	var b bytes.Buffer
	png.Encode(&b, img)
	return b.Bytes()
}
