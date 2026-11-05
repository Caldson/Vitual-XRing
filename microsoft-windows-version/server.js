"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8"
};

function createLocalServer(webRoot) {
    const root = path.resolve(webRoot);
    const server = http.createServer((request, response) => {
        let pathname;
        try {
            pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
        } catch (error) {
            response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
            response.end("Bad request");
            return;
        }

        if (pathname === "/") pathname = "/index.html";
        const target = path.resolve(root, "." + pathname);
        if (target !== root && !target.startsWith(root + path.sep)) {
            response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
            response.end("Forbidden");
            return;
        }

        fs.stat(target, (error, stat) => {
            if (error || !stat.isFile()) {
                response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
                response.end("Not found");
                return;
            }

            const extension = path.extname(target).toLowerCase();
            const headers = {
                "content-type": MIME[extension] || "application/octet-stream",
                "cache-control": extension === ".html" ? "no-store" : "public, max-age=31536000, immutable",
                "x-content-type-options": "nosniff"
            };
            response.writeHead(200, headers);
            if (request.method === "HEAD") {
                response.end();
                return;
            }
            fs.createReadStream(target).pipe(response);
        });
    });

    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            resolve({
                server,
                url: `http://127.0.0.1:${address.port}/`,
                close: () => new Promise((done) => server.close(() => done()))
            });
        });
    });
}

module.exports = { createLocalServer };
