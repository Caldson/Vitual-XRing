# Vitual XRing API 文档

账户服务 API，用于在其它站点登录 Vitual XRing 账户并同步全部账户信息。

- 基础地址：`https://xsmmc.caldson.us.ci`
- 所有接口均返回 JSON，字符集 UTF-8
- 实现：Cloudflare Worker（[worker/index.js](./worker/index.js)）
- 客户端 SDK：[vtx-sdk.js](./vtx-sdk.js)
- API 版本：`6.2.0`（接口与 5.2.0 一致；6.0 新增商店、管理员仓库修改器与聊天室页面，6.1 更新商店商品数据，6.2 新增商店分类，见第 9.2 节）

---

## 1. 快速开始

### 1.1 浏览器（推荐，使用 SDK）

```html
<script src="https://xsmmc.caldson.us.ci/vtx-sdk.js"></script>
<script>
    VTX.configure({ baseUrl: "https://xsmmc.caldson.us.ci" });

    const session = await VTX.login("账户名称", "你的密码");
    console.log(session.account.username, session.account.money);

    const all = await VTX.accounts();     // 同步全部账户
    console.log(all.count, all.accounts);
</script>
```

### 1.2 直接调用 HTTP

```bash
# 登录，拿到 token
curl -X POST https://xsmmc.caldson.us.ci/api/login \
  -H "content-type: application/json" \
  -d '{"login":"账户名称","password":"你的密码"}'

# 用 token 读取全部账户
curl https://xsmmc.caldson.us.ci/api/accounts \
  -H "authorization: Bearer <token>"
```

> 站点的 Cloudflare 机器人防护可能会拦截非浏览器请求（返回 403）。
> 若需服务端调用，请在 Cloudflare WAF 中为 `/api/*` 添加放行规则。

---

## 2. 认证

- 调用 `POST /api/login` 用登录名 + 密码换取 **token**
- 后续请求在请求头携带：`Authorization: Bearer <token>`
- token 为 HMAC-SHA256 签名（`base64url(payload).base64url(signature)`），**默认 12 小时有效**
- token 无状态：服务端不存储会话；轮换 `SIGNING_SECRET` 会让所有 token 立即失效

**载荷结构**

```json
{ "sub": "账户名称", "iat": 1760688000, "exp": 1760731200, "iss": "vtx-api" }
```

`sub` 为**登录账户名**（JSON 键），不是显示用的用户名。

---

## 3. 数据模型

### 3.1 Account（对外返回，已剥离密码）

```json
{
    "username": "用户名",
    "money": "100.00",
    "trades": [
        {
            "name": "转账",
            "description": "备注示例",
            "time": "2026/10/17",
            "from": "用户名",
            "to": "另一个用户名",
            "price": "-50.00"
        }
    ],
    "data": {
        "Decrive": {
            "boost": 1,
            "stats": { "charts": {}, "last": null }
        },
        "另一个游戏": {
            "自定义键": "值"
        }
    }
}
```

`data` 的第一层键是**游戏名称**（调用方自定义，允许中英文、数字、空格、`_`、`.`、`-`，1–32 字符），
第二层才是该游戏自己的数据。不同游戏互不干扰，删除某个游戏的数据不会影响其它游戏。

| 字段 | 类型 | 说明 |
|---|---|---|
| `username` | string | 显示用用户名（可修改，不唯一） |
| `money` | string | 余额，保留两位小数的字符串，单位 VTX |
| `trades` | array | 交易记录，按追加顺序；展示时按 `time` 倒序 |
| `data` | object | 按游戏名分区的自定义数据（`data["游戏名称"] = {...}`），默认 `{}`，只能由本人通过 API 写入 |

> 任何接口都**不会返回密码**。

### 3.2 Trade

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 交易类型，如 `转账`、`官方福利`、`每日签到`、`提款`、`AI 聊天`、`AI 生图` |
| `description` | string | 备注 |
| `time` | string | `YYYY/MM/DD` 或 `YYYY/MM/DD HH:mm:ss` |
| `from` | string | 付款方显示名，或 `系统` / `官方` |
| `to` | string | 收款方显示名，或 `AI` / `XRingCR` |
| `price` | string | 带符号金额，如 `-50.00`、`+5.00` |

---

## 4. 接口列表

