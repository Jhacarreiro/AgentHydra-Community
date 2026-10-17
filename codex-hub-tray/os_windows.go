package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"fyne.io/systray"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const (
	runKey    = `Software\Microsoft\Windows\CurrentVersion\Run`
	runValue  = "Codex Hub"
	mutexName = `Local\CodexHubTray`
	// The name of a scheduled task that ran the pusher on a PC set up before the tray; the tray takes its place.
	oldTask = "Codex hub push"
)

// The mode the tray gives the builds it writes (os.Create's).
const exeMode = 0o666

const quitHint = "Stops pushing until Windows starts again"

// localHostName: only a Mac has a Bonjour name to prefer (pcName).
func localHostName() string { return "" }

func osPaths() (dir, tray, pusher string) {
	dir = filepath.Join(os.Getenv("LOCALAPPDATA"), "codex-hub")
	return dir, filepath.Join(dir, "codex-hub-tray.exe"), filepath.Join(dir, "codex-hub-push.exe")
}

// startup clears what a previous run left and makes the tray start with Windows.
func startup() {
	// A pusher left by a tray that was killed, or by the earlier scheduled task.
	hidden("taskkill", "/F", "/IM", "codex-hub-push.exe")
	if k, _, err := registry.CreateKey(registry.CURRENT_USER, runKey, registry.SET_VALUE); err == nil {
		k.SetStringValue(runValue, `"`+trayExe+`"`)
		k.Close()
	}
}

func run() {
	systray.Run(onReady, onExit)
}

func quitTray() {
	systray.Quit()
}

// install copies a downloaded exe to its place, replacing a running tray and the earlier scheduled-task setup,
// and starts it there.
func install(from string) {
	first := !exists(trayExe)
	hidden("taskkill", "/F", "/IM", "codex-hub-tray.exe", "/FI", fmt.Sprintf("PID ne %d", os.Getpid()))
	hidden("taskkill", "/F", "/IM", "codex-hub-push.exe")
	hidden("schtasks", "/Delete", "/TN", oldTask, "/F")
	time.Sleep(time.Second)
	os.Remove(trayExe + ".old")
	if exists(trayExe) {
		os.Rename(trayExe, trayExe+".old")
	}
	if err := copyFile(from, trayExe); err != nil {
		fatal("Could not install to " + trayExe + ": " + err.Error())
	}
	if err := startDetached(trayExe); err != nil {
		fatal("Could not start Codex Hub: " + err.Error())
	}
	if first {
		message("Codex Hub is installed and starts with Windows. It sits in the system tray, next to the clock.\n\nIf the browser opens the hub's pairing page, choose Connect there to link this PC.")
	}
}

// replaceSelf puts the verified build at next in this one's place and starts it.
func (a *app) replaceSelf(next string, rel *release) {
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

// singleInstance makes this the only tray; a build that just replaced the previous one waits for it to exit.
func singleInstance() bool {
	name, _ := windows.UTF16PtrFromString(mutexName)
	for i := 0; i < 40; i++ {
		h, err := windows.CreateMutex(nil, false, name)
		if err == nil {
			return true
		}
		if h != 0 {
			windows.CloseHandle(h)
		}
		time.Sleep(500 * time.Millisecond)
	}
	return false
}

func samePath(a, b string) bool {
	return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
}

func message(text string) {
	t, _ := windows.UTF16PtrFromString(text)
	c, _ := windows.UTF16PtrFromString("Codex Hub")
	windows.MessageBox(0, t, c, windows.MB_OK|windows.MB_ICONINFORMATION)
}

func fatal(text string) {
	log.Println(text)
	t, _ := windows.UTF16PtrFromString(text)
	c, _ := windows.UTF16PtrFromString("Codex Hub")
	windows.MessageBox(0, t, c, windows.MB_OK|windows.MB_ICONERROR)
	os.Exit(1)
}

func openURL(u string) {
	verb, _ := windows.UTF16PtrFromString("open")
	target, _ := windows.UTF16PtrFromString(u)
	windows.ShellExecute(0, verb, target, nil, nil, windows.SW_SHOWNORMAL)
}

const createNoWindow = 0x08000000

func hiddenAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}

// hidden runs a command without a window and ignores its outcome.
func hidden(name string, args ...string) {
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = hiddenAttr()
	_ = cmd.Run()
}

func startDetached(exe string, args ...string) error {
	cmd := exec.Command(exe, args...)
	cmd.SysProcAttr = hiddenAttr()
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// The pusher runs in a job that closes with this process, so a tray that is killed or crashes takes its pusher
// with it and the next tray never finds two.
var job = func() windows.Handle {
	h, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(h, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(h)
		return 0
	}
	return h
}()

func joinJob(p *os.Process) {
	if job == 0 {
		return
	}
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(p.Pid))
	if err != nil {
		return
	}
	windows.AssignProcessToJobObject(job, h)
	windows.CloseHandle(h)
}

func pusherAttr() *syscall.SysProcAttr { return hiddenAttr() }

// adoptPusher ties a started pusher to this process; pusherGone is told when it has exited.
func adoptPusher(p *os.Process) { joinJob(p) }

func pusherGone() {}

func killPusher(p *os.Process) { p.Kill() }

// encodeIcon writes the drawn icon as a 32-bit .ico: bottom-up BGRA rows, then an all-zero AND mask (the alpha
// channel decides).
func encodeIcon(img *image.NRGBA) []byte {
	n := img.Rect.Dx()
	px := make([]byte, 0, n*n*4)
	for y := n - 1; y >= 0; y-- { // bottom-up rows
		for x := 0; x < n; x++ {
			p := img.Pix[img.PixOffset(x, y):]
			px = append(px, p[2], p[1], p[0], p[3])
		}
	}
	var bmp bytes.Buffer
	binary.Write(&bmp, binary.LittleEndian, struct {
		Size                        uint32
		Width, Height               int32
		Planes, BitCount            uint16
		Compression, ImageSize      uint32
		XPels, YPels, Used, Importa int32
	}{40, int32(n), int32(2 * n), 1, 32, 0, uint32(len(px) + n*4), 0, 0, 0, 0})
	bmp.Write(px)
	bmp.Write(make([]byte, n*4)) // AND mask, all zero: the alpha channel decides
	var ico bytes.Buffer
	binary.Write(&ico, binary.LittleEndian, []uint16{0, 1, 1})
	ico.Write([]byte{byte(n), byte(n), 0, 0})
	binary.Write(&ico, binary.LittleEndian, []uint16{1, 32})
	binary.Write(&ico, binary.LittleEndian, []uint32{uint32(bmp.Len()), 22})
	ico.Write(bmp.Bytes())
	return ico.Bytes()
}
