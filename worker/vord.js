/*
 * Vitual XRing 9.4.0 — Vord 文本文档
 *
 * - 登录用户可以在 Vord 里新建 / 编辑 txt / md 文档，内容存在 Workers KV；
 * - 文档可以保存到 XOS 云盘（由前端调用 /api/xos/files），也可以下载到本地；
 * - 每个文档可以生成分享链接，链接权限分 6 档：
 *     1 = 仅预览              2 = 仅登录账号可预览
 *     3 = 仅受邀的账号可预览   4 = 可编辑
 *     5 = 仅登录账号可编辑     6 = 仅受邀的账号可编辑
 * - 编辑记录按人记录：登录用户显示账户昵称，未登录的编辑者显示
 *   「匿名用户 [网页版]」/「匿名用户 [Windows版]」。
 */
const VORD_VERSION = "9.4.0";

const VORD_DOC_PREFIX = "vord:doc:";
const VORD_INDEX_PREFIX = "vord:index:";
const VORD_TOKEN_PREFIX = "vord:token:";

const VORD_MAX_BYTES = 512 * 1024;
const VORD_MAX_DOCS = 200;
const VORD_MAX_INVITES = 200;
const VORD_HISTORY_LIMIT = 120;
const VORD_TITLE_MAX = 120;

const VORD_ID_PATTERN = /^d_[A-Za-z0-9]{6,32}$/;
const VORD_TOKEN_PATTERN = /^[A-Za-z0-9]{16,64}$/;

const VORD_PERMISSIONS = [
    { value: 1, label: "仅预览" },
    { value: 2, label: "仅登录账号可预览" },
    { value: 3, label: "仅受邀的账号可预览" },
    { value: 4, label: "可编辑" },
    { value: 5, label: "仅登录账号可编辑" },
    { value: 6, label: "仅受邀的账号可编辑" }
];

const VORD_CLIENTS = ["网页版", "Windows版"];

function vordRandom(prefix, bytes) {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    const data = new Uint8Array(Number(bytes) || 9);
    crypto.getRandomValues(data);
    let out = "";
    for (let index = 0; index < data.length; index += 1) {
        out += alphabet[data[index] % alphabet.length];
    }
    return String(prefix || "") + out;
}

function vordByteSize(text) {
    return new TextEncoder().encode(String(text == null ? "" : text)).length;
}

function vordPermission(value) {
    const number = Number(value);
    return VORD_PERMISSIONS.some((item) => item.value === number) ? number : 1;
}

function vordPermissionLabel(value) {
    const item = VORD_PERMISSIONS.find((entry) => entry.value === vordPermission(value));
    return item ? item.label : VORD_PERMISSIONS[0].label;
}

function vordCleanTitle(raw) {
    return String(raw == null ? "" : raw)
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, VORD_TITLE_MAX);
}

function vordFormat(raw, title) {
    const value = String(raw || "").toLowerCase();
    if (value === "md" || value === "markdown") return "md";
    if (value === "txt" || value === "text") return "txt";
    return /\.md$/i.test(String(title || "")) ? "md" : "txt";
}

function vordFileExtension(format) {
    return format === "md" ? "md" : "txt";
}

function vordContentType(format) {
    return format === "md" ? "text/markdown" : "text/plain";
}

function vordAccountName(accounts, login) {
    const account = accounts && accounts[login];
    const name = String((account && account.username) || login || "").trim();
    return name || String(login || "");
}

function vordClientName(request, raw) {
    const value = String(raw || "").trim();
    if (VORD_CLIENTS.includes(value)) return value;
    if (/windows|electron|客户端|桌面/i.test(value)) return "Windows版";
    if (/网页|web|browser|browser版/i.test(value)) return "网页版";
    const agent = String((request && request.headers && request.headers.get("user-agent")) || "");
    return /Electron|VitualXRing/i.test(agent) ? "Windows版" : "网页版";
}

function vordGuestName(client) {
    return `匿名用户 [${VORD_CLIENTS.includes(client) ? client : "网页版"}]`;
}

/* 返回链接权限允许的操作。登录用户可以不具备邀请资格（3 / 6 档）。 */
function vordAccess(permission, login, invitees) {
    const mode = vordPermission(permission);
    const logged = Boolean(login);
    const invited = logged && Array.isArray(invitees) && invitees.includes(login);
    switch (mode) {
        case 1:
            return { view: true, edit: false, loginRequired: false, inviteRequired: false };
        case 2:
            return { view: logged, edit: false, loginRequired: !logged, inviteRequired: false };
        case 3:
            return { view: invited, edit: false, loginRequired: !logged, inviteRequired: logged && !invited };
        case 4:
            return { view: true, edit: true, loginRequired: false, inviteRequired: false };
        case 5:
            return { view: logged, edit: logged, loginRequired: !logged, inviteRequired: false };
        case 6:
            return { view: invited, edit: invited, loginRequired: !logged, inviteRequired: logged && !invited };
        default:
            return { view: true, edit: false, loginRequired: false, inviteRequired: false };
    }
}

