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

// tray.json, at mode 0600 and replaced all at once (writePrivate): the hub the user set, if any, and this PC's token.
// pc and id are what the hub has the token under (from redeem, exchange or whoami), install is the install id bound to
// it (install.go), and next is a token the tray asked the hub to take and is not sure it has yet (settleNext). A token
// that is not a PC token is the legacy token, from a tray paired before PCs had tokens of their own.
type config struct {
	Hub     string `json:"hub,omitempty"`
	Token   string `json:"token,omitempty"`
	PC      string `json:"pc,omitempty"`
	ID      string `json:"id,omitempty"`
	Install string `json:"install,omitempty"`
	Next    string `json:"next,omitempty"`
	// The names a pairing link said this PC is renamed from and pairs as (5.3), saved with next by that link's redeem:
	// a check that finds the hub has next under the second's key retires the first's token, as the page's answer would
	// have (settleNext). They go with next.
	RenameFrom string `json:"renameFrom,omitempty"`
	RenameTo   string `json:"renameTo,omitempty"`
}

// pusherConfig is what the pusher is started with (startPusher): a change of any of these restarts it, and a change
// of nothing else does (a new next or id is no change to it).
type pusherConfig struct{ Hub, Token, PC, Install string }

func (c config) pusher() pusherConfig { return pusherConfig{c.Hub, c.Token, c.PC, c.Install} }

// savedConfig is what the user set in tray.json, without what loadConfig fills in. A hub that is this build's own
// or an earlier build's (isBuildHub) is no choice of theirs: a build before this one saved it with the token when it
// paired.
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

// isBuildHub: hub is this build's (-X main.hubURL) or one that earlier builds were made with (-X main.oldHubURLs),
// which a build that moved the hub names so that a PC paired by one of them takes the new hub at once.
func isBuildHub(hub string) bool {
	hub = strings.TrimRight(hub, "/")
	if hub == "" {
		return false
	}
	for _, h := range append(strings.Split(oldHubURLs, ","), hubURL) {
		if strings.TrimRight(strings.TrimSpace(h), "/") == hub {
			return true
		}
	}
	return false
}

// loadConfig is the config the tray works with: tray.json's, with the build's hub when the user set none, and the
// install id the tray sends (ensureInstall).
func loadConfig() config {
	c := savedConfig()
	if c.Hub == "" {
		c.Hub = hubURL
	}
	// A PC that ran the pusher before the tray may have the token in its user environment.
	if c.Token == "" {
		c.Token = strings.TrimSpace(os.Getenv("AGENTHYDRA_CODEX_HUB_TOKEN"))
	}
	c.Hub = strings.TrimRight(c.Hub, "/")
	c.Install = ensureInstall()
	return c
}

