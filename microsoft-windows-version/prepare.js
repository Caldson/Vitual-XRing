"use strict";

const fs = require("node:fs");
const path = require("node:path");

const appRoot = __dirname;
const repoRoot = path.resolve(appRoot, "..");
const webRoot = path.join(appRoot, "www");
const API_BASE = "https://xsmmc.caldson.us.ci/api";

const ROOT_FILES = new Set([
    "index.html", "settings.html", "shop.html", "xos.html", "manager.html",
    "login.html", "loginplaces.html", "chat.html", "chatroom.html", "chat-record.html",
    "image.html", "audiv.html", "viratch.html", "share.html", "vstyle.html",
    "vistyle.html", "vclang.html", "vmusic.html", "vimidi.html", "vitxvideo.html",
    "vitxvideopublish.html", "vitx-dynamic.html", "vitualgit.html", "vuolingo.html",
    "API_LOGIN.html", "API_VTXPAY.html", "accounts-admin.html", "WebsiteClose.html",
    "offline.html", "admin.html", "shop.json", "version.json",
    "vtx-api.js", "vtx-sdk.js", "vtx-uno.js", "vtx-theme.js", "vtx-theme.css",
    "vtx-markdown.js", "vtx-pwa.js", "vtx-sw.js", "vtx-closed.js", "xring-social.js",
    "XRingLogo.png", "XRingLogo-V.png", "favicon.ico"
]);

const STATIC_DIRS = ["images"];
const ROOT_ASSET_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".ico", ".css", ".js"]);

function copyFile(source, target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
}

function copyDirectory(source, target) {
    if (!fs.existsSync(source)) return;
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        const from = path.join(source, entry.name);
        const to = path.join(target, entry.name);
        if (entry.isDirectory()) copyDirectory(from, to);
        else if (entry.isFile()) copyFile(from, to);
    }
}

function prepareHtml(file) {
    let html = fs.readFileSync(file, "utf8");
    html = html.replace(/<script[^>]+src=["']vtx-pwa\.js[^"']*["'][^>]*><\/script>\s*/gi, "");
    if (!html.includes("window.VTX_API_BASE")) {
        const config = `    <script>window.VTX_API_BASE = ${JSON.stringify(API_BASE)};</script>\n`;
        html = html.replace(/<\/head>/i, `${config}</head>`);
    }
    fs.writeFileSync(file, html, "utf8");
}

fs.rmSync(webRoot, { recursive: true, force: true });
fs.mkdirSync(webRoot, { recursive: true });

for (const name of ROOT_FILES) {
    const source = path.join(repoRoot, name);
    if (!fs.existsSync(source)) continue;
    copyFile(source, path.join(webRoot, name));
}

for (const entry of fs.readdirSync(repoRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (ROOT_ASSET_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        copyFile(path.join(repoRoot, entry.name), path.join(webRoot, entry.name));
    }
}

for (const directory of STATIC_DIRS) {
    copyDirectory(path.join(repoRoot, directory), path.join(webRoot, directory));
}

for (const entry of fs.readdirSync(webRoot, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".html")) {
        prepareHtml(path.join(webRoot, entry.name));
    }
}

const bundleInfo = {
    name: "Vitual XRing",
    version: JSON.parse(fs.readFileSync(path.join(repoRoot, "version.json"), "utf8")).version,
    apiBase: API_BASE,
    builtAt: new Date().toISOString()
};
fs.writeFileSync(path.join(webRoot, "bundle.json"), JSON.stringify(bundleInfo, null, 4), "utf8");
console.log(`Prepared ${webRoot} (${bundleInfo.version}), api=${API_BASE}`);
