# detect-tv-codecs.ps1 — asks an Android TV, over ADB, which video formats it
# decodes in hardware, and writes tv-transcode.config.json with that.
#
#   powershell -ExecutionPolicy Bypass -File detect-tv-codecs.ps1 -TvIp 192.168.0.10
#
# Needs:
#   - adb (Android platform-tools): https://developer.android.com/tools/releases/platform-tools
#   - On the TV: Settings > Device Preferences > About > tap "Build" 7 times,
#     then Developer options > turn on "USB debugging" / "Network debugging".
#     The first time, the TV asks you to allow the connection from the PC.
#
# It reads the TV's media_codecs*.xml files (the list Android uses to know
# which decoders it has) and keeps the hardware ones only: the software ones
# (OMX.google.*, c2.android.*) are the ones that freeze on weak TVs.

param(
    [Parameter(Mandatory = $true)][string]$TvIp,
    [string]$Adb = "adb",
    [string]$StremioDir = "$env:LOCALAPPDATA\Programs\StremioService",
    [switch]$OnlyThisTv,      # convert only for this TV (other devices get the original file)
    [switch]$DryRun           # just show it, don't write anything
)

$ErrorActionPreference = "Stop"
if (-not (Get-Command $Adb -ErrorAction SilentlyContinue)) { throw "adb not found. Pass -Adb with the path to adb.exe." }

$target = if ($TvIp -match ":") { $TvIp } else { "$TvIp`:5555" }
& $Adb connect $target | Out-Host
$state = (& $Adb -s $target get-state 2>&1) -join " "
if ($state -notmatch "device") { throw "Can't talk to the TV ($state). Check that network debugging is on and that you accepted the prompt on the TV." }

# Android MIME type -> ffmpeg codec name
$mimeToCodec = @{
    "video/avc" = "h264"; "video/hevc" = "hevc"; "video/x-vnd.on2.vp9" = "vp9"; "video/x-vnd.on2.vp8" = "vp8"
    "video/av01" = "av1"; "video/mpeg2" = "mpeg2video"; "video/mp4v-es" = "mpeg4"; "video/3gpp" = "h263"
}

$files = (& $Adb -s $target shell "ls /vendor/etc/media_codecs*.xml /odm/etc/media_codecs*.xml /system/etc/media_codecs*.xml 2>/dev/null") -split "`r?`n" | Where-Object { $_ -match "\.xml$" }
$found = @{}   # codec -> @{ w; h; decoder }
foreach ($f in $files) {
    $text = (& $Adb -s $target shell "cat $f") -join "`n"
    try { [xml]$x = $text } catch { continue }
    foreach ($mc in $x.SelectNodes("//Decoders/MediaCodec")) {
        $name = $mc.GetAttribute("name")
        if ($name -match "^(OMX\.google\.|c2\.android\.|OMX\.ffmpeg\.)" -or $name -match "secure") { continue }
        $types = @()
        if ($mc.GetAttribute("type")) { $types += @{ mime = $mc.GetAttribute("type"); node = $mc } }
        foreach ($t in $mc.SelectNodes("Type")) { $types += @{ mime = $t.GetAttribute("name"); node = $t } }
        foreach ($t in $types) {
            $codec = $mimeToCodec[$t.mime]
            if (-not $codec) { continue }
            $w = 0; $h = 0
            $limit = $t.node.SelectSingleNode("Limit[@name='size']")
            if (-not $limit) { $limit = $mc.SelectSingleNode("Limit[@name='size']") }
            if ($limit -and $limit.GetAttribute("max") -match "(\d+)x(\d+)") { $w = [int]$Matches[1]; $h = [int]$Matches[2] }
            if (-not $found[$codec] -or $w -gt $found[$codec].w) { $found[$codec] = @{ w = $w; h = $h; decoder = $name } }
        }
    }
}
if ($found.Count -eq 0) { throw "No hardware decoders found in the TV's media_codecs*.xml files." }

Write-Host "`nHardware decoders found on the TV:"
$found.GetEnumerator() | Sort-Object Name | ForEach-Object { Write-Host ("  {0,-11} up to {1}x{2}  ({3})" -f $_.Name, $_.Value.w, $_.Value.h, $_.Value.decoder) }

$ws = @($found.Values | ForEach-Object { $_.w } | Where-Object { $_ -gt 0 })
$hs = @($found.Values | ForEach-Object { $_.h } | Where-Object { $_ -gt 0 })
$maxW = if ($ws.Count) { ($ws | Measure-Object -Maximum).Maximum } else { 1920 }
$maxH = if ($hs.Count) { ($hs | Measure-Object -Maximum).Maximum } else { 1088 }
$panel = (& $Adb -s $target shell "wm size") -join " "
$outW = if ($panel -match "(\d+)x(\d+)") { [Math]::Min([int]$Matches[1], 1920) } else { 1280 }
Write-Host "Screen: $panel"

$configPath = Join-Path $StremioDir "tv-transcode.config.json"
$config = [ordered]@{}
if (Test-Path $configPath) {
    (Get-Content $configPath -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $config[$_.Name] = $_.Value }
}
$config["supportedCodecs"] = @($found.Keys | Sort-Object)
$config["maxWidth"] = $maxW
$config["maxHeight"] = $maxH
$config["outputWidth"] = $outW
if ($OnlyThisTv) { $config["clients"] = @($TvIp -replace ":\d+$", "") }

$json = $config | ConvertTo-Json -Depth 5
Write-Host "`ntv-transcode.config.json:`n$json"
if ($DryRun) { Write-Host "`n(-DryRun: nothing written)"; return }
[IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "`nSaved to $configPath. Restart Stremio Service for it to take effect."
