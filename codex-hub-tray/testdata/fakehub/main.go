// Command fakehub stands in for the hub in test-linux.sh and test-macos.sh, and in the tray's TestContract. It hands
// out the builds in a folder the way the hub does, behind each PC's own token, or behind the legacy token while a PC
// is pending, and answers the routes a tray calls to get and check a token of its own: redeem, exchange, whoami and
// retire, with the hub's refusals for those routes ({ error, code } and its status, server/src/routes/codex-hub.ts).
// Pushes, the relay and the pairing page are not here: the tests' pusher is a script.
//
// GET /api/codex-hub/{pusher,tray}[?platform=P] answers {"sha256","size"}, with "signature" from the build's .sig
// when there is one (testdata/signbuild writes it), and .../download the file. No platform means windows-x64; an
// empty or unknown one is a 400; a platform with no build, a 404. Files are read on each request, so a test can put
// a new build in place while the tray runs. With -header, a request to /api/codex-hub/ without that header gets a 403
// first, as from an access proxy in front of the hub.
//
// What the hub's page and its command line do, a test does with controls outside /api/codex-hub/, each answering the
// one value it makes as text:
//
//	POST /fake/pair-code?pc=NAME            a pairing code for NAME, as the page puts it in its form
//	POST /fake/add?pc=NAME[&install=ID]     a token for NAME, as scripts/codex-hub-pcs.ts add makes one (bound to ID)
//	POST /fake/pending?pc=NAME&install=ID   NAME pushes with the legacy token, from install ID, and may move (409 for
//	                                        an ID a PC here has, which the hub's rule claims)
//	POST /fake/revoke?pc=NAME               NAME revoked, a pending one included
//	GET  /fake/state                        {"pcs": [...], "pending": [...]}
//
// The legacy token's window is open while -legacy is given. Each request is logged to stdout with the bearer it carried
// (none, admin, legacy, chp_<id> or other) and its install id (- for none).
//
//	fakehub -dir builds -addr-file hub.addr [-admin A] [-legacy L] [-pending key=install,...] [-header "Name: value"]
package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
)

var platforms = map[string]bool{
	"windows-x64": true, "linux-x64": true, "linux-arm64": true, "darwin-x64": true, "darwin-arm64": true,
}

// file is the name a build has in the hub's .pusher folder: codex-hub-push.exe and codex-hub-tray.exe for
// windows-x64, codex-hub-push-P and codex-hub-tray-P for the others.
func file(name, platform string) string {
	base := map[string]string{"pusher": "codex-hub-push", "tray": "codex-hub-tray"}[name]
	if platform == "windows-x64" {
		return base + ".exe"
	}
	return base + "-" + platform
}

var (
	pcToken  = regexp.MustCompile(`^chp_([0-9a-f]{16})_[0-9a-f]{64}$`)
	hex16    = regexp.MustCompile(`^[0-9a-f]{16}$`)
	hex64    = regexp.MustCompile(`^[0-9a-f]{64}$`)
	install  = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)
	notInKey = regexp.MustCompile(`[^a-z0-9_-]+`)
)

// key is the hub's key for a name (hubPcKey), for the names the tests use.
func key(pc string) string {
	k := strings.Trim(notInKey.ReplaceAllString(strings.ToLower(strings.TrimSpace(pc)), "-"), "-")
	if len(k) > 63 {
		k = k[:63]
	}
	return k
}

