<#
.SYNOPSIS
  Builds, signs and publishes a Raven release, desktop and Android. See docs/releasing.md.

.EXAMPLE
  .\release.ps1 build   -Version 0.1.0
  .\release.ps1 publish -Version 0.1.0
  .\release.ps1 repoint -Version 0.1.0
  .\release.ps1 status
  .\release.ps1 publish -Version 0.1.0 -Docker -GitHub   # also Docker Hub and GitHub
  .\release.ps1 images -Version 0.1.0   # server images to Docker Hub
  .\release.ps1 github -Version 0.1.0   # installers to a GitHub release
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet("help", "build", "publish", "repoint", "status", "images", "github")]
  [string]$Command = "help",
  [string]$Version,
  # Release notes shown in the app. Defaults to docs/release-notes/<version>.md when it exists.
  [string]$NotesFile,
  # The server a fresh install signs in to (people can change it on the sign-in screen).
  [string]$ApiUrl = "https://mimir.rvn.bluehour.cloud",
  [string]$SshTarget = "raven",
  [string]$WslDistro = "Ubuntu",
  # Build from a tree with uncommitted changes. For rehearsals, not for real releases.
  [switch]$AllowDirty,
  # Publish into a folder beside the real releases (for example "test") and leave the
  # real latest.json alone. Point a debug build at it with RAVEN_UPDATE_ENDPOINT.
  [string]$Scratch,
  # images: the Docker Hub account the server images are pushed to.
  [string]$ImageNamespace = "soroushtaheri",
  # images: push only the X.Y.Z tag, not :latest.
  [switch]$NoLatest,
  # images: build both platforms but push nothing.
  [switch]$DryRun,
  # publish: also push the server images to Docker Hub, before the update host.
  [switch]$Docker,
  # publish: also create the GitHub release, after the update host.
  [switch]$GitHub
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = $PSScriptRoot
$Desktop = Join-Path $Root "apps\desktop"
$PublicBase = "https://updates.rvn.bluehour.cloud"
$RemoteRoot = "/srv/raven/releases"
$PublicKey = Join-Path $Desktop "src-tauri\updater\raven-updater.key.pub"
$KeepVersions = 5
$GitHubRepo = "raven-collective/raven-prototype"
# The Android app (apps/desktop/web). $true builds, signs and publishes its APK with the
# installers; $false leaves it out of the release entirely.
$ReleaseAndroid = $false

if ($Scratch) {
  if ($Scratch -notmatch '^[a-z0-9-]+$') { throw "-Scratch must be a simple folder name such as 'test'." }
  $PublicBase = "$PublicBase/$Scratch"
  $RemoteRoot = "$RemoteRoot/$Scratch"
}

function Invoke-Native {
  param([string]$File, [string[]]$Arguments, [string]$WorkingDirectory = $Root)
  Push-Location $WorkingDirectory
  # Windows PowerShell turns a native program's stderr into errors when it is captured;
  # the exit code is what counts.
  $ErrorActionPreference = "Continue"
  try {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$File $($Arguments -join ' ') failed with exit code $LASTEXITCODE." }
  }
  finally { Pop-Location }
}

# Bash scripts go to Vala and WSL as files: piped from Windows PowerShell they would
# arrive with a byte-order mark and CRLF line endings, and bash rejects both.
function New-BashScript {
  param([string]$Script)
  $file = Join-Path ([IO.Path]::GetTempPath()) "raven-release-$([Guid]::NewGuid().ToString('N')).sh"
  [IO.File]::WriteAllText($file, (($Script -replace "`r", "") + "`n"), (New-Object Text.UTF8Encoding($false)))
  return $file
}

