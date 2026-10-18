# approve_switch_card.ps1 - answer Claude Desktop's "Allow Claude to switch ..." permission card,
# unattended, in a loop, for every running Claude Desktop account from ONE process.
#
# WHY THIS EXISTS (owner, 2026-10-03: "everything I'm doing gets stuck ... automated task
# orchestration while I sleep"). A manager chat that calls set_session_permission_mode stops on
# the app's permission card and nothing restarts it but a click. approve_prompt.ps1 answers that
# card too, but it is driven per-chat from unblock_prompts.py (transcript scan, verdict, target
# JSON, tray arm) - a batch lane, not a resident watcher. This is the resident watcher: it hangs
# on each account's window and presses the card's own Allow once the moment it appears.
#
# ONE WATCHER, NOT ONE PER ACCOUNT (owner, 2026-10-12: "all this could probably be better
# integrated ... instead of just being random PowerShells that sit on their own"). It was one
# pwsh per account (3 on the owner's PC, ~110-150 MB each, each growing to 400 MB a day), kept
# alive by a Task Scheduler supervisor every 5 minutes. Now this one process finds the running
# accounts itself (every ~60 s, and at once when one it watched goes away), keeps each one's
# window and card state, and AgentHydra's helpers list (server/src/helpers.ts) starts it,
# restarts it when it exits or outgrows its memory cap, and shows it in the window's header.
#
# REUSED WHOLESALE FROM approve_prompt.ps1:
#   * instance resolution - exact --user-data-dir for a path-shaped -Instance, exact leaf-folder
#     match for a bare one ('blaarrrggghhh'), never a substring, never "take the first";
#   * Wake $hwnd - the MSAA AccessibleObjectFromWindow poke that switches Electron's lazy
#     accessibility tree on. Without it the app's buttons do not exist to UIA at all;
#   * TryPattern + InvokePattern - the same press approve_prompt.ps1 uses at its Allow button
#     (line ~657): $inv = TryPattern $b ([InvokePattern]::Pattern); $inv.Invoke().
#
# WHAT THIS DOES DIFFERENTLY, and the only thing it aims at:
#   1. it looks for the CARD TEXT, not a sidebar row: a rendered element whose Name starts with
#      -CardText (default 'Allow Claude to switch') or the observed build-2.19675.0 body
#      -CardTextAlso (default 'This one switches'). ⛔ 'Allow Claude to switch' is NOT a string
#      this build ships (checked resources/en-US.json and the ion-dist bundle): the
#      set_session_permission_mode card renders Vxe's "This one switches a session ... to Bypass
#      permissions ... mode." Both phrases are accepted so an older/newer wording still matches,
#      and the log prints the exact card text that was approved;
#   2. from that element it walks UP the control tree until an ancestor holds exactly one enabled,
#      on-screen button named -AllowName (default 'Allow once'), then presses THAT button. One
#      ancestor with several such buttons is ambiguous and refused, not guessed;
#   3. it never touches a Deny/Cancel/Reject - the button name allow-list below has none in it;
#   4. it LOOPS every -IntervalSecs (default 2), and every detection and every press (with the
#      account, the card text and the button label) is appended to one log file.
#
# ACCOUNTS: every running account whose profile leaf matches exactly one main claude.exe (the
# default profile, whose bare claude.exe CLI processes share the leaf 'Claude', is skipped and
# logged). -Instance narrows it to one: an exact --user-data-dir for a path, an exact leaf for a
# bare name. The log defaults to <orchestrator>/state/logs/approve-switch-card.log.
#
# HOW IT RUNS: as an AgentHydra helper (the owner's helpers.json), which starts it hidden. By hand:
#   pwsh -NoProfile -File approve_switch_card.ps1 -Once
#
# FOREVER-WATCH GUARDS: a card that will not clear is pressed at most 3 times, then only reported
# ("gave up ... still watching") so a wedged window cannot be clicked every 2s all night. The
# window is never brought to the foreground - InvokePattern needs no focus - and an iconic window
# is shown with SW_SHOWNOACTIVATE at most, so the desk the owner left is not rearranged.
#
# Exit: 0 ran (with -Once: pressed) - 3 with -Once, no card was showing - 6 with -Once, a card was
#       showing but its Allow once was missing/disabled/ambiguous - 1 error/no account (-Once).
param(
  # Only this account (a full profile directory, or its exact leaf). Default: every running account.
  [string]$Instance = '',
  [string]$CardText = 'Allow Claude to switch',
  # The wording Claude Desktop 2.19675.0 actually renders for this card (see header). '' disables it.
  [string]$CardTextAlso = 'This one switches',
  [string]$AllowName = 'Allow once',
  [ValidateRange(1, 3600)][int]$IntervalSecs = 2,
  [string]$LogPath = '',
  # One scan then exit - for a person testing it at the desk instead of an all-night watcher.
  [switch]$Once,
  # Rarely needed: grab the foreground for this window before each scan. InvokePattern does not
  # require it, so the default leaves the owner's focus alone.
  [switch]$Steal
)
$ErrorActionPreference = 'Stop'
# ⛔ UTF-8 ON THE WAY OUT (same reason as approve_prompt.ps1): a non-ASCII title/name must not
# come back as question marks through the pipe or into the log.
try {
  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = $OutputEncoding
} catch { }

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace Approve -Name Inv -MemberDefinition @'
[DllImport("oleacc.dll")] public static extern int AccessibleObjectFromWindow(IntPtr hwnd, int id, ref System.Guid iid, ref System.IntPtr ppv);
[DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr p);
public delegate bool EnumProc(IntPtr h, IntPtr p);
[DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
public static bool Foreground(IntPtr h) {
  if (IsIconic(h)) ShowWindow(h, 9);
  uint tgt = GetWindowThreadProcessId(h, IntPtr.Zero);
  uint me = GetCurrentThreadId();
  if (tgt == me) return SetForegroundWindow(h);
  AttachThreadInput(me, tgt, true);
  bool ok = SetForegroundWindow(h);
  AttachThreadInput(me, tgt, false);
  return ok;
}
'@

# The localized Allow-once labels approve_prompt.ps1 already carries. -AllowName is the primary;
# these are the same observed translations so a non-English app still matches. NOTHING in here is
# a Deny/Cancel/Reject.
$ALLOW_NAMES = @($AllowName, 'Allow once', 'Einmal erlauben', 'Permitir una vez', 'Autoriser une fois') |
  Where-Object { $_ } | Select-Object -Unique
# Every card-text phrase this watcher will match, on any locale ('Allow Claude to switch' as asked,
# plus the build's observed body). A match needs the element Name to START WITH one of these.
$CARD_PHRASES = @($CardText, $CardTextAlso) | Where-Object { $_ } | Select-Object -Unique
$TREE = [System.Windows.Automation.TreeScope]::Descendants
$BTN = [System.Windows.Automation.ControlType]::Button
$btnCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $BTN)
function TryPattern($e, $pat) { try { return $e.GetCurrentPattern($pat) } catch { return $null } }

