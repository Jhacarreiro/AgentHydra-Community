# Creates / refreshes the "AgentHydra" shortcut in the project root. THIN ADAPTER over the
# generic shortcut engine (misc\New-TrayShortcut.ps1, maintained in this repository;
# keep it app-agnostic and put AgentHydra's specifics here).
# The shortcut launches the native tray host and carries the icon, so the root has one nice
# clickable entry. Re-run this if you move or rename the folder.
#
#   -Legacy   Rebuild the shortcut against the OLD wscript + Tray-Launch.vbs + AgentHydra-Tray.ps1
#             chain. Both hosts are shipped and either can drive the app, so if the native one ever
#             misbehaves the rollback is this one switch rather than a code change:
#                 powershell -File misc\Create-Shortcut.ps1 -Legacy
#
# A release always has the native host. A source checkout has it once it is built
# (`bun scripts/build-natives.ts tray`, which needs Rust); until then this makes the -Legacy
# shortcut and says so, and re-running it after the build switches the shortcut to the native host.
param([switch]$Legacy)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition   # ...\misc
$root = Split-Path -Parent $scriptDir

. (Join-Path $scriptDir "New-TrayShortcut.ps1")

# The main shortcut runs the NATIVE tray host (misc\AgentHydra-Tray.exe; its source is beside it in
# misc\tray-host-native\), not wscript +
# Tray-Launch.vbs + AgentHydra-Tray.ps1. Measured on the author's machine, alternating runs: the
# PowerShell chain started the daemon at +475ms and was serving at +745-1115ms; the native host
# starts it at +25ms and serves at ~400ms through the real shortcut. Almost all of the difference is
# script-host overhead (wscript, the CLR, Add-Type of WinForms, and parsing 1,215 lines) rather than
# anything the app does.
$native = @{ ExeFile = "AgentHydra-Tray.exe"; ExeArguments = "AgentHydra-Tray.json" }
if (-not $Legacy -and -not (Test-Path -LiteralPath (Join-Path $scriptDir $native.ExeFile))) {
  Write-Host ("misc\AgentHydra-Tray.exe is not built in this checkout, so the AgentHydra shortcut runs the " +
    "PowerShell tray (misc\AgentHydra-Tray.ps1) instead. For the native tray, build it with " +
    "'bun scripts/build-natives.ts tray' (needs Rust: https://rustup.rs) and run this script again.")
  $Legacy = $true
}
if ($Legacy) { $native = @{} }
New-TrayShortcut -Root $root -ScriptDir $scriptDir `
  -LnkName "AgentHydra" `
  -IconFile "AgentHydra.ico" `
  -Description "Launch AgentHydra (system tray)" `
  @native

# The quick launcher deliberately bypasses the tray/full daemon. Instance-Launch.vbs picks the
# compiled release executable or the source entrypoint and passes --instances with no console.
New-TrayShortcut -Root $root -ScriptDir $scriptDir `
  -LnkName "AgentHydra Instances" `
  -IconFile "AgentHydra.ico" `
  -Description "Quick launch AgentHydra instances" `
  -VbsFile "Instance-Launch.vbs"
