#!/usr/bin/env python3
"""Vitual XRing WindowsVersion · Python 浏览器版启动器

不依赖 .NET / WebView2，也不需要管理员权限：
- 从 EXE 内置资源里读取静态网页；
- 在 127.0.0.1 的随机端口上起一个本地 HTTP 服务；
- 用系统默认浏览器打开页面；
- 页面里的 vtx-api.js 被注入 window.VTX_API_BASE，直接连线上 Worker。

打包命令见 build.ps1。
"""

from __future__ import annotations

import argparse
import http.server
import os
import socketserver
import sys
import threading
import time
import traceback
import webbrowser
from pathlib import Path

APP_VERSION = "1.8.1"
API_BASE = "https://xsmmc.caldson.us.ci/api"

# 在页面 <head> 后插入。清掉可能缓存的同源 /api，强制走线上 Worker。
INJECT = (
    "<script>"
    "try{sessionStorage.removeItem('vtxApiBase');}catch(e){}"
    f"window.VTX_API_BASE={API_BASE!r};"
    "</script>"
)


def app_dir() -> Path:
    """PyInstaller 单文件模式解压到 _MEIPASS；源码运行则用脚本目录。"""
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))


def site_root() -> Path:
    bundled = app_dir() / "site"
    if bundled.is_dir():
        return bundled
    # 源码直接运行时，上一级就是 WindowsVersion_branch
    return Path(__file__).resolve().parent.parent


def log(message: str) -> None:
    try:
        folder = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "VitualXRing"
        folder.mkdir(parents=True, exist_ok=True)
        with (folder / "python-launcher.log").open("a", encoding="utf-8") as handle:
            handle.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}\n")
    except Exception:
        pass


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(site_root()), **kwargs)

    def log_message(self, fmt, *args):  # 不刷控制台
        pass

    def do_GET(self):
        path = Path(self.translate_path(self.path))
        if path.is_dir():
            path = path / "index.html"
        if path.is_file() and path.suffix.lower() in (".html", ".htm"):
            try:
                text = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                return super().do_GET()
            head = text.lower().find("<head")
            if head >= 0:
                end = text.find(">", head)
                if end >= 0:
                    text = text[: end + 1] + INJECT + text[end + 1 :]
            body = text.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        return super().do_GET()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def start_server(port: int):
    server = Server(("127.0.0.1", port), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, int(server.server_address[1])


def run_browser_ui(url: str, server, auto_open: bool) -> None:
    """一个小控制窗：打开浏览器 / 复制地址 / 退出。没有 tkinter 也能退化运行。"""
    try:
        import tkinter as tk
        from tkinter import ttk
    except Exception:
        log("tkinter 不可用，退化为只打开浏览器")
        if auto_open:
            webbrowser.open(url, new=2)
        while True:
            time.sleep(1)

    root = tk.Tk()
    root.title(f"Vitual XRing {APP_VERSION} · 浏览器版")
    root.geometry("580x270")
    root.minsize(520, 240)
    try:
        icon = tk.PhotoImage(file=str(site_root() / "XRingLogo.png"))
        root.iconphoto(True, icon)
        root._vtx_icon = icon  # 防止被垃圾回收
    except Exception:
        pass

    def close():
        try:
            server.shutdown()
        except Exception:
            pass
        try:
            server.server_close()
        except Exception:
            pass
        root.destroy()

    def open_browser():
        try:
            ok = webbrowser.open(url, new=2)
            status.set("已请求打开默认浏览器" if ok else f"请手动打开：{url}")
        except Exception as error:
            status.set(f"打开浏览器失败：{error}")

    def copy_url():
        try:
            root.clipboard_clear()
            root.clipboard_append(url)
            status.set("地址已复制")
        except Exception as error:
            status.set(f"复制失败：{error}")

    frame = ttk.Frame(root, padding=20)
    frame.pack(fill="both", expand=True)
    ttk.Label(
        frame,
        text=f"Vitual XRing {APP_VERSION}",
        font=("Microsoft YaHei UI", 16, "bold"),
    ).pack(anchor="w")
    ttk.Label(
        frame,
        text="本地网页服务已启动，账户 / 视频 / 聊天数据通过线上 API 读取。",
        foreground="#5b6678",
    ).pack(anchor="w", pady=(6, 0))

    status = tk.StringVar(value="正在打开默认浏览器…")
    ttk.Label(frame, textvariable=status, foreground="#3867e8").pack(anchor="w", pady=(12, 0))

    url_var = tk.StringVar(value=url)
    entry = ttk.Entry(frame, textvariable=url_var, width=64)
    entry.pack(fill="x", pady=(10, 0))
    entry.configure(state="readonly")

    buttons = ttk.Frame(frame)
    buttons.pack(fill="x", pady=(14, 0))
    ttk.Button(buttons, text="在浏览器中打开", command=open_browser).pack(side="left")
    ttk.Button(buttons, text="复制地址", command=copy_url).pack(side="left", padx=(8, 0))
    ttk.Button(buttons, text="退出", command=close).pack(side="right")

    root.protocol("WM_DELETE_WINDOW", close)
    if auto_open:
        root.after(300, open_browser)
    else:
        status.set("点击「在浏览器中打开」启动")
    root.mainloop()


def main() -> int:
    parser = argparse.ArgumentParser(description="Vitual XRing browser launcher")
    parser.add_argument("--port", type=int, default=0, help="本地端口，默认随机")
    parser.add_argument("--serve-only", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--no-browser", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()

    server, port = start_server(args.port)
    url = f"http://127.0.0.1:{port}/index.html"
    log(f"server={url} site={site_root()}")

    if args.serve_only:
        print(url, flush=True)
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        finally:
            try:
                server.shutdown()
                server.server_close()
            except Exception:
                pass
        return 0

    run_browser_ui(url, server, not args.no_browser)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        log(traceback.format_exc())
        try:
            import tkinter.messagebox as messagebox

            messagebox.showerror("Vitual XRing", traceback.format_exc())
        except Exception:
            pass
        raise
