import test from "node:test";
import assert from "node:assert/strict";

import worker from "../index.js";

/* 12.0.1：同捆包与成为商铺 Beta */

class MockKV {
    constructor() {
        this.map = new Map();
    }

    async get(key, type) {
        const entry = this.map.get(key);
        if (!entry) return null;
        if (type === "json") return typeof entry.value === "string" ? JSON.parse(entry.value) : entry.value;
        return entry.value;
    }

    async put(key, value) {
        this.map.set(key, { value });
    }

    async delete(key) {
        this.map.delete(key);
    }

    async list() {
        return { keys: Array.from(this.map.keys()).map((name) => ({ name })) };
    }
}

const CATALOG = {
    version: "10.0",
    "XOS虚拟云电脑": [
        {
            id: "xos-pc-home-26h2",
            name: "XOS PC Home 26H2",
            price: "1025.00",
            virtual: true,
            type: "xos",
            xosEdition: "home",
            xosRank: 0,
            xosGeneration: 2,
            xosUpgradePrice: "25.00",
            xosConfig: { resolution: "1440x900", cpu: "XOS CPU V1 2025" },
            refreshRates: [15],
            xosApps: ["任务管理器", "番茄钟"]
        },
        {
            id: "xos-pc-personal-26h2",
            name: "XOS PC Personal 26H2",
            price: "1275.00",
            virtual: true,
            type: "xos",
            xosEdition: "personal",
            xosRank: 1,
            xosGeneration: 2,
            xosUpgradePrice: "25.00",
            xosConfig: { resolution: "1440x900", cpu: "XOS Core V1 2025" },
            refreshRates: [15, 30],
            xosApps: ["任务管理器", "番茄钟"]
        }
    ],
    "同捆包 [Beta]": [
        {
            id: "bundle-xos-creator-26h2",
            name: "XOS 创作者双机同捆包 [Beta]",
            price: "2200.00",
            virtual: true,
            type: "bundle",
            bundle: true,
            bundleItems: ["xos-pc-home-26h2", "xos-pc-personal-26h2"],
            stock: 9999
        },
        {
            id: "bundle-invalid",
            name: "无效同捆包",
            price: "1.00",
            virtual: true,
            type: "bundle",
            bundle: true,
            bundleItems: ["missing-item", "xos-pc-home-26h2"],
            stock: 9999
        }
    ]
};

const SEED = {
    Alice: { password: "password1", username: "爱丽丝", money: "5000.00", trades: [], data: {} },
    Bob: { password: "password1", username: "鲍勃", money: "100.00", trades: [], data: {} },
    Kitawaga: { password: "adminpass1", username: "站主", money: "0.00", trades: [], data: {} }
};

let envCount = 0;

function createEnv() {
    envCount += 1;
    return {
        ACCOUNTS_KV: new MockKV(),
        SIGNING_SECRET: "test-secret",
        ADMIN_ACCOUNT: "Kitawaga",
        ALLOWED_ORIGINS: "*",
        TOKEN_TTL_SECONDS: "3600",
        SHOP_CATALOG: CATALOG,
        __ip: `10.91.${Math.floor(envCount / 250)}.${envCount % 250}`
    };
}

async function api(env, method, path, options = {}) {
    const headers = new Headers();
    if (env.__ip) headers.set("cf-connecting-ip", env.__ip);
    if (options.token) headers.set("authorization", `Bearer ${options.token}`);
    let body;
    if (options.body !== undefined) {
        headers.set("content-type", "application/json");
        body = JSON.stringify(options.body);
    }
    const response = await worker.fetch(new Request(`https://api.test${path}`, { method, headers, body }), env);
    const type = response.headers.get("content-type") || "";
    return {
        status: response.status,
        data: type.includes("application/json") ? await response.json() : await response.text()
    };
}

async function prepare() {
    const env = createEnv();
    await env.ACCOUNTS_KV.put("accounts", JSON.stringify(SEED));
    const tokens = {};
    for (const login of Object.keys(SEED)) {
        const password = SEED[login].password;
        const result = await api(env, "POST", "/api/login", { body: { login, password } });
        assert.equal(result.status, 200, JSON.stringify(result.data));
        tokens[login] = result.data.token;
    }
    return { env, tokens };
}