| 方法 | 路径 | 需要 token | 说明 |
|---|---|---|---|
| GET | `/api/health` | 否 | 健康检查 |
| POST | `/api/login` | 否 | 登录，换取 token |
| POST | `/api/register` | 否 | 创建账户并直接登录 |
| GET | `/api/me` | 是 | 当前登录账户信息 |
| GET | `/api/accounts` | 是 | 全部账户 |
| GET | `/api/accounts/{登录名}` | 是 | 单个账户 |
| PUT | `/api/me/data/{游戏名称}` | 是 | 写入某个游戏的数据（合并） |
| GET | `/api/me/data/{游戏名称}` | 是 | 读取某个游戏的数据 |
| DELETE | `/api/me/data/{游戏名称}` | 是 | 删除某个游戏的全部数据 |
| DELETE | `/api/me/data/{游戏名称}/{键}` | 是 | 删除某个游戏下的单个键 |
| PUT | `/api/accounts/{登录名}/data/{游戏名称}` | 是 | 同上，显式指定账户（只能是自己） |
| GET | `/api/accounts/{登录名}/data/{游戏名称}` | 是 | 同上 |
| DELETE | `/api/accounts/{登录名}/data/{游戏名称}[/{键}]` | 是 | 同上 |
| POST | `/api/me/trades` | 是 | 记一笔收款（无需密码）/ 付款（需密码确认） |
| POST | `/api/me/receipt-code` | 是 | 生成新的收款码（旧码立即失效） |
| GET | `/api/me/receipt-code` | 是 | 读取当前收款码 |
| DELETE | `/api/me/receipt-code` | 是 | 撤销收款码 |
| GET | `/api/receipt-codes/{code}` | 否 | 解析收款码（收款人、金额，不走缓存，刷新/撤销后立即失效） |
| POST | `/api/receipt-codes/{code}/pay` | 是 | 扫收款码付款（需密码） |
| POST | `/api/accounts/{登录名}/trades` | 是 | 同上，显式指定账户（只能是自己） |

> **破坏性变更（1.4.0）**：`/api/me/data`（不带游戏名）现在返回 `400 bad_request`，并提示新用法。
> 旧版平铺的 `data` 会被视为「键不是对象」，请把数据搬到 `data[游戏名称]` 下。

`GET /` 与 `GET /api` 同样返回健康检查结果。

---

### 4.1 健康检查

```
GET /api/health
```

**响应 `200`**

```json
{ "name": "Vitual XRing API", "version": "1.1.0", "ok": true }
```

---

### 4.2 登录

```
POST /api/login
content-type: application/json

{ "login": "账户名称", "password": "你的密码" }
```

**响应 `200`**

```json
{
    "token": "eyJzdWIiOiJLaXRh...<base64url 签名>",
    "expiresAt": "2026-10-18T04:00:00.000Z",
    "login": "账户名称",
    "account": {
        "username": "用户名",
        "money": "100.00",
        "trades": []
    }
}
```

**错误**

| 状态码 | `error` | 说明 |
|---|---|---|
| 400 | `bad_request` | 请求体不是 JSON，或缺少 `login` / `password` |
| 401 | `invalid_credentials` | 登录名或密码不正确 |
| 429 | `too_many_requests` | 同一 IP 每分钟失败超过 10 次 |
| 500 | `server_misconfigured` | 服务端未配置 `SIGNING_SECRET` |

> 登录名 = `account.json` 的键；**用显示用户名（nickname）登录会失败**，除非两者相同。

---

### 4.2.1 创建账户

创建新账户并**直接返回 token**（相当于注册后自动登录）。

```
POST /api/register
content-type: application/json

{
    "login": "账户名称",
    "password": "至少 6 位",
    "username": "显示名称（选填）"
}
```

**响应 `201`**

```json
{
    "token": "eyJzdWIiOi...",
    "expiresAt": "2026-10-18T04:00:00.000Z",
    "login": "账户名称",
    "created": true,
    "account": { "username": "显示名称", "money": "0.00", "trades": [], "data": {} }
}
```

**约束**

| 项目 | 限制 |
|---|---|
| 登录名 | 2–20 个字符，**不能包含空格**，全局唯一 |
| 密码 | 至少 6 个字符 |
| 显示名称 | 最多 24 个字符，留空则与登录名相同 |
| 初始余额 | `0.00` VTX |
| 频率 | 每 IP 每分钟 5 次 |
| 账户上限 | 500 个 |
| 服务端 | 必须配置 `GITHUB_TOKEN`，否则返回 `503 write_unavailable` |

登录名已被占用时返回 `409 account_exists`。

---

### 4.3 当前账户

```
GET /api/me
authorization: Bearer <token>
```

**响应 `200`**

```json
{
    "login": "账户名称",
    "expiresAt": "2026-10-18T04:00:00.000Z",
    "account": { "username": "用户名", "money": "100.00", "trades": [] }
}
```

---

### 4.4 全部账户

```
GET /api/accounts
authorization: Bearer <token>
```

**响应 `200`**

```json
{
    "me": "账户名称",
    "count": 2,
    "accounts": {
        "账户名称": { "username": "用户名", "money": "100.00", "trades": [] },
        "另一个账户": { "username": "另一个用户名", "money": "20.00", "trades": [] }
    }
}
```