# ⛔ THE CHEAP LOOK (2026-10-04). Find-Card walks every Text element and, when none matches (every
# tick with no card up), EVERY element of the window, one cross-process call per element: six
# watchers did that every 2 s all night and grew to ~1.2 GB each. A card is only pressable through
# an Allow button, so each tick first asks for the buttons' names alone, in one cached round trip
# that keeps no element alive; the full walk runs when one starts with an Allow name, while a card
# is up, and every FULL_SCAN_EVERY ticks so a card with no enabled Allow is still reported.
$FULL_SCAN_EVERY = 30
# The running accounts are looked up again this often (and at once when a watched one goes away):
# one WMI query for claude.exe, so not every tick.
$DISCOVER_EVERY = [math]::Max(1, [int](60 / $IntervalSecs))
function Test-AllowButton($roots) {
  $cr = New-Object System.Windows.Automation.CacheRequest
  $cr.Add([System.Windows.Automation.AutomationElement]::NameProperty)
  $cr.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::None
  foreach ($root in $roots) {
    $found = $null
    $scope = $cr.Activate()
    try { $found = $root.FindAll($TREE, $btnCond) } catch { $found = $null } finally { $scope.Dispose() }
    if (-not $found) { continue }
    foreach ($b in $found) {
      $n = $null
      try { $n = [string]$b.Cached.Name } catch { continue }
      if ($n -and @($ALLOW_NAMES | Where-Object { $n.StartsWith($_) }).Count -gt 0) { return $true }
    }
  }
  return $false
}

