package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"
)

type config struct {
	Hub   string `json:"hub,omitempty"`
	Token string `json:"token,omitempty"`
}

func loadConfig() config {
	var c config
	if b, err := os.ReadFile(configPath); err == nil {
		_ = json.Unmarshal(b, &c)
	}
	if c.Hub == "" {
		c.Hub = hubURL
	}
	// A PC set up by the earlier script (install-codex-hub.ps1) has the token in its user environment.
	if c.Token == "" {
		c.Token = strings.TrimSpace(os.Getenv("AGENTHYDRA_CODEX_HUB_TOKEN"))
	}
	c.Hub = strings.TrimRight(c.Hub, "/")
	return c
}

func saveConfig(c config) error {
	b, _ := json.MarshalIndent(c, "", "  ")
	return os.WriteFile(configPath, b, 0o600)
}

// errToken: the hub refused the token (a new one on the hub, or none here).
var errToken = errors.New("the hub refused the token")

type release struct {
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

var client = &http.Client{Timeout: 30 * time.Second}

// platform names this system the way the hub names its builds (Bun's targets: windows-x64, linux-x64, linux-arm64,
// darwin-x64, darwin-arm64), so each PC is handed the build that runs on it.
var platform = platformName(runtime.GOOS, runtime.GOARCH)

func platformName(goos, goarch string) string {
	if goarch == "amd64" {
		goarch = "x64"
	}
	return goos + "-" + goarch
}

// hubHeaders are the extra headers every request to the hub carries, from AGENTHYDRA_CODEX_HUB_HEADERS: a JSON object
// of header names to values, such as an access proxy's service token in front of the hub, as the pusher reads it
// (codexHubPushConfig in server/src/core/codex-hub-push.ts). The pusher gets the variable with the rest of the tray's
// environment.
func hubHeaders() map[string]string {
	raw := strings.TrimSpace(os.Getenv("AGENTHYDRA_CODEX_HUB_HEADERS"))
	if raw == "" {
		return nil
	}
	var h map[string]string
	if err := json.Unmarshal([]byte(raw), &h); err != nil {
		badHeaders.Do(func() {
			log.Println("AGENTHYDRA_CODEX_HUB_HEADERS must be a JSON object of header names to values; the tray sends none")
		})
		return nil
	}
	return h
}

var badHeaders sync.Once

// hubGet is a request for path on the hub with the extra headers and the token, which wins over a header of the same
// name, as in the pusher.
func hubGet(c config, path string) (*http.Request, error) {
	req, err := http.NewRequest("GET", c.Hub+path, nil)
	if err != nil {
		return nil, err
	}
	for k, v := range hubHeaders() {
		req.Header.Set(k, v)
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	return req, nil
}

// latest is the build the hub hands out for name ("pusher" or "tray"); nil when it hands out none.
func latest(c config, name string) (*release, error) {
	req, err := hubGet(c, "/api/codex-hub/"+name+"?platform="+platform)
	if err != nil {
		return nil, err
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	switch res.StatusCode {
	case http.StatusOK:
		var r release
		if err := json.NewDecoder(res.Body).Decode(&r); err != nil || r.SHA256 == "" {
			return nil, fmt.Errorf("the hub sent no build hash for %s", name)
		}
		return &r, nil
	case http.StatusNotFound:
		return nil, nil
	case http.StatusUnauthorized:
		return nil, errToken
	default:
		return nil, fmt.Errorf("the hub answered %d for %s", res.StatusCode, name)
	}
}

// badBuild: the hub's build fails its checks here (a program for another system, not the build the hub announced,
// or it does not start), and would fail them the same way if it were fetched again.
type badBuild struct{ error }

// exeSystem is the system a program is for, by its first bytes: windows (MZ), linux (ELF) or darwin (Mach-O, one
// architecture or universal); "" for anything else, such as a script.
func exeSystem(head []byte) string {
	switch {
	case bytes.HasPrefix(head, []byte("MZ")):
		return "windows"
	case bytes.HasPrefix(head, []byte("\x7fELF")):
		return "linux"
	case len(head) >= 4:
		switch binary.BigEndian.Uint32(head) {
		case 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe:
			return "darwin"
		}
	}
	return ""
}

// download saves the hub's build of name at dest+".new", executable, once it matches want and starts with --version.
// A program for another system (what a hub that ignores ?platform= hands out) is refused from its first bytes.
func download(c config, name string, want *release, dest string) (string, error) {
	next := dest + ".new"
	os.Remove(next)
	req, err := hubGet(c, "/api/codex-hub/"+name+"/download?platform="+platform)
	if err != nil {
		return "", err
	}
	long := &http.Client{Timeout: 15 * time.Minute}
	res, err := long.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("downloading %s: the hub answered %d", name, res.StatusCode)
	}
	body := bufio.NewReader(res.Body)
	head, _ := body.Peek(4)
	if sys := exeSystem(head); sys != "" && sys != runtime.GOOS {
		return "", badBuild{fmt.Errorf("the hub's %s build is a %s program, not one for %s", name, sys, platform)}
	}
	f, err := os.OpenFile(next, os.O_RDWR|os.O_CREATE|os.O_TRUNC, exeMode)
	if err != nil {
		return "", err
	}
	n, err := io.Copy(f, body)
	f.Close()
	if err != nil {
		os.Remove(next)
		return "", err
	}
	if sum, _ := sha256File(next); n != want.Size || sum != want.SHA256 {
		os.Remove(next)
		return "", badBuild{fmt.Errorf("the downloaded %s does not match the hub's hash", name)}
	}
	out, err := runVersion(next)
	if err != nil {
		os.Remove(next)
		return "", badBuild{fmt.Errorf("the new %s build does not start: %v", name, err)}
	}
	if first, _, _ := strings.Cut(out, "\n"); strings.TrimSpace(first) != buildBanner(name) {
		os.Remove(next)
		return "", badBuild{fmt.Errorf("the hub's %s build is another program: its --version printed %q", name, strings.TrimSpace(first))}
	}
	return next, nil
}

// buildBanner is what the build of name prints first for --version. The pusher and the tray both start, so the
// banner is what tells a tray build in the pusher's place (or the other way round) from the build it was fetched as.
func buildBanner(name string) string {
	if name == "tray" {
		return banner
	}
	return "codex-hub-push" // PUSHER_BANNER in server/src/core/codex-hub-update.ts
}

// tokenWorks asks the hub whether it takes this token.
func tokenWorks(c config) error {
	_, err := latest(c, "pusher")
	return err
}