function vordDocKey(owner, id) {
    return `${VORD_DOC_PREFIX}${owner}:${id}`;
}

function vordIndexKey(owner) {
    return `${VORD_INDEX_PREFIX}${owner}`;
}

function vordTokenKey(token) {
    return `${VORD_TOKEN_PREFIX}${token}`;
}

function vordMeta(doc) {
    return {
        id: doc.id,
        title: doc.title,
        format: doc.format,
        size: Number(doc.size) || 0,
        createdAt: Number(doc.createdAt) || 0,
        updatedAt: Number(doc.updatedAt) || 0,
        shared: Boolean(doc.token),
        permission: vordPermission(doc.permission),
        permissionLabel: vordPermissionLabel(doc.permission),
        editCount: Array.isArray(doc.history) ? doc.history.length : 0
    };
}

function vordHistoryView(history, includeLogin) {
    return (Array.isArray(history) ? history : []).slice(0, VORD_HISTORY_LIMIT).map((entry) => {
        const item = {
            at: Number(entry.at) || 0,
            name: String(entry.name || "").replace(/^著名用户/, "匿名用户"),
            guest: entry.guest === true,
            client: VORD_CLIENTS.includes(entry.client) ? entry.client : "网页版",
            action: entry.action === "create" ? "create" : "edit"
        };
        if (includeLogin) item.by = String(entry.by || "");
        return item;
    });
}

function vordRecord(doc, accounts, login, request, clientHint, action) {
    const client = vordClientName(request, clientHint);
    const guest = !login;
    const entry = {
        at: Date.now(),
        by: login || "",
        name: guest ? vordGuestName(client) : vordAccountName(accounts, login),
        guest,
        client,
        action: action === "create" ? "create" : "edit"
    };
    doc.history = Array.isArray(doc.history) ? doc.history : [];
    doc.history.unshift(entry);
    if (doc.history.length > VORD_HISTORY_LIMIT) {
        doc.history.length = VORD_HISTORY_LIMIT;
    }
}

async function vordReadIndex(env, owner) {
    const value = await env.ACCOUNTS_KV.get(vordIndexKey(owner), "json");
    return Array.isArray(value)
        ? value.filter((item) => item && VORD_ID_PATTERN.test(String(item.id || "")))
        : [];
}

async function vordReadDoc(env, owner, id) {
    const value = await env.ACCOUNTS_KV.get(vordDocKey(owner, id), "json");
    if (!value || !value.id || String(value.owner || "") !== String(owner)) return null;
    return value;
}

async function vordWriteIndexDoc(env, owner, doc) {
    const index = await vordReadIndex(env, owner);
    const meta = vordMeta(doc);
    const position = index.findIndex((item) => item.id === doc.id);
    if (position === -1) index.push(meta);
    else index[position] = meta;
    await env.ACCOUNTS_KV.put(vordIndexKey(owner), JSON.stringify(index));
}

async function vordSaveDoc(env, doc) {
    doc.updatedAt = Number(doc.updatedAt) || Date.now();
    doc.size = vordByteSize(doc.content);
    await env.ACCOUNTS_KV.put(vordDocKey(doc.owner, doc.id), JSON.stringify(doc));
    await vordWriteIndexDoc(env, doc.owner, doc);
}

function vordOwnerView(doc, accounts) {
    const invitees = (Array.isArray(doc.invitees) ? doc.invitees : []).map((login) => ({
        login,
        name: vordAccountName(accounts, login)
    }));
    return {
        ...vordMeta(doc),
        content: String(doc.content == null ? "" : doc.content),
        owner: doc.owner,
        ownerName: vordAccountName(accounts, doc.owner),
        token: doc.token || "",
        permission: vordPermission(doc.permission),
        permissionLabel: vordPermissionLabel(doc.permission),
        invitees,
        history: vordHistoryView(doc.history, true),
        sharePath: doc.token ? `vord.html?doc=${encodeURIComponent(doc.token)}` : ""
    };
}