func sha(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// record is a PC's entry on the hub: its token's id and hash, the install bound to it ("" until its first use), and
// how it was paired.
type record struct {
	PC      string `json:"pc"`
	Key     string `json:"key"`
	ID      string `json:"id,omitempty"`
	Hash    string `json:"-"`
	Install string `json:"install,omitempty"`
	By      string `json:"by"`
	Revoked bool   `json:"revoked,omitempty"`
}

type redemption struct{ id, hash, install string }

// code is a pairing code the page handed out: for which name, and the credential it may replace then ("" for none,
// "legacy" for a pending key, else a token id).
type code struct {
	pc, key, replaces string
	redeemed          *redemption
}

type hub struct {
	mu            sync.Mutex
	dir           string
	admin, legacy string
	pcs           map[string]*record // by key
	pending       map[string]string  // key -> install
	codes         map[string]*code
}

// credential is what key acts with now, as a code made for it records it.
func (h *hub) credential(k string) string {
	if r := h.pcs[k]; r != nil && !r.Revoked && r.ID != "" {
		return r.ID
	}
	if _, ok := h.pending[k]; ok {
		return "legacy"
	}
	return ""
}

func (h *hub) idInUse(id string) bool {
	for _, r := range h.pcs {
		if r.ID == id {
			return true
		}
	}
	return false
}

func (h *hub) byToken(token string) *record {
	m := pcToken.FindStringSubmatch(token)
	if m == nil {
		return nil
	}
	for _, r := range h.pcs {
		if r.ID == m[1] && subtle.ConstantTimeCompare([]byte(r.Hash), []byte(sha(token))) == 1 {
			return r
		}
	}
	return nil
}

func bearerOf(r *http.Request) string {
	b, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok {
		return ""
	}
	return strings.TrimSpace(b)
}

// bearerName names a request's bearer for the log, never with its secret.
func (h *hub) bearerName(r *http.Request) string {
	b := bearerOf(r)
	switch {
	case b == "":
		return "none"
	case h.admin != "" && b == h.admin:
		return "admin"
	case h.legacy != "" && b == h.legacy:
		return "legacy"
	case pcToken.MatchString(b):
		return "chp_" + pcToken.FindStringSubmatch(b)[1]
	}
	return "other"
}

type refusal struct {
	status   int
	code, at string
}

func (f *refusal) send(w http.ResponseWriter) int {
	return answer(w, f.status, map[string]string{"error": f.at, "code": f.code})
}

func refuse(status int, code, text string) *refusal { return &refusal{status, code, text} }

func answer(w http.ResponseWriter, status int, body any) int {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
	return status
}

// caller is the PC whose token r carries, or legacy for the legacy token, as the hub's hubCaller works it out.
func (h *hub) caller(r *http.Request, installRequired bool) (pc *record, legacy bool, no *refusal) {
	b := bearerOf(r)
	id := r.Header.Get("x-codex-hub-install")
	if !install.MatchString(id) {
		id = ""
	}
	switch {
	case b == "":
		return nil, false, refuse(401, "unauthorized", "unauthorized")
	case pcToken.MatchString(b):
		rec := h.byToken(b)
		switch {
		case rec == nil:
			return nil, false, refuse(401, "unknown-token", "unknown-token")
		case rec.Revoked:
			return nil, false, refuse(401, "revoked", "revoked")
		case id == "" && installRequired:
			return nil, false, refuse(400, "install-required", "a PC token is sent with this PC's install id")
		case rec.Install != "" && id != "" && rec.Install != id:
			return nil, false, refuse(409, "install-mismatch", "this token belongs to another install")
		}
		if rec.Install == "" && id != "" {
			rec.Install = id
		}
		return rec, false, nil
	case h.legacy != "" && b == h.legacy:
		return nil, true, nil
	}
	return nil, false, refuse(401, "unauthorized", "unauthorized")
}

func main() {
	dir := flag.String("dir", ".", "folder with the builds")
	admin := flag.String("admin", "", "the admin token, which every route here refuses")
	legacy := flag.String("legacy", "", "the legacy token; the migration window is open while it is set")
	pending := flag.String("pending", "", "pending keys and their install ids: key=install,...")
	addrFile := flag.String("addr-file", "", "where to write the hub's address")
	header := flag.String("header", "", `a header every request to /api/codex-hub/ must carry ("Name: value")`)
	flag.Parse()
	h := &hub{dir: *dir, admin: *admin, legacy: *legacy, pcs: map[string]*record{}, pending: map[string]string{},
		codes: map[string]*code{}}
	for _, p := range strings.Split(*pending, ",") {
		if k, id, ok := strings.Cut(strings.TrimSpace(p), "="); ok {
			h.pending[k] = id
		}
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	addr := "http://" + ln.Addr().String()
	if *addrFile != "" {
		os.WriteFile(*addrFile, []byte(addr+"\n"), 0o644)
	}
	fmt.Println("fakehub: listening on", addr)
	http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.mu.Lock()
		defer h.mu.Unlock()
		who := h.bearerName(r)
		status := h.serve(w, r, *header)
		plat := ""
		if strings.HasPrefix(r.URL.Path, "/api/codex-hub/pusher") || strings.HasPrefix(r.URL.Path, "/api/codex-hub/tray") {
			plat = " platform=" + r.URL.Query().Get("platform")
		}
		id := r.Header.Get("x-codex-hub-install")
		if id == "" {
			id = "-"
		}
		fmt.Printf("fakehub: bearer=%s install=%s %s %s%s %d\n", who, id, r.Method, r.URL.Path, plat, status)
	}))
}

func (h *hub) serve(w http.ResponseWriter, r *http.Request, header string) int {
	if strings.HasPrefix(r.URL.Path, "/fake/") {
		return h.control(w, r)
	}
	if name, value, ok := strings.Cut(header, ":"); ok && r.Header.Get(strings.TrimSpace(name)) != strings.TrimSpace(value) {
		return refuse(http.StatusForbidden, "forbidden", "the access proxy wants its header").send(w)
	}
	route := r.Method + " " + strings.TrimPrefix(r.URL.Path, "/api/codex-hub/")
	switch route {
	case "GET whoami":
		return h.whoami(w, r)
	case "POST redeem":
		return h.redeem(w, r)
	case "POST exchange":
		return h.exchange(w, r)
	case "POST retire":
		return h.retire(w, r)
	case "GET pusher", "GET tray", "GET pusher/download", "GET tray/download":
		return h.build(w, r)
	}
	return refuse(http.StatusNotFound, "not-found", "not found").send(w)
}

