# What the tray's Quit runs (quitCommand in misc/AgentHydra-Tray.json): AgentHydra closes completely.
#
#   1. Each window of this install (launcher/HydraDesk2.exe) is asked to close, so it saves its place; one that is
#      still open after 5 s, or has no window to ask, is ended.
#   2. stop.ps1 stops Desk 2's server. Chats keep running in their hosts, as with any stop.ps1, and the next
#      server takes them over.
#
# The tray stops the AgentHydra daemon itself; this is everything that runs beside it.
$ErrorActionPreference = 'SilentlyContinue'

$HostExe = Join-Path $PSScriptRoot 'HydraDesk2.exe'
$windows = @(Get-Process -Name 'HydraDesk2' | Where-Object { $_.Path -and $_.Path -ieq $HostExe })
foreach ($p in $windows) {
  if (-not $p.CloseMainWindow()) { Stop-Process -Id $p.Id -Force }
}
foreach ($p in $windows) {
  if (-not $p.HasExited -and -not $p.WaitForExit(5000)) { Stop-Process -Id $p.Id -Force }
}

& (Join-Path $PSScriptRoot 'stop.ps1')