function vordSharedView(doc, accounts, login) {
    const owner = Boolean(login) && String(login) === String(doc.owner);
    const access = vordAccess(doc.permission, login, doc.invitees);
    const visible = owner || access.view;
    return {
        id: doc.id,
        title: doc.title,
        format: doc.format,
        ownerName: vordAccountName(accounts, doc.owner),
        createdAt: Number(doc.createdAt) || 0,
        updatedAt: Number(doc.updatedAt) || 0,
        size: Number(doc.size) || 0,
        permission: vordPermission(doc.permission),
        permissionLabel: vordPermissionLabel(doc.permission),
        canView: visible,
        canEdit: owner || access.edit,
        isOwner: owner,
        loginRequired: access.loginRequired,
        inviteRequired: access.inviteRequired,
        history: visible ? vordHistoryView(doc.history, false) : [],
        content: visible ? String(doc.content == null ? "" : doc.content) : ""
    };
}

function vordShareInfo(doc, accounts) {
    return {
        token: doc.token || "",
        permission: vordPermission(doc.permission),
        permissionLabel: vordPermissionLabel(doc.permission),
        invitees: (Array.isArray(doc.invitees) ? doc.invitees : []).map((login) => ({
            login,
            name: vordAccountName(accounts, login)
        })),
        sharePath: doc.token ? `vord.html?doc=${encodeURIComponent(doc.token)}` : ""
    };
}

function vordTooLarge(cors, jsonResponse) {
    return jsonResponse({
        error: "payload_too_large",
        message: `单个 Vord 文档不能超过 ${Math.round(VORD_MAX_BYTES / 1024)} KB`
    }, 413, cors);
}

async function vordOwnerDocument(env, cors, jsonResponse, login, id) {
    if (!VORD_ID_PATTERN.test(String(id || ""))) {
        return { error: jsonResponse({ error: "bad_request", message: "文档 id 不合法" }, 400, cors) };
    }
    const doc = await vordReadDoc(env, login, id);
    if (!doc) {
        return { error: jsonResponse({ error: "not_found", message: "文档不存在" }, 404, cors) };
    }
    return { doc };
}

