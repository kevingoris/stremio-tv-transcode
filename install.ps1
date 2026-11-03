# install.ps1 — installs (or removes) tv-transcode in Stremio Service on Windows.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1             # install / re-apply after an update
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall  # remove
#
# Copies tv-transcode.js next to server.js and adds a small hook to server.js
# (it keeps a backup of the original). Then it restarts Stremio Service.

param(
    [string]$StremioDir = "$env:LOCALAPPDATA\Programs\StremioService",
    [switch]$Uninstall,
    [switch]$NoRestart
)

$ErrorActionPreference = "Stop"
$serverJs = Join-Path $StremioDir "server.js"
if (-not (Test-Path $serverJs)) { throw "Can't find $serverJs. Pass -StremioDir with the Stremio Service folder." }

$utf8 = New-Object System.Text.UTF8Encoding($false)   # no BOM
$code = [IO.File]::ReadAllText($serverJs, $utf8)
$begin = "/* tv-transcode:begin */"
$end = "/* tv-transcode:end */"
$anchor = 'EngineFS.emit("stream-open", e.infoHash, e.files.indexOf(handle));'
$hook = @"
$begin if (!req.__tvChecked) { req.__tvChecked = !0; var tvTranscode = null; try { tvTranscode = require(path.join(path.dirname(process.execPath), "tv-transcode.js")); } catch (ex) { console.error("tv-transcode:", ex); } if (tvTranscode) return tvTranscode.maybeHandle(req, res, e, e.files.indexOf(handle), handle.name, (function(handled) { handled || handleTorrent(req, res, next); })); } $end
"@

$pattern = [regex]::Escape($begin) + ".*?" + [regex]::Escape($end) + "\r?\n?\s*"
$clean = [regex]::Replace($code, $pattern, "", "Singleline")

if ($Uninstall) {
    [IO.File]::WriteAllText($serverJs, $clean, $utf8)
    Remove-Item (Join-Path $StremioDir "tv-transcode.js") -ErrorAction SilentlyContinue
    Write-Host "Hook removed from server.js."
} else {
    $i = $clean.IndexOf($anchor)
    if ($i -lt 0) { throw "This version of server.js doesn't have the expected code (handleTorrent changed). The hook has to be adapted by hand; see README." }
    $backup = Join-Path $StremioDir "server.js.bak-tvtranscode"
    if (-not (Test-Path $backup)) { [IO.File]::WriteAllText($backup, $clean, $utf8) }
    $patched = $clean.Insert($i, $hook.Trim() + "`n            ")
    [IO.File]::WriteAllText($serverJs, $patched, $utf8)
    Copy-Item (Join-Path $PSScriptRoot "tv-transcode.js") $StremioDir -Force
    Write-Host "Installed. Original server.js backup: $backup"
}

if (-not $NoRestart) {
    $exe = Join-Path $StremioDir "stremio-service.exe"
    & taskkill.exe /IM stremio-service.exe 2>&1 | Out-Null
    Start-Sleep -Seconds 5
    Get-Process | Where-Object { $_.ProcessName -match "stremio" } | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    if (Test-Path $exe) { Start-Process -FilePath $exe -WorkingDirectory $StremioDir; Write-Host "Stremio Service restarted." }
}
