"use strict";

const { app, BrowserWindow, shell, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { createLocalServer } = require("./server");

const APP_ID = "com.xring.vitualxring";
let mainWindow = null;
let localServer = null;

app.setAppUserModelId(APP_ID);

// 9.0.0：没有管理员权限时把用户数据放到当前用户可写的目录，
// 避免 %APPDATA% 被重定向 / 只读时 single-instance lock 失败后静默退出。
function ensureWritableUserData() {
    const candidates = [];
    try { candidates.push(app.getPath("userData")); } catch (error) { /* ignore */ }
    try { candidates.push(path.join(app.getPath("temp"), "VitualXRing")); } catch (error) { /* ignore */ }
    try { candidates.push(path.join(app.getPath("appData"), "VitualXRing")); } catch (error) { /* ignore */ }
    for (const dir of candidates) {
        try {
            fs.mkdirSync(dir, { recursive: true });
            const probe = path.join(dir, `.write-test-${process.pid}`);
            fs.writeFileSync(probe, "ok");
            fs.unlinkSync(probe);
            app.setPath("userData", dir);
            try { app.setPath("sessionData", dir); } catch (error) { /* older Electron */ }
            return dir;
        } catch (error) {
            /* try the next candidate */
        }
    }
    return "";
}

ensureWritableUserData();

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on("second-instance", () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    });

    app.whenReady().then(async () => {
        localServer = await createLocalServer(path.join(__dirname, "www"));

        session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
            const allowed = new Set(["clipboard-read", "clipboard-sanitized-write", "media", "notifications"]);
            callback(allowed.has(permission));
        });

        mainWindow = new BrowserWindow({
            width: 1320,
            height: 860,
            minWidth: 960,
            minHeight: 620,
            show: false,
            backgroundColor: "#0b101b",
            title: "Vitual XRing",
            icon: path.join(__dirname, "assets", "icon.ico"),
            autoHideMenuBar: true,
            webPreferences: {
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
                spellcheck: false
            }
        });

        mainWindow.setMenuBarVisibility(false);
        mainWindow.once("ready-to-show", () => mainWindow.show());
        mainWindow.webContents.setWindowOpenHandler(({ url }) => {
            if (url.startsWith(localServer.url)) return { action: "allow" };
            shell.openExternal(url);
            return { action: "deny" };
        });
        mainWindow.webContents.on("will-navigate", (event, url) => {
            if (url.startsWith(localServer.url)) return;
            event.preventDefault();
            shell.openExternal(url);
        });

        await mainWindow.loadURL(localServer.url);
    });

    app.on("window-all-closed", () => {
        if (process.platform !== "darwin") app.quit();
    });

    app.on("before-quit", async (event) => {
        if (!localServer) return;
        event.preventDefault();
        const server = localServer;
        localServer = null;
        await server.close();
        app.quit();
    });
}