// saveConfig writes c to tray.json, leaving out a hub that is this build's own: only a hub the user set there is
// kept over the one a later build names.
func saveConfig(c config) error {
	if isBuildHub(c.Hub) {
		c.Hub = ""
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	return writePrivate(configPath, b)
}

var configMu sync.Mutex

// updateConfig changes tray.json as change says, under the one lock every change takes (pairing, the checks and the
// install id run on goroutines of their own), and writes it only when something changed.
func updateConfig(change func(*config)) error {
	configMu.Lock()
	defer configMu.Unlock()
	before := savedConfig()
	after := before
	change(&after)
	if after == before {
		return nil
	}
	return saveConfig(after)
}

// unpinBuildHub takes a build's hub (isBuildHub) out of a tray.json that an earlier build saved it in, so that the hub
// a build names, this one or a later one, is the one this PC uses.
func unpinBuildHub() error {
	var c config
	b, err := os.ReadFile(configPath)
	if err != nil || json.Unmarshal(b, &c) != nil || !isBuildHub(c.Hub) {
		return nil
	}
	return saveConfig(c)
}

// keepInstall, at start: writes the install id back into the pusher's file if that went (ensureInstall), and keeps it
// in tray.json with a PC token that has none there, such as one written in by hand.
func keepInstall() {
	install := ensureInstall()
	if err := updateConfig(func(c *config) {
		if isPcToken(c.Token) && !validInstall(c.Install) {
			c.Install = install
		}
	}); err != nil {
		log.Println("config:", err)
	}
}

var (
	// errToken: the hub refused the token (a 401: one it does not know, or none here).
	errToken = errors.New("the hub refused the token")
	// errRevoked: the hub revoked this PC's token (401 revoked), which is one way of refusing it.
	errRevoked = fmt.Errorf("%w: it revoked this PC", errToken)
	// errInstall: the token is bound to another install of the pusher (409 install-mismatch).
	errInstall = errors.New("the hub has this token for another install")
)

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
// hash, checked against the public keys this tray was built with (-X main.updateKey: base64 of each key's 32 bytes,
// as scripts/codex-hub-sign.ts prints it, comma-separated); server/src/core/codex-hub-signature.ts says what is
// signed. A tray built without a key takes builds only from an https hub.
//
// More than one key is for moving to a new one: a build that trusts the old key and the new one, signed with the
// old, reaches every PC, and the builds after it can be signed with the new key alone (docs/CODEX-HUB.md).
var (
	errNoKey  = errors.New("this build has no update key (-X main.updateKey), so it takes no builds from a hub that is not https")
	errBadKey = errors.New("this build's update key (-X main.updateKey) is not a public key, or a comma-separated list of them (base64 of 32 bytes each), so it takes no builds")
)

// buildKeys are the keys this build takes a build signed with; none without a key. One entry in the list that is not
// a key makes the whole list errBadKey: a key left out by mistake must not leave the PC trusting fewer than meant.
func buildKeys() ([]ed25519.PublicKey, error) {
	if updateKey == "" {
		return nil, nil
	}
	var keys []ed25519.PublicKey
	for _, text := range strings.Split(updateKey, ",") {
		raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(text))
		if err != nil || len(raw) != ed25519.PublicKeySize {
			return nil, errBadKey
		}
		keys = append(keys, ed25519.PublicKey(raw))
	}
	return keys, nil
}

