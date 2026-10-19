package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"
)

// A PC token is the secret this PC alone holds for the hub (server/src/core/codex-hub-ids.ts): chp_, the token's id
// (16 hex), _, and its secret (64 hex). The tray makes its own here and sends the hub only the id and the SHA-256 of
// the whole token, which is all the hub keeps: no token travels from the hub, and the hub never makes one. A token of
// another shape is the one token every PC shared before (the legacy token), which the tray trades for one of its own
// (tray.go exchange).
var pcToken = regexp.MustCompile(`^chp_([0-9a-f]{16})_[0-9a-f]{64}$`)

func isPcToken(t string) bool { return pcToken.MatchString(t) }

// pcTokenID is a PC token's id, "" for what is not one.
func pcTokenID(t string) string {
	if m := pcToken.FindStringSubmatch(t); m != nil {
		return m[1]
	}
	return ""
}

// pcTokenHash is what the hub keeps of a token: the SHA-256 of its UTF-8, in lower-case hex.
func pcTokenHash(t string) string {
	sum := sha256.Sum256([]byte(t))
	return hex.EncodeToString(sum[:])
}

// newPcToken makes a token from 8 random bytes for its id and 32 for its secret, with the id and hash the hub is sent.
func newPcToken() (token, id, hash string) {
	b := make([]byte, 40)
	rand.Read(b)
	id = hex.EncodeToString(b[:8])
	token = "chp_" + id + "_" + hex.EncodeToString(b[8:])
	return token, id, pcTokenHash(token)
}

var notKey = regexp.MustCompile(`[^a-z0-9_-]+`)

// pcKey is the hub's key for a PC's name, its folder there and the one name the hub keeps it under, as hubPcKey in
// server/src/core/codex-hub-ids.ts makes it: lower case, every run of characters but a-z, 0-9, _ and - made one dash,
// no dash at either end, then cut to 63 characters, which can leave one at the end; "" for a name that has none.
// testdata/pckey.json holds the cases both must pass.
func pcKey(name string) string {
	// JavaScript lowers İ to i and a combining dot, which then becomes a dash; Go lowers it to i alone.
	lower := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(name), "İ", "i̇"))
	key := strings.Trim(notKey.ReplaceAllString(lower, "-"), "-")
	if len(key) > 63 {
		key = key[:63]
	}
	return key
}
