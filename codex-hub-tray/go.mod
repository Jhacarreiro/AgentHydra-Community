module github.com/Jhacarreiro/AgentHydra-Community/codex-hub-tray

go 1.23

// The Go every tray build is made with (build.sh): another Go makes other bytes.
toolchain go1.24.7

require (
	fyne.io/systray v1.11.0
	github.com/godbus/dbus/v5 v5.1.0
	golang.org/x/sys v0.25.0
)
