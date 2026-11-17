# Launch the desktop app in dev mode with the WebView's DevTools protocol on
# 127.0.0.1:9223, so cdp.ts can inspect and drive the real app.
#
#   app.ps1 up       start (waits for the window and the debug port; first build is slow)
#                    set RAVEN_APP_RELEASE=1 first for an optimised build
#   app.ps1 status
#   app.ps1 log      scan the run's output for panics; show the tail
#   app.ps1 down     stop the instance this script started
#
# Close the app from inside (cdp.ts click "Close") when testing exit behaviour. Never use
# Process.CloseMainWindow() or a blind WM_CLOSE: it can hit the framework's hidden
# "Tao Thread Event Target" window and break the event loop of the app under test.
param([Parameter(Position = 0)][string]$Action = "status")
. "$PSScriptRoot\_common.ps1"

$log = Join-Path $RigDir "app.log"
$port = if ($env:RAVEN_CDP_PORT) { $env:RAVEN_CDP_PORT } else { "9223" }

function Test-Cdp {
  try { (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 2).StatusCode -eq 200 } catch { $false }
}
function Test-AppRunning { [bool](Get-Process -Name "raven-desktop" -ErrorAction SilentlyContinue) }

switch ($Action) {
  "up" {
    Stop-Detached "app"
    Start-Sleep -Milliseconds 500
    if (Test-AppRunning) {
      Write-Output "A raven-desktop process is already running and was not started by this rig. Close it first."
      exit 1
    }
    Remove-Item $log -ErrorAction SilentlyContinue
    # RAVEN_APP_RELEASE=1 builds optimised, as installed copies are. Use it for anything
    # that measures per-frame cost (video frame rates, CPU); debug pixel code is far slower.
    $releaseArg = if ($env:RAVEN_APP_RELEASE -eq "1") { " --release" } else { "" }
    $launcher = Start-Detached "app" @(
      "cd /d `"$RavenRepo\apps\desktop`"",
      "set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=$port --remote-allow-origins=*",
      "powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tauri.ps1 dev$releaseArg > `"$log`" 2>&1"
    )
    $deadline = (Get-Date).AddMinutes(14)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
      if ((Test-AppRunning) -and (Test-Cdp)) { $ready = $true; break }
      if ($launcher.HasExited) { break }
      Start-Sleep -Seconds 3
    }
    Write-Output "APP_READY=$ready  (log: $log)"
    if (-not $ready) { Get-Content $log -ErrorAction SilentlyContinue | Select-Object -Last 30 }
  }
  "log" {
    Write-Output "---- panics / errors ----"
    $hits = @()
    if (Test-Path $log) {
      $hits = Select-String -Path $log -Pattern 'panicked|Cannot start a runtime|can call blocking only|error\[E|overflowed its stack|STATUS_|failed to run'
    }
    if (@($hits).Count -eq 0) { Write-Output "none" } else { $hits | ForEach-Object { $_.Line } | Select-Object -First 30 }
    Write-Output "---- tail ----"
    Get-Content $log -ErrorAction SilentlyContinue |
      Where-Object { $_ -notmatch '^\s*(\S*\[\d+m)*\s*(Compiling|Checking|Fresh|Building|Blocking)\b' } |
      Select-Object -Last 15
  }
  "down" { Stop-Detached "app"; Write-Output "stopped" }
  default { Write-Output "APP_RUNNING=$(Test-AppRunning) CDP=$(Test-Cdp)" }
}