---

### 4.5 单个账户

```
GET /api/accounts/{登录名}
authorization: Bearer <token>
```

**响应 `200`**

```json
{
    "login": "另一个账户",
    "account": { "username": "另一个用户名", "money": "20.00", "trades": [] }
}
```

**错误 `404`**

```json
{ "error": "not_found", "message": "账户不存在" }
```

---

### 4.6 写入游戏数据

把游戏成绩、进度之类的数据写进自己账户的某个游戏分区，**只会合并（merge），不会覆盖其它键或其它游戏**。

```
PUT /api/me/data/{游戏名称}
authorization: ******
content-type: application/json

{ "boost": 1, "stats": { "charts": {} } }
```

也可以用显式账户路径（值必须是自己）：

```
PUT /api/accounts/{登录名}/data/{游戏名称}
```

**响应 `200`**

```json
{
    "ok": true,
    "login": "账户名称",
    "game": "Decrive",
    "keys": ["boost", "stats"],
    "gameData": { "boost": 1, "stats": { "charts": {} } },
    "data": { "Decrive": { "boost": 1, "stats": { "charts": {} } } }
}
```

`gameData` 是该游戏合并后的完整数据，`data` 是账户里全部分区的数据。

**约束**

| 项目 | 限制 |
|---|---|
| 游戏名称 | 只能包含中英文、数字、空格、`_`、`.`、`-`，长度 1–32 |
| 单账户游戏数 | 最多 20 个分区 |
| 键名 | 只能包含字母、数字、`_`、`.`、`-`，长度 1–64 |
| 单次键数 | 最多 20 个 |
| 单账户数据总量 | 32 KB（整个 `data` 的 `JSON.stringify(...)` UTF-8 字节数） |
| 写入频率 | 每 IP 每分钟 60 次 |
| 权限 | 只能写自己的账户（token 的 `sub` 必须等于 `{登录名}`） |

---

### 4.6.1 读取游戏数据

```
GET /api/me/data/{游戏名称}
authorization: ******
```

或

```
GET /api/accounts/{登录名}/data/{游戏名称}
```

**响应 `200`**

```json
{ "ok": true, "login": "账户名称", "game": "Decrive", "gameData": { "boost": 1 } }
```

从未写过的游戏返回 `gameData: {}`。

---

### 4.7 删除游戏数据

删单个键：

```
DELETE /api/me/data/{游戏名称}/{键}
authorization: ******
```

删掉整个分区：

```
DELETE /api/me/data/{游戏名称}
```

也可以换成 `/api/accounts/{登录名}/data/...`。

**响应 `200`**

```json
{ "ok": true, "login": "账户名称", "game": "Decrive", "removed": "boost", "data": { "Decrive": { "stats": {} } } }
```

游戏分区或键不存在时返回 `404 not_found`；删整个分区时 `removed` 就是该游戏名称。

---

### 4.8 记一笔收款 / 付款

给自己的账户追加一条交易记录，并同步修改余额。

- **付款（`payment`）必须携带账户密码**（二次确认，防止 token 被盗后被刷）。
- **收款（`receipt`）不需要密码**，有有效 token 就能直接入账。

```
POST /api/me/trades
authorization: Bearer <token>
content-type: application/json

{
    "type": "payment",
    "amount": "12.34",
    "party": "示例网站",
    "description": "购买道具",
    "password": "账户密码"
}
```

收款就不用带 `password`：

```json
{
    "type": "receipt",
    "amount": "5.00",
    "party": "官方福利",
    "description": "每日签到"
}
```

也可用显式账户路径（`{登录名}` 必须是自己）：

```
POST /api/accounts/{登录名}/trades
```

**请求字段**

| 字段 | 必填 | 说明 |
|---|---|---|
| `type` | 是 | `payment`（付款，扣余额）或 `receipt`（收款，加余额） |
| `amount` | 是 | 正数字符串或数字，最多两位小数，单笔上限 `1000000.00` |
| `party` | 是 | 付款填**去向**，收款填**来源**（账户显示名或网站名），最长 40 字符 |
| `description` | 否 | 备注，最长 200 字符 |
| `name` | 否 | 记录名称，默认 `付款` / `收款`，最长 20 字符 |
| `password` | 仅付款 | 付款时必填，必须等于当前账户的登录密码；收款忽略此项 |

**生成的记录**

| `type` | `name` | `price` | `from` | `to` |
|---|---|---|---|---|
| `payment` | `付款` | `-12.34` | 本人显示名 | `party` |
| `receipt` | `收款` | `+12.34` | `party` | 本人显示名 |

`time` 为北京时间 `YYYY/MM/DD HH:mm:ss`。

