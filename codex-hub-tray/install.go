package main

import (
	"crypto/rand"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
)

// The install id names one install of the pusher (HUB_INSTALL_HEADER in server/src/core/codex-hub.ts), and the hub
// binds a PC's token to the one it is first used with: a token copied to another install is refused there. The tray
// sends the same id as its pusher, read from the pusher's own file, because a PC still on the legacy token can move
// only with the id the hub already has for it, the one its pusher has been pushing with. Once it has a token, tray.json
// keeps the id with it, and the tray writes it back into the pusher's file if that went with a wiped config folder.

// installHeader carries the install id on each request to the hub.
const installHeader = "x-codex-hub-install"

var installShape = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)

func validInstall(id string) bool { return installShape.MatchString(id) }

// pusherConfigDir is the pusher's config folder, found the way resolveConfigDir (server/src/config.ts) finds it, but
// without its rename of an old folder: AGENTHYDRA_HOME, else CCMANAGERUI_HOME (one that is set but empty hides the
// second, as appEnv's ?? reads them), else ~/.agenthydra if it is there, else ~/.ccmanagerui if that one is, else
// ~/.agenthydra. A relative one is the pusher's, which runs in appDir.
func pusherConfigDir() string {
	for _, name := range []string{"AGENTHYDRA_HOME", "CCMANAGERUI_HOME"} {
		v, set := os.LookupEnv(name)
		if !set {
			continue
		}
		if v = strings.TrimSpace(v); v == "" {
			break
		}
		if !filepath.IsAbs(v) {
			v = filepath.Join(appDir, v)
		}
		return v
	}
	home, _ := os.UserHomeDir()
	preferred, legacy := filepath.Join(home, ".agenthydra"), filepath.Join(home, ".ccmanagerui")
	if !exists(preferred) && exists(legacy) {
		return legacy
	}
	return preferred
}

// pusherInstallFile is where the pusher the tray runs keeps its install id (PUSHER_INSTALL_FILES.standalone in
// server/src/core/codex-hub-push.ts).
func pusherInstallFile() string { return filepath.Join(pusherConfigDir(), "codex-hub-push-install") }

var installMu sync.Mutex

// ensureInstall is the install id the tray sends and hands its pusher (AGENTHYDRA_CODEX_HUB_INSTALL):
//
//   - tray.json's, when it has one; written back into the pusher's file when that is missing or holds another;
//   - else the pusher's file's, made at 0600 if it is not there yet (an exclusive create, so a pusher making it at the
//     same time ends with the same id);
//   - else, when that file can be neither read nor made, a new id kept in tray.json alone.
func ensureInstall() string {
	installMu.Lock()
	defer installMu.Unlock()
	file := pusherInstallFile()
	if kept := savedConfig().Install; validInstall(kept) {
		if have, err := readInstall(file); err != nil || have != kept {
			if err := writePrivate(file, []byte(kept+"\n")); err != nil {
				logOnce(fmt.Sprintf("install: could not write this PC's install id into %s (%v); the tray passes it to the pusher", file, err))
			} else {
				logOnce("install: wrote this PC's install id back into " + file)
			}
		}
		return kept
	}
	id, err := pusherInstall(file)
	if err == nil {
		return id
	}
	id = newInstallID()
	if serr := updateConfig(func(c *config) { c.Install = id }); serr != nil {
		log.Println("install: could not save the install id in tray.json:", serr)
	}
	logOnce(fmt.Sprintf("the pusher's install file %s cannot be written (%v); the tray passes its id to the pusher", file, err))
	return id
}

var errNoInstall = errors.New("it holds no install id")

// readInstall is the install id in file.
func readInstall(file string) (string, error) {
	b, err := os.ReadFile(file)
	if err != nil {
		return "", err
	}
	if id := strings.TrimSpace(string(b)); validInstall(id) {
		return id, nil
	}
	return "", errNoInstall
}

// pusherInstall is the id in the pusher's file, which it makes when there is none: an exclusive create at 0600 with a
// random UUID v4, in a folder made 0700. One there already is made 0600, and one that holds no id gets a new one, as
// the pusher would give it.
func pusherInstall(file string) (string, error) {
	id, err := readInstall(file)
	switch {
	case err == nil:
		makePrivate(file)
		return id, nil
	case errors.Is(err, errNoInstall):
		id = newInstallID()
		return id, writePrivate(file, []byte(id+"\n"))
	case !errors.Is(err, fs.ErrNotExist):
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return "", err
	}
	f, err := os.OpenFile(file, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if errors.Is(err, fs.ErrExist) { // the pusher made it just now
		return readInstall(file)
	}
	if err != nil {
		return "", err
	}
	id = newInstallID()
	_, err = f.WriteString(id + "\n")
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(file)
		return "", err
	}
	return id, nil
}

// newInstallID is a random UUID v4, as the pusher makes its own (randomUUID).
func newInstallID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// makePrivate gives a file that holds a secret mode 0600; Windows has no such modes.
func makePrivate(path string) {
	if runtime.GOOS == "windows" {
		return
	}
	if st, err := os.Stat(path); err == nil && st.Mode().Perm() != 0o600 {
		os.Chmod(path, 0o600)
	}
}

// writePrivate replaces path with data at mode 0600, all at once: through path.tmp, made 0600 even when one was left
// with another mode, then renamed over path.
func writePrivate(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	err := os.WriteFile(tmp, data, 0o600)
	if err == nil {
		err = os.Chmod(tmp, 0o600)
	}
	if err == nil {
		err = os.Rename(tmp, path)
	}
	if err != nil {
		os.Remove(tmp)
	}
	return err
}

// openPrivate opens a log for appending at mode 0600, as the tray's and the pusher's logs are kept (a PC without a
// desktop writes its pairing link to the tray's): created so, and made so when it was there already.
func openPrivate(path string) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	makePrivate(path)
	return f, nil
}

var logged sync.Map

// logOnce logs text the first time this run says it.
func logOnce(text string) {
	if _, said := logged.LoadOrStore(text, true); !said {
		log.Println(text)
	}
}
