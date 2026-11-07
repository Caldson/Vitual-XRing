param(
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

if (-not $Version) {
    $Version = (Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json).version
}
$FileVersion = if ($Version -match '^\d+\.\d+\.\d+$') { "$Version.0" } else { $Version }

$AppDir = Join-Path $Root "dist\win-unpacked"
if (-not (Test-Path (Join-Path $AppDir "Vitual XRing.exe"))) {
    throw "dist\win-unpacked is missing. Run 'npm run build:dir' first."
}

$SevenZip = Join-Path $Root "node_modules\7zip-bin\win\x64\7za.exe"
$Sfx = Join-Path $Root "assets\7zSD.sfx"
$Manifest = Join-Path $Root "assets\app.manifest"
$Archive = Join-Path $Root "dist\app.7z"
$Config = Join-Path $Root "dist\sfx-config.txt"
$Output = Join-Path $Root "dist\VitualXRing-$Version-portable.exe"
$TempSfx = Join-Path $Root "dist\7zSD-with-manifest.exe"
$ManifestCheck = Join-Path $Root "dist\sfx-manifest-check.xml"

if (-not (Test-Path $SevenZip)) { throw "7za.exe is missing; run npm install." }
if (-not (Test-Path $Sfx)) { throw "assets\7zSD.sfx is missing." }
if (-not (Test-Path $Manifest)) { throw "assets\app.manifest is missing." }

function Find-Mt {
    if ($env:MT_EXE -and (Test-Path $env:MT_EXE)) { return (Resolve-Path $env:MT_EXE).Path }
    $command = Get-Command mt.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    $roots = @(
        (Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"),
        (Join-Path $env:ProgramFiles "Windows Kits\10\bin")
    )
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        $found = Get-ChildItem $root -Recurse -Filter mt.exe -File -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\x64\\mt\.exe$' } |
            Sort-Object FullName -Descending |
            Select-Object -First 1
        if ($found) { return $found.FullName }
    }
    return $null
}

$Mt = Find-Mt
if (-not $Mt) {
    throw "mt.exe not found. Install the Windows SDK or set MT_EXE. Without an asInvoker manifest Windows may treat the SFX as a legacy installer and request administrator rights."
}

if (Test-Path $Archive) { Remove-Item $Archive -Force }
& $SevenZip a -t7z -mx=5 $Archive (Join-Path $AppDir "*") | Out-Null

# Start from the source SFX and stamp icon + version when rcedit is available.
$IconSfx = Join-Path $Root "dist\7zSD-icon.exe"
Copy-Item $Sfx $TempSfx -Force
$Rcedit = @(
    (Join-Path $Root "node_modules\rcedit\bin\rcedit-x64.exe"),
    (Join-Path $env:LOCALAPPDATA "electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\rcedit-x64.exe")
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($Rcedit) {
    & $Rcedit $TempSfx --set-icon (Join-Path $Root "assets\icon.ico") `
        --set-file-version $FileVersion --set-product-version $FileVersion `
        --set-version-string "ProductName" "Vitual XRing" `
        --set-version-string "FileDescription" "Vitual XRing" `
        --set-version-string "CompanyName" "XRing Studios"
} elseif (Test-Path $IconSfx) {
    # No rcedit: reuse the previously icon-patched SFX (version info may be older).
    Copy-Item $IconSfx $TempSfx -Force
}

# No-admin fix: embed an explicit asInvoker manifest into the SFX PE header.
& $Mt -nologo -manifest $Manifest "-outputresource:$TempSfx;#1"
if ($LASTEXITCODE -ne 0) { throw "Failed to embed the asInvoker manifest (mt.exe exit $LASTEXITCODE)." }

if (Test-Path $ManifestCheck) { Remove-Item $ManifestCheck -Force }
& $Mt -nologo "-inputresource:$TempSfx;#1" "-out:$ManifestCheck"
if ($LASTEXITCODE -ne 0 -or -not (Select-String -Path $ManifestCheck -Pattern 'requestedExecutionLevel level="asInvoker"' -Quiet)) {
    throw "asInvoker manifest verification failed; portable EXE was not generated."
}

$ConfigText = ";!@Install@!UTF-8!`r`nTitle=`"Vitual XRing`"`r`nRunProgram=`"Vitual XRing.exe`"`r`nGUIMode=`"2`"`r`n;!@InstallEnd@!`r`n"
[IO.File]::WriteAllText($Config, $ConfigText, (New-Object System.Text.UTF8Encoding($false)))

if (Test-Path $Output) { Remove-Item $Output -Force }
$outStream = [IO.File]::Create($Output)
try {
    foreach ($part in @($TempSfx, $Config, $Archive)) {
        $inStream = [IO.File]::OpenRead($part)
        try { $inStream.CopyTo($outStream) } finally { $inStream.Dispose() }
    }
} finally {
    $outStream.Dispose()
}
if (-not (Test-Path $Output)) { throw "Failed to write $Output" }

Write-Host "Built $Output"
Write-Host "Manifest: asInvoker (no administrator required)"