**响应 `200`**

```json
{
    "ok": true,
    "login": "账户名称",
    "trade": {
        "name": "付款",
        "description": "购买道具",
        "time": "2026/10/17 18:30:12",
        "from": "用户名",
        "to": "示例网站",
        "price": "-12.34"
    },
    "account": { "username": "用户名", "money": "87.66", "trades": [], "data": {} }
}
```

**约束**

| 项目 | 限制 |
|---|---|
| 密码 | `payment` 必须与账户当前密码一致，否则 `400 invalid_password`（不会产生记录）；`receipt` 不校验密码 |
| 余额 | `payment` 时余额必须足够，否则 `400 insufficient_funds` |
| 权限 | 只能给自己记账（token 的 `sub` 必须等于 `{登录名}`），否则 `403 forbidden` |
| 频率 | 每 IP 每分钟 20 次，超出 `429 too_many_requests` |
| 并发 | 余额校验与写入在同一次提交内完成，服务端冲突自动重试 3 次 |

> 这条接口只做**记账**：`party` 是自由文本，不会给对方账户加减钱。需要账户间真实转账，请在站内 `manager.html` 操作。


### 4.9 收款码

扫码付款用的一次性收款入口。码本身是可撤销的随机串，**存在账户里**，所以：

- 只有主动「刷新」才会生成新码，重新打开页面、换设备打开都是同一个码
- 刷新后旧码立即失效（不会误收）
- **收款方不需要做任何确认**，付款方扫完码付完款，钱直接进账

#### 生成 / 读取 / 撤销（需要 token）

```
POST /api/me/receipt-code
authorization: ******
content-type: application/json

{ "amount": "12.50" }          // 可省略；省略则由付款方自己填金额
```

**响应 `200`**

```json
{
    "ok": true,
    "login": "账户名称",
    "payeeName": "用户名",
    "code": "Kq3fGb2xLmN0pQrStUvWxY",
    "amount": "12.50",
    "createdAt": "2026/10/19 20:00:00",
    "url": "https://xsmmc.caldson.us.ci/API_VTXPAY.html?rc=Kq3fGb2xLmN0pQrStUvWxY"
}
```

- `GET /api/me/receipt-code` 读当前码（不会重新生成），没有码时 `code` 为 `null`
- `DELETE /api/me/receipt-code` 撤销当前码

#### 解析收款码（公开，不需要 token）

```
GET /api/receipt-codes/{code}
```

```json
{
    "ok": true,
    "code": "Kq3fGb2xLmN0pQrStUvWxY",
    "payee": "账户名称",
    "payeeName": "用户名",
    "amount": "12.50",
    "createdAt": "2026/10/19 20:00:00",
    "url": "https://xsmmc.caldson.us.ci/API_VTXPAY.html?rc=Kq3fGb2xLmN0pQrStUvWxY"
}
```

码不存在或已被刷新替换时返回 `404 not_found`。这个接口**不走账户缓存**，所以刷新/撤销后立即失效。

#### 扫码付款（需要 token + 密码）

```
POST /api/receipt-codes/{code}/pay
authorization: ******
content-type: application/json

{ "password": "付款方密码", "amount": "12.50" }
```

- `amount` 只有在该收款码没有预设金额时才必填
- 收款方**不需要确认**，付款成功后钱立即入账

**响应 `200`**

```json
{
    "ok": true,
    "login": "付款方账户",
    "trade": {
        "name": "付款",
        "description": "",
        "time": "2026/10/19 20:05:11",
        "from": "付款方用户名",
        "to": "收款方用户名",
        "price": "-12.50"
    },
    "payee": { "login": "收款方账户", "username": "收款方用户名" },
    "account": { "username": "付款方用户名", "money": "87.50", "trades": [], "data": {} },
    "payeeAccount": { "login": "收款方账户", "money": "112.50" }
}
```

双方各追加一条记录：付款方 `付款 -12.50`，收款方 `收款 +12.50`。

**约束**

| 项目 | 限制 |
|---|---|
| 密码 | 付款方必须输入正确密码，否则 `400 invalid_password`（双方余额都不会变） |
| 余额 | 付款方余额必须足够，否则 `400 insufficient_funds` |
| 自己的码 | 扫自己的收款码付款返回 `400 bad_request` |
| 码格式 | 只允许字母、数字、`_`、`-`，长度 16–64 |
| 频率 | 生成受写入限流（每分钟 60 次）；付款受记账限流（每分钟 20 次） |

> 只在需要收钱时把码发给别人；码被转发出去谁都能用它给你打钱（不会扣你的钱），如果不想再收就点「撤销」。

---

## 5. 错误响应格式

所有错误统一为：