function Invoke-Remote {
  param([string]$Script)
  $file = New-BashScript $Script
  $ErrorActionPreference = "Continue"
  try {
    $output = & cmd.exe /d /c "ssh -o BatchMode=yes -o ConnectTimeout=8 $SshTarget bash -s < `"$file`""
    if ($LASTEXITCODE -ne 0) { throw "The command on $SshTarget failed with exit code $LASTEXITCODE." }
    return $output
  }
  finally { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
}

function Assert-Version {
  if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$') { throw "Pass -Version as a semantic version, for example 0.1.0." }
  $declared = [ordered]@{
    "apps/desktop/package.json"              = (Get-Content -Raw (Join-Path $Desktop "package.json") | ConvertFrom-Json).version
    "apps/desktop/src-tauri/tauri.conf.json" = (Get-Content -Raw (Join-Path $Desktop "src-tauri\tauri.conf.json") | ConvertFrom-Json).version
    "apps/desktop/src-tauri/Cargo.toml"      = [regex]::Match((Get-Content -Raw (Join-Path $Desktop "src-tauri\Cargo.toml")), '(?m)^version\s*=\s*"([^"]+)"').Groups[1].Value
    "packages/shared/package.json"           = (Get-Content -Raw (Join-Path $Root "packages\shared\package.json") | ConvertFrom-Json).version
  }
  foreach ($entry in $declared.GetEnumerator()) {
    if ($entry.Value -ne $Version) { throw "$($entry.Key) says version $($entry.Value), not $Version. Set the same version in all four files first." }
  }
}

function Get-Stage {
  $stage = Join-Path $Root ".release\$Version"
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  return $stage
}

function Get-Artifacts {
  param([string]$Stage)
  $artifacts = [ordered]@{
    "windows-x86_64" = Join-Path $Stage "Raven_${Version}_x64-setup.exe"
    "linux-x86_64"   = Join-Path $Stage "Raven_${Version}_amd64.AppImage"
  }
  if ($ReleaseAndroid) { $artifacts["android"] = Join-Path $Stage "Raven_${Version}.apk" }
  return $artifacts
}

function Get-Sha256 {
  param([string]$Path)
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Get-TauriCli {
  foreach ($name in @("tauri.exe", "tauri.cmd")) {
    $candidate = Join-Path $Desktop "node_modules\.bin\$name"
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  throw "The Tauri CLI is missing. Run 'bun install' in apps/desktop."
}

function Invoke-Sign {
  param([string]$Artifact)
  $keyDirectory = Join-Path $env:USERPROFILE ".raven\updater"
  $key = Join-Path $keyDirectory "raven-updater.key"
  $passwordFile = Join-Path $keyDirectory "raven-updater.password.dpapi"
  if (-not (Test-Path -LiteralPath $key) -or -not (Test-Path -LiteralPath $passwordFile)) {
    throw "The updater signing key or its password file is missing from $keyDirectory."
  }
  $secure = ConvertTo-SecureString ((Get-Content -Raw -LiteralPath $passwordFile).Trim())
  $env:TAURI_SIGNING_PRIVATE_KEY_PATH = $key
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [System.Net.NetworkCredential]::new("", $secure).Password
  try {
    Remove-Item -LiteralPath "$Artifact.sig" -ErrorAction SilentlyContinue
    Invoke-Native (Get-TauriCli) @("signer", "sign", $Artifact) $Desktop | Out-Null
  }
  finally {
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PATH, Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
  }
  Assert-Signature $Artifact
}

# Checks the artifact against the public key built into the app, exactly as Raven will.
function Assert-Signature {
  param([string]$Artifact)
  if (-not (Test-Path -LiteralPath "$Artifact.sig")) { throw "$Artifact has no signature." }
  $manifest = Join-Path $Root "tools\release\signature-verify\Cargo.toml"
  Invoke-Native "cargo" @("run", "--quiet", "--locked", "--manifest-path", $manifest, "--", $Artifact, "$Artifact.sig", $PublicKey) | Out-Null
}

function Build-Windows {
  param([string]$Stage, [string]$Destination)
  Write-Host "== Building the Windows installer"
  $env:VITE_RAVEN_API_URL = $ApiUrl
  # A target directory of its own, so a running 'tauri dev' is not disturbed.
  $env:CARGO_TARGET_DIR = Join-Path $env:USERPROFILE "rvr"
  $bundles = Join-Path $env:CARGO_TARGET_DIR "release\bundle\nsis"
  Remove-Item -Recurse -Force -LiteralPath $bundles -ErrorAction SilentlyContinue
  Invoke-Native "bun" @("run", "tauri", "build", "--bundles", "nsis", "--config", (Join-Path $Root "infra\release\tauri.windows.release.conf.json"), "--ci") $Desktop
  $built = @(Get-ChildItem -LiteralPath $bundles -File -Filter "*.exe")
  if ($built.Count -ne 1) { throw "Expected exactly one Windows installer in $bundles, found $($built.Count)." }
  Copy-Item -LiteralPath $built[0].FullName -Destination $Destination -Force
}

function Build-Linux {
  param([string]$Stage, [string]$Destination, [string]$Commit)
  Write-Host "== Building the Linux AppImage in WSL ($WslDistro)"
  $dist = Join-Path $Desktop "dist"
  if (-not (Test-Path -LiteralPath (Join-Path $dist "index.html"))) { throw "apps/desktop/dist is missing; the Windows build creates it." }
  $sourceTar = Join-Path $Stage "source.tar"
  $distTar = Join-Path $Stage "dist.tar"
  # 'git archive' gives the committed line endings (LF), which the shell scripts need.
  Invoke-Native "git" @("archive", "--format=tar", "--output=$sourceTar", $Commit)
  Invoke-Native "tar.exe" @("-cf", $distTar, "-C", $Root, "apps/desktop/dist")
  $stageInWsl = (& wsl.exe -d $WslDistro -- wslpath -a ($Stage -replace '\\', '/')).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $stageInWsl) { throw "Could not reach the WSL distro '$WslDistro'." }
  $script = @"
set -euo pipefail
command -v docker >/dev/null || { echo 'Docker is not installed in this WSL distro. See docs/releasing.md.' >&2; exit 3; }
base="`$HOME/raven-build"
rm -rf "`$base/source"
mkdir -p "`$base/source" "`$base/out"
tar -xf '$stageInWsl/source.tar' -C "`$base/source"
tar -xf '$stageInWsl/dist.tar' -C "`$base/source"
bash "`$base/source/infra/release/build-linux-appimage.sh" "`$base/source" '$Version' "`$base/out"
cp "`$base/out/Raven_${Version}_amd64.AppImage" "`$base/out/compatibility-linux.txt" '$stageInWsl/'
"@
  $scriptFile = Join-Path $Stage "build-linux.sh"
  [IO.File]::WriteAllText($scriptFile, (($script -replace "`r", "") + "`n"), (New-Object Text.UTF8Encoding($false)))
  $ErrorActionPreference = "Continue"
  & wsl.exe -d $WslDistro --cd $Stage -- bash ./build-linux.sh
  $ErrorActionPreference = "Stop"
  if ($LASTEXITCODE -ne 0) { throw "The Linux build failed with exit code $LASTEXITCODE." }
  Remove-Item -LiteralPath $scriptFile -Force
  Remove-Item -LiteralPath $sourceTar, $distTar -Force
  if (-not (Test-Path -LiteralPath $Destination)) { throw "The Linux build did not produce $Destination." }
}

# Android only installs an app over an older one signed with the same key, so every
# release is signed with this one key, kept beside the updater key on this PC.
function Build-Android {
  param([string]$Destination)
  Write-Host "== Building the Android app"
  $keyDirectory = Join-Path $env:USERPROFILE ".raven\android"
  $keystore = Join-Path $keyDirectory "raven-android.keystore"
  $passwordFile = Join-Path $keyDirectory "raven-android.password.dpapi"
  if (-not (Test-Path -LiteralPath $keystore) -or -not (Test-Path -LiteralPath $passwordFile)) {
    throw "The Android signing key or its password file is missing from $keyDirectory. See docs/releasing.md."
  }
  $apksigner = Join-Path (Get-ChildItem -Directory -LiteralPath (Join-Path $env:ANDROID_HOME "build-tools") | Sort-Object { [version]$_.Name } | Select-Object -Last 1).FullName "apksigner.bat"
  $env:VITE_RAVEN_API_URL = $ApiUrl
  Invoke-Native "bun" @("run", "web:android") $Desktop
  $secure = ConvertTo-SecureString ((Get-Content -Raw -LiteralPath $passwordFile).Trim())
  $env:RAVEN_ANDROID_KEY_PASSWORD = [System.Net.NetworkCredential]::new("", $secure).Password
  try {
    $unsigned = Join-Path $Desktop "web\android\app\build\outputs\apk\release\app-release-unsigned.apk"
    Invoke-Native $apksigner @("sign", "--ks", $keystore, "--ks-pass", "env:RAVEN_ANDROID_KEY_PASSWORD", "--out", $Destination, $unsigned) | Out-Null
  }
  finally { Remove-Item Env:RAVEN_ANDROID_KEY_PASSWORD -ErrorAction SilentlyContinue }
  Invoke-Native $apksigner @("verify", $Destination) | Out-Null
}

# The notes of every version before this one, so someone several versions behind sees them all.
function Get-NotesHistory([string]$Current) {
  $currentCore = [version]($Current -replace '-.*$', '')
  $entries = foreach ($file in Get-ChildItem -LiteralPath (Join-Path $Root "docs/release-notes") -Filter "*.md") {
    $name = $file.BaseName
    $core = [version]::new()
    if ([version]::TryParse(($name -replace '-.*$', ''), [ref]$core) -and $core -lt $currentCore) {
      [ordered]@{ version = $name; notes = (Get-Content -Raw -Encoding UTF8 -LiteralPath $file.FullName).Trim() }
    }
  }
  return , @($entries)
}

function Invoke-Build {
  Assert-Version
  $dirty = @(& git -C $Root status --porcelain)
  if ($dirty.Count -gt 0 -and -not $AllowDirty) {
    throw "The working tree has uncommitted changes. Commit them, or pass -AllowDirty for a rehearsal."
  }
  $commit = (& git -C $Root rev-parse HEAD).Trim()
  if ($dirty.Count -gt 0) {
    # A throwaway commit of the working tree (new files included), made through a
    # temporary index so the real index and branch are untouched. Both platforms then
    # build the same source.
    $ErrorActionPreference = "Continue"
    $env:GIT_INDEX_FILE = Join-Path ([IO.Path]::GetTempPath()) "raven-release-index-$PID"
    try {
      & git -C $Root read-tree HEAD 2>$null
      & git -C $Root add -A 2>$null
      $tree = (& git -C $Root write-tree 2>$null)
      $snapshot = (& git -C $Root commit-tree $tree -p HEAD -m "release rehearsal snapshot" 2>$null)
    }
    finally {
      Remove-Item -LiteralPath $env:GIT_INDEX_FILE -Force -ErrorAction SilentlyContinue
      Remove-Item Env:GIT_INDEX_FILE
      $ErrorActionPreference = "Stop"
    }
    if (-not $snapshot) { throw "Could not snapshot the working tree." }
    $commit = "$snapshot".Trim()
    Write-Warning "Building with uncommitted changes (rehearsal)."
  }
  $stage = Get-Stage
  $artifacts = Get-Artifacts $stage
  # Each installer is signed, and the signature checked, as soon as it exists.
  Build-Windows $stage $artifacts["windows-x86_64"]
  Invoke-Sign $artifacts["windows-x86_64"]
  Build-Linux $stage $artifacts["linux-x86_64"] $commit
  Invoke-Sign $artifacts["linux-x86_64"]
  if ($ReleaseAndroid) {
    Build-Android $artifacts["android"]
    Invoke-Sign $artifacts["android"]
  }

  $notesPath = if ($NotesFile) { $NotesFile } else { Join-Path $Root "docs/release-notes/$Version.md" }
  $notes = if (Test-Path -LiteralPath $notesPath) { (Get-Content -Raw -Encoding UTF8 -LiteralPath $notesPath).Trim() } else { "" }
  $history = Get-NotesHistory $Version
  $platforms = [ordered]@{}
  foreach ($entry in $artifacts.GetEnumerator()) {
    $platforms[$entry.Key] = [ordered]@{
      signature = (Get-Content -Raw -LiteralPath "$($entry.Value).sig").Trim()
      url       = "$PublicBase/$Version/$(Split-Path -Leaf $entry.Value)"
    }
  }
  $manifest = [ordered]@{
    version   = $Version
    notes     = $notes
    history   = $history
    pub_date  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    commit    = $commit
    platforms = $platforms
  }
  [IO.File]::WriteAllText((Join-Path $stage "latest.json"), ($manifest | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))

  Write-Host ""
  Write-Host "Raven $Version is built and signed in $stage"
  foreach ($artifact in $artifacts.Values) { Write-Host ("  {0}  {1:N1} MB" -f (Split-Path -Leaf $artifact), ((Get-Item $artifact).Length / 1MB)) }
  Write-Host "Send these files to friends for a first install. Then: .\release.ps1 publish -Version $Version"
}

# Fetches the manifest and both installers the way a friend's Raven will (through the
# CDN) and compares them with what was built.
function Assert-PublicRelease {
  param([string]$Stage)
  Write-Host "== Checking the public download path"
  $expected = Get-Content -Raw -LiteralPath (Join-Path $Stage "latest.json") | ConvertFrom-Json
  $live = $null
  foreach ($attempt in 1..5) {
    try {
      $live = Invoke-RestMethod -Uri "$PublicBase/latest.json?t=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())" -Headers @{ "Cache-Control" = "no-cache" } -TimeoutSec 30
      if ($live.version -eq $expected.version) { break }
    }
    catch { $live = $null }
    Start-Sleep -Seconds 4
  }
  if (-not $live -or $live.version -ne $expected.version) { throw "$PublicBase/latest.json does not show version $($expected.version) yet." }
  $download = Join-Path $Stage "public-check.tmp"
  try {
    foreach ($artifact in (Get-Artifacts $Stage).Values) {
      $url = "$PublicBase/$Version/$(Split-Path -Leaf $artifact)"
      Invoke-WebRequest -Uri $url -OutFile $download -TimeoutSec 900 -UseBasicParsing
      if ((Get-Sha256 $download) -ne (Get-Sha256 $artifact)) { throw "$url does not match the file that was built." }
      Write-Host "  ok  $url"
    }
  }
  finally { Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue }
}

function Invoke-Publish {
  Assert-Version
  if ($DryRun) { throw "-DryRun only works with the images command." }
  if ($Scratch -and ($Docker -or $GitHub)) { throw "-Scratch publishes only to the scratch folder; leave out -Docker and -GitHub." }
  $stage = Get-Stage
  $artifacts = Get-Artifacts $stage
  $manifest = Join-Path $stage "latest.json"
  $files = @($artifacts.Values) + @($artifacts.Values | ForEach-Object { "$_.sig" }) + @($manifest)
  foreach ($file in $files) {
    if (-not (Test-Path -LiteralPath $file)) { throw "$file is missing. Run: .\release.ps1 build -Version $Version" }
  }
  foreach ($artifact in $artifacts.Values) { Assert-Signature $artifact }
  if ((Get-Content -Raw -LiteralPath $manifest | ConvertFrom-Json).platforms."windows-x86_64".url -notlike "$PublicBase/*") {
    throw "This build was made for a different destination. Rebuild with the same -Scratch value you publish with."
  }
  # Refuse early, before friends are told about a version that cannot reach GitHub.
  if ($GitHub) {
    Get-ReleaseCommit $stage | Out-Null
    Assert-GitHubAccess
  }
  # Server images first, so they exist before any client that needs them is offered.
  if ($Docker) { Invoke-Images }

  $checksums = ($files | ForEach-Object { "$(Get-Sha256 $_)  $(Split-Path -Leaf $_)" }) -join "`n"
  $incoming = "$RemoteRoot/.incoming-$Version"
  $final = "$RemoteRoot/$Version"

  Write-Host "== Uploading to $SshTarget"
  $state = Invoke-Remote @"
set -euo pipefail
mkdir -p '$RemoteRoot'
if [ -d '$final' ]; then
  cd '$final'
  if printf '%s\n' '$checksums' | grep -v ' latest.json$' | sha256sum --check --status -; then echo same; else echo different; fi
else
  rm -rf '$incoming'; mkdir -p '$incoming'; echo new
fi
"@
  if ("$state".Trim() -eq "different") {
    throw "Version $Version is already published with different files. A published version never changes: bump the version and build again."
  }
  if ("$state".Trim() -eq "new") {
    foreach ($file in $files) { Invoke-Native "scp" @("-q", "-o", "BatchMode=yes", $file, "${SshTarget}:$incoming/") }
    Invoke-Remote @"
set -euo pipefail
cd '$incoming'
printf '%s\n' '$checksums' | sha256sum --check --quiet -
chmod 0644 ./*
mv '$incoming' '$final'
"@ | Out-Null
  }
  else { Write-Host "  version $Version is already on the server with identical files" }

  Set-Latest
  Assert-PublicRelease $stage
  Write-Host ""
  Write-Host "Raven $Version is published. Friends will be told about it the next time their Raven checks."
  if ($GitHub) { Invoke-GitHub }
}

# Makes <version>/latest.json the live manifest. The swap is a rename, so a client never
# reads a half-written file; the manifest it replaces is kept as latest.previous.json.
function Get-DownloadPage {
  $android = if ($ReleaseAndroid) { @"
  <div class="card">
    <h2>Android</h2>
    <a class="button" href="$Version/Raven_${Version}.apk">Download for Android</a>
    <p>Open the file and allow installing from your browser when Android asks. For a newer version, download and open the new file the same way.</p>
  </div>
"@ } else { "" }
  return @"
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Download Raven</title>
<style>
  :root { color-scheme: light dark; --bg: #f7f8f9; --fg: #16181d; --muted: #5b6270; --card: #ffffff; --line: #dde1e6; --accent: #0f7f86; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111317; --fg: #e8eaee; --muted: #9aa1ad; --card: #191c21; --line: #2a2e35; --accent: #6fd3d8; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 640px; margin: 0 auto; padding: 56px 16px; }
  h1 { font-size: 28px; margin: 0 0 4px; }
  p { color: var(--muted); margin: 0 0 16px; }
  a { color: var(--accent); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin: 16px 0; }
  .card h2 { font-size: 18px; margin: 0 0 8px; }
  .button { display: inline-block; background: var(--accent); color: var(--bg); text-decoration: none; font-weight: 600; padding: 10px 16px; border-radius: 8px; margin-bottom: 12px; }
  code { font-size: 14px; }
</style>
</head>
<body>
<main>
  <h1>Raven $Version</h1>
  <p>Calls, screen sharing and chat with your friends. Install Raven, then enter your server's address on the sign-in screen. Raven tells you when a newer version is out.</p>
  <div class="card">
    <h2>Windows</h2>
    <a class="button" href="$Version/Raven_${Version}_x64-setup.exe">Download for Windows</a>
    <p>Windows may say the publisher is unknown. Choose "More info", then "Run anyway".</p>
  </div>
  <div class="card">
    <h2>Linux</h2>
    <a class="button" href="$Version/Raven_${Version}_amd64.AppImage">Download the AppImage</a>
    <p>Make it executable with <code>chmod +x Raven_${Version}_amd64.AppImage</code>. On newer Ubuntu, install <code>libfuse2t64</code> first.</p>
  </div>
$android
  <p>Running your own server? See the <a href="https://github.com/raven-collective/raven-prototype/blob/main/docs/self-hosting.md">self-hosting guide</a>.</p>
</main>
</body>
</html>
"@
}

function Set-Latest {
  Write-Host "== Pointing latest.json at $Version"
  Invoke-Remote @"
set -euo pipefail
cd '$RemoteRoot'
test -f '$Version/latest.json' || { echo 'Version $Version is not on the server.' >&2; exit 4; }
# Re-pointing at the live version must not overwrite the record of the one before it.
if [ -f latest.json ] && ! cmp -s latest.json '$Version/latest.json'; then cp -p latest.json latest.previous.json; fi
cp '$Version/latest.json' .latest.json.new
mv .latest.json.new latest.json
# The download page for people installing Raven for the first time. Links are relative,
# so the same page works under a -Scratch folder.
cat > .index.html.new <<'PAGE'
$(Get-DownloadPage)
PAGE
chmod 0644 .index.html.new
mv .index.html.new index.html
# Keep the newest $KeepVersions versions (and always the live one); the disk here is small.
ls -1d [0-9]*/ 2>/dev/null | tr -d / | sort -V | head -n -$KeepVersions | while read -r old; do
  [ "`$old" = '$Version' ] || rm -rf -- "`$old"
done
"@ | Out-Null
}

function Invoke-Repoint {
  Assert-Version
  Set-Latest
  $live = Invoke-RestMethod -Uri "$PublicBase/latest.json?t=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())" -TimeoutSec 30
  Write-Host "latest.json now offers Raven $($live.version)."
  Write-Host "Raven only installs versions newer than the one running, so nobody is downgraded."
  Write-Host "Anyone already on a bad version reinstalls from: $($live.platforms.'windows-x86_64'.url) or $($live.platforms.'linux-x86_64'.url)"
}

function Invoke-Status {
  $remote = Invoke-Remote @"
cd '$RemoteRoot' 2>/dev/null || { echo '(nothing published yet)'; exit 0; }
ls -1d [0-9]*/ 2>/dev/null | tr -d / | sort -V | sed 's/^/  /'
du -sh . | cut -f1 | sed 's/^/Disk used: /'
"@
  Write-Host "Versions on ${SshTarget}:"
  $remote | ForEach-Object { Write-Host $_ }
  try {
    $live = Invoke-RestMethod -Uri "$PublicBase/latest.json?t=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())" -TimeoutSec 30
    Write-Host "Offered to friends: Raven $($live.version), published $($live.pub_date)"
  }
  catch { Write-Host "Offered to friends: nothing ($PublicBase/latest.json is not reachable)" }
}

# The commit the installers in this stage were built from. A rehearsal's throwaway
# snapshot is not on this branch, so it never reaches Docker Hub or GitHub.
function Get-ReleaseCommit {
  param([string]$Stage)
  $manifest = Join-Path $Stage "latest.json"
  if (-not (Test-Path -LiteralPath $manifest)) { throw "$manifest is missing. Run: .\release.ps1 build -Version $Version" }
  $commit = (Get-Content -Raw -Encoding UTF8 -LiteralPath $manifest | ConvertFrom-Json).commit
  $ErrorActionPreference = "Continue"
  & git -C $Root merge-base --is-ancestor $commit HEAD 2>$null
  $onBranch = $LASTEXITCODE -eq 0
  $ErrorActionPreference = "Stop"
  if (-not $onBranch) { throw "Version $Version was built from $commit, which is not on this branch. Was it a rehearsal? Build it again from a commit." }
  return $commit
}

function Assert-GitHubAccess {
  Invoke-Native "gh" @("auth", "status") | Out-Null
}

# Compares what GitHub serves with what was built. A published version never changes.
function Assert-GitHubRelease {
  param([string]$Tag, [string[]]$Files)
  Write-Host "== Checking the GitHub release"
  $download = Join-Path (Split-Path -Parent $Files[0]) "github-check"
  Remove-Item -Recurse -Force -LiteralPath $download -ErrorAction SilentlyContinue
  try {
    Invoke-Native "gh" @("release", "download", $Tag, "--repo", $GitHubRepo, "--dir", $download)
    foreach ($file in $Files) {
      $name = Split-Path -Leaf $file
      $copy = Join-Path $download $name
      if (-not (Test-Path -LiteralPath $copy)) { throw "The GitHub release $Tag has no $name." }
      if ((Get-Sha256 $copy) -ne (Get-Sha256 $file)) { throw "$name on the GitHub release $Tag differs from this build. A published version never changes: bump the version and build again." }
      Write-Host "  ok  $name"
    }
  }
  finally { Remove-Item -Recurse -Force -LiteralPath $download -ErrorAction SilentlyContinue }
}

function Invoke-GitHub {
  Assert-Version
  if ($Scratch) { throw "-Scratch publishes only to the scratch folder; it does not apply to GitHub." }
  $stage = Get-Stage
  $commit = Get-ReleaseCommit $stage
  $artifacts = Get-Artifacts $stage
  foreach ($artifact in $artifacts.Values) {
    if (-not (Test-Path -LiteralPath $artifact)) { throw "$artifact is missing. Run: .\release.ps1 build -Version $Version" }
    Assert-Signature $artifact
  }
  Assert-GitHubAccess
  $tag = "v$Version"

  $ErrorActionPreference = "Continue"
  $tagged = (& git -C $Root rev-parse --quiet --verify "refs/tags/$tag^{commit}" 2>$null)
  $ErrorActionPreference = "Stop"
  if ($tagged -and "$tagged".Trim() -ne $commit) { throw "Tag $tag points at $tagged, not at the release commit $commit." }
  if (-not $tagged) { Invoke-Native "git" @("tag", "-a", $tag, "-m", "Raven $Version", $commit) }

  # Publishes the release commit and its history, not whatever came after it locally.
  # Git refuses this if GitHub's main has diverged.
  Write-Host "== Pushing $tag to GitHub"
  Invoke-Native "git" @("fetch", "--quiet", "origin", "main")
  $ErrorActionPreference = "Continue"
  & git -C $Root merge-base --is-ancestor $commit FETCH_HEAD 2>$null
  $onMain = $LASTEXITCODE -eq 0
  $ErrorActionPreference = "Stop"
  $refs = @("refs/tags/$tag")
  if (-not $onMain) { $refs += "${commit}:refs/heads/main" }
  Invoke-Native "git" (@("push", "--atomic", "origin") + $refs)

  $sums = Join-Path $stage "SHA256SUMS"
  $names = @($artifacts.Values)
  $text = ($names | ForEach-Object { "$(Get-Sha256 $_)  $(Split-Path -Leaf $_)" }) -join "`n"
  [IO.File]::WriteAllText($sums, "$text`n", (New-Object Text.UTF8Encoding($false)))
  $files = $names + @($sums)

  $ErrorActionPreference = "Continue"
  $draft = (& gh release view $tag --repo $GitHubRepo --json isDraft --jq .isDraft 2>$null)
  $exists = $LASTEXITCODE -eq 0
  $ErrorActionPreference = "Stop"
  if ($exists -and "$draft".Trim() -eq "true") {
    throw "An unfinished draft of $tag is on GitHub. Remove it, then run this again: gh release delete $tag --repo $GitHubRepo"
  }
  if ($exists) { Write-Host "  release $tag is already on GitHub" }
  else {
    $notes = (Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $stage "latest.json") | ConvertFrom-Json).notes
    $android = if ($ReleaseAndroid) { "`n- **Android:** ``Raven_${Version}.apk``. Open it and allow installing from your browser when Android asks." } else { "" }
    $body = @"
$notes

## Install

- **Windows:** ``Raven_${Version}_x64-setup.exe``. Windows may say the publisher is unknown: choose "More info", then "Run anyway".
- **Linux:** ``Raven_${Version}_amd64.AppImage``. Run ``chmod +x`` on it. On newer Ubuntu, install ``libfuse2t64`` first.$android

Raven tells you when a newer version is out.

## Your own server

Server images are on Docker Hub: [soroushtaheri/raven-api](https://hub.docker.com/r/soroushtaheri/raven-api) and [soroushtaheri/raven-admin](https://hub.docker.com/r/soroushtaheri/raven-admin). See the [self-hosting guide](https://github.com/$GitHubRepo/blob/$tag/docs/self-hosting.md).
"@
    $bodyFile = Join-Path $stage "github-notes.md"
    [IO.File]::WriteAllText($bodyFile, ($body -replace "`r", ""), (New-Object Text.UTF8Encoding($false)))
    Write-Host "== Creating the GitHub release $tag"
    Invoke-Native "gh" (@("release", "create", $tag, "--repo", $GitHubRepo, "--verify-tag", "--title", "Raven $Version", "--notes-file", $bodyFile) + $files)
    Remove-Item -LiteralPath $bodyFile -Force
  }
  Assert-GitHubRelease $tag $files
  Write-Host "https://github.com/$GitHubRepo/releases/tag/$tag"
}

function Invoke-Images {
  Assert-Version
  $stage = Get-Stage
  if (-not $DryRun -and (Test-Path -LiteralPath (Join-Path $stage "latest.json"))) {
    # Same commit as the installers of this version, whatever has happened on the branch since.
    $commit = Get-ReleaseCommit $stage
  }
  else {
    $dirty = @(& git -C $Root status --porcelain)
    if ($dirty.Count -gt 0 -and -not $AllowDirty) {
      throw "The working tree has uncommitted changes. Commit them, or pass -AllowDirty for a rehearsal."
    }
    if ($dirty.Count -gt 0 -and -not $DryRun) { throw "-AllowDirty only works with -DryRun: published images must come from a commit." }
    $commit = "HEAD"
    if ($dirty.Count -gt 0) { Write-Warning "Building the last commit (HEAD); uncommitted changes are not in the images." }
  }
  Write-Host "== Building the server images in WSL ($WslDistro)"
  $sourceTar = Join-Path $Stage "source.tar"
  # 'git archive' gives the committed line endings (LF), which the Dockerfiles and scripts need.
  Invoke-Native "git" @("archive", "--format=tar", "--output=$sourceTar", $commit)
  $stageInWsl = (& wsl.exe -d $WslDistro -- wslpath -a ($stage -replace '\\', '/')).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $stageInWsl) { throw "Could not reach the WSL distro '$WslDistro'." }
  $tags = if ($NoLatest) { "" } else { " -t $ImageNamespace/raven-`$name:latest" }
  $output = if ($DryRun) { "--output type=image,push=false" } else { "--push" }
  $script = @"
set -euo pipefail
command -v docker >/dev/null || { echo 'Docker is not installed in this WSL distro. See docs/releasing.md.' >&2; exit 3; }
docker buildx version >/dev/null || { echo 'docker buildx is missing in this WSL distro.' >&2; exit 3; }
docker buildx inspect raven-multi >/dev/null 2>&1 || docker buildx create --name raven-multi >/dev/null
base="`$HOME/raven-images"
rm -rf "`$base/source"
mkdir -p "`$base/source"
tar -xf '$stageInWsl/source.tar' -C "`$base/source"
cd "`$base/source"
for name in api admin; do
  docker buildx build --builder raven-multi --platform linux/amd64,linux/arm64     -f infra/homelab/`$name.Dockerfile --build-arg RAVEN_VERSION=$Version     -t $ImageNamespace/raven-`$name:$Version$tags $output .
done
if [ '$DryRun' = 'False' ]; then
  for name in api admin; do
    docker buildx imagetools inspect $ImageNamespace/raven-`$name:$Version | grep -E '^(Name|Digest)'
  done
fi
"@
  $scriptFile = Join-Path $stage "build-images.sh"
  [IO.File]::WriteAllText($scriptFile, (($script -replace "`r", "") + "`n"), (New-Object Text.UTF8Encoding($false)))
  $ErrorActionPreference = "Continue"
  & wsl.exe -d $WslDistro --cd $stage -- bash ./build-images.sh
  $code = $LASTEXITCODE
  $ErrorActionPreference = "Stop"
  Remove-Item -LiteralPath $scriptFile, $sourceTar -Force -ErrorAction SilentlyContinue
  if ($code -ne 0) { throw "The image build failed with exit code $code. If the push was refused, run 'docker login' in WSL once." }
  if ($DryRun) { Write-Host "Dry run: both images build for amd64 and arm64; nothing was pushed." }
  else { Write-Host "Pushed $ImageNamespace/raven-api and $ImageNamespace/raven-admin $Version." }
}

switch ($Command) {
  "build" { Invoke-Build }
  "publish" { Invoke-Publish }
  "repoint" { Invoke-Repoint }
  "status" { Invoke-Status }
  "images" { Invoke-Images }
  "github" { Invoke-GitHub }
  default { Get-Help $PSCommandPath -Examples }
}
