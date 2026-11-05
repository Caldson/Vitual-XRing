param(
    [string]$Version = "8.2.2"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$AppDir = Join-Path $Root "dist\win-unpacked"
if (-not (Test-Path (Join-Path $AppDir "Vitual XRing.exe"))) {
    throw "dist\win-unpacked is missing. Run 'npm run build:dir' first."
}

$SevenZip = Join-Path $Root "node_modules\7zip-bin\win\x64\7za.exe"
$Sfx = Join-Path $Root "assets\7zSD.sfx"
$Archive = Join-Path $Root "dist\app.7z"
$Config = Join-Path $Root "dist\sfx-config.txt"
$Output = Join-Path $Root "dist\VitualXRing-$Version-portable.exe"
$TempSfx = Join-Path $Root "dist\7zSD-icon.exe"

if (-not (Test-Path $SevenZip)) { throw "7za.exe is missing; run npm install." }
if (-not (Test-Path $Sfx)) { throw "assets\7zSD.sfx is missing." }

if (Test-Path $Archive) { Remove-Item $Archive -Force }
& $SevenZip a -t7z -mx=5 $Archive (Join-Path $AppDir "*") | Out-Null
Copy-Item $Sfx $TempSfx -Force

$Rcedit = @(
    (Join-Path $Root "node_modules\rcedit\bin\rcedit-x64.exe"),
    (Join-Path $Root ".cache\electron-builder\winCodeSign\winCodeSign-2.6.0\rcedit-x64.exe")
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($Rcedit) {
    & $Rcedit $TempSfx --set-icon (Join-Path $Root "assets\icon.ico") `
        --set-file-version "$Version.0" --set-product-version "$Version.0" `
        --set-version-string "ProductName" "Vitual XRing" `
        --set-version-string "FileDescription" "Vitual XRing" `
        --set-version-string "CompanyName" "XRing Studios"
}

$ConfigText = ";!@Install@!UTF-8!`r`nTitle=`"Vitual XRing`"`r`nRunProgram=`"Vitual XRing.exe`"`r`nGUIMode=`"2`"`r`n;!@InstallEnd@!`r`n"
[IO.File]::WriteAllText($Config, $ConfigText, (New-Object System.Text.UTF8Encoding($false)))

cmd /c copy /b "$TempSfx"+"$Config"+"$Archive" "$Output" > $null
Write-Host "Built $Output"