test("12.0.1：购买同捆包一次获得多个 XOS 授权", async () => {
    const { env, tokens } = await prepare();
    const result = await api(env, "POST", "/api/me/purchase", {
        token: tokens.Alice,
        body: { id: "bundle-xos-creator-26h2", quantity: 1, password: "password1" }
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.item.unitPrice, "2200.00");
    assert.equal(result.data.account.money, "2800.00");
    assert.equal(result.data.account.xosDevices.length, 2);
    assert.equal(result.data.account.xosDevices.some((item) => item.edition === "home"), true);
    assert.equal(result.data.account.xosDevices.some((item) => item.edition === "personal"), true);
    assert.match(result.data.receipt, /包含/);
});

test("12.0.1：同捆包有缺失商品时拒绝购买", async () => {
    const { env, tokens } = await prepare();
    const result = await api(env, "POST", "/api/me/purchase", {
        token: tokens.Alice,
        body: { id: "bundle-invalid", quantity: 1, password: "password1" }
    });
    assert.equal(result.status, 400);
    assert.equal(result.data.error, "unsupported_bundle");
});

test("12.0.1：商铺申请由站主审核并通过", async () => {
    const { env, tokens } = await prepare();
    const submit = await api(env, "POST", "/api/shop/application", {
        token: tokens.Alice,
        body: { name: "爱丽丝工坊", description: "制作 XOS 主题壁纸和小工具。" }
    });
    assert.equal(submit.status, 201, JSON.stringify(submit.data));
    assert.equal(submit.data.application.status, "pending");

    const duplicate = await api(env, "POST", "/api/shop/application", {
        token: tokens.Alice,
        body: { name: "第二个名字", description: "重复申请应该被拒绝。" }
    });
    assert.equal(duplicate.status, 409);

    const adminList = await api(env, "GET", "/api/admin/shop-applications", { token: tokens.Kitawaga });
    assert.equal(adminList.status, 200);
    assert.equal(adminList.data.applications.length, 1);
    assert.equal(adminList.data.applications[0].login, "Alice");

    const reviewed = await api(env, "POST", `/api/admin/shop-applications/${submit.data.application.id}`, {
        token: tokens.Kitawaga,
        body: { action: "approve", note: "欢迎入驻" }
    });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
    assert.equal(reviewed.data.application.status, "approved");

    const mine = await api(env, "GET", "/api/shop/application", { token: tokens.Alice });
    assert.equal(mine.status, 200);
    assert.equal(mine.data.shop.name, "爱丽丝工坊");

    const shops = await api(env, "GET", "/api/shops");
    assert.equal(shops.status, 200);
    assert.equal(shops.data.shops.length, 1);
    assert.equal(shops.data.shops[0].name, "爱丽丝工坊");
});

test("12.0.1：认证商铺上架商品，站主审核后可购买并结算给商家", async () => {
    const { env, tokens } = await prepare();
    const application = await api(env, "POST", "/api/shop/application", {
        token: tokens.Alice,
        body: { name: "爱丽丝工坊", description: "制作 XOS 主题壁纸和小工具。" }
    });
    assert.equal(application.status, 201);
    const approvedShop = await api(env, "POST", `/api/admin/shop-applications/${application.data.application.id}`, {
        token: tokens.Kitawaga,
        body: { action: "approve", note: "" }
    });
    assert.equal(approvedShop.status, 200);

    const listing = await api(env, "POST", "/api/merchant/products", {
        token: tokens.Alice,
        body: {
            name: "XOS 主题贴纸",
            description: "一套四张的 XOS 26H2 主题贴纸。",
            price: "25.00",
            stock: 2,
            category: "文具",
            image: "images/xos-pc-home.svg"
        }
    });
    assert.equal(listing.status, 201, JSON.stringify(listing.data));
    assert.equal(listing.data.product.status, "pending");

    const submitted = await api(env, "GET", "/api/merchant/products", { token: tokens.Alice });
    assert.equal(submitted.status, 200);
    assert.equal(submitted.data.products.length, 1);

    const review = await api(env, "POST", `/api/admin/merchant-products/${listing.data.product.id}`, {
        token: tokens.Kitawaga,
        body: { action: "approve", note: "可以上架" }
    });
    assert.equal(review.status, 200, JSON.stringify(review.data));

    const publicProducts = await api(env, "GET", "/api/shop/merchant-products");
    assert.equal(publicProducts.status, 200);
    assert.equal(publicProducts.data.products.length, 1);
    assert.equal(publicProducts.data.products[0].shopName, "爱丽丝工坊");

    const updated = await api(env, "GET", "/api/shop");
    assert.equal(updated.status, 200);
    assert.equal(updated.data.stock[listing.data.product.id], 2);

    const bought = await api(env, "POST", "/api/me/purchase", {
        token: tokens.Bob,
        body: { id: listing.data.product.id, quantity: 1, password: "password1" }
    });
    assert.equal(bought.status, 200, JSON.stringify(bought.data));
    assert.match(bought.data.receipt, /爱丽丝工坊/);

    const meAlice = await api(env, "GET", "/api/me", { token: tokens.Alice });
    assert.equal(meAlice.data.account.money, "5025.00");
    const meBob = await api(env, "GET", "/api/me", { token: tokens.Bob });
    assert.equal(meBob.data.account.money, "75.00");
    const afterStock = await api(env, "GET", "/api/shop");
    assert.equal(afterStock.data.stock[listing.data.product.id], 1);

    const selfBuy = await api(env, "POST", "/api/me/purchase", {
        token: tokens.Alice,
        body: { id: listing.data.product.id, quantity: 1, password: "password1" }
    });
    assert.equal(selfBuy.status, 400);
});

test("12.0.1：普通用户不能审核商铺，拒绝后可以重新申请", async () => {
    const { env, tokens } = await prepare();
    const submit = await api(env, "POST", "/api/shop/application", {
        token: tokens.Bob,
        body: { name: "鲍勃小铺", description: "卖一些数字小玩意。" }
    });
    assert.equal(submit.status, 201);

    const forbidden = await api(env, "GET", "/api/admin/shop-applications", { token: tokens.Bob });
    assert.equal(forbidden.status, 403);

    const reviewed = await api(env, "POST", `/api/admin/shop-applications/${submit.data.application.id}`, {
        token: tokens.Kitawaga,
        body: { action: "reject", note: "请补充经营范围" }
    });
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.data.application.status, "rejected");

    const again = await api(env, "POST", "/api/shop/application", {
        token: tokens.Bob,
        body: { name: "鲍勃小铺", description: "卖数字小玩意，补充经营范围。" }
    });
    assert.equal(again.status, 201);
});