```json
{ "error": "错误码", "message": "可读说明" }
```

| 状态码 | `error` | 含义 |
|---|---|---|
| 400 | `bad_request` | 参数缺失、格式错误、键名不合法 |
| 400 | `invalid_password` | 付款时密码不正确 |
| 400 | `insufficient_funds` | 付款金额超过当前余额 |
| 409 | `account_exists` | 创建账户时登录名已被占用 |
| 401 | `unauthorized` | 缺少 / 无效 / 过期的 Bearer token |
| 401 | `invalid_credentials` | 登录名或密码错误 |
| 403 | `origin_not_allowed` | 请求来源不在 CORS 白名单 |
| 403 | `forbidden` | 试图修改别人的账户数据 |
| 404 | `not_found` | 接口、账户或数据键不存在 |
| 409 | `conflict` | 并发写入冲突（服务端已自动重试 3 次） |
| 413 | `payload_too_large` | 自定义数据超过 32 KB |
| 429 | `too_many_requests` | 登录或写入过于频繁 |
| 500 | `server_misconfigured` | 服务端缺少必要配置 |
| 502 | `upstream_error` | 读写账户数据源（GitHub）失败 |
| 503 | `write_unavailable` | 服务端未配置 `GITHUB_TOKEN`，无法写入 |

---

## 6. CORS

- 允许方法：`GET, POST, PUT, DELETE, OPTIONS`
- 允许请求头：`authorization, content-type`
- 预检请求返回 `204`
- 允许的来源由 `ALLOWED_ORIGINS` 决定（逗号分隔，`*` 表示任意）
- 不在白名单的来源会收到 `403 origin_not_allowed`

---

## 7. 缓存与数据来源

- 数据来源：仓库 `Caldson/Vitual-XRing` 的 `account.json`
- 存在 `GITHUB_TOKEN` 时走 GitHub Contents API；否则回退 `raw.githubusercontent.com`
- Worker 内部缓存默认 **20 秒**（`CACHE_TTL_SECONDS`），因此账户变动最多延迟约 20 秒可见
- 响应头统一 `cache-control: no-store`，浏览器不会缓存

---

## 8. SDK 参考

`vtx-sdk.js` 挂载全局对象 `VTX`，token 自动保存在 `localStorage`（键 `vtxApiToken`）。

| 方法 | 说明 |
|---|---|
| `VTX.configure({ baseUrl })` | 设置 API 地址（必需，末尾斜杠会自动去除并持久化） |
| `VTX.login(login, password)` | 登录，成功后自动保存 token，返回登录响应 |
| `VTX.register({ login, password, username })` | 创建账户并自动登录，返回带 `created: true` 的响应 |
| `VTX.setToken(token)` | 采纳外部（如 `API_LOGIN.html` 弹窗）拿到的 token |
| `VTX.logout()` | 清除本地 token |
| `VTX.isLoggedIn()` | 是否有 token |
| `VTX.me()` | 当前账户 |
| `VTX.accounts()` | 全部账户 |
| `VTX.account(login)` | 单个账户 |
| `VTX.setData(game, values)` | 写入某个游戏的分区数据（合并），返回 `{ ok, login, game, keys, gameData, data }` |
| `VTX.getData(game)` | 读取某个游戏的分区数据，返回 `{ ok, login, game, gameData }` |
| `VTX.deleteData(game)` | 删除某个游戏的全部分区数据 |
| `VTX.deleteData(game, key)` | 删除某个游戏分区下的单个键 |
| `VTX.pay({ amount, party, description, password })` | 记一笔付款（扣余额），`password` 必填 |
| `VTX.receive({ amount, party, description })` | 记一笔收款（加余额），**不需要密码** |
| `VTX.trade({ type, amount, party, description, name, password })` | 上面两个的通用形式（`payment` 才需要 `password`） |
| `VTX.createReceiptCode(amount?)` | 生成新的收款码（旧码立即失效），返回 `{ code, url, amount, createdAt }` |
| `VTX.receiptCode()` | 读取当前收款码（不会重新生成） |
| `VTX.revokeReceiptCode()` | 撤销收款码 |
| `VTX.receiptCodeInfo(code)` | 解析收款码（公开接口，不需要登录） |
| `VTX.payReceiptCode(code, { password, amount, description })` | 扫收款码付款，`amount` 仅在码上没预设金额时需要 |
| `VTX.getToken()` | 当前 token（无则空字符串） |
| `VTX.baseUrl` | 当前生效的 API 地址 |

失败时抛出 `Error`，附带：

- `error.status`：HTTP 状态码
- `error.code`：接口返回的 `error` 字段

```js
try {
    await VTX.login("账户名称", "错误密码");
} catch (error) {
    console.log(error.status, error.code);   // 401 invalid_credentials
}
```

