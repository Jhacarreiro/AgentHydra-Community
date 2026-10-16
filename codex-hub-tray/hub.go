package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var configPath = filepath.Join(appDir, "tray.json")

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

// latest is the build the hub hands out for name ("pusher" or "tray"); nil when it hands out none.
func latest(c config, name string) (*release, error) {
	req, _ := http.NewRequest("GET", c.Hub+"/api/codex-hub/"+name, nil)
	req.Header.Set("Authorization", "Bearer "+c.Token)
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

// download saves the hub's build of name at dest+".new" once it matches want and starts with --version.
func download(c config, name string, want *release, dest string) (string, error) {
	next := dest + ".new"
	os.Remove(next)
	req, _ := http.NewRequest("GET", c.Hub+"/api/codex-hub/"+name+"/download", nil)
	req.Header.Set("Authorization", "Bearer "+c.Token)
	long := &http.Client{Timeout: 15 * time.Minute}
	res, err := long.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("downloading %s: the hub answered %d", name, res.StatusCode)
	}
	f, err := os.Create(next)
	if err != nil {
		return "", err
	}
	n, err := io.Copy(f, res.Body)
	f.Close()
	if err != nil {
		os.Remove(next)
		return "", err
	}
	if sum, _ := sha256File(next); n != want.Size || sum != want.SHA256 {
		os.Remove(next)
		return "", fmt.Errorf("the downloaded %s does not match the hub's hash", name)
	}
	if out, err := runVersion(next); err != nil || !strings.HasPrefix(strings.TrimSpace(out), "codex-hub-") {
		os.Remove(next)
		return "", fmt.Errorf("the new %s build does not start: %v", name, err)
	}
	return next, nil
}

// tokenWorks asks the hub whether it takes this token.
func tokenWorks(c config) error {
	_, err := latest(c, "pusher")
	return err
}
