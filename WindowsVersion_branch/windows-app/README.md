# Vitual XRing WindowsVersion 桌面版

把 `WindowsVersion_branch` 里的整套网页打包成一个单文件 Windows EXE（WinForms + WebView2）。
网页文件会嵌进 EXE，启动时解压到 `%LOCALAPPDATA%\VitualXRing\web`，
通过虚拟域名 `https://vtx.local/` 加载；API / WebSocket 指向线上 Worker
（`https://xsmmc.caldson.us.ci/api`），所以聊天、账户、视频等功能和网页版一致。

## 直接运行

产物：

```
WindowsVersion_branch\windows-app\dist\VitualXRing-1.8.0.exe
```

双击即可。首次启动会创建：

- `%LOCALAPPDATA%\VitualXRing\web`：内置网页
- `%LOCALAPPDATA%\VitualXRing\WebView2`：WebView2 用户数据（登录状态等）

要求：

- Windows 10 / 11 x64
- Microsoft Edge WebView2 Runtime（Win10/11 一般已自带；
  没有时程序会提示下载地址）

> EXE 没有数字签名，SmartScreen 可能提示「Windows 已保护你的电脑」。
> 点「更多信息 → 仍要运行」即可。

## 重新打包

要求：.NET 10 SDK（或更高）、WebView2 Runtime。

```powershell
cd WindowsVersion_branch\windows-app
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

脚本会：

1. 把上一级 `WindowsVersion_branch` 的 HTML / JS / JSON / PNG / TXT / images 打成 `web.zip`；
2. `dotnet publish` 成 `win-x64`、self-contained、single-file；
3. 把最终 EXE 复制到 `dist\VitualXRing-1.8.0.exe`。

构建中间文件（`bin` / `obj` / `publish` / `web-stage` / `web.zip` / `dist`）已在
`windows-app\.gitignore` 里忽略；仓库只保留源码。

## 网页内容从哪来

EXE 里的网页来自上一级目录（`WindowsVersion_branch`），所以更新网页后：

1. 把根目录的 1.8.0 文件同步到 `WindowsVersion_branch`；
2. 重新运行 `build.ps1`。

当前版本：**1.8.0**（聊天室 14 天媒体、音乐直接播放、Markdown、长消息展开、转账）。