**写入游戏数据示例**

```js
await VTX.login("账户名称", "密码");

// 第一个参数是游戏名称，第二个才是数据；合并写入，不会覆盖其它键或其它游戏
await VTX.setData("Decrive", { boost: 1 });

// 读回来
const mine = await VTX.getData("Decrive");
console.log(mine.gameData.boost);        // 1

// 登录后返回的账户里也带全部分区
const me = await VTX.me();
console.log(me.account.data.Decrive.boost);

// 删除某个键 / 删除整个游戏分区
await VTX.deleteData("Decrive", "boost");
await VTX.deleteData("Decrive");
```

**记账示例**

```js
await VTX.login("账户名称", "密码");

// 付款 12.34 VTX 给某个网站
const paid = await VTX.pay({
    amount: "12.34",
    party: "示例网站",
    description: "购买道具",   // 选填
    password: "账户密码"       // 必填：二次确认
});
console.log(paid.trade.price, paid.account.money);   // -12.34  87.66

// 收款 5.00 VTX 来自某个网站
await VTX.receive({ amount: "5.00", party: "游戏站", description: "签到奖励" });
```

**收款码示例**

```js
await VTX.login("账户名称", "密码");

// 生成 12.50 VTX 的收款码，把 url 画成二维码给别人扫
const code = await VTX.createReceiptCode("12.50");
console.log(code.url);        // https://xsmmc.caldson.us.ci/API_VTXPAY.html?rc=...

// 换设备 / 刷新页面都读同一个码
const same = await VTX.receiptCode();

// 付款方扫到码之后（需要他自己的 token 和密码）
await VTX.payReceiptCode(code.code, { password: "付款方密码" });

// 不想再收了就撤销
await VTX.revokeReceiptCode();
```

---

## 9. 登录页（API_LOGIN.html）

`API_LOGIN.html` 是给其它站点用的登录页：能自动登录就自动登录，否则用登录名 + 密码换取 VTX 余额。

**地址**

```
https://xsmmc.caldson.us.ci/API_LOGIN.html
```

**可选参数**

| 参数 | 说明 |
|---|---|
| `api` | API 地址，默认当前域名；本地静态预览（`localhost` / `127.0.0.1`）时默认 `https://xsmmc.caldson.us.ci`，跨域或本地 Worker 时用它覆盖 |
| `redirect` | 登录成功后跳回的地址，会附带 `vtx_*` 参数 |
| `tab` | `register` 时直接打开「创建账户」标签页 |
| `embed` | `1` 表示被 iframe 嵌入：**跳过自动登录**，始终显示表单 |

**示例**

```
https://xsmmc.caldson.us.ci/API_LOGIN.html?redirect=https://example.com/callback
https://xsmmc.caldson.us.ci/API_LOGIN.html?tab=register
```

登录成功后跳转到：

```
https://example.com/callback?vtx_result=<URL 编码的 VTX.login() 结果 JSON>
```

若结果 JSON 过长，则改为：

```
https://example.com/callback?vtx_login=账户名称&vtx_token=<token>&vtx_money=100.00
```

**行为**

1. 若浏览器中已有有效 token（`VTX.isLoggedIn()`）且未带 `embed=1`，调用 `GET /api/me` 自动登录
2. 否则显示「登录 / 创建账户」两个标签页
3. 成功后页面显示 **「登录成功，如果没有自动跳转，请刷新并重试。」**，并同时向 `window.opener` / `window.parent` 回传完整结果

> 页面本身不再展示 VTX 余额；需要余额的站点请从回传结果或 `GET /api/me` 读取。
> 「开发者信息」折叠区里仍保留完整 JSON 与复制按钮，供手动联调使用。

**回传的返回值**

```json
{
    "token": "eyJzdWIiOi...",
    "expiresAt": "2026-10-18T04:00:00.000Z",
    "login": "账户名称",
    "account": {
        "username": "用户名",
        "money": "100.00",
        "trades": []
    }
}
```

**弹窗 / 内嵌方式**：向 `window.opener` 以及 `window.parent`（iframe 嵌入时）发送

```js
{ type: "vtx-login", ok: true, result: /* 上面这个对象 */ }
```

**跳转方式**：`?redirect=` 会附加 `vtx_result`（完整的 JSON，URL 编码）；
若该 JSON 过长（> 6000 字符），退化为 `vtx_login`、`vtx_token`、`vtx_money` 三个参数。

> `redirect` 会把 token 拼进 URL，注意它可能出现在浏览器历史与服务器日志中。对安全性要求高的场景，建议改用弹窗 + `postMessage` 方式。

---

## 9.1 记账页（API_VTXPAY.html）

给其它站点用的收款 / 付款页面，背后调用 `POST /api/me/trades`。