// updatesAllowed is why this build takes no builds from hub (errNoKey, errBadKey), or nil.
func updatesAllowed(hub string) error {
	keys, err := buildKeys()
	if err != nil {
		return err
	}
	if keys == nil && !overHTTPS(hub) {
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
// signature for name on this platform over its hash, with one of this build's keys, which the download must then
// match.
func checkSigned(c config, name string, rel *release) error {
	if err := updatesAllowed(c.Hub); err != nil {
		return err
	}
	keys, _ := buildKeys()
	if keys == nil {
		return nil
	}
	if rel.Signature == "" {
		return badBuild{fmt.Errorf("the hub's %s build is not signed", name)}
	}
	if sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(rel.Signature)); err == nil {
		for _, key := range keys {
			if ed25519.Verify(key, buildSignedText(name, platform, rel.SHA256), sig) {
				return nil
			}
		}
	}
	return badBuild{fmt.Errorf("the hub's %s build is not signed with this build's update key for %s", name, platform)}
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

// hubRequest is a request to the hub with the extra headers, then the token as the bearer, which wins over a header
// of the same name as in the pusher, and the install id; with no token (redeem) it carries no bearer. A body is sent
// as JSON.
func hubRequest(c config, method, path string, body any) (*http.Request, error) {
	var payload io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		payload = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.Hub+path, payload)
	if err != nil {
		return nil, err
	}
	for k, v := range hubHeaders() {
		req.Header.Set(k, v)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	if c.Install != "" {
		req.Header.Set(installHeader, c.Install)
	}
	return req, nil
}

// hubAnswer is what the hub answered: its status and body, and for a refusal the code and the text of its error body
// ({ error, code }, server/src/routes/codex-hub.ts).
type hubAnswer struct {
	status     int
	code, text string
	body       []byte
}

// ask sends req and reads the answer; the error is for a hub that did not answer.
func ask(cl *http.Client, req *http.Request) (hubAnswer, error) {
	res, err := cl.Do(req)
	if err != nil {
		return hubAnswer{}, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return hubAnswer{}, err
	}
	a := hubAnswer{status: res.StatusCode, body: body}
	if a.status >= 300 {
		var e struct{ Error, Code string }
		if json.Unmarshal(body, &e) == nil {
			a.code, a.text = e.Code, e.Error
		}
	}
	return a, nil
}

// refusal is what an answer other than 200 means here: errRevoked or errToken for a 401, errInstall for a token of
// another install, else the status and the hub's own words.
func (a hubAnswer) refusal(what string) error {
	switch {
	case a.status == http.StatusUnauthorized && a.code == "revoked":
		return errRevoked
	case a.status == http.StatusUnauthorized:
		return errToken
	case a.status == http.StatusConflict && a.code == "install-mismatch":
		return errInstall
	case a.text != "":
		return fmt.Errorf("the hub answered %d for %s: %s", a.status, what, a.text)
	}
	return fmt.Errorf("the hub answered %d for %s", a.status, what)
}

// latest is the build the hub hands out for name ("pusher" or "tray"); nil when it hands out none.
func latest(c config, name string) (*release, error) {
	req, err := hubRequest(c, "GET", "/api/codex-hub/"+name+"?platform="+platform, nil)
	if err != nil {
		return nil, err
	}
	a, err := ask(client, req)
	if err != nil {
		return nil, err
	}
	switch a.status {
	case http.StatusOK:
		var r release
		if err := json.Unmarshal(a.body, &r); err != nil || r.SHA256 == "" {
			return nil, fmt.Errorf("the hub sent no build hash for %s", name)
		}
		return &r, nil
	case http.StatusNotFound:
		return nil, nil
	}
	return nil, a.refusal(name)
}

// pcAnswer is how the hub names the PC a token is for: redeem, exchange and whoami answer it, retire with its state.
type pcAnswer struct {
	PC      string `json:"pc"`
	Key     string `json:"key"`
	ID      string `json:"id"`
	Install string `json:"install,omitempty"`
	State   string `json:"state,omitempty"`
}

// errUnreadable: the hub answered 200 with a body that does not name the token sent, which says nothing sure.
var errUnreadable = errors.New("the hub's answer does not name this token")

// askPC sends a request about a token and reads the PC it names; the error is for no answer, or one it cannot read.
// For a 200 that names a token, id is the one it must name.
func askPC(c config, method, path string, body any, id string) (pcAnswer, hubAnswer, error) {
	var out pcAnswer
	req, err := hubRequest(c, method, path, body)
	if err != nil {
		return out, hubAnswer{}, err
	}
	a, err := ask(client, req)
	if err == nil && a.status == http.StatusOK {
		if json.Unmarshal(a.body, &out) != nil || out.PC == "" || (id != "" && out.ID != id) {
			err = errUnreadable
		}
	}
	return out, a, err
}

// whoami is what the hub has c's token under (GET /api/codex-hub/whoami).
func whoami(c config) (pcAnswer, hubAnswer, error) {
	return askPC(c, "GET", "/api/codex-hub/whoami", nil, pcTokenID(c.Token))
}

// redeemTries and redeemGap: a redeem the hub did not answer is sent again, the same, twice, 2 seconds apart.
var (
	redeemTries = 3
	redeemGap   = 2 * time.Second
)

// redeem takes a pairing code to the hub with the id and hash of the token the tray made for it (POST
// /api/codex-hub/redeem; no bearer, as the code is the credential). The hub answers a repeat the same way, so a
// request it may have taken is sent again.
func redeem(c config, code, id, hash string) (pcAnswer, hubAnswer, error) {
	c.Token = ""
	body := map[string]string{"code": code, "id": id, "hash": hash}
	for try := 1; ; try++ {
		who, a, err := askPC(c, "POST", "/api/codex-hub/redeem", body, id)
		if err == nil || errors.Is(err, errUnreadable) || try == redeemTries {
			return who, a, err
		}
		log.Printf("pair: the hub did not answer the redeem (%v); trying again", err)
		time.Sleep(redeemGap)
	}
}

// exchangeToken trades the legacy token in c for the token whose id and hash these are (POST
// /api/codex-hub/exchange), once; the hub answers a repeat the same way.
func exchangeToken(c config, id, hash string) (pcAnswer, hubAnswer, error) {
	return askPC(c, "POST", "/api/codex-hub/exchange", map[string]string{"id": id, "hash": hash}, id)
}

// retire has the hub revoke c's own token, after this PC was paired under the name renamedTo (POST
// /api/codex-hub/retire).
func retire(c config, renamedTo string) (pcAnswer, hubAnswer, error) {
	return askPC(c, "POST", "/api/codex-hub/retire", map[string]string{"renamedTo": renamedTo}, "")
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
	req, err := hubRequest(c, "GET", "/api/codex-hub/"+name+"/download?platform="+platform, nil)
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

// tokenWorks asks the hub whether it takes this token, as a hub from before PC tokens hands one out (pair.go).
func tokenWorks(c config) error {
	_, err := latest(c, "pusher")
	return err
}
