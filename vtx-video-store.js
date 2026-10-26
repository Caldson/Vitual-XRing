/**
 * Vitx® 视频：本机视频文件仓库
 *
 * 投稿页把用户选的视频文件（任何格式）存进 IndexedDB，视频页再取出来用 <video> 播放。
 * 只在这台浏览器里有效，清除站点数据后视频就没了——页面上会如实提示。
 */
(function (global) {
    "use strict";

    var DB_NAME = "vitx-video";
    var DB_VERSION = 1;
    var STORE = "files";
    var dbPromise = null;

    function openDb() {
        if (dbPromise) {
            return dbPromise;
        }
        dbPromise = new Promise(function (resolve, reject) {
            if (!global.indexedDB) {
                reject(new Error("no_indexeddb"));
                return;
            }
            var request = global.indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = function () {
                var db = request.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE);
                }
            };
            request.onsuccess = function () {
                resolve(request.result);
            };
            request.onerror = function () {
                reject(request.error || new Error("open_failed"));
            };
        });
        return dbPromise;
    }

    function withStore(mode, run) {
        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(STORE, mode);
                var store = tx.objectStore(STORE);
                var request = run(store);
                tx.oncomplete = function () {
                    resolve(request ? request.result : undefined);
                };
                tx.onerror = function () {
                    reject(tx.error || new Error("tx_failed"));
                };
                tx.onabort = function () {
                    reject(tx.error || new Error("tx_aborted"));
                };
            });
        });
    }

    var store = {
        available: Boolean(global.indexedDB),

        /** 保存文件；成功返回 true，失败（配额不足 / 隐私模式）返回 false */
        save: function (id, file) {
            if (!id || !file) {
                return Promise.resolve(false);
            }
            return withStore("readwrite", function (s) {
                return s.put(file, String(id));
            }).then(function () {
                return true;
            }).catch(function () {
                return false;
            });
        },

        /** 取出文件（Blob / File）；没有就返回 null */
        get: function (id) {
            if (!id) {
                return Promise.resolve(null);
            }
            return withStore("readonly", function (s) {
                return s.get(String(id));
            }).then(function (value) {
                return value || null;
            }).catch(function () {
                return null;
            });
        },

        remove: function (id) {
            if (!id) {
                return Promise.resolve(false);
            }
            return withStore("readwrite", function (s) {
                return s.delete(String(id));
            }).then(function () {
                return true;
            }).catch(function () {
                return false;
            });
        }
    };

    global.VTXVideoStore = store;
})(window);
