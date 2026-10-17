package main

import (
	"bufio"
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
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

// savedConfig is what the user set in tray.json, without what loadConfig fills in. A hub that is this build's own
// (-X main.hubURL) is no choice of theirs: a build before this one saved it with the token when it paired.
func savedConfig() config {
	var c config
	if b, err := os.ReadFile(configPath); err == nil {
		_ = json.Unmarshal(b, &c)
	}
	if isBuildHub(c.Hub) {
		c.Hub = ""
	}
	return c
}

func isBuildHub(hub string) bool {
	return hub != "" && strings.TrimRight(hub, "/") == strings.TrimRight(hubURL, "/")
}

func loadConfig() config {
	c := savedConfig()
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

// saveConfig writes c to tray.json, leaving out a hub that is this build's own: only a hub the user set there is
// kept over the one a later build names.
func saveConfig(c config) error {
	if isBuildHub(c.Hub) {
		c.Hub = ""
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	return os.WriteFile(configPath, b, 0o600)
}

// unpinBuildHub takes this build's hub out of a tray.json that an earlier build saved it in, so that once the hub
// hands out a build with another hub, that hub is the one this PC uses.
func unpinBuildHub() error {
	var c config
	b, err := os.ReadFile(configPath)
	if err != nil || json.Unmarshal(b, &c) != nil || !isBuildHub(c.Hub) {
		return nil
	}
	return saveConfig(c)
}

// errToken: the hub refused the token (a new one on the hub, or none here).
var errToken = errors.New("the hub refused the token")

type release struct {
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
	// The operator's signature (base64) when the hub has the build's .sig (checkSigned).
	Signature string `json:"signature,omitempty"`
}

// seen names the build with its signature, as the updater remembers one that failed its checks: the same build with
// a signature put in place after it is checked again.
func (r *release) seen() string { return r.SHA256 + " " + r.Signature }

var (
	client = &http.Client{Timeout: 30 * time.Second}
	// A build is 60-90 MB.
	downloadClient = &http.Client{Timeout: 15 * time.Minute}
)

// The hash the hub sends comes from the same address as the build, so over plain http anyone on the way can send
// both. A build is therefore taken only with the operator's ed25519 signature over its name, this platform and its
// hash, checked against the public key this tray was built with (-X main.updateKey: base64 of its 32 bytes, as
// scripts/codex-hub-sign.ts prints it); server/src/core/codex-hub-signature.ts says what is signed. A tray built
// without a key takes builds only from an https hub.
var (
	errNoKey  = errors.New("this build has no update key (-X main.updateKey), so it takes no builds from a hub that is not https")
	errBadKey = errors.New("this build's update key (-X main.updateKey) is not a public key (base64 of 32 bytes), so it takes no builds")
)

// buildKey is this build's update key; nil without one.
func buildKey() (ed25519.PublicKey, error) {
	if updateKey == "" {
		return nil, nil
	}
	raw, err := base64.StdEncoding.DecodeString(updateKey)
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return nil, errBadKey
	}
	return ed25519.PublicKey(raw), nil
}

// updatesAllowed is why this build takes no builds from hub (errNoKey, errBadKey), or nil.
func updatesAllowed(hub string) error {
	key, err := buildKey()
	if err != nil {
		return err
	}
	if key == nil && !overHTTPS(hub) {
		return errNoKey
	}
	return nil
}

// overHTTPS says whether the hub's answers are known to be its own: over https, and not over plain http.
func overHTTPS(hub string) bool { return strings.HasPrefix(strings.ToLower(hub), "https://") }

// buildSignedText is the text a build's signature signs (buildSignedText in server/src/core/codex-hub-signature.ts).
func buildSignedText(name, plat, sum string) []byte {
	return []byte("codex-hub-build v1\n" + name + "\n" + plat + "\n" + sum + "\n")
}

// checkSigned says whether the hub's build of name may be fetched: with a key, only when it carries the operator's
// signature for name on this platform over its hash, which the download must then match.
func checkSigned(c config, name string, rel *release) error {
	if err := updatesAllowed(c.Hub); err != nil {
		return err
	}
	key, _ := buildKey()
	if key == nil {
		return nil
	}
	if rel.Signature == "" {
		return badBuild{fmt.Errorf("the hub's %s build is not signed", name)}
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(rel.Signature))
	if err != nil || !ed25519.Verify(key, buildSignedText(name, platform, rel.SHA256), sig) {
		return badBuild{fmt.Errorf("the hub's %s build is not signed with this build's update key for %s", name, platform)}
	}
	return nil
}

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

// badBuild: the hub's build fails its checks here (it lacks the signature it needs, it is a program for another
// system, or it does not start), and would fail them the same way if it were fetched again.
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
// A build without the signature it needs is refused before it is fetched. What it does once its bytes match the
// signed hash is held against it (badBuild); a download that does not match is not, since over http someone on the
// way can send the hub's signed hash with other bytes, and neither is a --version cut off at the timeout. Over https
// the bytes are the hub's from the first, so a program for another system (what a hub that ignores ?platform= hands
// out) is refused from its first bytes, before the rest comes down.
func download(c config, name string, want *release, dest string) (string, error) {
	if err := checkSigned(c, name, want); err != nil {
		return "", err
	}
	next := dest + ".new"
	os.Remove(next)
	req, err := hubGet(c, "/api/codex-hub/"+name+"/download?platform="+platform)
	if err != nil {
		return "", err
	}
	res, err := downloadClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("downloading %s: the hub answered %d", name, res.StatusCode)
	}
	body := bufio.NewReader(res.Body)
	head, _ := body.Peek(4)
	var otherSystem error
	if sys := exeSystem(head); sys != "" && sys != runtime.GOOS {
		otherSystem = badBuild{fmt.Errorf("the hub's %s build is a %s program, not one for %s", name, sys, platform)}
	}
	if otherSystem != nil && overHTTPS(c.Hub) {
		return "", otherSystem
	}
	f, err := os.OpenFile(next, os.O_RDWR|os.O_CREATE|os.O_TRUNC, exeMode)
	if err != nil {
		return "", err
	}
	// Someone on the way can send the signed hash and then bytes without end: one past the size is enough to refuse.
	n, err := io.Copy(f, io.LimitReader(body, want.Size+1))
	f.Close()
	if err != nil {
		os.Remove(next)
		return "", err
	}
	if sum, _ := sha256File(next); n != want.Size || sum != want.SHA256 {
		os.Remove(next)
		return "", fmt.Errorf("the downloaded %s does not match the hub's hash", name)
	}
	// The signature covers want.SHA256, so from here these bytes are the signed build.
	if otherSystem != nil {
		os.Remove(next)
		return "", otherSystem
	}
	out, err := runVersion(next)
	if err != nil {
		os.Remove(next)
		err = fmt.Errorf("the new %s build does not start: %w", name, err)
		if errors.Is(err, errSlowStart) {
			return "", err
		}
		return "", badBuild{err}
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
