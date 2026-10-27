# Vitual XRing WindowsVersion · Python 浏览器版

不依赖 .NET / WebView2，**不需要管理员权限**。
启动后会在 `127.0.0.1` 上开一个本地网页服务，并用系统默认浏览器打开页面。

## 直接运行

产物目录：

```
WindowsVersion_branch\python-app\dist\VitualXRing-1.8.1-python\
    VitualXRing-1.8.1-python.exe
    _internal\...
```

分发包：

```
WindowsVersion_branch\python-app\dist\VitualXRing-1.8.1-python-portable.zip
```

**解压整个 zip，双击 `VitualXRing-1.8.1-python.exe` 即可。**
（`_internal` 文件夹必须和 EXE 放在一起，不能只复制 EXE。）

会先弹出一个小控制窗：

- 「在浏览器中打开」：重新打开默认浏览器
- 「复制地址」：复制本地地址
- 「退出」：关闭本地服务和窗口

关闭控制窗后，本地服务停止，浏览器里的页面也会失效，需要重新打开 EXE。

日志：`%LOCALAPPDATA%\VitualXRing\python-launcher.log`

## 为什么不打单文件 onefile

PyInstaller 的 onefile 启动器在 **EXE 路径含中文** 时无法创建 `_MEI` 临时目录，
会直接报：

```
Could not create temporary directory!
```

本项目的路径含「项目」，所以 onefile 在这台机器上打不开。
onedir 不会往临时目录解压，因此放在中文路径也能运行；整个目录压成 zip 分发即可。

## 为什么不用管理员权限

- 只监听 `127.0.0.1` 的随机高位端口（不是 80/443）
- 网页资源从程序目录读取，不写系统目录
- 用系统默认浏览器渲染，不安装 WebView2 / .NET 运行时
- PyInstaller onedir 不写临时目录

> EXE 没有数字签名，SmartScreen 可能提示「Windows 已保护你的电脑」；
> 点「更多信息 → 仍要运行」即可。这不是管理员权限。

## 重新打包

要求：Python 3.10+（官方版一般自带 tkinter）、PyInstaller。

```powershell
cd WindowsVersion_branch\python-app
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

脚本会：

1. 把上一级 `WindowsVersion_branch` 的 HTML / JS / JSON / PNG / TXT / images 复制到 `site/`
2. `python -m PyInstaller --onedir --noconsole --add-data "site;site"` 打包
3. 输出 `dist\VitualXRing-1.8.1-python\` 和 `dist\VitualXRing-1.8.1-python-portable.zip`

## 页面为什么还能登录 / 聊天

启动器在返回 HTML 时会注入：

```html
<script>
  window.VTX_API_BASE = "https://xsmmc.caldson.us.ci/api";
</script>
```

所以本地页面里的 `vtx-api.js` 直接请求线上 Worker（CORS 允许），
聊天室 WebSocket、视频、账户、关注 UP 主等功能都和网页版一致。

## 当前版本

**1.8.1**：Vitx 视频关注 UP 主、聊天室 14 天媒体、音乐直接播放、Markdown、
长消息展开、聊天室转账。
