"""VShop 0.1.0 — Vitual XRing game platform (Steam-like)."""
from __future__ import annotations

import json
import os
import sys
import tkinter as tk
import webbrowser
from pathlib import Path
from tkinter import messagebox, simpledialog, ttk

try:
    from vtx_sdk import VTX, VTXError
except Exception:
    VTX = None
    VTXError = Exception

APP_VERSION = "0.1.0"
BASE = Path(__file__).resolve().parent
GAMES_FILE = BASE / "games.json"
LIBRARY_FILE = BASE / "library.json"
API = "https://xsmmc.caldson.us.ci"

FALLBACK_GAMES = [
    {"id": "neon-drift", "title": "Neon Drift", "genre": "竞速", "price": "0.00", "emoji": "🏎️", "color": "#2b6cff", "description": "霓虹赛道上的高速漂移。", "url": "https://xsmmc.caldson.us.ci/"},
    {"id": "block-studio", "title": "Block Studio", "genre": "创作", "price": "5.00", "emoji": "🧱", "color": "#e85d3f", "description": "用积木搭出你的世界。", "url": "https://xsmmc.caldson.us.ci/"},
    {"id": "pixel-farm", "title": "Pixel Farm", "genre": "模拟", "price": "10.00", "emoji": "🌾", "color": "#2f9e62", "description": "经营一座像素农场。", "url": "https://xsmmc.caldson.us.ci/"},
    {"id": "space-miner", "title": "Space Miner", "genre": "冒险", "price": "15.00", "emoji": "🪐", "color": "#7a5cff", "description": "在深空小行星带开采资源。", "url": "https://xsmmc.caldson.us.ci/"},
    {"id": "rhythm-lab", "title": "Rhythm Lab", "genre": "音乐", "price": "8.00", "emoji": "🎵", "color": "#d946ef", "description": "跟着节拍敲击。", "url": "https://xsmmc.caldson.us.ci/"},
    {"id": "tower-guard", "title": "Tower Guard", "genre": "策略", "price": "12.00", "emoji": "🏰", "color": "#f59e0b", "description": "布置防线，守住高塔。", "url": "https://xsmmc.caldson.us.ci/"},
]


def load_json(path: Path, fallback):
    try:
        return json.loads(path.read_text("utf-8"))
    except Exception:
        return fallback


def save_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), "utf-8")


class VShopApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title(f"VShop {APP_VERSION}")
        self.root.geometry("1120x720")
        self.root.minsize(900, 600)
        self.root.configure(bg="#101318")
        self.games = load_json(GAMES_FILE, FALLBACK_GAMES)
        self.library = load_json(LIBRARY_FILE, [])
        self.vtx = None
        self.account = None
        self.user = ""
        self.password = ""
        self.tab = "store"
        self._style()
        self._login()

    def _style(self) -> None:
        style = ttk.Style()
        style.theme_use("clam")
        style.configure("TButton", font=("Microsoft YaHei", 9), padding=6)
        style.configure("Buy.TButton", background="#1a9fff", foreground="#fff", font=("Microsoft YaHei", 9, "bold"))
        style.map("Buy.TButton", background=[("active", "#42b4ff")])

    def _clear(self) -> None:
        for child in self.root.winfo_children():
            child.destroy()

    def _login(self) -> None:
        self._clear()
        box = tk.Frame(self.root, bg="#101318")
        box.place(relx=.5, rely=.5, anchor="center")
        tk.Label(box, text="VSHOP", bg="#101318", fg="#66c0f4", font=("Segoe UI", 38, "bold")).pack(pady=(0, 4))
        tk.Label(box, text="Vitual XRing game platform", bg="#101318", fg="#8f98a0", font=("Microsoft YaHei", 10)).pack(pady=(0, 22))
        self.login_user = tk.Entry(box, width=32, bg="#1b2838", fg="#fff", insertbackground="#fff", relief="flat")
        self.login_user.pack(ipady=7, pady=4)
        self.login_pass = tk.Entry(box, width=32, show="•", bg="#1b2838", fg="#fff", insertbackground="#fff", relief="flat")
        self.login_pass.pack(ipady=7, pady=4)
        tk.Button(box, text="登录 VTX 账户", command=self._do_login, bg="#1a9fff", fg="#fff", relief="flat", font=("Microsoft YaHei", 10, "bold"), padx=20, pady=7).pack(pady=12)
        tk.Label(box, text="VShop 需要 VTX 账户登录", bg="#101318", fg="#6b7480", font=("Microsoft YaHei", 9)).pack()
        self.login_pass.bind("<Return>", lambda _: self._do_login())

    def _do_login(self) -> None:
        if VTX is None:
            messagebox.showerror("VShop", "缺少 vtx-sdk.py")
            return
        login = self.login_user.get().strip()
        password = self.login_pass.get()
        if not login or not password:
            messagebox.showwarning("VShop", "请输入账户名和密码")
            return
        try:
            self.vtx = VTX(API)
            data = self.vtx.login(login, password)
            self.account = data.get("account") or {}
            self.user = login
            self.password = password
            self._main()
        except Exception as error:
            messagebox.showerror("登录失败", str(error))

    def _main(self) -> None:
        self._clear()
        top = tk.Frame(self.root, bg="#171a21", height=56)
        top.pack(fill="x")
        tk.Label(top, text="VSHOP", bg="#171a21", fg="#66c0f4", font=("Segoe UI", 20, "bold")).pack(side="left", padx=(20, 24))
        for key, label in [("store", "商店"), ("library", "库"), ("account", "账户")]:
            tk.Button(top, text=label, command=lambda k=key: self._tab(k), bg="#171a21", fg="#c7d5e0", activebackground="#2a475e", activeforeground="#fff", relief="flat", font=("Microsoft YaHei", 10)).pack(side="left", padx=2)
        tk.Label(top, text=f"{self.account.get('username') or self.user}  ·  {self.account.get('money', '0.00')} VTX", bg="#171a21", fg="#8f98a0", font=("Microsoft YaHei", 9)).pack(side="right", padx=16)
        tk.Button(top, text="退出", command=self._login, bg="#171a21", fg="#8f98a0", relief="flat").pack(side="right")
        self.body = tk.Frame(self.root, bg="#101318")
        self.body.pack(fill="both", expand=True, padx=20, pady=16)
        self._render()

    def _tab(self, key: str) -> None:
        self.tab = key
        self._render()

    def _render(self) -> None:
        for child in self.body.winfo_children():
            child.destroy()
        if self.tab == "account":
            self._account()
        elif self.tab == "library":
            self._library()
        else:
            self._store()

    def _section(self, title: str) -> None:
        tk.Label(self.body, text=title, bg="#101318", fg="#fff", font=("Microsoft YaHei", 18, "bold"), anchor="w").pack(fill="x", pady=(0, 10))

    def _store(self) -> None:
        self._section("商店")
        canvas = tk.Canvas(self.body, bg="#101318", highlightthickness=0)
        scroll = tk.Scrollbar(self.body, orient="vertical", command=canvas.yview)
        frame = tk.Frame(canvas, bg="#101318")
        frame.bind("<Configure>", lambda e: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.create_window((0, 0), window=frame, anchor="nw")
        canvas.configure(yscrollcommand=scroll.set)
        canvas.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")
        for index, game in enumerate(self.games):
            card = tk.Frame(frame, bg="#16202d", padx=16, pady=14)
            card.grid(row=index // 2, column=index % 2, sticky="nsew", padx=6, pady=6)
            frame.grid_columnconfigure(index % 2, weight=1)
            tk.Label(card, text=game.get("emoji", "🎮"), bg="#16202d", font=("Segoe UI Emoji", 26)).pack(anchor="w")
            tk.Label(card, text=game.get("title", "Untitled"), bg="#16202d", fg="#fff", font=("Microsoft YaHei", 13, "bold")).pack(anchor="w", pady=(6, 2))
            tk.Label(card, text=f"{game.get('genre', '游戏')} · {game.get('price', '0.00')} VTX", bg="#16202d", fg="#66c0f4", font=("Microsoft YaHei", 9)).pack(anchor="w")
            tk.Label(card, text=game.get("description", ""), bg="#16202d", fg="#8f98a0", wraplength=420, justify="left", font=("Microsoft YaHei", 9)).pack(anchor="w", pady=8)
            owned = game.get("id") in self.library
            tk.Button(card, text="已在库中" if owned else "购买", command=lambda g=game: self._buy(g), bg="#2a475e" if owned else "#1a9fff", fg="#fff", relief="flat", font=("Microsoft YaHei", 9, "bold"), padx=16, pady=5).pack(anchor="w")

    def _buy(self, game: dict) -> None:
        gid = game.get("id")
        if gid in self.library:
            messagebox.showinfo("VShop", "这个游戏已经在你的库里")
            return
        price = str(game.get("price", "0.00"))
        try:
            amount = float(price)
        except ValueError:
            amount = 0
        if amount > 0:
            password = tk.simpledialog.askstring("购买确认", f"购买 {game['title']} 需要 {price} VTX\n请输入账户密码：", show="•")
            if not password:
                return
            try:
                self.vtx.pay(price, "VShop", f"购买 {game['title']}", password=password)
            except Exception as error:
                messagebox.showerror("购买失败", str(error))
                return
        self.library.append(gid)
        save_json(LIBRARY_FILE, self.library)
        self._render()
        messagebox.showinfo("VShop", f"已加入库：{game['title']}")

    def _library(self) -> None:
        self._section("我的库")
        owned = [g for g in self.games if g.get("id") in self.library]
        if not owned:
            tk.Label(self.body, text="库里还没有游戏，去商店看看吧。", bg="#101318", fg="#8f98a0", font=("Microsoft YaHei", 10)).pack(anchor="w")
            return
        for game in owned:
            row = tk.Frame(self.body, bg="#16202d", padx=14, pady=10)
            row.pack(fill="x", pady=4)
            tk.Label(row, text=game.get("emoji", "🎮"), bg="#16202d", font=("Segoe UI Emoji", 18)).pack(side="left")
            tk.Label(row, text=game.get("title", ""), bg="#16202d", fg="#fff", font=("Microsoft YaHei", 11, "bold")).pack(side="left", padx=10)
            tk.Button(row, text="启动", command=lambda g=game: self._launch(g), bg="#1a9fff", fg="#fff", relief="flat").pack(side="right")

    def _launch(self, game: dict) -> None:
        url = game.get("url") or "https://xsmmc.caldson.us.ci/"
        webbrowser.open(url)
        messagebox.showinfo("VShop", f"正在启动 {game.get('title', '游戏')}")

    def _account(self) -> None:
        self._section("账户")
        tk.Label(self.body, text=f"登录名：{self.user}", bg="#101318", fg="#c7d5e0", font=("Microsoft YaHei", 11)).pack(anchor="w", pady=3)
        tk.Label(self.body, text=f"显示名：{self.account.get('username', '')}", bg="#101318", fg="#c7d5e0", font=("Microsoft YaHei", 11)).pack(anchor="w", pady=3)
        tk.Label(self.body, text=f"VTX 余额：{self.account.get('money', '0.00')} VTX", bg="#101318", fg="#66c0f4", font=("Microsoft YaHei", 11, "bold")).pack(anchor="w", pady=3)
        tk.Button(self.body, text="刷新账户", command=self._refresh, bg="#2a475e", fg="#fff", relief="flat").pack(anchor="w", pady=14)

    def _refresh(self) -> None:
        try:
            data = self.vtx.me()
            self.account = data.get("account") or self.account
            self._render()
        except Exception as error:
            messagebox.showerror("VShop", str(error))


def main() -> None:
    if not GAMES_FILE.exists():
        save_json(GAMES_FILE, FALLBACK_GAMES)
    root = tk.Tk()
    VShopApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
