// Command fakehub stands in for the hub in test-linux.sh and test-macos.sh. It serves the builds in a folder the way
// the hub does, for one token: GET /api/codex-hub/{pusher,tray}[?platform=P] answers {"sha256","size"} and
// .../download the file. No platform means windows-x64; an empty or unknown one is a 400; a platform with no build,
// a 404. Files are read on each request, so a test can put a new build in place while the tray runs. Each request
// is logged to stdout.
//
//	fakehub -dir builds -token T -addr-file hub.addr
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
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

func main() {
	dir := flag.String("dir", ".", "folder with the builds")
	token := flag.String("token", "", "the hub token")
	addrFile := flag.String("addr-file", "", "where to write the hub's address")
	flag.Parse()
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
		status := serve(w, r, *dir, *token)
		fmt.Printf("fakehub: %s %s platform=%s %d\n", r.Method, r.URL.Path, r.URL.Query().Get("platform"), status)
	}))
}

func serve(w http.ResponseWriter, r *http.Request, dir, token string) int {
	fail := func(status int, msg string) int {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(map[string]string{"error": msg})
		return status
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/codex-hub/")
	name, download := strings.CutSuffix(path, "/download")
	if r.Method != http.MethodGet || (name != "pusher" && name != "tray") {
		return fail(http.StatusNotFound, "not found")
	}
	if r.Header.Get("Authorization") != "Bearer "+token {
		return fail(http.StatusUnauthorized, "unauthorized")
	}
	q := r.URL.Query()
	platform := q.Get("platform")
	if _, named := q["platform"]; !named { // the trays and pushers from before there were other builds
		platform = "windows-x64"
	}
	if !platforms[platform] {
		return fail(http.StatusBadRequest, fmt.Sprintf("unknown platform %q", platform))
	}
	b, err := os.ReadFile(filepath.Join(dir, file(name, platform)))
	if err != nil {
		return fail(http.StatusNotFound, "no "+name+" build for "+platform)
	}
	if download {
		w.Header().Set("content-type", "application/octet-stream")
		w.Write(b)
		return http.StatusOK
	}
	sum := sha256.Sum256(b)
	w.Header().Set("content-type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"sha256": hex.EncodeToString(sum[:]), "size": len(b)})
	return http.StatusOK
}
