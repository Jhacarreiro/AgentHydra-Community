package main

// What starts the tray at log in on Linux (an XDG autostart entry, and a systemd --user unit on a PC without a
// desktop) and on macOS (a LaunchAgent), and the macOS app bundle's Info.plist. They are plain text, made here for
// every system so their tests run on any of them.

import (
	"bytes"
	"encoding/xml"
	"os"
	"path/filepath"
	"strings"
)

func desktopEntry(exe string) string {
	return "[Desktop Entry]\n" +
		"Type=Application\n" +
		"Name=Codex Hub\n" +
		"Comment=Keeps this PC's Codex chats pushed to the hub\n" +
		"Exec=" + desktopExec(exe) + "\n" +
		"Terminal=false\n" +
		"X-GNOME-Autostart-enabled=true\n"
}

// desktopExec writes a program's path as an Exec value: quoted when it has a reserved character, with the
// backslash that quoting puts before " ` $ \ doubled by the key's own string escaping, and % doubled.
func desktopExec(p string) string {
	if !strings.ContainsAny(p, " \t\"'\\><~|&;$*?#()`%") {
		return p
	}
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range p {
		switch r {
		case '"', '`', '$':
			b.WriteString(`\\`)
			b.WriteRune(r)
		case '\\':
			b.WriteString(`\\\\`)
		case '%':
			b.WriteString("%%")
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

// serviceUnit is the systemd --user unit that starts the tray on a Linux PC without a desktop, where no autostart
// entry runs: when the user's systemd starts, at their first log in (over SSH too) or at boot once lingering is on
// for them, and again after a crash, but not after a stop (the tray exits 0 on SIGTERM).
func serviceUnit(exe string) string {
	return "[Unit]\n" +
		"Description=Codex Hub: keeps this PC's Codex chats pushed to the hub\n" +
		"\n" +
		"[Service]\n" +
		"ExecStart=" + systemdExec(exe) + "\n" +
		"Restart=on-failure\n" +
		"RestartSec=10\n" +
		"\n" +
		"[Install]\n" +
		"WantedBy=default.target\n"
}

// systemdExec writes a program's path as ExecStart's first word: % doubled (systemd's specifiers), and quoted, with
// \ and " escaped, when it has a space, a quote or a backslash.
func systemdExec(p string) string {
	p = strings.ReplaceAll(p, "%", "%%")
	if !strings.ContainsAny(p, " \t\"'\\") {
		return p
	}
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(p) + `"`
}

const plistHead = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
`

func xmlText(s string) string {
	var b bytes.Buffer
	xml.EscapeText(&b, []byte(s))
	return b.String()
}

// launchAgentPlist has launchd start exe when the user logs in to the desktop, and again if it crashes; a Quit
// (exit 0) stays quit until the next log in.
func launchAgentPlist(label, exe string) string {
	return plistHead + `<dict>
	<key>Label</key>
	<string>` + xmlText(label) + `</string>
	<key>ProgramArguments</key>
	<array>
		<string>` + xmlText(exe) + `</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>LimitLoadToSessionType</key>
	<string>Aqua</string>
	<key>ProcessType</key>
	<string>Interactive</string>
</dict>
</plist>
`
}

// infoPlist describes "Codex Hub.app": its program, its identifier, and no Dock icon (LSUIElement), since it lives
// in the menu bar.
func infoPlist(id string) string {
	return plistHead + `<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleDisplayName</key>
	<string>Codex Hub</string>
	<key>CFBundleExecutable</key>
	<string>codex-hub-tray</string>
	<key>CFBundleIdentifier</key>
	<string>` + xmlText(id) + `</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>Codex Hub</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSUIElement</key>
	<true/>
	<key>NSHighResolutionCapable</key>
	<true/>
</dict>
</plist>
`
}

// writeFileIfChanged writes text to path, making its folder, unless the file already says that.
func writeFileIfChanged(path, text string) error {
	if b, err := os.ReadFile(path); err == nil && string(b) == text {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(text), 0o644)
}