// body reads a JSON object of strings; nil for anything else.
func body(r *http.Request) map[string]any {
	var m map[string]any
	if json.NewDecoder(r.Body).Decode(&m) != nil {
		return nil
	}
	return m
}

func text(m map[string]any, k string) string {
	s, _ := m[k].(string)
	return s
}

func (h *hub) build(w http.ResponseWriter, r *http.Request) int {
	_, legacy, no := h.caller(r, false)
	if no != nil {
		return no.send(w)
	}
	if legacy && len(h.pending) == 0 {
		return refuse(401, "unauthorized", "unauthorized").send(w)
	}
	name, download := strings.CutSuffix(strings.TrimPrefix(r.URL.Path, "/api/codex-hub/"), "/download")
	q := r.URL.Query()
	platform := q.Get("platform")
	if _, named := q["platform"]; !named { // the trays and pushers from before there were other builds
		platform = "windows-x64"
	}
	if !platforms[platform] {
		return refuse(http.StatusBadRequest, "bad-request", fmt.Sprintf("unknown platform %q", platform)).send(w)
	}
	b, err := os.ReadFile(filepath.Join(h.dir, file(name, platform)))
	if err != nil {
		return refuse(http.StatusNotFound, "not-found", "no "+name+" build for "+platform).send(w)
	}
	if download {
		w.Header().Set("content-type", "application/octet-stream")
		w.Write(b)
		return http.StatusOK
	}
	release := map[string]any{"sha256": sha(string(b)), "size": len(b)}
	if sig, err := os.ReadFile(filepath.Join(h.dir, file(name, platform)+".sig")); err == nil && len(bytes.TrimSpace(sig)) > 0 {
		release["signature"] = string(bytes.TrimSpace(sig))
	}
	return answer(w, http.StatusOK, release)
}

func (h *hub) whoami(w http.ResponseWriter, r *http.Request) int {
	pc, legacy, no := h.caller(r, false)
	if no != nil {
		return no.send(w)
	}
	if legacy {
		return refuse(401, "unauthorized", "unauthorized").send(w)
	}
	return answer(w, http.StatusOK, map[string]string{"pc": pc.PC, "key": pc.Key, "id": pc.ID, "install": pc.Install})
}

func (h *hub) redeem(w http.ResponseWriter, r *http.Request) int {
	m := body(r)
	c, id, hash := text(m, "code"), text(m, "id"), text(m, "hash")
	if !hex64.MatchString(c) || !hex16.MatchString(id) || !hex64.MatchString(hash) {
		return refuse(400, "bad-request", "code must be 64 hex, id 16 hex and hash 64 hex").send(w)
	}
	by := r.Header.Get("x-codex-hub-install")
	if !install.MatchString(by) {
		return refuse(400, "install-required", "a redeem is sent with this PC's install id").send(w)
	}
	entry := h.codes[sha(c)]
	if entry == nil {
		return refuse(401, "pair-code", "this pairing code is unknown, expired or used").send(w)
	}
	if done := entry.redeemed; done != nil {
		if rec := h.pcs[entry.key]; *done == (redemption{id, hash, by}) && rec != nil && rec.ID == id && !rec.Revoked {
			return answer(w, http.StatusOK, map[string]string{"pc": entry.pc, "key": entry.key, "id": id})
		}
		return refuse(401, "pair-code", "this pairing code is unknown, expired or used").send(w)
	}
	if h.credential(entry.key) != entry.replaces {
		delete(h.codes, sha(c))
		return refuse(409, "name-changed", entry.pc+" changed on the hub since the page opened").send(w)
	}
	if h.idInUse(id) {
		return refuse(409, "id-taken", "that token id is in use").send(w)
	}
	h.pcs[entry.key] = &record{PC: entry.pc, Key: entry.key, ID: id, Hash: hash, Install: by, By: "page"}
	delete(h.pending, entry.key)
	entry.redeemed = &redemption{id, hash, by}
	return answer(w, http.StatusOK, map[string]string{"pc": entry.pc, "key": entry.key, "id": id})
}

