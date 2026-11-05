"use strict";

const { app, BrowserWindow, shell, session } = require("electron");
const path = require("node:path");
const { createLocalServer } = require("./server");

const APP_ID = "com.xring.vitualxring";
let mainWindow = null;
let localServer = null;

app.setAppUserModelId(APP_ID);

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