# ---- Logging -------------------------------------------------------------------------------
# Default: <orchestrator>/state/logs/approve-switch-card.log, one file for every account (each
# line names its account). Falls back to %TEMP% if the state dir is not writable, because a
# watcher that cannot log must still watch.
if (-not $LogPath) {
  $name = 'approve-switch-card.log'
  try {
    $stateRoot = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'state'
    $dir = Join-Path $stateRoot 'logs'
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $LogPath = Join-Path $dir $name
  } catch {
    $LogPath = Join-Path $env:TEMP $name
  }
}
function Write-Log([string]$who, [string]$msg) {
  $line = '{0} [{1}] {2}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $who, $msg
  # Not Write-Output: Get-Accounts and Scan-Account log mid-function, and a pipeline line would
  # become part of what they return.
  [Console]::Out.WriteLine($line)
  try { Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8 } catch { }
}

# Account resolution is approve_prompt.ps1's rail 1/1b. Every main claude.exe (no --type=) and the profile it runs. An account is watched only when its
# leaf (or, for a path-shaped -Instance, its exact directory) names exactly ONE such process: two
# processes on one profile cannot be told apart, and a guess could press another account's card.
$script:SkipNote = @{}
function Get-Accounts {
  $procs = @(Get-CimInstance Win32_Process -Filter "Name = 'claude.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' } |
    ForEach-Object {
      $m = [regex]::Match($_.CommandLine, '"--user-data-dir=([^"]+)"')
      if (-not $m.Success) { $m = [regex]::Match($_.CommandLine, '--user-data-dir=(\S+)') }
      $d = if ($m.Success) { $m.Groups[1].Value.Trim() } else { Join-Path $env:APPDATA 'Claude' }
      [pscustomobject]@{ ProcId = [int]$_.ProcessId; Dir = $d.TrimEnd('\'); Leaf = (Split-Path -Leaf $d.TrimEnd('\')) }
    })
  if ($Instance -match '[\\/]') {
    $procs = @($procs | Where-Object { $_.Dir -eq $Instance.TrimEnd('\') })
  } elseif ($Instance) {
    $procs = @($procs | Where-Object { $_.Leaf.Equals($Instance, [System.StringComparison]::OrdinalIgnoreCase) })
  }
  $out = @()
  foreach ($g in ($procs | Where-Object { $_.Leaf } | Group-Object Leaf)) {
    if ($g.Count -ne 1) {
      if (-not $script:SkipNote.ContainsKey($g.Name)) {
        Write-Log $g.Name "skipped: $($g.Count) claude.exe main processes carry this profile (the watcher needs exactly 1)"
        $script:SkipNote[$g.Name] = $true
      }
      continue
    }
    $script:SkipNote.Remove($g.Name)
    $out += $g.Group[0]
  }
  return $out
}

function Window-Inventory([int]$procId) {
  $out = @()
  try {
    $cond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$procId)
    foreach ($w in [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
                     [System.Windows.Automation.TreeScope]::Children, $cond)) {
      try {
        $r = $w.Current.BoundingRectangle
        $empty = $r.IsEmpty -or $r.Width -le 0 -or $r.Height -le 0
        $out += [pscustomobject]@{
          Hwnd = [int]$w.Current.NativeWindowHandle
          Name = [string]$w.Current.Name
          Offscreen = [bool]$w.Current.IsOffscreen
          Area = if ($empty) { 0 } else { [int]($r.Width * $r.Height) }
        }
      } catch { continue }
    }
  } catch { }
  return $out
}

# The instance's window: its main window, else its largest visible top-level one; zero when it has none.
function Find-Window([int]$procId) {
  $main = (Get-Process -Id $procId -ErrorAction SilentlyContinue).MainWindowHandle
  if ($main -and $main -ne [IntPtr]::Zero) { return $main }
  $best = @(Window-Inventory $procId | Where-Object { -not $_.Offscreen -and $_.Area -gt 0 } |
            Sort-Object Area -Descending) | Select-Object -First 1
  if ($best) { return [IntPtr]$best.Hwnd }
  return [IntPtr]::Zero
}

# The MSAA poke (approve_prompt.ps1's Wake, reused): switches Electron's lazy accessibility tree
# on so buttons exist to UIA at all.
function Wake($h, [int]$SleepMs = 0) {
  $cb = [Approve.Inv+EnumProc]{
    param($c, $lp)
    $sb = New-Object System.Text.StringBuilder 256
    [void][Approve.Inv]::GetClassName($c, $sb, 256)
    if ($sb.ToString() -eq 'Chrome_RenderWidgetHostHWND') {
      $iid = [Guid]'618736e0-3c3d-11cf-810c-00aa00389b71'; $ppv = [IntPtr]::Zero
      [void][Approve.Inv]::AccessibleObjectFromWindow($c, -4, [ref]$iid, [ref]$ppv)
    }
    return $true
  }
  [void][Approve.Inv]::EnumChildWindows($h, $cb, [IntPtr]::Zero)
  if ($SleepMs -gt 0) { Start-Sleep -Milliseconds $SleepMs }
  return [System.Windows.Automation.AutomationElement]::FromHandle($h)
}

# The main window first, then every visible top-level window this pid owns (a card can also be a
# separate owned window), scoped to this process so no other instance is ever read.
function Get-Roots([int]$procId, $mainHwnd) {
  $roots = @()
  try {
    $main = [System.Windows.Automation.AutomationElement]::FromHandle($mainHwnd)
    if ($main) { $roots += $main }
  } catch { }
  try {
    $pidCond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$procId)
    foreach ($w in [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
                     [System.Windows.Automation.TreeScope]::Children, $pidCond)) {
      try {
        if ($mainHwnd -and $w.Current.NativeWindowHandle -eq [int]$mainHwnd) { continue }
        if ($w.Current.IsOffscreen -or $w.Current.BoundingRectangle.IsEmpty) { continue }
        $roots += $w
      } catch { continue }
    }
  } catch { }
  return $roots
}

# From a matched card-text element: walk UP until an ancestor holds exactly one enabled, on-screen
# Allow button, then return that button. Several in one ancestor is ambiguous - refused, not
# guessed. (This is the "up to the card container, then down to its button".)
# ⛔ The walk stops at an ancestor with more than $CARD_MAX_BUTTONS buttons of any kind: a card
# holds a handful, a chat pane holds dozens. Without the stop, chat text that merely starts with a
# card phrase could climb to the pane and press the lone Allow once of a different permission card.
$CARD_MAX_BUTTONS = 8
function Find-AllowButton($start) {
  $node = $start
  for ($depth = 0; $depth -lt 12; $depth++) {
    try { $node = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($node) } catch { $node = $null }
    if (-not $node) { break }
    try { if ($node.Current.BoundingRectangle.IsEmpty) { continue } } catch { break }
    $all = $node.FindAll($TREE, $btnCond)
    if ($all.Count -gt $CARD_MAX_BUTTONS) { return @{ Button = $null; Card = $null; Why = 'too-wide'; Count = $all.Count } }
    $btns = @()
    foreach ($b in $all) {
      try {
        $n = $b.Current.Name
        if (-not $n) { continue }
        if (@($ALLOW_NAMES | Where-Object { $n.StartsWith($_) }).Count -eq 0) { continue }
        if (-not $b.Current.IsEnabled -or $b.Current.IsOffscreen) { continue }
        if ($b.Current.BoundingRectangle.IsEmpty) { continue }
        $btns += $b
      } catch { continue }
    }
    if ($btns.Count -eq 1) { return @{ Button = $btns[0]; Card = $node; Why = 'ok' } }
    if ($btns.Count -gt 1) { return @{ Button = $null; Card = $node; Why = 'ambiguous' } }
  }
  return @{ Button = $null; Card = $null; Why = 'no-button' }
}

# Look for the card text (Name starts with any of $CARD_PHRASES), then its Allow once. Text
# elements first (the common case and the cheap walk), then any element, because an Electron
# header can surface under a non-Text control type.
function Find-Card($root, $phrases) {
  $textCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Text)
  $candidates = @()
  foreach ($e in $root.FindAll($TREE, $textCond)) {
    try {
      $n = $e.Current.Name
      if (-not $n) { continue }
      $hit = @($phrases | Where-Object { $n.StartsWith($_, [System.StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
      if (-not $hit) { continue }
      if ($e.Current.IsOffscreen -or $e.Current.BoundingRectangle.IsEmpty) { continue }
      $candidates += [pscustomobject]@{ El = $e; Name = $n }
    } catch { continue }
  }
  if ($candidates.Count -eq 0) {
    foreach ($e in $root.FindAll($TREE, [System.Windows.Automation.Condition]::TrueCondition)) {
      try {
        $n = $e.Current.Name
        if (-not $n) { continue }
        $hit = @($phrases | Where-Object { $n.StartsWith($_, [System.StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
        if (-not $hit) { continue }
        if ($e.Current.IsOffscreen -or $e.Current.BoundingRectangle.IsEmpty) { continue }
        $candidates += [pscustomobject]@{ El = $e; Name = $n }
      } catch { continue }
    }
  }
  $last = $null
  foreach ($c in $candidates) {
    $found = Find-AllowButton $c.El
    if ($found.Button) { return @{ Header = $c.Name; Button = $found.Button; Why = 'ok' } }
    if ($found.Why -in 'ambiguous', 'too-wide') { $last = @{ Header = $c.Name; Button = $null; Why = $found.Why; Count = $found.Count } }
    elseif (-not $last) { $last = @{ Header = $c.Name; Button = $null; Why = 'no-button' } }
  }
  return $last
}

# One watch per account, keyed by its pid. The pid and its start time name the instance: a pid
# Windows hands to another process later is not it.
$script:Watches = @{}
$script:NoWindowNote = @{}
$script:OncePressed = $false
$script:OnceCardSeen = $false
$script:OnceUnpressable = ''

function Sync-Watches {
  $accounts = @(Get-Accounts)
  $live = @{}
  foreach ($a in $accounts) {
    $live[$a.ProcId] = $true
    if ($script:Watches.ContainsKey($a.ProcId)) { continue }
    $p = Get-Process -Id $a.ProcId -ErrorAction SilentlyContinue
    if (-not $p) { continue }
    $hwnd = Find-Window $a.ProcId
    if (-not $hwnd -or $hwnd -eq [IntPtr]::Zero) {
      if (-not $script:NoWindowNote.ContainsKey($a.ProcId)) {
        Write-Log $a.Leaf "pid $($a.ProcId) has no window yet - looking again at the next pass"
        $script:NoWindowNote[$a.ProcId] = $true
      }
      continue
    }
    $script:NoWindowNote.Remove($a.ProcId)
    $script:Watches[$a.ProcId] = [pscustomobject]@{
      Leaf = $a.Leaf; ProcId = $a.ProcId; Started = $p.StartTime; Hwnd = $hwnd; Tick = 0
      CardVisible = $false; Attempts = 0; LastPressAt = [DateTime]::MinValue
      LoggedDisabled = $false; GaveUpLogged = $false; LastRefusal = ''
    }
    Write-Log $a.Leaf "watching: pid $($a.ProcId) hwnd $hwnd"
  }
  foreach ($procId in @($script:Watches.Keys)) {
    if (-not $live.ContainsKey($procId)) {
      Write-Log $script:Watches[$procId].Leaf "stopped watching: pid $procId is no longer a running account"
      $script:Watches.Remove($procId)
    }
  }
}

# One scan of one account's windows. Returns $false when the account is gone (its pid exited, or
# was reused, or it has no window left), so the caller drops it and looks for accounts again.
function Scan-Account($w) {
  try {
    if ([Approve.Inv]::IsIconic($w.Hwnd)) {
      [void][Approve.Inv]::ShowWindow($w.Hwnd, 4)   # SW_SHOWNOACTIVATE - render, do not steal focus
      Start-Sleep -Milliseconds 400
    }
    if ($Steal) { [void][Approve.Inv]::Foreground($w.Hwnd); Start-Sleep -Milliseconds 150 }
    [void](Wake $w.Hwnd 0)
    $card = $null
    $roots = @(Get-Roots $w.ProcId $w.Hwnd)
    $full = $Once -or $w.CardVisible -or ($w.Tick % $FULL_SCAN_EVERY -eq 0) -or (Test-AllowButton $roots)
    $w.Tick++
    if ($full) {
      foreach ($root in $roots) {
        $card = Find-Card $root $CARD_PHRASES
        if ($card -and $card.Button) { break }
      }
    }

    if (-not $card -or -not $card.Button) {
      if ($w.CardVisible) {
        Write-Log $w.Leaf 'card cleared'
        $w.CardVisible = $false; $w.Attempts = 0
        $w.LoggedDisabled = $false; $w.GaveUpLogged = $false
      }
      if ($card -and $card.Why -eq 'ambiguous') {
        $script:OnceCardSeen = $true; $script:OnceUnpressable = "the card '$($card.Header)' holds more than one Allow button - refused"
        if (-not $w.CardVisible) { Write-Log $w.Leaf "REFUSED: '$($card.Header)' is a container with more than one Allow button - not guessing" }
      } elseif ($card -and $card.Why -eq 'too-wide') {
        $script:OnceCardSeen = $true; $script:OnceUnpressable = "'$($card.Header)' reached a container of $($card.Count) buttons before any Allow - refused"
        $msg = "REFUSED: '$($card.Header)' reached a container of $($card.Count) buttons (over $CARD_MAX_BUTTONS) before any Allow - chat text, not a card"
        if ($msg -ne $w.LastRefusal) { Write-Log $w.Leaf $msg; $w.LastRefusal = $msg }
      } elseif ($card -and $card.Why -eq 'no-button') {
        $script:OnceCardSeen = $true; $script:OnceUnpressable = "the card '$($card.Header)' has no enabled Allow once"
        if (-not $w.CardVisible) { Write-Log $w.Leaf "card '$($card.Header)' is showing but no enabled '$AllowName' is inside it" }
      }
      return $true
    }

    $header = $card.Header
    $btn = $card.Button
    try { $label = [string]$btn.Current.Name } catch { $label = $AllowName }
    $script:OnceCardSeen = $true
    if (-not $w.CardVisible) {
      Write-Log $w.Leaf "card showing: '$header' -> '$label'"
      $w.CardVisible = $true; $w.Attempts = 0
      $w.LoggedDisabled = $false; $w.GaveUpLogged = $false
    }
    $enabled = $false
    try { $enabled = [bool]$btn.Current.IsEnabled } catch { $enabled = $false }
    if (-not $enabled) {
      if (-not $w.LoggedDisabled) { Write-Log $w.Leaf "card '$header' is up but '$label' is disabled - waiting"; $w.LoggedDisabled = $true }
      $script:OnceUnpressable = "'$label' on '$header' was disabled"
    } elseif ($w.Attempts -ge 3) {
      if (-not $w.GaveUpLogged) { Write-Log $w.Leaf "gave up on '$header' after 3 presses - it is not clearing; still watching"; $w.GaveUpLogged = $true }
      $script:OnceUnpressable = "'$header' did not clear after 3 presses"
    } elseif (((Get-Date) - $w.LastPressAt).TotalSeconds -ge 5) {
      $inv = TryPattern $btn ([System.Windows.Automation.InvokePattern]::Pattern)
      if (-not $inv) {
        Write-Log $w.Leaf "REFUSED: '$label' on '$header' exposes no InvokePattern"
        $script:OnceUnpressable = "'$label' exposes no InvokePattern"
      } else {
        try {
          $inv.Invoke()
          $w.LastPressAt = Get-Date
          $w.Attempts++
          $script:OncePressed = $true
          Write-Log $w.Leaf "APPROVED '$label' on '$header' (press #$($w.Attempts))"
        } catch {
          Write-Log $w.Leaf "invoke failed on '$label' on '$header': $($_.Exception.Message)"
          $script:OnceUnpressable = "invoke failed: $($_.Exception.Message)"
        }
      }
    }
    return $true
  } catch {
    Write-Log $w.Leaf "scan error: $($_.Exception.Message)"
    # The window is cached when the watch starts. When the instance quits (an app restart gives it
    # a new pid), every scan would fail on the dead window forever: drop the watch, and the next
    # look for accounts picks up the new process. A recreated window is followed in place, found
    # the way the watch found it; a pid reused by another process is not followed, since its
    # windows are some other app's and the next scan would press an Allow there.
    $live = Get-Process -Id $w.ProcId -ErrorAction SilentlyContinue
    if (-not $live -or $live.StartTime -ne $w.Started) {
      Write-Log $w.Leaf "pid $($w.ProcId) is gone - dropping its watch"
      return $false
    }
    $found = Find-Window $w.ProcId
    if ($found -eq [IntPtr]::Zero) {
      Write-Log $w.Leaf "pid $($w.ProcId) has no window - dropping its watch"
      return $false
    }
    if ($found -ne $w.Hwnd) {
      Write-Log $w.Leaf "window changed: $($w.Hwnd) -> $found"
      $w.Hwnd = $found
    }
    return $true
  }
}

Sync-Watches
Write-Log '*' ("watcher start: $($script:Watches.Count) account(s), every ${IntervalSecs}s, card text " +
               ($CARD_PHRASES | ForEach-Object { "'$_'" }) + ", button '" + ($ALLOW_NAMES -join "'/'") + "', log '$LogPath'" + $(if ($Once) { ' (once)' } else { '' }))
if ($Once -and $script:Watches.Count -eq 0) {
  Write-Log '*' 'FAIL: no running account to watch'
  exit 1
}

$tick = 0
try {
  while ($true) {
    $lost = $false
    foreach ($w in @($script:Watches.Values)) {
      if (-not (Scan-Account $w)) { $script:Watches.Remove($w.ProcId); $lost = $true }
    }
    if ($Once) { break }
    $tick++
    if ($lost -or ($tick % $DISCOVER_EVERY -eq 0)) { Sync-Watches }
    # The UIA wrappers are tiny managed objects pinning native ones, so the GC never feels the
    # pressure on its own: collect each tick. A watcher that grows anyway is restarted by its
    # helper entry's memory cap.
    [System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()
    Start-Sleep -Seconds $IntervalSecs
  }
} finally {
  Write-Log '*' 'watcher stopped'
}

if ($Once) {
  if ($script:OncePressed) { exit 0 }
  if (-not $script:OnceCardSeen) { exit 3 }
  if ($script:OnceUnpressable) { Write-Log '*' "not pressed: $($script:OnceUnpressable)" }
  exit 6
}
