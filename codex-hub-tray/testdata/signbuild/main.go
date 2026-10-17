// Command signbuild stands in for scripts/codex-hub-sign.ts in test-linux.sh and test-macos.sh, which need only Go.
// It makes the same key file (PKCS#8 PEM, mode 0600, never written over) and the same <build>.sig, taking the build's
// name and platform from its file name as the hub serves it:
//
//	signbuild keygen <private-key-file>            prints the public key (base64)
//	signbuild sign <private-key-file> <build>...   writes <build>.sig beside each build
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

var platforms = map[string]bool{"linux-x64": true, "linux-arm64": true, "darwin-x64": true, "darwin-arm64": true}

var buildName = regexp.MustCompile(`^codex-hub-(push|tray)(?:\.exe|-([a-z0-9-]+))$`)

func fail(format string, a ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", a...)
	os.Exit(1)
}

func main() {
	if len(os.Args) < 3 {
		fail("usage: signbuild keygen <key> | sign <key> <build>...")
	}
	keyFile := os.Args[2]
	switch os.Args[1] {
	case "keygen":
		pub, priv, _ := ed25519.GenerateKey(rand.Reader)
		der, _ := x509.MarshalPKCS8PrivateKey(priv)
		f, err := os.OpenFile(keyFile, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			fail("%v", err)
		}
		pem.Encode(f, &pem.Block{Type: "PRIVATE KEY", Bytes: der})
		f.Close()
		fmt.Println(base64.StdEncoding.EncodeToString(pub))
	case "sign":
		b, err := os.ReadFile(keyFile)
		block, _ := pem.Decode(b)
		if err != nil || block == nil {
			fail("no key in %s", keyFile)
		}
		k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		key, ok := k.(ed25519.PrivateKey)
		if err != nil || !ok {
			fail("%s is not an ed25519 key", keyFile)
		}
		for _, file := range os.Args[3:] {
			m := buildName.FindStringSubmatch(filepath.Base(file))
			if m == nil || (m[2] != "" && !platforms[m[2]]) {
				fail("%s: not a name the hub serves a build under", file)
			}
			name, platform := map[string]string{"push": "pusher", "tray": "tray"}[m[1]], m[2]
			if platform == "" {
				platform = "windows-x64"
			}
			data, err := os.ReadFile(file)
			if err != nil {
				fail("%v", err)
			}
			sum := sha256.Sum256(data)
			text := "codex-hub-build v1\n" + name + "\n" + platform + "\n" + hex.EncodeToString(sum[:]) + "\n"
			sig := base64.StdEncoding.EncodeToString(ed25519.Sign(key, []byte(text)))
			if err := os.WriteFile(file+".sig", []byte(sig+"\n"), 0o644); err != nil {
				fail("%v", err)
			}
		}
	default:
		fail("usage: signbuild keygen <key> | sign <key> <build>...")
	}
}