**地址**

```
https://xsmmc.caldson.us.ci/API_VTXPAY.html
```

**可选参数**

| 参数 | 说明 |
|---|---|
| `api` | API 地址，规则与 `API_LOGIN.html` 相同 |
| `type` | `payment`（默认）、`receipt` 或 `code`（收款码），决定打开时的初始页签 |
| `party` | 预填对方（付款去向 / 收款来源） |
| `amount` | 预填金额，如 `5.00` |
| `description` | 预填描述 |
| `lock` | `1` 时锁定上述字段，并禁止切换付款 / 收款 / 收款码（用于固定商品） |
| `close` | `1` 时付款成功后自动关闭窗口（仅对弹窗有效） |
| `embed` | `1` 表示被 iframe 嵌入 |
| `rc` | 收款码，例如 `?rc=Kq3f...`；带上就直接进入「扫码付款」流程 |

**示例（固定商品付款）**

```
https://xsmmc.caldson.us.ci/API_VTXPAY.html?party=Decrive%20音游&amount=5.00&description=全%20PERFECT%20道具&lock=1
```

**示例（生成自己的收款码）**

```
https://xsmmc.caldson.us.ci/API_VTXPAY.html?type=code
```

「收款码」页签里可以填金额、生成 / 刷新 / 撤销收款码，并把二维码图片保存到电脑或手机相册。
**只有点「刷新收款码」才会生成新的码**，旧码同时失效。
进入收款码界面后，付款 / 收款页签会隐藏，只能点「退出收款码」回到记账 —— 避免在查看收款码时顺手切到记账模式。

**示例（扫码付款）**

```
https://xsmmc.caldson.us.ci/API_VTXPAY.html?rc=Kq3fGb2xLmN0pQrStUvWxY
```

扫码者打开后会看到收款人与金额，登录并输入自己的密码即可付款；**收款方不需要确认**。

**成功回调**：向 `window.opener` 与 `window.parent` 发送

```js
{ type: "vtx-pay", ok: true, kind: "payment", trade: { /* Trade */ }, account: { /* Account */ } }
```

**流程**

1. 已有有效 token 时调 `GET /api/me` 自动登录，否则显示登录表单
2. 选择「付款 / 收款 / 收款码」，填对方、金额、描述（选填）；**付款才需要再输一次密码**，收款直接点「确认收款」到账
3. 提交后页面展示记录详情（名称 / 金额 / 流向 / 描述 / 时间）与最新余额

带 `rc` 参数时是另一条流程：先解析收款码 → 登录 → 输入密码 → 直接付款（收款方无需确认），完成后同样向 `opener / parent` 发送上面那条 `vtx-pay` 消息。

站内也可用 iframe 嵌它，把 `type=payment` 直接落到付款页签：

```html
<iframe src="https://xsmmc.caldson.us.ci/API_VTXPAY.html?type=payment"
        style="width:440px;height:640px;border:0"></iframe>
```

---

## 9.2 商店、管理员工具与聊天室（6.0 新增）

以下页面直接使用 `secure.json` 中保存的 GitHub token 读写仓库（Contents API / Git Data API），**不经过 Worker 接口**，
因此 API 端点与 5.2.0 完全一致。

### 9.2.1 商店（shop.html）

- 地址：`https://xsmmc.caldson.us.ci/shop.html`，需要已登录（`sessionStorage.vtxAccount`）
- 商品数据存放在仓库根目录 `shop.json`，**按分类分组**：`items` 键放未分类商品，其它键名即分类名，值为该分类的商品数组：

```json
{
    "version": "6.2",
    "items": [],
    "文具本 - 采用冷胶工艺": [
        {
            "id": "xring-backend-blankbook-pocketver",
            "name": "[返场] [返场专属口袋版] 空白本",
            "price": "5.00",
            "description": "好久不见，空白本！我们，又见面了！请下单后截图发群主次日线下领取。",
            "manufacturer": "XRingCR",
            "stock": 2
        }
    ]
}
```

- 页面顶部会按数据自动生成分栏：**全部**、**未分类**、（每个自定义分类），每个分栏后显示商品数量；「全部」视图会在卡片上标出该商品的分类
- 兼容旧格式：`shop.json` 直接是商品数组（6.1 及更早）时，所有商品都算「未分类」；也可以改用 `未分类` 作为键名
- 单个商品也可以加 `"category": "分类名"` 覆盖它所在分组的名字

| 字段 | 说明 |
|---|---|
| `id` | 商品唯一标识（全局不要重复），购买时用于定位商品 |
| `name` | 商品名称 |
| `price` | 单价（VTX，字符串） |
| `description` | 详情描述 |
| `manufacturer` | 制造商 |
| `stock` | 库存数量，由站主填写；`stock > 0` 自动显示「在售」，否则显示「无货」 |
| `category` | 选填，覆盖分组名 |

