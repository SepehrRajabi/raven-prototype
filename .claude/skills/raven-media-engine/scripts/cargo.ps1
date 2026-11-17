# Run cargo for the Raven desktop crate with the project's native build environment
# (MSVC on PATH, short target dir, libclang, C++20) — the same setup scripts\tauri.ps1 uses.
#
#   cargo.ps1 test --lib
#   cargo.ps1 test --lib dynamics::
#   cargo.ps1 check --lib --message-format short
#   cargo.ps1 clippy --lib
#   cargo.ps1 fmt --all
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$CargoArgs)
. "$PSScriptRoot\_common.ps1"

$desktop = Join-Path $RavenRepo "apps\desktop"
$log = Join-Path $RigDir "cargo.log"
$quoted = ($CargoArgs | ForEach-Object { '"' + $_ + '"' }) -join ' '
$code = 1

# The caller's working directory is restored afterwards.
Push-Location $desktop
try {
  . .\scripts\msvc-env.ps1 | Out-Null
  . .\scripts\native-build-env.ps1 | Out-Null
  Set-Location (Join-Path $desktop "src-tauri")
  cmd /c "cargo $quoted > `"$log`" 2>&1"
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}

Get-Content $log |
  Where-Object { $_ -notmatch '^\s*(Compiling|Checking|Fresh|Blocking|Downloaded|Downloading|Locking|Adding)\b' } |
  Select-Object -Last 120
Write-Output "CARGO_EXIT=$code  (full log: $log)"
