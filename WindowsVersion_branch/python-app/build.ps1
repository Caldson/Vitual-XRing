# Vitual XRing WindowsVersion · Python 浏览器版打包脚本
#
# 依赖：Python 3.10+（含 tkinter）、PyInstaller
# 用法：powershell -ExecutionPolicy Bypass -File .\build.ps1
#
# 产物：
#   dist\VitualXRing-1.8.1-python\VitualXRing-1.8.1-python.exe   （直接运行）
#   dist\VitualXRing-1.8.1-python-portable.zip                    （整个目录，推荐分发）
#
# 为什么用 onedir 而不是 onefile：
#   PyInstaller 的 onefile 启动器在 EXE 路径含中文时无法创建 _MEI 临时目录
#   （本项目路径含“项目”），会直接报 “Could not create temporary directory!”。
#   onedir 不往临时目录解压，因此放在任何路径（包括中文目录）都能运行。
#   整个目录压缩成 zip 分发即可；解压后双击 EXE，不需要管理员权限。

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$site = Split-Path -Parent $here
$stage = Join-Path $here "site"
$dist = Join-Path $here "dist"
$build = Join-Path $here "build"
$icon = Join-Path $here "app.ico"
$name = "VitualXRing-1.8.1-python"

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

Write-Host "==> 检查 PyInstaller"
python -c "import PyInstaller, sys; print('PyInstaller', PyInstaller.__version__, 'Python', sys.version.split()[0])"
if ($LASTEXITCODE -ne 0) {
    throw "没有安装 PyInstaller，请先执行：python -m pip install pyinstaller"
}

if (Test-Path -LiteralPath $dist) { Remove-Item -LiteralPath $dist -Recurse -Force }
if (Test-Path -LiteralPath $build) { Remove-Item -LiteralPath $build -Recurse -Force }
New-Item -ItemType Directory -Path $dist -Force | Out-Null

Write-Host "==> PyInstaller onedir（不依赖临时目录，中文路径可运行）"
$previousErrorAction = $ErrorActionPreference
$ErrorActionPreference = "Continue"
python -m PyInstaller `
    --noconfirm `
    --clean `
    --onedir `
    --noconsole `
    --name $name `
    --icon $icon `
    --add-data "$stage;site" `
    --distpath $dist `
    --workpath (Join-Path $build "work") `
    --specpath $here `
    (Join-Path $here "launcher.py")
$pyInstallerExit = $LASTEXITCODE
$ErrorActionPreference = $previousErrorAction
if ($pyInstallerExit -ne 0) { throw "PyInstaller 失败（exit $pyInstallerExit）" }

$appDir = Join-Path $dist $name
$exe = Join-Path $appDir "$name.exe"
if (-not (Test-Path -LiteralPath $exe)) { throw "没有找到 $exe" }

Write-Host "==> 压缩便携版"
$zip = Join-Path $dist "$name-portable.zip"
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    $appDir,
    $zip,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false)

Write-Host ""
Write-Host "==> 完成"
Write-Host "    直接运行：$exe"
Write-Host "    分发压缩包：$zip"
Write-Host ("    压缩包大小：{0:N1} MB" -f ((Get-Item -LiteralPath $zip).Length / 1MB))
Write-Host "    解压后双击 EXE 即可；不需要管理员权限，也不需要 .NET / WebView2。"
Write-Host "    注意：整个 $name 文件夹要一起保留，不能只复制 EXE。"