- 购买流程：选择数量 → 输入**账户密码**确认 → 扣款并写入一条 `name` 为 `购买商品` 的交易记录
- 购买会在一次提交中同时更新 `shop.json`（原分类内库存减少）与 `account.json`（余额减少、写入交易记录）
- 成功后页面显示购买凭证，需要截图发到 XRingCR 群，次日线下领取

### 9.2.2 管理员仓库修改器（admin.html）

- 地址：`https://xsmmc.caldson.us.ci/admin.html`
- 仅当 `sessionStorage.vtxAccount === "Kitawaga"` 时可访问，其它账户会被重定向到 `manager.html`；
  `manager.html` 顶部也只在该账户登录时显示「管理员仓库修改器」按钮
- 支持：新建 / 删除 / 修改文件，重命名文件（含扩展名），新建 / 删除 / 重命名文件夹，
  fetch、pull、fetch and pull、push、自己处理 merge、让 AI 处理 merge、让 AI 写代码，
  以及 push 前编辑 commit 名称与详情、push 后修改最近一次提交的名称与详情
- 「让 AI 处理 merge」与「让 AI 写代码」使用 `https://text.pollinations.ai/openai`（依次尝试 `openai-fast`、`openai`、`mistral`）
- 空文件夹通过 `.gitkeep` 占位，Git 本身不保存空目录

### 9.2.3 聊天室（chatroom.html）

- 地址：`https://xsmmc.caldson.us.ci/chatroom.html`
- 6.0 版本仅显示「功能开发中，敬请期待。」

### 9.2.4 提款与转账的密码确认（6.0 变更）

`manager.html` 中的「提款」与「转账」在提交前必须输入当前账户密码，密码错误则不写入仓库。

---

## 10. 服务端配置

`worker/wrangler.toml`：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `REPO` | `Caldson/Vitual-XRing` | 账户文件所在仓库 |
| `BRANCH` | `main` | 分支 |
| `PATH` | `account.json` | 文件路径 |
| `ALLOWED_ORIGINS` | `*` | CORS 白名单，逗号分隔 |
| `TOKEN_TTL_SECONDS` | `43200` | token 有效期（秒） |
| `CACHE_TTL_SECONDS` | `20` | 账户数据缓存（秒） |

机密（用 `wrangler secret put` 设置，不要写进仓库）：

| 名称 | 必需 | 说明 |
|---|---|---|
| `SIGNING_SECRET` | 是 | token 签名密钥，泄露后需更换（所有 token 立即失效） |
| `GITHUB_TOKEN` | 否 | 读写仓库用；**不配置则只能读**（回退 `raw.githubusercontent.com`），写入接口返回 `503` |

部署：

```bash
cd worker
npx wrangler login
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put SIGNING_SECRET
npx wrangler deploy
```

路由绑定见 [worker/wrangler.toml](./worker/wrangler.toml)（`xsmmc.caldson.us.ci/api/*`）。

### 本地调试

`npx http-server` 只是静态服务器，**没有** `/api/*`，请求会返回 404/405——这不是代码问题。两种做法：

**A. 部署后直接测线上**（推荐）

```bash
cd worker
npx wrangler deploy
```

然后访问 `https://xsmmc.caldson.us.ci/API_LOGIN.html`。本地想预览页面也行，只要 `?api=` 指向线上地址：

```
http://127.0.0.1:3000/API_LOGIN.html?api=https://xsmmc.caldson.us.ci
```

> 页面在 `localhost` / `127.0.0.1` 上且没写 `?api=` 时，会自动连 `https://xsmmc.caldson.us.ci`。

**B. 本地跑 Worker**

```bash
cd worker
cp .dev.vars.example .dev.vars    # 填入 GITHUB_TOKEN / SIGNING_SECRET
npx wrangler dev                  # 默认 http://127.0.0.1:8787
```

静态页照旧用 http-server 起，然后把 `api` 指向本地 Worker：

```
http://127.0.0.1:3000/API_LOGIN.html?api=http://127.0.0.1:8787
```

`.dev.vars` 已加入 `.gitignore`，不会误提交。

---

## 11. 安全说明

- 所有接口都不会返回密码字段
- 登录失败按 IP 限流：60 秒内最多 10 次
- token 由 HMAC-SHA256 签名，篡改或过期即失效
- **当前 `account.json` 中密码仍为明文且公开可读**，任何人都能直接读取
  `https://xsmmc.caldson.us.ci/account.json` 获取全部账户密码，
  这将使本 API 的鉴权失去意义。建议后续改为 PBKDF2 哈希存储。
