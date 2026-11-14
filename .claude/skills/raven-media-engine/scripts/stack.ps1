# Local backend for exercising a real call: the Raven API built from the working tree and,
# when LIVEKIT_URL in .env points at this machine, a LiveKit dev server on that port.
#
#   stack.ps1 up        build + start both, wait for the ports
#   stack.ps1 status
#   stack.ps1 lk-down   kill only LiveKit (simulate an outage mid-call)
#   stack.ps1 lk-up     start LiveKit again
#   stack.ps1 down      stop everything this script started
#
# Addresses and keys come from the repository .env; nothing secret is printed or written.
param([Parameter(Position = 0)][string]$Action = "status")
. "$PSScriptRoot\_common.ps1"

$api = Split-Endpoint (Get-RavenEnv "RAVEN_API_ADDR") 6977
if (-not $api) { $api = [pscustomobject]@{ Host = "127.0.0.1"; Port = 6977 } }
$livekit = Split-Endpoint (Get-RavenEnv "LIVEKIT_URL") 7880
if (-not $livekit) { $livekit = [pscustomobject]@{ Host = "127.0.0.1"; Port = 7880 } }
$livekitIsLocal = Test-LocalAddress $livekit.Host

function Start-LiveKit {
  if (-not $livekitIsLocal) {
    Write-Output "LIVEKIT_URL points at $($livekit.Host), not this machine: not starting a local server."
    return
  }
  if (Test-Port $livekit.Host $livekit.Port) {
    Write-Output "Something already listens on $($livekit.Host):$($livekit.Port); using it as it is."
    return
  }
  $exe = (Get-Command "livekit-server" -ErrorAction SilentlyContinue).Source
  if (-not $exe) { $exe = Join-Path $env:USERPROFILE "livekit-server.exe" }
  if (-not (Test-Path $exe)) { Write-Output "livekit-server not found on PATH or in $env:USERPROFILE"; return }

  $config = Join-Path $RigDir "livekit.yaml"
  @(
    "port: $($livekit.Port)",
    "rtc:",
    "  tcp_port: $($livekit.Port + 1)",
    "  udp_port: $($livekit.Port + 2)",
    "  use_external_ip: false"
  ) | Set-Content -Path $config -Encoding ascii

  $loopback = $livekit.Host -in @("127.0.0.1", "localhost")
  $bind = if ($loopback) { "127.0.0.1" } else { "0.0.0.0" }
  $nodeIp = if ($loopback) { "127.0.0.1" } else { $livekit.Host }

  # Keys reach the server through its environment, never through a file.
  $key = Get-RavenEnv "LIVEKIT_API_KEY"; if (-not $key) { $key = "devkey" }
  $secret = Get-RavenEnv "LIVEKIT_API_SECRET"; if (-not $secret) { $secret = "secret" }
  $env:LIVEKIT_KEYS = "${key}: ${secret}"
  Start-Detached "livekit" @(
    "`"$exe`" --dev --bind $bind --node-ip $nodeIp --config `"$config`" > `"$RigDir\livekit.log`" 2>&1"
  ) | Out-Null
  Remove-Item Env:\LIVEKIT_KEYS -ErrorAction SilentlyContinue
}

# Only ever stops the server this script started (by its recorded process tree).
function Stop-LiveKit { Stop-Detached "livekit" }

function Wait-Port([string]$Address, [int]$Port, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Port $Address $Port) { return $true }
    Start-Sleep -Milliseconds 300
  }
  return $false
}

function Write-Status {
  Write-Output "API $($api.Host):$($api.Port) up=$(Test-Port $api.Host $api.Port)   LiveKit $($livekit.Host):$($livekit.Port) up=$(Test-Port $livekit.Host $livekit.Port) local=$livekitIsLocal"
}

switch ($Action) {
  "up" {
    Stop-Detached "api"; Stop-LiveKit
    if (Test-Port $api.Host $api.Port) {
      Write-Output "An API already listens on $($api.Host):$($api.Port); it was not started by this rig, so it is left alone."
      Start-LiveKit
      if ($livekitIsLocal) { Wait-Port $livekit.Host $livekit.Port 30 | Out-Null }
      Write-Status
      return
    }
    $binary = Join-Path $RigDir "raven-api.exe"
    Push-Location (Join-Path $RavenRepo "services\api")
    & go build -o $binary ./cmd/raven-api
    $built = $LASTEXITCODE -eq 0
    Pop-Location
    if (-not $built) { Write-Output "API build failed"; exit 1 }

    Start-LiveKit
    # The API reads ..\..\.env relative to its working directory.
    Start-Detached "api" @(
      "cd /d `"$RavenRepo\services\api`"",
      "`"$binary`" > `"$RigDir\api.log`" 2>&1"
    ) | Out-Null

    Wait-Port $api.Host $api.Port 30 | Out-Null
    if ($livekitIsLocal) { Wait-Port $livekit.Host $livekit.Port 30 | Out-Null }
    Write-Status
    Write-Output "logs: $RigDir\api.log, $RigDir\livekit.log"
  }
  "lk-down" { Stop-LiveKit; Write-Output "livekit stopped at $(Get-Date -Format HH:mm:ss.fff)" }
  "lk-up" {
    Start-LiveKit
    Wait-Port $livekit.Host $livekit.Port 20 | Out-Null
    Write-Output "livekit up=$(Test-Port $livekit.Host $livekit.Port) at $(Get-Date -Format HH:mm:ss.fff)"
  }
  "down" {
    Stop-Detached "api"; Stop-LiveKit
    Write-Output "stopped"
  }
  default { Write-Status }
}
