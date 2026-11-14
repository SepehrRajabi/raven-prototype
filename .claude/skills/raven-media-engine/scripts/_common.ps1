# Shared helpers for the Raven media test rig. Dot-source from the other scripts.
$ErrorActionPreference = "Continue"

function Resolve-RavenRepo {
  $candidates = @()
  if ($env:RAVEN_REPO) { $candidates += $env:RAVEN_REPO }
  $top = (& git rev-parse --show-toplevel 2>$null)
  if ($top) { $candidates += ($top -replace "/", "\") }
  $dir = $PSScriptRoot
  while ($dir) {
    $candidates += $dir
    $parent = Split-Path -Parent $dir
    if ($parent -eq $dir) { break }
    $dir = $parent
  }
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path (Join-Path $candidate "apps\desktop\src-tauri\Cargo.toml"))) {
      return (Resolve-Path $candidate).Path
    }
  }
  throw "Raven repository not found. Set RAVEN_REPO to its root."
}

$RavenRepo = Resolve-RavenRepo
$RigDir = Join-Path $env:TEMP "raven-media-rig"
New-Item -ItemType Directory -Force -Path $RigDir | Out-Null

# Read one value from the repository .env without printing it.
function Get-RavenEnv([string]$Name) {
  $file = Join-Path $RavenRepo ".env"
  if (-not (Test-Path $file)) { return $null }
  $line = Get-Content $file | Where-Object { $_ -match "^\s*$Name\s*=" } | Select-Object -First 1
  if (-not $line) { return $null }
  return ($line -split "=", 2)[1].Trim().Trim('"').Trim("'")
}

# { Host, Port } for "host:port", "http://host:port" or "ws://host:port".
function Split-Endpoint([string]$Value, [int]$DefaultPort) {
  if (-not $Value) { return $null }
  if ($Value -notmatch "^[a-z]+://") { $Value = "tcp://$Value" }
  $uri = [Uri]$Value
  $port = if ($uri.Port -gt 0) { $uri.Port } else { $DefaultPort }
  return [pscustomobject]@{ Host = $uri.Host; Port = $port }
}

function Test-Port([string]$Address, [int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try { $client.Connect($Address, $Port); return $true } catch { return $false } finally { $client.Close() }
}

function Test-LocalAddress([string]$Address) {
  if ($Address -in @("127.0.0.1", "localhost", "::1")) { return $true }
  $own = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) | ForEach-Object { $_.IPAddressToString }
  return $own -contains $Address
}

# Start a command line detached, with its output in a log file. Going through a .cmd
# launcher (ShellExecute) keeps the child from inheriting this shell's pipes, so a
# caller that pipes this script's output is not held open by the background process.
function Start-Detached([string]$Name, [string[]]$Lines) {
  $launcher = Join-Path $RigDir "run-$Name.cmd"
  (@("@echo off") + $Lines) | Set-Content -Path $launcher -Encoding ascii
  $process = Start-Process -FilePath $launcher -WindowStyle Hidden -PassThru
  $process.Id | Set-Content (Join-Path $RigDir "$Name.pid")
  return $process
}

function Stop-Detached([string]$Name) {
  $pidFile = Join-Path $RigDir "$Name.pid"
  if (Test-Path $pidFile) {
    & taskkill /PID (Get-Content $pidFile) /T /F 2>$null | Out-Null
    Remove-Item $pidFile -ErrorAction SilentlyContinue
  }
}