export async function routeVord(request, env, cors, context) {
    const {
        jsonResponse, readJsonBody, plainObject, requireSession, optionalLogin,
        loadAccounts, withStoreLock
    } = context;
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    // ["api", "vord", ...]
    const section = parts[2] || "";
    const method = request.method;

    if (!env.ACCOUNTS_KV) {
        return jsonResponse({ error: "storage_unavailable", message: "Vord 需要 Workers KV 存储" }, 503, cors);
    }

    /* 公开分享链接：/api/vord/share/{token} */
    if (section === "share") {
        const token = decodeURIComponent(parts[3] || "");
        if (!VORD_TOKEN_PATTERN.test(token)) {
            return jsonResponse({ error: "bad_request", message: "分享链接不合法" }, 400, cors);
        }
        const target = await env.ACCOUNTS_KV.get(vordTokenKey(token), "json");
        if (!target || !target.owner || !target.id) {
            return jsonResponse({ error: "not_found", message: "分享链接不存在或已关闭" }, 404, cors);
        }
        const login = await optionalLogin(request);
        const accounts = await loadAccounts(env);
        const doc = await vordReadDoc(env, target.owner, target.id);
        if (!doc || doc.token !== token) {
            return jsonResponse({ error: "not_found", message: "分享链接不存在或已关闭" }, 404, cors);
        }
        const owner = Boolean(login) && String(login) === String(doc.owner);
        const access = vordAccess(doc.permission, login, doc.invitees);
        const meta = {
            title: doc.title,
            ownerName: vordAccountName(accounts, doc.owner),
            permission: vordPermission(doc.permission),
            permissionLabel: vordPermissionLabel(doc.permission)
        };

        if (method === "GET") {
            if (!owner && !access.view) {
                const error = access.loginRequired ? "login_required" : "not_invited";
                const status = access.loginRequired ? 401 : 403;
                return jsonResponse({
                    error,
                    message: access.loginRequired
                        ? "登录 Vitual XRing 账号后才能查看这个文档"
                        : "只有受邀的账号才能查看这个文档",
                    meta
                }, status, cors);
            }
            return jsonResponse({ ok: true, document: vordSharedView(doc, accounts, login) }, 200, cors);
        }

        if (method === "PUT" || method === "PATCH") {
            if (owner || access.edit) {
                const body = plainObject(await readJsonBody(request));
                const content = String(body.content == null ? "" : body.content);
                if (vordByteSize(content) > VORD_MAX_BYTES) {
                    return vordTooLarge(cors, jsonResponse);
                }
                const result = await withStoreLock(async () => {
                    const latest = await vordReadDoc(env, target.owner, target.id);
                    if (!latest || latest.token !== token) {
                        return { error: jsonResponse({ error: "not_found", message: "分享链接不存在或已关闭" }, 404, cors) };
                    }
                    const latestOwner = Boolean(login) && String(login) === String(latest.owner);
                    const latestAccess = vordAccess(latest.permission, login, latest.invitees);
                    if (!latestOwner && !latestAccess.edit) {
                        return { error: jsonResponse({ error: "read_only", message: "这个链接不允许编辑" }, 403, cors) };
                    }
                    latest.content = content;
                    latest.updatedAt = Date.now();
                    vordRecord(latest, accounts, login, request, body.client, "edit");
                    await vordSaveDoc(env, latest);
                    return { doc: latest };
                });
                if (result.error) return result.error;
                return jsonResponse({
                    ok: true,
                    document: vordSharedView(result.doc, accounts, login)
                }, 200, cors);
            }
            const error = access.loginRequired ? "login_required" : "read_only";
            const status = access.loginRequired ? 401 : 403;
            return jsonResponse({
                error,
                message: access.loginRequired ? "登录后才能编辑这个文档" : "这个链接不允许编辑",
                meta
            }, status, cors);
        }

        return jsonResponse({ error: "method_not_allowed", message: "不支持的方法" }, 405, cors);
    }

    if (section !== "documents") {
        return jsonResponse({ error: "not_found", message: "接口不存在" }, 404, cors);
    }

    /* 以下都是文档所有者接口，需要登录。 */
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const login = session.payload.sub;

    /* /api/vord/documents */
    if (!parts[3]) {
        const accounts = await loadAccounts(env);
        if (method === "GET") {
            const index = await vordReadIndex(env, login);
            index.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
            return jsonResponse({
                ok: true,
                version: VORD_VERSION,
                permissions: VORD_PERMISSIONS,
                ownerName: vordAccountName(accounts, login),
                documents: index
            }, 200, cors);
        }

        if (method === "POST") {
            const body = plainObject(await readJsonBody(request));
            const title = vordCleanTitle(body.title) || "未命名文档";
            const format = vordFormat(body.format, title);
            const content = String(body.content == null ? "" : body.content);
            if (vordByteSize(content) > VORD_MAX_BYTES) {
                return vordTooLarge(cors, jsonResponse);
            }
            const doc = {
                id: vordRandom("d_", 10),
                owner: login,
                title,
                format,
                content,
                size: 0,
                permission: 1,
                invitees: [],
                token: "",
                createdAt: Date.now(),
                updatedAt: Date.now(),
                history: []
            };
            vordRecord(doc, accounts, login, request, body.client, "create");
            const created = await withStoreLock(async () => {
                const index = await vordReadIndex(env, login);
                if (index.length >= VORD_MAX_DOCS) {
                    return { error: jsonResponse({ error: "too_many_documents", message: `最多只能创建 ${VORD_MAX_DOCS} 个文档` }, 413, cors) };
                }
                doc.size = vordByteSize(doc.content);
                await env.ACCOUNTS_KV.put(vordDocKey(login, doc.id), JSON.stringify(doc));
                index.push(vordMeta(doc));
                await env.ACCOUNTS_KV.put(vordIndexKey(login), JSON.stringify(index));
                return { doc };
            });
            if (created.error) return created.error;
            return jsonResponse({
                ok: true,
                document: vordOwnerView(created.doc, accounts),
                share: vordShareInfo(created.doc, accounts)
            }, 201, cors);
        }

        return jsonResponse({ error: "method_not_allowed", message: "不支持的方法" }, 405, cors);
    }

    const id = decodeURIComponent(parts[3] || "");
    const action = parts[4] || "";

    if (!action) {
        const found = await vordOwnerDocument(env, cors, jsonResponse, login, id);
        if (found.error) return found.error;
        const accounts = await loadAccounts(env);

        if (method === "GET") {
            return jsonResponse({
                ok: true,
                document: vordOwnerView(found.doc, accounts)
            }, 200, cors);
        }

        if (method === "PUT" || method === "PATCH") {
            const body = plainObject(await readJsonBody(request));
            if (body.content !== undefined && vordByteSize(body.content) > VORD_MAX_BYTES) {
                return vordTooLarge(cors, jsonResponse);
            }
            const result = await withStoreLock(async () => {
                const latest = await vordReadDoc(env, login, id);
                if (!latest) {
                    return { error: jsonResponse({ error: "not_found", message: "文档不存在" }, 404, cors) };
                }
                if (body.title !== undefined) {
                    latest.title = vordCleanTitle(body.title) || latest.title || "未命名文档";
                }
                if (body.format !== undefined) {
                    latest.format = vordFormat(body.format, latest.title);
                }
                if (body.content !== undefined) {
                    latest.content = String(body.content == null ? "" : body.content);
                }
                latest.updatedAt = Date.now();
                vordRecord(latest, accounts, login, request, body.client, "edit");
                await vordSaveDoc(env, latest);
                return { doc: latest };
            });
            if (result.error) return result.error;
            return jsonResponse({
                ok: true,
                document: vordOwnerView(result.doc, accounts),
                share: vordShareInfo(result.doc, accounts)
            }, 200, cors);
        }

        if (method === "DELETE") {
            await withStoreLock(async () => {
                const latest = await vordReadDoc(env, login, id);
                if (latest && latest.token) {
                    await env.ACCOUNTS_KV.delete(vordTokenKey(latest.token));
                }
                await env.ACCOUNTS_KV.delete(vordDocKey(login, id));
                const index = await vordReadIndex(env, login);
                await env.ACCOUNTS_KV.put(vordIndexKey(login), JSON.stringify(index.filter((item) => item.id !== id)));
            });
            return jsonResponse({ ok: true, removed: id }, 200, cors);
        }

        return jsonResponse({ error: "method_not_allowed", message: "不支持的方法" }, 405, cors);
    }

    if (action === "share") {
        const found = await vordOwnerDocument(env, cors, jsonResponse, login, id);
        if (found.error) return found.error;
        const accounts = await loadAccounts(env);

        if (method === "GET") {
            return jsonResponse({ ok: true, share: vordShareInfo(found.doc, accounts) }, 200, cors);
        }

        if (method === "POST" || method === "PUT" || method === "PATCH") {
            const body = plainObject(await readJsonBody(request));
            const permission = body.permission === undefined ? found.doc.permission : Number(body.permission);
            if (!VORD_PERMISSIONS.some((item) => item.value === Number(permission))) {
                return jsonResponse({ error: "bad_permission", message: "链接权限不合法" }, 400, cors);
            }
            let invitees = found.doc.invitees;
            if (body.invitees !== undefined) {
                if (!Array.isArray(body.invitees)) {
                    return jsonResponse({ error: "bad_request", message: "受邀账号列表不合法" }, 400, cors);
                }
                const cleaned = [];
                for (const raw of body.invitees.slice(0, VORD_MAX_INVITES)) {
                    const target = String(raw || "").trim();
                    if (!target || cleaned.includes(target)) continue;
                    if (!accounts[target]) {
                        return jsonResponse({
                            error: "account_not_found",
                            message: `找不到账户 ${target}，请检查登录名`
                        }, 400, cors);
                    }
                    cleaned.push(target);
                }
                invitees = cleaned;
            }
            const result = await withStoreLock(async () => {
                const latest = await vordReadDoc(env, login, id);
                if (!latest) {
                    return { error: jsonResponse({ error: "not_found", message: "文档不存在" }, 404, cors) };
                }
                latest.permission = vordPermission(permission);
                latest.invitees = (invitees || []).filter((item) => accounts[item]).slice(0, VORD_MAX_INVITES);
                if (!latest.token) {
                    latest.token = vordRandom("", 24);
                    await env.ACCOUNTS_KV.put(vordTokenKey(latest.token), JSON.stringify({ owner: login, id }));
                }
                latest.updatedAt = Number(latest.updatedAt) || Date.now();
                await vordSaveDoc(env, latest);
                return { doc: latest };
            });
            if (result.error) return result.error;
            return jsonResponse({
                ok: true,
                share: vordShareInfo(result.doc, accounts),
                document: vordOwnerView(result.doc, accounts)
            }, 200, cors);
        }

        if (method === "DELETE") {
            const result = await withStoreLock(async () => {
                const latest = await vordReadDoc(env, login, id);
                if (!latest) {
                    return { error: jsonResponse({ error: "not_found", message: "文档不存在" }, 404, cors) };
                }
                if (latest.token) {
                    await env.ACCOUNTS_KV.delete(vordTokenKey(latest.token));
                    latest.token = "";
                    await vordSaveDoc(env, latest);
                }
                return { doc: latest };
            });
            if (result.error) return result.error;
            return jsonResponse({
                ok: true,
                share: vordShareInfo(result.doc, accounts),
                document: vordOwnerView(result.doc, accounts)
            }, 200, cors);
        }

        return jsonResponse({ error: "method_not_allowed", message: "不支持的方法" }, 405, cors);
    }

    return jsonResponse({ error: "not_found", message: "接口不存在" }, 404, cors);
}

export { VORD_VERSION, VORD_PERMISSIONS, VORD_MAX_BYTES, vordContentType, vordFileExtension };
