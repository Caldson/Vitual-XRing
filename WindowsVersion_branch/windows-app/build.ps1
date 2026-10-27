# Vitual XRing WindowsVersion -> single-file EXE
#
# 依赖：.NET 10 SDK（或更高）、Microsoft Edge WebView2 Runtime
# 用法：powershell -ExecutionPolicy Bypass -File .\build.ps1
#
# 产物：dist\VitualXRing-1.8.1.exe

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$site = Split-Path -Parent $here
$stage = Join-Path $here "web-stage"
$zip = Join-Path $here "web.zip"
$publish = Join-Path $here "publish"
$dist = Join-Path $here "dist"

Write-Host "==> 打包网页文件：$site"
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

foreach ($pattern in @("*.html", "*.js", "*.json", "*.png", "*.txt")) {
    Get-ChildItem -LiteralPath $site -Filter $pattern -File | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $stage $_.Name) -Force
    }
}
$images = Join-Path $site "images"
if (Test-Path -LiteralPath $images) {
    Copy-Item -LiteralPath $images -Destination (Join-Path $stage "images") -Recurse -Force
}

if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stage,
    $zip,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false)
Write-Host ("==> web.zip：{0:N1} MB" -f ((Get-Item -LiteralPath $zip).Length / 1MB))

Write-Host "==> dotnet publish（win-x64 / self-contained / single-file）"
if (Test-Path -LiteralPath $publish) { Remove-Item -LiteralPath $publish -Recurse -Force }
& dotnet publish (Join-Path $here "VitualXRing.csproj") `
    -c Release `
    -r win-x64 `
    --self-contained true `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:EnableCompressionInSingleFile=true `
    -p:DebugType=None `
    -p:DebugSymbols=false `
    -o $publish
if ($LASTEXITCODE -ne 0) { throw "dotnet publish 失败（exit $LASTEXITCODE）" }

New-Item -ItemType Directory -Path $dist -Force | Out-Null
$exe = Join-Path $publish "VitualXRing.exe"
if (-not (Test-Path -LiteralPath $exe)) { throw "没有找到 publish\VitualXRing.exe" }
$out = Join-Path $dist "VitualXRing-1.8.1.exe"
Copy-Item -LiteralPath $exe -Destination $out -Force

Write-Host ""
Write-Host "==> 完成：$out"
Write-Host ("    大小：{0:N1} MB" -f ((Get-Item -LiteralPath $out).Length / 1MB))
Write-Host "    publish 目录里的其它文件（如果有）仅用于排查，正式分发只需要上面的 EXE。"
Get-ChildItem -LiteralPath $publish -File | Select-Object Name, Length | Format-Table -AutoSize