func (h *hub) exchange(w http.ResponseWriter, r *http.Request) int {
	if h.legacy == "" || bearerOf(r) != h.legacy {
		return refuse(401, "unauthorized", "unauthorized").send(w)
	}
	by := r.Header.Get("x-codex-hub-install")
	if !install.MatchString(by) {
		return refuse(400, "install-required", "an exchange is sent with this PC's install id").send(w)
	}
	m := body(r)
	id, hash := text(m, "id"), text(m, "hash")
	if !hex16.MatchString(id) || !hex64.MatchString(hash) {
		return refuse(400, "bad-request", "id must be 16 hex and hash 64 hex").send(w)
	}
	for _, rec := range h.pcs {
		if rec.ID == id && rec.Install == by { // a repeat after a lost answer
			if rec.Hash == hash && !rec.Revoked {
				return answer(w, http.StatusOK, map[string]string{"pc": rec.PC, "key": rec.Key, "id": id})
			}
			return refuse(401, "unauthorized", "unauthorized").send(w)
		}
	}
	k := ""
	for pk, pi := range h.pending {
		if pi == by {
			k = pk
		}
	}
	if k == "" {
		return refuse(401, "unauthorized", "unauthorized").send(w)
	}
	if h.idInUse(id) {
		return refuse(409, "id-taken", "that token id is in use").send(w)
	}
	h.pcs[k] = &record{PC: k, Key: k, ID: id, Hash: hash, Install: by, By: "exchange"}
	delete(h.pending, k)
	return answer(w, http.StatusOK, map[string]string{"pc": k, "key": k, "id": id})
}

func (h *hub) retire(w http.ResponseWriter, r *http.Request) int {
	pc, legacy, no := h.caller(r, true)
	if no != nil {
		return no.send(w)
	}
	if legacy {
		return refuse(401, "unauthorized", "unauthorized").send(w)
	}
	var m map[string]any
	if err := json.NewDecoder(r.Body).Decode(&m); err != nil && err.Error() != "EOF" {
		return refuse(400, "bad-request", "body must be JSON").send(w)
	}
	if to, sent := m["renamedTo"]; sent {
		if s, ok := to.(string); !ok || strings.TrimSpace(s) == "" || len(s) > 64 {
			return refuse(400, "bad-request", "renamedTo, when sent, is a PC name of up to 64 characters").send(w)
		}
	}
	pc.Revoked = true
	return answer(w, http.StatusOK, map[string]string{"pc": pc.PC, "key": pc.Key, "state": "revoked"})
}

// control is the test's side of the hub: what the page and the command line would do.
func (h *hub) control(w http.ResponseWriter, r *http.Request) int {
	q := r.URL.Query()
	pc := strings.TrimSpace(q.Get("pc"))
	k := key(pc)
	say := func(s string) int {
		w.Header().Set("content-type", "text/plain")
		fmt.Fprint(w, s)
		return http.StatusOK
	}
	switch r.Method + " " + r.URL.Path {
	case "GET /fake/state":
		pcs := []*record{}
		for _, rec := range h.pcs {
			pcs = append(pcs, rec)
		}
		sort.Slice(pcs, func(i, j int) bool { return pcs[i].Key < pcs[j].Key })
		pending := []string{}
		for pk := range h.pending {
			pending = append(pending, pk)
		}
		sort.Strings(pending)
		return answer(w, http.StatusOK, map[string]any{"pcs": pcs, "pending": pending})
	case "POST /fake/pair-code":
		if k == "" {
			return refuse(400, "bad-request", "pc is required").send(w)
		}
		c := random(32)
		h.codes[sha(c)] = &code{pc: pc, key: k, replaces: h.credential(k)}
		return say(c)
	case "POST /fake/add":
		if k == "" {
			return refuse(400, "bad-request", "pc is required").send(w)
		}
		id := random(8)
		token := "chp_" + id + "_" + random(32)
		h.pcs[k] = &record{PC: pc, Key: k, ID: id, Hash: sha(token), Install: q.Get("install"), By: "cli"}
		delete(h.pending, k)
		return say(token)
	case "POST /fake/pending":
		if k == "" || !install.MatchString(q.Get("install")) {
			return refuse(400, "bad-request", "pc and install are required").send(w)
		}
		// The hub's rule: an install id a record carries is claimed, and no folder with it is pending.
		for _, rec := range h.pcs {
			if rec.Install == q.Get("install") {
				return refuse(409, "install-claimed", "a PC on this hub has that install id").send(w)
			}
		}
		h.pending[k] = q.Get("install")
		return say(k)
	case "POST /fake/revoke":
		rec := h.pcs[k]
		if rec == nil {
			if _, ok := h.pending[k]; !ok {
				return refuse(404, "not-found", "no PC "+k+" on this hub").send(w)
			}
			rec = &record{PC: pc, Key: k, Install: h.pending[k], By: "cli"}
			h.pcs[k] = rec
		}
		rec.Revoked = true
		delete(h.pending, k)
		return say(k)
	}
	return refuse(http.StatusNotFound, "not-found", "not found").send(w)
}

// random is n random bytes, in hex.
func random(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}
