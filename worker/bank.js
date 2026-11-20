const BANK_PREFIX = "bank:card:";

function cents(value) {
    const n = Number(String(value == null ? "" : value).replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? Math.round(n * 100) : null;
}
function money(c) { return (c / 100).toFixed(2); }
function cardNumber() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const digits = Array.from(bytes, (b) => String(b % 10)).join("");
    return digits.replace(/(.{4})/g, "$1-").replace(/-$/, "");
}
async function readCard(env, login) { return await env.ACCOUNTS_KV.get(BANK_PREFIX + login, "json"); }
async function saveCard(env, login, card) { await env.ACCOUNTS_KV.put(BANK_PREFIX + login, JSON.stringify(card)); }

export async function routeBank(request, env, cors, deps) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/bank\/?/, "");
    const session = await deps.requireSession(request, env, cors);
    if (session.error) return session.error;
    const login = session.payload.sub;

    if (path === "card" && request.method === "GET") {
        return deps.jsonResponse({ ok: true, card: await readCard(env, login) }, 200, cors);
    }
    if (path === "card" && request.method === "POST") {
        let card = await readCard(env, login);
        if (!card) {
            card = { number: cardNumber(), cvv: String(100 + Math.floor(Math.random() * 900)), expiry: "12/30", balance: "0.00", transactions: [], createdAt: new Date().toISOString() };
            await saveCard(env, login, card);
        }
        return deps.jsonResponse({ ok: true, card }, 200, cors);
    }
    if ((path === "recharge" || path === "withdraw") && request.method === "POST") {
        const body = deps.plainObject(await deps.readJsonBody(request));
        const amount = cents(body.amount);
        if (amount == null || amount <= 0) return deps.jsonResponse({ error: "bad_request", message: "金额必须大于 0" }, 400, cors);
        const card = await readCard(env, login);
        if (!card) return deps.jsonResponse({ error: "no_card", message: "请先创建银行卡" }, 400, cors);
        const accounts = await env.ACCOUNTS_KV.get("accounts", "json");
        await deps.checkPassword(accounts[login], body.password);
        const cardCents = cents(card.balance) || 0;
        if (path === "withdraw" && cardCents < amount) return deps.jsonResponse({ error: "insufficient_funds", message: "银行卡余额不足" }, 400, cors);
        await deps.commitAccounts(env, (data) => {
            const account = data[login];
            if (!account) throw new deps.HttpError(404, "not_found", "账户不存在");
            const accountCents = cents(account.money) || 0;
            if (path === "recharge" && accountCents < amount) throw new deps.HttpError(400, "insufficient_funds", "VTX 余额不足");
            account.money = deps.addMoney(account.money, path === "recharge" ? -amount : amount);
        });
        card.balance = money(path === "recharge" ? cardCents + amount : cardCents - amount);
        card.transactions = Array.isArray(card.transactions) ? card.transactions : [];
        card.transactions.unshift({ type: path, amount: money(amount), time: new Date().toISOString(), balance: card.balance });
        card.transactions = card.transactions.slice(0, 50);
        await saveCard(env, login, card);
        return deps.jsonResponse({ ok: true, card }, 200, cors);
    }
    return deps.jsonResponse({ error: "not_found", message: "Bank 接口不存在" }, 404, cors);
}