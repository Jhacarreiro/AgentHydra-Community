# Creates (or refreshes) the "AgentHydra" shortcuts on the Desktop and in the Start Menu. They run
# launcher/start.vbs through wscript.exe, which starts start.ps1 hidden: no console flash. Icon:
# AgentHydra's own, compiled into launcher/HydraDesk2.exe (host/build.rs, from misc/AgentHydra.ico).
# The window host is built, never committed (scripts/build-natives.ts): a source checkout that has not
# built it takes the same icon from misc/AgentHydra.ico, and the shortcut works all the same (start.ps1
# then opens the page in the default browser). Re-run after moving the desk folder.
#
# This window was called Hydra Desk 2 until 2026-10-06, when it became AgentHydra 2.0 (owner): the
# "Hydra Desk 2" shortcuts this script made before go to the Recycle Bin, and only those that run this
# launcher.
#
#   -DryRun  print the shortcuts it would write and retire, and exit 0
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$DeskRoot = Split-Path -Parent $PSScriptRoot
$Vbs = Join-Path $PSScriptRoot 'start.vbs'
$Icon = Join-Path $PSScriptRoot 'HydraDesk2.exe'
$Wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'

if (-not (Test-Path $Vbs)) { [Console]::Error.WriteLine("missing $Vbs"); exit 1 }
if (-not (Test-Path $Icon)) {
  # The file build.rs compiles into the host: misc\AgentHydra.ico at the repository root, which git tracks.
  $IcoFile = Join-Path (Split-Path -Parent $DeskRoot) 'misc\AgentHydra.ico'
  if (-not (Test-Path $IcoFile)) { [Console]::Error.WriteLine("missing $Icon (and $IcoFile for its icon)"); exit 1 }
  Write-Output ("$Icon is not built in this checkout: the shortcuts take their icon from $IcoFile, and the " +
    "page opens in the default browser until it is. For AgentHydra's own window, build it with " +
    "'bun scripts/build-natives.ts window' from the repository root (needs Rust: https://rustup.rs).")
  $Icon = $IcoFile
}

$folders = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))
$sh = New-Object -ComObject WScript.Shell

foreach ($dir in $folders) {
  $lnk = Join-Path $dir 'AgentHydra.lnk'
  if ($DryRun) {
    Write-Output "[dry-run] would write $lnk -> $Wscript `"$Vbs`" (icon $Icon, start in $DeskRoot)"
  } else {
    $s = $sh.CreateShortcut($lnk)
    $s.TargetPath = $Wscript
    $s.Arguments = "`"$Vbs`""
    $s.WorkingDirectory = $DeskRoot
    $s.IconLocation = "$Icon,0"
    $s.Description = 'AgentHydra: Claude Code chats, CliMayte workers and every account in one window'
    $s.WindowStyle = 7  # minimized: wscript has no window anyway; this keeps any edge case out of sight
    $s.Save()
    Write-Output "wrote $lnk"
  }

  $old = Join-Path $dir 'Hydra Desk 2.lnk'
  if (-not (Test-Path -LiteralPath $old)) { continue }
  if ($sh.CreateShortcut($old).Arguments -notlike "*$Vbs*") { continue }  # not ours: left alone
  if ($DryRun) {
    Write-Output "[dry-run] would move $old to the Recycle Bin"
    continue
  }
  Add-Type -AssemblyName Microsoft.VisualBasic
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($old, 'OnlyErrorDialogs', 'SendToRecycleBin')
  Write-Output "moved $old to the Recycle Bin"
}
exit 0
