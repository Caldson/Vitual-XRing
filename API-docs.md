# Vitual XRing API 文档

账户服务 API，用于在其它站点登录 Vitual XRing 账户并同步全部账户信息。

- 基础地址：`https://xsmmc.caldson.us.ci`
- 所有接口均返回 JSON，字符集 UTF-8
- 实现：Cloudflare Worker（[worker/index.js](./worker/index.js)）
- 客户端 SDK：[vtx-sdk.js](./vtx-sdk.js)
- API 版本：`1.10.2`（接口与 5.2.0 一致；6.0 新增商店、管理员仓库修改器与聊天室页面，6.1 更新商店商品数据，6.2 新增商店分类，6.3 新增商品图片显示，见第 9.2 节；7.0 新增登录位置记录，见第 9.3 节；8.0 把账户数据迁入 Workers KV，新增「账号修改」管理接口与聊天室接口骨架，见第 12 节；9.0 上线完整聊天室：单聊、群聊、好友、群公告、撤回、转发、搜索、免打扰、20 分钟媒体与 WebSocket 实时推送；9.1 新增「解散群聊」：群主 / 站主解散后群聊变成只读；9.2 站主可以新增、改名、解散公共频道；9.3 修复前端脚本缓存；1.0.0 新增账号 UID、群号与群二维码、4 / 8 位数字建群邀请码、拼手速红包，见第 14 节；**1.2.0 是安全修复补丁：移除随网站发布的仓库 Token、停用仓库直连备用通道、附件类型白名单、服务端定价与扣库存、保留管理员登录名，见第 15 节**；**1.3.0 修复已知问题（[issue #2](https://github.com/Caldson/Vitual-XRing/issues/2)）：聊天室在 iPad / iOS 上的视口高度与 overflow 排版，见第 16 节**；**1.4.0 恢复登录页自动登录、管理员可查看账户当前密码、取消聊天室与面对面加群的全部限流，见第 17 节**；**1.5.0 新增聊天室 mention（@ 提及）：输入 @ 选人、气泡高亮、未读 @ 提醒，见第 18 节**；**1.6.0 新增视频站 Vitx® 视频（`vitxvideo.html`），见第 19 节**；**1.6.1 视频改成独立观看页 `vitxvideo.html?videoid=xxx`（本机真实播放 + 评论区），投稿支持任何文件格式，见第 20 节**；**1.7.0 把投稿视频改成服务端存储（Workers KV），审核通过后全站可见，见第 21 节**；**1.7.1 放宽到 5 GB / 100 小时（R2 分片上传），并上线投币（1 币 = 5.00 VTX，取消不退），见第 22 节**；**1.7.2 把「没开通 R2」时的投稿文件改存 GitHub Release（单文件 2 GB / 100 小时），见第 23 节**；**1.7.3 解除聊天室 500 字限制（长消息折叠 + 全文弹窗）、聊天室支持 Discord 风格 Markdown（代码块 / 时间块 / 粗体 / 斜体等）与转账，见第 24 节**；**1.8.0 把聊天室图片 / 文件从 20 分钟改为保留 14 天，见第 25 节**；**1.8.0 同时支持聊天室音乐文件直接播放（音频上限 20 MB），见第 26 节**；**1.8.1 新增「关注 UP 主」，见第 27 节**；**1.8.2 新增「举报视频」（理由、照片证据、补充文字与管理员处理），见第 28 节**；**1.9.0 新增聊天室 UNO（人机对战 / 普通房间 / 混合对战 / 随机匹配、组队互看手牌、批量出牌、生效玩家、局内聊天与反转奇偶），见第 29 节**；**1.10.0 支持 UNO 一回合多次抽牌与 +4 / +6 选择（转色不在手里自动 +6），见第 30 节**；**1.10.1 让同点数批量出牌可以带上压不住的抽牌并参与最终颜色选择，见第 31 节**；**1.10.2 修复红 8/黄 4 转绿 8/绿 4、生效玩家改为单选、+4/+6 改由被选中的玩家选择，见第 32 节**）

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
> `account.json` 中的 `loginHistory`（登录位置）同样不会通过 API 返回，见第 9.3 节。

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
| PUT | `/api/me/username` | 是 | 修改用户名（显示名） |
| PUT | `/api/me/password` | 是 | 修改密码，需要提供当前密码 |
| POST | `/api/me/checkin` | 是 | 每日签到（服务端每天只允许一次，+5.00 VTX） |
| POST | `/api/me/transfer` | 是 | 账户间转账（服务端校验密码并同时更新双方余额） |
| POST | `/api/me/withdraw` | 是 | 提款（需密码），返回线下领取凭证文案 |
| POST | `/api/me/billing` | 是 | AI 扣费 / 退款记账（`charge` / `refund`） |
| POST | `/api/me/purchase` | 是 | 商店购买扣款（需密码），价格与库存由服务端决定，返回购买凭证 |
| GET | `/api/shop` | 否 | 商品库存（1.2.0 新增，KV 里没有记录时回落到 `shop.json` 的 `stock`） |
| POST | `/api/me/login-location` | 是 | 记录一次登录位置（IP 由服务端取 `cf-connecting-ip`） |
| GET | `/api/admin/accounts` | 是（站主） | 读取全部账户（含登录记录与可显示的 `password`，后者 1.4.0 起恢复；未配置 `PASSWORD_VIEW_KEY` 时为 `null`） |
| POST | `/api/admin/accounts` | 是（站主） | 直接创建账户 |
| PUT | `/api/admin/accounts/{登录名}` | 是（站主） | 修改用户名 / 密码 / 余额 |
| DELETE | `/api/admin/accounts/{登录名}` | 是（站主） | 删除账户（不能删站主自己） |
| GET | `/api/admin/log` | 是（站主） | 管理操作审计记录 |
| GET | `/api/chat/status` | 否 | 聊天室状态（版本、开关、实时通道、公共频道、媒体 TTL） |
| GET | `/api/chat/ws` | 是（`?token=`） | WebSocket 实时通道（Durable Object `ChatHub`），不支持时降级轮询 |
| GET | `/api/chat/conversations` | 是 | 会话列表（未读数、置顶、免打扰、最后一条消息） |
| POST | `/api/chat/conversations/direct` | 是 | 与好友开启单聊 |
| POST | `/api/chat/conversations/group` | 是 | 创建群聊 |
| GET | `/api/chat/conversations/{id}` | 是 | 会话详情与成员列表 |
| PATCH | `/api/chat/conversations/{id}` | 是 | 修改群名（群主 / 管理员 / 站主） |
| DELETE | `/api/chat/conversations/{id}` | 是 | 删除会话（单聊）或解散群聊（群主 / 站主） |
| GET | `/api/chat/conversations/{id}/messages` | 是 | 读取消息（`before` 分页、每会话保留最近 300 条） |
| POST | `/api/chat/conversations/{id}/messages` | 是 | 发送文字 / 图片 / 文件 / 音乐消息（支持引用回复、@成员） |
| POST | `/api/chat/conversations/{id}/read` | 是 | 标记已读 |
| POST | `/api/chat/conversations/{id}/typing` | 是 | 正在输入提示 |
| POST | `/api/chat/conversations/{id}/settings` | 是 | 会话置顶 / 免打扰 |
| POST | `/api/chat/conversations/{id}/clear` | 是 | 清空自己的聊天记录 |
| POST | `/api/chat/conversations/{id}/leave` | 是 | 退出群聊 / 公共频道 |
| POST | `/api/chat/conversations/{id}/join` | 是 | 重新加入公共频道 |
| POST | `/api/chat/conversations/{id}/members` | 是 | 邀请成员进群 |
| DELETE | `/api/chat/conversations/{id}/members/{登录名}` | 是 | 移出成员（群主 / 管理员 / 站主） |
| POST | `/api/chat/conversations/{id}/owner` | 是 | 转让群主 |
| POST | `/api/chat/conversations/{id}/admins` | 是 | 设置群管理员（群主） |
| DELETE | `/api/chat/conversations/{id}/admins/{登录名}` | 是 | 取消群管理员（群主） |
| PUT | `/api/chat/conversations/{id}/announcement` | 是 | 发布 / 修改 / 删除群公告 |
| POST | `/api/chat/conversations/{id}/announcement/pin` | 是 | 置顶 / 取消置顶群公告 |
| PATCH | `/api/chat/conversations/{id}/me` | 是 | 修改自己的群昵称 |
| POST | `/api/chat/messages/{id}/recall` | 是 | 撤回消息（发送者 2 分钟内；群主 / 站主不受限） |
| POST | `/api/chat/messages/{id}/forward` | 是 | 转发到最多 9 个会话 |
| DELETE | `/api/chat/messages/{id}` | 是 | 删除消息（发送者单聊 / 群管理 / 站主） |
| GET | `/api/chat/search` | 是 | 搜索自己的聊天记录（可限定会话） |
| GET | `/api/chat/users` | 是 | 搜索账户（用于加好友 / 发起聊天） |
| GET | `/api/chat/contacts` | 是 | 好友、黑名单、收到 / 发出的好友申请 |
| POST | `/api/chat/friends/requests` | 是 | 发送好友申请（对方也申请过时自动成为好友） |
| POST | `/api/chat/friends/requests/{id}/accept` | 是 | 同意好友申请 |
| POST | `/api/chat/friends/requests/{id}/decline` | 是 | 拒绝好友申请 |
| DELETE | `/api/chat/friends/{登录名}` | 是 | 删除好友 |
| POST | `/api/chat/blocks` | 是 | 拉黑用户（同时解除好友关系） |
| DELETE | `/api/chat/blocks/{登录名}` | 是 | 解除拉黑 |
| POST | `/api/chat/media` | 是 | 上传图片 / 文件 / 音乐（普通 4 MB，音乐 20 MB，保留 14 天） |
| GET | `/api/chat/media/{id}` | 是（`?token=`） | 读取图片 / 文件 / 音乐；过期返回 `410 media_expired` |
| GET | `/api/chat/admin/conversations` | 是（站主） | 查看全部群聊与单聊 |
| GET | `/api/chat/admin/conversations/{id}/messages` | 是（站主） | 查看任意会话的消息 |
| DELETE | `/api/chat/admin/messages/{id}` | 是（站主） | 永久删除任意消息 |
| DELETE | `/api/chat/admin/conversations/{id}` | 是（站主） | 永久删除任意会话 |
| GET | `/api/chat/admin/public-groups` | 是（站主） | 公共频道列表（9.2） |
| POST | `/api/chat/admin/public-groups` | 是（站主） | 新建公共频道（9.2） |
| PATCH | `/api/chat/admin/public-groups/{id}` | 是（站主） | 修改频道名称 / 简介（9.2） |
| DELETE | `/api/chat/admin/public-groups/{id}` | 是（站主） | 解散公共频道（9.2） |
| GET | `/api/chat/users/uid/{uid}` | 是 | 按 UID 精确查号（1.0.0） |
| GET | `/api/chat/groups/lookup` | 是 | 按群号查群（1.0.0） |
| POST | `/api/chat/groups/join` | 是 | 按群号加入群聊（1.0.0） |
| GET | `/api/chat/invites/current` | 是 | 我进行中的建群邀请（1.0.0） |
| POST | `/api/chat/invites` | 是 | 发起 4 / 8 位邀请码（1.0.0） |
| GET | `/api/chat/invites/{code}` | 是 | 邀请详情（1.0.0） |
| POST | `/api/chat/invites/{code}/join` | 是 | 参加邀请（1.0.0） |
| POST | `/api/chat/invites/{code}/leave` | 是 | 退出邀请（1.0.0） |
| POST | `/api/chat/invites/{code}/close` | 是（发起人） | 结束邀请并建群（1.0.0） |
| DELETE | `/api/chat/invites/{code}` | 是（发起人） | 取消邀请（1.0.0） |
| POST | `/api/chat/conversations/{id}/redpackets` | 是 | 群聊里发拼手速红包（1.0.0） |
| POST | `/api/chat/messages/{id}/redpacket/grab` | 是 | 抢红包（1.0.0） |
| GET | `/api/chat/messages/{id}/redpacket` | 是 | 红包详情（1.0.0） |
| POST | `/api/chat/messages/{id}/redpacket/refund` | 是（发送者） | 退回未抢完的金额（1.0.0） |
| POST | `/api/chat/conversations/{id}/transfers` | 是 | 聊天室转账（先扣款，1.7.3） |
| POST | `/api/chat/messages/{id}/transfer/claim` | 是（收款人） | 收取转账（1.7.3） |
| POST | `/api/chat/messages/{id}/transfer/refund` | 是（发送者） | 退回未收款的转账（1.7.3） |
| GET | `/api/chat/messages` | 是 | 兼容旧接口：等价于 `general` / `trade` / `help` 的消息列表 |
| POST | `/api/chat/messages` | 是 | 兼容旧接口：向公共频道发文字消息 |

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
{
    "name": "Vitual XRing API",
    "version": "1.0.0",
    "ok": true,
    "storage": "workers-kv",
    "chat": { "version": "1.0", "enabled": true }
}
```

`storage` 为 `workers-kv`（数据在 Workers KV，推荐）或 `github`（未绑定 KV，退回 7.0 的仓库读写）。

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
| 502 | `upstream_error` | 读写账户数据源失败 |
| 503 | `write_unavailable` | 服务端既没有 `ACCOUNTS_KV` 也没有 `GITHUB_TOKEN`，无法写入 |
| 503 | `chat_not_ready` | 聊天室还没开放（`CHAT_ENABLED=false`），提示「版本9.0，我们聊天室见」 |

---

## 6. CORS

- 允许方法：`GET, POST, PUT, DELETE, OPTIONS`
- 允许请求头：`authorization, content-type`
- 预检请求返回 `204`
- 允许的来源由 `ALLOWED_ORIGINS` 决定（逗号分隔，`*` 表示任意）
- 不在白名单的来源会收到 `403 origin_not_allowed`

---

## 7. 缓存与数据来源

**8.0 起**：

- 数据来源：绑定 `ACCOUNTS_KV` 的 Workers KV，键为 `accounts`（一份完整账户 JSON）
- 首次读取时如果 KV 为空，会自动把仓库里的 `account.json` 导入 KV；
  `MIGRATE_DELETE_REPO_FILE` 未设为 `false` 且配置了 `GITHUB_TOKEN` 时，导入后**删除仓库里的公开 account.json**
- 写入直接落 KV，不需要等待 GitHub Pages；同一 isolate 内 5 秒内复用内存快照
- `MIRROR_TO_GITHUB=true` 时每次写入会额外把数据镜像回仓库 `account.json`（默认关闭，避免数据再次公开）
- 未绑定 `ACCOUNTS_KV` 时退回 7.0：读写仓库 `account.json`，存在 `GITHUB_TOKEN` 时走 Contents API，
  否则回退 `raw.githubusercontent.com`；内部缓存默认 **20 秒**（`CACHE_TTL_SECONDS`）
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

## 9.2 商店、管理员工具与聊天室（6.0 新增，8.0 调整）

6.0 的页面原本直接使用 `secure.json` 中保存的 GitHub token 读写仓库。
**8.0 起账户相关操作改为走 Workers 接口**（[vtx-api.js](./vtx-api.js)），只有 `shop.json` 仍然用仓库直连
（Contents / Git Data API），`secure.json` 中的 token 作为 Workers 不可用时的备用通道保留。

> **1.2.0 变更**：`secure.json` 已从仓库删除，浏览器直连 GitHub 的备用通道也已停用。
> 仓库 Token 现在由站主在 `admin.html` 里点「设置仓库 Token」临时填入，只存在当前标签页的 `sessionStorage`，
> 关闭标签页即失效，绝不随网站发布。商店的库存也改由 Worker 记账，页面不再写 `shop.json`。

### 9.2.1 商店（shop.html）

- 地址：`https://xsmmc.caldson.us.ci/shop.html`，需要已登录（`sessionStorage.vtxAccount`）
- 商品数据存放在仓库根目录 `shop.json`，**按分类分组**：`items` 键放未分类商品，其它键名即分类名，值为该分类的商品数组：

```json
{
    "version": "7.0",
    "items": [],
    "文具本 - 采用冷胶工艺": [
        {
            "id": "xring-backend-blankbook-pocketver",
            "name": "[返场] [返场专属口袋版] 空白本",
            "price": "5.00",
            "description": "好久不见，空白本！我们，又见面了！请下单后截图发群主次日线下领取。",
            "manufacturer": "XRingCR",
            "stock": 2,
            "image": "images/blankbook.png"
        }
    ]
}
```

- 页面顶部会按数据自动生成分栏：**全部**、**未分类**、（每个自定义分类），每个分栏后显示商品数量；「全部」视图会在卡片上标出该商品的分类
- 兼容旧格式：`shop.json` 直接是商品数组（6.1 及更早）时，所有商品都算「未分类」；也可以改用 `未分类` 作为键名
- 单个商品也可以加 `"category": "分类名"` 覆盖它所在分组的名字
- 卡片顶部显示商品图片（`image` 字段）；没有填写图片、或图片加载失败时，显示 `无图片预览`

| 字段 | 说明 |
|---|---|
| `id` | 商品唯一标识（全局不要重复），购买时用于定位商品 |
| `name` | 商品名称 |
| `price` | 单价（VTX，字符串） |
| `description` | 详情描述 |
| `manufacturer` | 制造商 |
| `stock` | 库存数量，由站主填写；`stock > 0` 自动显示「在售」，否则显示「无货」 |
| `category` | 选填，覆盖分组名 |
| `image` | 选填，图片地址。相对路径以站点根目录为基准（如 `images/blankbook.png`），也可以填完整 `https://` 地址；留空或加载失败时显示「无图片预览」 |

- 购买流程：选择数量 → 输入**账户密码**确认 → 由 `POST /api/me/purchase` 校验密码与余额并扣款，写入一条 `name` 为 `购买商品` 的交易记录
- 扣款成功后页面更新 `shop.json`（原分类内库存减少）；库存写入失败时会自动调用 `POST /api/me/billing`（`refund`）退款
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
- 9.0 起为完整聊天室：左侧会话列表 / 通讯录 / 站主管理，右侧聊天窗口
- 支持：单聊、群聊、创建群、修改群名、群公告与置顶群公告、群主 / 管理员 / 转让 / 踢人、
  解散群聊（9.1：解散后只读保留历史消息）、
  公共频道管理（9.2：站主可在「管理」页新建 / 改名 / 改简介 / 解散公共频道）、
  账号 UID 与按 UID 搜人、群号与群二维码、4 / 8 位邀请码建群、拼手速红包（1.0.0）、
  好友申请与黑名单、消息撤回、引用回复、转发、聊天记录搜索、会话置顶、消息免打扰、
  未读数、正在输入提示、在线状态、图片 / 文件 / 音乐消息
- 实时消息通过 Durable Object `ChatHub` 的 WebSocket 推送；连接失败时自动降级为 7 秒轮询
- 图片 / 文件 / 音乐上传后保留 14 天（KV `expirationTtl`），过期后聊天记录仍在，但显示「已过期」
- 站主（`ADMIN_ACCOUNT`，默认 `Kitawaga`）可以在「管理」页查看、删除全部群聊与单聊的消息，
  也可以解散任意群聊（只读保留记录）
- 详细接口见第 13 节

### 9.2.4 提款与转账的密码确认（6.0 变更）

`manager.html` 中的「提款」与「转账」在提交前必须输入当前账户密码，密码错误则不写入仓库。

---

## 9.3 登录位置（7.0 新增）

`manager.html` 的「登录位置」区块展示该账户每次登录的公网 IP、经纬度与地图，数据保存在
`account.json` 的 `loginHistory` 字段：

```json
{
    "username": "用户名",
    "password": "...",
    "money": "100.00",
    "trades": [],
    "loginHistory": [
        {
            "time": "2026/10/22 19:37:52",
            "ip": "203.0.113.7",
            "latitude": 31.2304,
            "longitude": 121.4737,
            "city": "Shanghai",
            "region": "Shanghai",
            "country": "China",
            "isp": "Example ISP"
        }
    ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `time` | string | `YYYY/MM/DD HH:mm:ss`，登录时间（浏览器本地时区） |
| `ip` | string | 公网 IP；定位失败时省略 |
| `latitude` / `longitude` | number | IP 归属地的大致经纬度（城市级精度） |
| `city` / `region` / `country` | string | IP 归属地的城市 / 省份 / 国家 |
| `isp` | string | 运营商或机构名称；取不到时省略 |

- **8.0 起由服务端记录**：`POST /api/login`（以及注册）成功后，Worker 会把本次登录写进账户的 `loginHistory`，
  公网 IP 一律取 `cf-connecting-ip`（不接受前端伪造），经纬度优先用浏览器 `vtx-geo.js` 传来的定位，
  没有则用 Cloudflare 提供的 `request.cf` 经纬度；最多保留最近 **20** 条
- 登录页（`login.html`）会在登录前调用 `VTXGeo.locate()` 取一次粗略位置，随 `geo` 字段一起提交
- 位置来源依次尝试 `https://ipwho.is/`、`https://ipinfo.io/json`、`https://api.ip.sb/geoip`、
  `https://api.ipapi.co/json/`、`https://api.ipify.org/?format=json`；全部失败时不影响登录
- 需要补记一次位置时（例如脚本调用）：`POST /api/me/login-location`，body 为 `{ latitude, longitude, city, region, country, isp }`
- 地图使用 Leaflet（jsDelivr → unpkg 依次回退）；瓦片优先高德（`webrd0{1-4}.is.autonavi.com`），
  连续加载失败时切换到 OpenStreetMap；Leaflet 两个 CDN 都加载失败时回退到 OpenStreetMap 的嵌入 iframe
- `GET /api/accounts`、`GET /api/accounts/{登录名}` **不会返回** `loginHistory`（避免把别人的 IP 暴露给所有登录用户）；
  `GET /api/me` 与登录响应会返回本人的记录

---

## 10. 服务端配置

`worker/wrangler.toml`：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `REPO` | `Caldson/Vitual-XRing` | 迁移数据来源仓库（旧 `account.json`） |
| `BRANCH` | `main` | 分支 |
| `PATH` | `account.json` | 文件路径 |
| `ALLOWED_ORIGINS` | `*` | CORS 白名单，逗号分隔 |
| `TOKEN_TTL_SECONDS` | `43200` | token 有效期（秒） |
| `CACHE_TTL_SECONDS` | `20` | 旧模式（未绑定 KV）下账户数据缓存（秒） |
| `ADMIN_ACCOUNT` | `Kitawaga` | 拥有「账号修改」等管理权限的登录名 |
| `MIGRATE_DELETE_REPO_FILE` | `true` | 首次迁移到 KV 后是否删除仓库里的公开 `account.json` |
| `MIRROR_TO_GITHUB` | `false` | 是否把 KV 数据镜像回仓库 `account.json` |
| `CHAT_ENABLED` | `true` | 聊天室接口开关（9.0 起默认开放） |

KV + Durable Object 绑定：

```toml
[[kv_namespaces]]
binding = "ACCOUNTS_KV"
id = "<npx wrangler kv namespace create ACCOUNTS_KV 输出的 id>"

# 9.0 聊天室实时通道
[[durable_objects.bindings]]
name = "CHAT"
class_name = "ChatHub"

[[migrations]]
tag = "v1-chat"
new_sqlite_classes = ["ChatHub"]
```

机密（用 `wrangler secret put` 设置，不要写进仓库）：

| 名称 | 必需 | 说明 |
|---|---|---|
| `SIGNING_SECRET` | 是 | token 签名密钥，泄露后需更换（所有 token 立即失效） |
| `GITHUB_TOKEN` | 否 | 迁移旧 `account.json` / 镜像时需要仓库 Contents 读写权限；不配置则无法迁移与镜像 |

部署：

```bash
cd worker
npx wrangler login
npx wrangler kv namespace create ACCOUNTS_KV     # 把 id 填进 wrangler.toml
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put SIGNING_SECRET
npx wrangler deploy
```

路由绑定见 [worker/wrangler.toml](./worker/wrangler.toml)（`xsmmc.caldson.us.ci/api/*`）。

**迁移步骤（8.0 首次上线）**

1. 先 `npx wrangler kv namespace create ACCOUNTS_KV` 并填写 id，配置好 `GITHUB_TOKEN`
2. `npx wrangler deploy`
3. 打开一次 `https://xsmmc.caldson.us.ci/api/health`，确认返回 `"storage": "workers-kv"`
4. 随便调用一次需要账户数据的接口（例如用任意账户 `POST /api/login`）：KV 为空时会自动从仓库导入，
   并删除仓库里的 `account.json`（`MIGRATE_DELETE_REPO_FILE=true`）
5. 删除后 `account.json` 从 GitHub Pages 上消失，账户数据只能通过 Worker 接口读取

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

- 所有接口都不会返回密码字段；**1.4.0 起 `/api/admin/accounts*` 例外**：站主会拿到解密后的 `password`
  （来自 AES-GCM 加密副本 `passwordSealed`，密钥是 secret `PASSWORD_VIEW_KEY`），其余接口仍只给 `hasPassword`
- 登录失败按 IP 限流：60 秒内最多 10 次；写入、记账、提款、转账、购买各有独立限流
  （**1.4.0 起聊天室与面对面加群都不再单独限流**：邀请码查询 / 加入、群号加入、发言、正在输入、上传媒体全部取消）
- token 由 HMAC-SHA256 签名，篡改或过期即失效
- **8.0 起账户数据不再公开**：账户、密码、余额、交易、游戏数据、登录 IP 记录全部存进 Workers KV，
  仓库里的 `account.json` 在首次迁移后会被自动删除，`/api/accounts` 之类的接口必须携带有效 token 才能读取
- `loginHistory`（登录 IP）只在 `GET /api/me` / 登录响应里返回给本人，`GET /api/accounts` 不含该字段
- 转账、提款、购买在**服务端**校验密码与余额，前端不再拿密码做本地比较；修改密码需要提供当前密码
- 管理操作（创建 / 修改 / 删除账户）会写入 KV 里的审计记录（`admin-log`，最多 200 条），通过 `GET /api/admin/log` 查看
- **1.2.0 起密码以 PBKDF2-SHA256 哈希存储**（10 万次迭代、每账户 16 字节随机盐，
  格式 `pbkdf2-sha256$<迭代>$<盐>$<哈希>`）。旧账户的明文密码会在**首次登录成功后就地升级**，
  不需要任何手工迁移；此后登录、付款、提款、转账、购买都用哈希做常数时间比对。
- **1.2.0 起余额修改跨 isolate 串行化**：`commitAccounts` 会先向 Durable Object `AccountsLock`
  申请一把带 30 秒租约的写锁，拿到后重新读 KV 再改再写，避免并发请求互相覆盖。

---

## 12. 8.0 更新：账户入 Workers、账号修改与聊天室准备

### 12.1 数据迁移

见第 7 节与第 10 节的迁移步骤。要点：

- KV 键 `accounts` 存整份账户 JSON，结构仍是 `{ "登录名": { username, password, money, trades, data, loginHistory, receipt } }`
  （1.2.0 起 `password` 是 `pbkdf2-sha256$<迭代>$<盐>$<哈希>` 形式的哈希，旧明文记录会在首次登录成功后自动替换）
- 迁移是一次性的：KV 有数据后不再读 GitHub；`migrated-from-github` 记录删除仓库文件的时间
- 未绑定 `ACCOUNTS_KV` 时行为与 7.0 完全一致（向后兼容）

### 12.2 账户自助接口

| 接口 | body | 说明 |
|---|---|---|
| `PUT /api/me/username` | `{"username":"新显示名"}` | 2-24 字符，不能与当前相同 |
| `PUT /api/me/password` | `{"currentPassword":"旧","newPassword":"新"}` | 新密码至少 6 位 |
| `POST /api/me/checkin` | — | 每天一次（北京时间），+5.00 VTX，重复签到返回 `400 already_checked_in` |
| `POST /api/me/transfer` | `{"to":"收款登录名","amount":"1.00","password":"...","description":"备注"}` | 双方余额与交易记录同时更新 |
| `POST /api/me/withdraw` | `{"amount":"1.00","password":"..."}` | 返回 `receipt` 凭证文案 |
| `POST /api/me/billing` | `{"type":"charge","amount":"0.01","name":"AI 聊天","description":"..."}` | `type` 取 `charge`（扣）或 `refund`（退） |
| `POST /api/me/purchase` | `{"id":"商品id","quantity":1,"password":"..."}` | 价格与库存都由服务端按 `shop.json` 计算；1.2.0 起不再接受 `amount` |
| `POST /api/me/login-location` | `{"latitude":..,"longitude":..,"city":".."}` | IP 由服务端填写 |

以上接口返回的 `account` 都是**本人视角**（含 `loginHistory`，不含 `password`）。

### 12.3 「账号修改」（账号管理，站主专用）

页面：`https://xsmmc.caldson.us.ci/accounts-admin.html`（`manager.html` 顶部站主专属入口「账号修改」）

- 仅 `sessionStorage.vtxAccount === "Kitawaga"`（且服务端 `ADMIN_ACCOUNT` 匹配）时可访问；服务端会再校验一次
- 功能：账户列表、查看交易笔数与最近登录 IP、修改用户名 / 密码 / 余额、创建账户、删除账户、查看审计记录
- 接口：

```bash
# 读取全部账户（含密码、登录记录）
curl https://xsmmc.caldson.us.ci/api/admin/accounts -H "authorization: ******"

# 修改余额
curl -X PUT https://xsmmc.caldson.us.ci/api/admin/accounts/账户名 \
  -H "authorization: ******" -H "content-type: application/json" \
  -d '{"money":"100.00"}'

# 创建 / 删除
curl -X POST https://xsmmc.caldson.us.ci/api/admin/accounts -H "authorization: ******" \
  -H "content-type: application/json" -d '{"login":"newuser","password":"secret123","username":"新人","money":"0.00"}'
curl -X DELETE https://xsmmc.caldson.us.ci/api/admin/accounts/newuser -H "authorization: ******"

# 审计记录
curl https://xsmmc.caldson.us.ci/api/admin/log -H "authorization: ******"
```

> `PUT` 只接受 `username` / `password` / `money` 三个字段；`money` 必须是 ≥ 0 且最多两位小数。
> 不能删除站主自己的账户，避免把自己锁在外面。

### 12.4 聊天室接口（9.0 已上线）

8.0 只提供 `/api/chat/status` 与 `general` / `trade` / `help` 三个房间的骨架；9.0 已扩展为完整聊天室。
旧接口仍可用（`GET/POST /api/chat/messages?room=general`），新前端使用第 13 节的会话接口。

---

## 13. 9.0 更新：完整聊天室（9.1 新增解散群聊）

聊天记录、好友关系、群资料全部存在 Workers KV；实时消息由 Durable Object `ChatHub` 通过 WebSocket 广播。
`CHAT_ENABLED=true`（9.0 默认）时所有聊天接口可用。

9.1 起支持「解散群聊」：群主或站主解散后，群聊变成只读历史（`dissolved: true`），
成员仍可查看聊天记录，但不能发言或修改群资料，详见 [13.3](#133-会话与群管理)。

### 13.1 数据模型与 KV 键

| KV 键 | 内容 |
|---|---|
| `chat:user:{登录名}` | 会话索引（置顶 / 免打扰 / 已读位置 / 清空时间）、好友、黑名单、好友申请 |
| `chat:conversation:{会话 id}` | 会话资料（类型、名称、成员、群主、管理员、群昵称、群公告、最后一条消息） |
| `chat:messages:{会话 id}` | 消息数组，最多保留最近 300 条（1.7.3 起另按约 6M 字符预算裁剪） |
| `chat:direct:{A}\|{B}` | 单聊去重：两个登录名 → 会话 id |
| `chat:media:{id}` / `chat:media-meta:{id}` | 图片 / 文件 / 音乐与元数据，`expirationTtl = 1209600`（14 天） |
| `chat:index` | 全部会话 id（站主管理页使用，最多 2000 个） |
| `chat:public-groups` | 公共频道定义（9.2）：`[{ id, name, description, createdAt }]`，缺失时使用内置默认值 |
| `chat:invite:{code}` | 建群邀请（1.0.0）：`{ code, digits, owner, name, participants[], closed, conversation }`，24 小时过期 |
| `chat:invite-owner:{登录名}` | 我进行中的邀请码（1.0.0） |

- 会话 id：公共频道为 `general` / `trade` / `help` 或站主新建的 `ch_xxxxxxxx`；群聊 `g_xxxxxxxxxxxx`；单聊 `dm_xxxxxxxxxxxx`
- 消息结构（响应）：

```json
{
    "id": "xxxxxxxxxxxx",
    "conversation": "dm_xxxxxxxxxxxx",
    "sender": "Alice",
    "senderName": "爱丽丝",
    "type": "text",
    "text": "你好",
    "media": null,
    "replyTo": { "id": "…", "sender": "Bob", "senderName": "鲍勃", "type": "text", "preview": "…" },
    "mentions": ["Bob"],
    "forwarded": false,
    "recalled": false,
    "system": false,
    "packet": null,
    "transfer": null,
    "at": 1760000000000,
    "time": "2026/10/25 12:00:00"
}
```

> `mentions`（1.5.0 起前端可用）：发送时在请求体里传成员登录名数组，服务端只保留**本会话成员**（最多 20 个，自动去重），
> 会话列表里额外返回 `mentionUnread`（未读的 @ 条数）。详见 [18. 1.5.0 更新](#18-150-更新mention)。

### 13.2 好友与联系人

```bash
# 搜索用户（加好友 / 发起聊天用）
curl "https://xsmmc.caldson.us.ci/api/chat/users?q=ali" -H "authorization: ******"

# 发送好友申请
curl -X POST https://xsmmc.caldson.us.ci/api/chat/friends/requests -H "authorization: ******" \
  -H "content-type: application/json" -d '{"login":"Bob","note":"我是爱丽丝"}'

# 对方同意 / 拒绝
curl -X POST https://xsmmc.caldson.us.ci/api/chat/friends/requests/fr_xxxx/accept -H "authorization: ******"
curl -X POST https://xsmmc.caldson.us.ci/api/chat/friends/requests/fr_xxxx/decline -H "authorization: ******"

# 联系人总览（好友、黑名单、收到 / 发出的申请）
curl https://xsmmc.caldson.us.ci/api/chat/contacts -H "authorization: ******"

# 删除好友 / 拉黑 / 解除拉黑
curl -X DELETE https://xsmmc.caldson.us.ci/api/chat/friends/Bob -H "authorization: ******"
curl -X POST https://xsmmc.caldson.us.ci/api/chat/blocks -H "authorization: ******" \
  -H "content-type: application/json" -d '{"login":"Bob"}'
curl -X DELETE https://xsmmc.caldson.us.ci/api/chat/blocks/Bob -H "authorization: ******"
```

- 只能和好友单聊；被拉黑后双方都不能继续发消息（历史记录仍可查看）
- 拉黑会同时解除好友关系；解除拉黑不会自动恢复好友

### 13.3 会话与群管理

```bash
# 会话列表（含未读数、置顶、免打扰）
curl https://xsmmc.caldson.us.ci/api/chat/conversations -H "authorization: ******"

# 与好友单聊（不存在则创建）
curl -X POST https://xsmmc.caldson.us.ci/api/chat/conversations/direct -H "authorization: ******" \
  -H "content-type: application/json" -d '{"login":"Bob"}'

# 创建群聊
curl -X POST https://xsmmc.caldson.us.ci/api/chat/conversations/group -H "authorization: ******" \
  -H "content-type: application/json" -d '{"name":"周末开黑","members":["Bob","Carol"]}'

# 修改群名（群主 / 管理员 / 站主）
curl -X PATCH https://xsmmc.caldson.us.ci/api/chat/conversations/g_xxxx -H "authorization: ******" \
  -H "content-type: application/json" -d '{"name":"新的群名"}'

# 群公告 + 置顶
curl -X PUT https://xsmmc.caldson.us.ci/api/chat/conversations/g_xxxx/announcement \
  -H "authorization: ******" -H "content-type: application/json" -d '{"text":"周五开会","pinned":true}'
curl -X POST https://xsmmc.caldson.us.ci/api/chat/conversations/g_xxxx/announcement/pin \
  -H "authorization: ******" -H "content-type: application/json" -d '{"pinned":false}'

# 邀请 / 移出 / 转让群主 / 设置管理员 / 取消管理员
curl -X POST https://xsmmc.caldson.us.ci/api/chat/conversations/g_xxxx/members \
  -H "authorization: ******" -H "content-type: application/json" -d '{"members":["Carol"]}'
curl -X DELETE https://xsmmc.caldson.us.ci/api/chat/conversations/g_xxxx/members/Carol -H "authorization: ******"
curl -X POST https://xsmmc.caldson.us.ci/api/chat/conversations/g_xxxx/owner \
  -H "authorization: ******" -H "content-type: application/json" -d '{"login":"Bob"}'
curl -X POST https://xsmmc.caldson.us.ci/api/chat/conversations/g_xxxx/admins \
  -H "authorization: ******" -H "content-type: application/json" -d '{"login":"Bob"}'
curl -X DELETE https://xsmmc.caldson.us.ci/api/chat/conversations/g_xxxx/admins/Bob -H "authorization: ******"

# 我的群昵称
curl -X PATCH https://xsmmc.caldson.us.ci/api/chat/conversations/g_xxxx/me \
  -H "authorization: ******" -H "content-type: application/json" -d '{"alias":"小明"}'

# 退出 / 解散
curl -X POST https://xsmmc.caldson.us.ci/api/chat/conversations/g_xxxx/leave -H "authorization: ******"
curl -X DELETE https://xsmmc.caldson.us.ci/api/chat/conversations/g_xxxx -H "authorization: ******"
```

`DELETE /api/chat/conversations/{id}`（9.1）：

- 群聊：群主或站主解散。会话会被标记 `dissolved: true`，**历史消息全部保留**，
  所有成员仍能在会话列表看到它（带「已解散」标记），但不能再发消息、改名、加人、改公告、
  转让群主或设置管理员，这些写操作统一返回 `410 group_dissolved`；
  成员可以调用 `/leave` 把这条只读会话从自己的列表里删掉。
- 单聊：只从自己的会话列表移除，对方不受影响。
- 解散后 `conversationView` 会返回 `dissolved`、`dissolvedAt`、`dissolvedBy`、`dissolvedByName`，
  并写入一条系统消息「XX 解散了群聊」，实时通道会广播 `conversation:dissolved` 事件。
- 公共频道：站主可以解散（9.2）。解散等于删除频道本身——消息一并删除，并从**所有账户**的会话列表移除，
  频道定义也会从 `chat:public-groups` 里去掉；普通用户只能 `/leave` 退出。

权限：

| 操作 | 谁可以 |
|---|---|
| 修改群名、群公告、置顶公告 | 群主、群管理员、站主 |
| 邀请成员 | 群内任意成员（公共频道无需邀请） |
| 移出成员 | 群主、群管理员（不能移出群主；管理员只有群主能移出）、站主 |
| 转让群主、设置 / 取消管理员 | 群主、站主 |
| 解散群聊 | 群主、站主；解散后群聊只读，历史消息保留 |
| 解散公共频道 | 只有站主（9.2），见 [13.9](#139-公共频道管理92仅站主) |
| 退出群聊 | 所有成员；群主退出时自动转让给最早加入的成员；已解散的群聊退出等于删除自己的会话 |

其他会话操作：`POST /conversations/{id}/settings`（`{"pinned":true,"muted":true}`）、
`POST /conversations/{id}/clear`（只清空自己的记录）、`POST /conversations/{id}/read`、
`POST /conversations/{id}/join`（重新加入公共频道）。

### 13.4 消息

```bash
# 读取消息（before 为毫秒时间戳，用于翻页）
curl "https://xsmmc.caldson.us.ci/api/chat/conversations/dm_xxxx/messages?limit=50" -H "authorization: ******"

# 发送文字 / 引用回复 / @成员
curl -X POST https://xsmmc.caldson.us.ci/api/chat/conversations/dm_xxxx/messages \
  -H "authorization: ******" -H "content-type: application/json" \
  -d '{"text":"收到","replyTo":"消息 id","mentions":["Bob"]}'

# 发送图片 / 文件 / 音乐（先上传，见 13.5）
curl -X POST https://xsmmc.caldson.us.ci/api/chat/conversations/dm_xxxx/messages \
  -H "authorization: ******" -H "content-type: application/json" \
  -d '{"type":"image","mediaId":"媒体 id","text":"配文"}'

# 撤回（发送者 2 分钟内；群主 / 管理员 / 站主不受限）
curl -X POST "https://xsmmc.caldson.us.ci/api/chat/messages/消息id/recall?conversation=dm_xxxx" \
  -H "authorization: ******"

# 转发到最多 9 个会话
curl -X POST "https://xsmmc.caldson.us.ci/api/chat/messages/消息id/forward?conversation=dm_xxxx" \
  -H "authorization: ******" -H "content-type: application/json" -d '{"targets":["g_xxxx","dm_yyyy"]}'

# 搜索聊天记录（可限定会话）
curl "https://xsmmc.caldson.us.ci/api/chat/search?q=开会&conversation=g_xxxx" -H "authorization: ******"

# 正在输入（供 WebSocket 广播，失败不影响聊天）
curl -X POST https://xsmmc.caldson.us.ci/api/chat/conversations/dm_xxxx/typing -H "authorization: ******"
```

- 1.7.3 起**不再限制 500 字**：单条消息上限 256 KB（`413 text_too_long`），每个会话最多保留最近 300 条 / 约 6M 字符
- 超过 500 字的消息在聊天室里折叠显示，点「.........展开」弹窗查看全文（前端行为，接口返回完整正文）
- 会话列表里的 `lastMessage.text` 最多 200 字，方便轮询时省流量
- 引用回复会保存原消息的发送者、类型与 40 字摘要
- 只有自己的消息能在 2 分钟内撤回；群主 / 群管理员 / 站主可以撤回或删除任意消息

### 13.5 图片、文件与音乐（14 天过期）

```bash
# 上传（原始二进制；普通文件 4 MB，音乐 20 MB）
curl -X POST https://xsmmc.caldson.us.ci/api/chat/media \
  -H "authorization: ******" -H "content-type: image/png" \
  -H "x-file-name: $(python -c "import urllib.parse;print(urllib.parse.quote('截图.png'))")" \
  --data-binary @截图.png

# 读取（浏览器 <img> 用 ?token=）
curl "https://xsmmc.caldson.us.ci/api/chat/media/媒体id?token=你的token" -o 截图.png
```

- KV 使用 `expirationTtl = 1209600`：上传 14 天后图片 / 文件 / 音乐本体自动删除
- 聊天记录里的消息仍然保留，`media.expiresAt` 过期后前端显示「图片/文件已过期」
- 过期的媒体再次读取返回 `410 media_expired`
- 只有上传者（或站主）可以把媒体作为消息发送

### 13.6 WebSocket 实时推送

```js
const socket = new WebSocket(
    `wss://xsmmc.caldson.us.ci/api/chat/ws?token=${encodeURIComponent(token)}`
);
socket.onmessage = (event) => console.log(JSON.parse(event.data));
socket.send(JSON.stringify({ type: "ping" }));
```

浏览器无法给 WebSocket 设置请求头，因此 token 放在查询参数里；服务端校验通过后转发给 Durable Object。
`wrangler.toml` 未绑定 `CHAT` 时，`/api/chat/ws` 返回 `503 chat_ws_unavailable`，前端自动改用轮询。

事件类型：

| `type` | 说明 |
|---|---|
| `hello` | 连接成功，带 `login` 与当前在线列表 `online` |
| `presence` | 在线用户列表变化 |
| `message` | 新消息（`conversation` 为会话视图，`message` 为消息） |
| `message:recall` | 某条消息被撤回 |
| `message:delete` | 某条消息被删除 |
| `conversation:new` | 被拉进新群 / 新单聊 |
| `conversation:update` | 群名、群公告、成员、管理员等变化 |
| `conversation:dissolved` | 群聊被解散（9.1 起；前端把会话标记成只读而不是删掉） |
| `conversation:remove` | 你被移出群聊 / 单聊被删除 |
| `typing` | 有人正在输入（`login`、`name`） |
| `friend:request` / `friend:accept` / `friend:decline` / `friend:remove` | 好友关系变化 |
| `pong` | 回复 `ping` |

### 13.7 站主管理

`ADMIN_ACCOUNT`（默认 `Kitawaga`）可以管理**全部群聊与所有用户的单聊**：

```bash
curl https://xsmmc.caldson.us.ci/api/chat/admin/conversations -H "authorization: ******"
curl https://xsmmc.caldson.us.ci/api/chat/admin/conversations/dm_xxxx/messages -H "authorization: ******"
curl -X DELETE "https://xsmmc.caldson.us.ci/api/chat/admin/messages/消息id?conversation=dm_xxxx" -H "authorization: ******"
curl -X DELETE https://xsmmc.caldson.us.ci/api/chat/admin/conversations/dm_xxxx -H "authorization: ******"
```

- 非站主调用返回 `403 forbidden`
- 站主也可以直接在普通接口里读取任意会话、修改任意群资料、撤回 / 删除任意消息
- 9.1 起站主可以在管理面板里「解散群聊（保留记录）」，也可以继续用 `/api/chat/admin/conversations/{id}` 永久删除整个会话
- 9.2 起站主可以在「管理」页新建、改名、改简介、解散公共频道，见 [13.9](#139-公共频道管理92仅站主)
- 「管理」页在 `chatroom.html` 左侧导航中出现（仅站主可见）

### 13.8 限流与错误码

| 操作 | 限制 |
|---|---|
| 发送消息 | **1.4.0 起不再限流**（1.0.0 ~ 1.3.0 为每 IP 60 秒 30 条） |
| 上传媒体 | **1.4.0 起不再限流**（原每 IP 60 秒 12 次） |
| 正在输入 | **1.4.0 起不再限流**（原每 IP + 会话 60 秒 120 次） |
| 好友申请 / 会话操作 | 受全局写入限流保护 |
| 面对面加群（邀请码 / 群号） | **1.4.0 起不再限流**（1.2.0 曾是每 IP 60 秒 10 次） |

| 状态码 | `error` | 说明 |
|---|---|---|
| `400` | `bad_request` | 参数不合法（名称、成员、消息内容等） |
| `401` | `unauthorized` | 缺少或过期的 token |
| `403` | `blocked` / `not_friend` / `forbidden` | 被拉黑、不是好友、没有管理权限 |
| `404` | `not_found` | 会话 / 消息 / 用户不存在 |
| `410` | `media_expired` | 图片 / 文件 / 音乐已超过 14 天 |
| `410` | `group_dissolved` | 群聊已解散，只能查看历史消息（9.1） |
| `410` | `packet_empty` / `packet_expired` | 红包抢完 / 已过期（1.0.0） |
| `409` | `already_grabbed` / `invite_closed` | 已抢过 / 邀请已结束（1.0.0） |
| `413` | `payload_too_large` | 普通文件超过 4 MB，或音乐超过 20 MB |
| `429` | `too_many_requests` | 触发限流 |
| `503` | `chat_not_ready` | `CHAT_ENABLED=false` |
| `503` | `chat_ws_unavailable` | 未绑定 `CHAT` Durable Object（可用轮询） |

### 13.9 公共频道管理（9.2，仅站主）

公共频道列表不再写死在代码里，而是存在 KV 的 `chat:public-groups`（数组，元素为 `{ id, name, description, createdAt }`）。
首次访问时如果 KV 里还没有这个键，会使用内置的 `general` / `trade` / `help` 作为默认值。

```bash
# 列出全部公共频道（含消息数、成员数）
curl https://xsmmc.caldson.us.ci/api/chat/admin/public-groups -H "authorization: ******"

# 新建公共频道（id 可省略，自动生成 ch_xxxxxxxx）
curl -X POST https://xsmmc.caldson.us.ci/api/chat/admin/public-groups \
  -H "authorization: ******" -H "content-type: application/json" \
  -d '{"name":"活动","description":"每周活动公告","id":"event"}'

# 改名 / 改简介
curl -X PATCH https://xsmmc.caldson.us.ci/api/chat/admin/public-groups/event \
  -H "authorization: ******" -H "content-type: application/json" \
  -d '{"name":"活动大厅","description":"每周活动与公告"}'

# 解散公共频道（同时删除频道内全部消息，并从所有账户的会话列表移除）
curl -X DELETE https://xsmmc.caldson.us.ci/api/chat/admin/public-groups/event \
  -H "authorization: ******"
```

- 只有站主（`ADMIN_ACCOUNT`）可以调用，其他人返回 `403 forbidden`
- 新建后所有账户的会话列表里立刻出现该频道（实时通道广播 `conversation:new`）
- 改名会同步更新频道定义与会话资料，并写入一条系统消息，广播 `conversation:update`
- 解散会广播 `conversation:remove`，所有账户的会话列表同步移除
- 至少保留一个公共频道：删除最后一个会返回 `400 bad_request`
- 站主也可以用普通接口 `PATCH /api/chat/conversations/{id}` 修改公共频道名称（会同步回频道定义），
  或用 `DELETE /api/chat/conversations/{id}` 解散公共频道
- 公共频道内的群公告与站主删除消息等能力沿用第 13.7 节

### 13.10 前端

- `chatroom.html`：完整聊天界面（会话、通讯录、站主管理、群资料、转发、搜索、撤回、媒体上传、Markdown、长消息展开、红包与转账）
- `vtx-markdown.js`：1.7.3 新增的 Discord 风格 Markdown 渲染器（纯前端、零依赖，输出经过转义与链接协议校验）
- `vtx-api.js`：`VTXApi.chat.*` 封装全部聊天接口，另有 `chatSocketUrl()` / `chatMediaUrl()` / `chat.upload(file)`
- 登录页支持 `login.html?next=chatroom.html`，登录后直接回到聊天室

### 13.11 前端脚本缓存与版本校验（9.3）

**问题**：`chatroom.html` 早期引用 SDK 时没写版本参数（`<script src="vtx-api.js">`）。
GitHub Pages 与浏览器会长期缓存这个 URL，于是页面在 9.2 上线后仍然用着 9.1 的 SDK，
点「解散公共频道」直接抛 `api.chat.removePublicGroup is not a function`。

**修复**：

1. 全站脚本引用统一带上版本参数，例如 `<script src="vtx-api.js?v=1.6.0"></script>`，
   `?v=` 变化会让浏览器与 CDN 必须重新取文件。发布新版本时**必须一起改这个参数**。
2. `chatroom.html` 启动时校验 `VTXApi.version`：
   - 低于页面要求的版本（当前 `REQUIRED_API_VERSION = "1.6.0"`）就自动按
     `vtx-api.js?v=<版本>&t=<时间戳>` 重新加载一次；
   - 仍然不达标时显示「页面资源需要更新」提示页，给一个「重新加载」按钮，
     而不是让用户对着 `xxx is not a function` 发愣。
3. 其他页面的 `report()` 遇到 `is not a function` 时会附带「请按 Ctrl+F5 刷新」的提示。

**约定**：`vtx-api.js` 的 `API_VERSION`、`chatroom.html` 的 `REQUIRED_API_VERSION`、
各页面 `<script>` 的 `?v=`、Worker 的 `VERSION` / `CHAT_VERSION` 必须同步升级。

---

## 14. 1.0.0 更新：UID、群号、邀请码与红包

### 14.1 账号 UID

每个账户都有一个稳定的数字 UID，注册时按顺序分配（从 `100001` 开始），
老账户在第一次调用 `/api/me`、`/api/chat/users` 等接口时自动补号。

```bash
# 看自己的 UID（account.uid）
curl https://xsmmc.caldson.us.ci/api/me -H "authorization: ******"

# 按 UID 精确查号
curl https://xsmmc.caldson.us.ci/api/chat/users/uid/100001 -H "authorization: ******"

# 搜索框也支持直接输入 UID
curl "https://xsmmc.caldson.us.ci/api/chat/users?q=100001" -H "authorization: ******"
```

- `publicAccount` / `/api/chat/users` / 群成员列表都会带上 `uid`
- 聊天室左下角显示「用户名 · UID 100001」，点一下复制

### 14.2 群号与群二维码

群聊创建时分配一个 8 位随机群号（`no`），老群在打开群资料时补号。

```bash
# 按群号查群（返回群名、群主、人数、是否已加入、二维码链接）
curl "https://xsmmc.caldson.us.ci/api/chat/groups/lookup?number=12345678" -H "authorization: ******"

# 按群号加入
curl -X POST https://xsmmc.caldson.us.ci/api/chat/groups/join \
  -H "authorization: ******" -H "content-type: application/json" -d '{"number":12345678}'
```

- 群二维码内容：`https://<站点>/chatroom.html?group=<群号>`，
  前端用 `vtx-qr.js`（`VTXQR.canvas`）在群资料里绘制，扫开链接会提示「加入「XX」？」
- 群资料里显示群号 + 「复制群号」「群二维码」

### 14.3 4 / 8 位数字建群邀请码

微信式流程：发起人给出 4 位（或本站特有的 8 位）数字，其他人输入后进入候选，
发起人点「结束邀请并建群」时，把发起人 + 所有参与者一次性建成群聊。

```bash
# 发起邀请（digits 只接受 4 或 8）
curl -X POST https://xsmmc.caldson.us.ci/api/chat/invites \
  -H "authorization: ******" -H "content-type: application/json" -d '{"digits":4,"name":"周末开黑"}'

# 我当前还没结束的邀请
curl https://xsmmc.caldson.us.ci/api/chat/invites/current -H "authorization: ******"

# 查看邀请详情 / 加入 / 退出
curl https://xsmmc.caldson.us.ci/api/chat/invites/1234 -H "authorization: ******"
curl -X POST https://xsmmc.caldson.us.ci/api/chat/invites/1234/join -H "authorization: ******"
curl -X POST https://xsmmc.caldson.us.ci/api/chat/invites/1234/leave -H "authorization: ******"

# 结束邀请并建群（只有发起人）
curl -X POST https://xsmmc.caldson.us.ci/api/chat/invites/1234/close \
  -H "authorization: ******" -H "content-type: application/json" -d '{"name":"周末开黑"}'

# 取消邀请（只有发起人）
curl -X DELETE https://xsmmc.caldson.us.ci/api/chat/invites/1234 -H "authorization: ******"
```

- 邀请有效期 24 小时（KV `expirationTtl`），KV 键：`chat:invite:{code}`、`chat:invite-owner:{登录名}`
- 每个账户同时只能有一个进行中的邀请，再发一次会自动作废旧的
- 最多 100 人参加；发起人不能加入自己的邀请
- 邀请结束时如果没有参与者也没填群名，返回 `400 no_participants`
- 实时事件：有人加入 / 退出广播 `invite:update`；结束广播 `conversation:new` + `invite:closed`；
  取消广播 `invite:cancelled`

### 14.4 拼手速红包

只能在群聊（含公共频道）里发，金额从发送者 VTX 余额里实扣，抢到的人余额实时增加。

```bash
# 发红包：total 元、count 最多几人可抢（0/省略＝所有人）、allow 只让这些人抢、note 留言
curl -X POST https://xsmmc.caldson.us.ci/api/chat/conversations/g_xxxx/redpackets \
  -H "authorization: ******" -H "content-type: application/json" \
  -d '{"total":"1.00","count":3,"allow":[],"note":"恭喜发财"}'

# 抢红包（返回抢到的分与最新余额）
curl -X POST "https://xsmmc.caldson.us.ci/api/chat/messages/消息id/redpacket/grab?conversation=g_xxxx" \
  -H "authorization: ******"

# 红包详情（含每人抢到多少）
curl "https://xsmmc.caldson.us.ci/api/chat/messages/消息id/redpacket?conversation=g_xxxx" \
  -H "authorization: ******"

# 发送者退回未被抢完的金额
curl -X POST "https://xsmmc.caldson.us.ci/api/chat/messages/消息id/redpacket/refund?conversation=g_xxxx" \
  -H "authorization: ******"
```

规则：

| 规则 | 说明 |
|---|---|
| 最小金额 | 0.01 元，单个红包上限 200000.00 元 |
| 每人至少 0.01 元 | `total` 的分数就是最多能分给的人数，`0.02` 元最多 2 人，人多会返回 `400 bad_request` |
| `count` | 0 / 省略＝所有有资格的人都能抢；填写时必须 ≤ 群内可抢人数，也 ≤ 金额分数 |
| `allow` | 只允许名单内的人抢，名单必须是群成员，人数同样受金额限制 |
| 不能抢自己的 | 返回 `403 forbidden` |
| 只能抢一次 | 重复抢返回 `409 already_grabbed` |
| 抢完 / 过期 | 返回 `410 packet_empty` / `410 packet_expired` |
| 分配算法 | 与微信相同的「二倍均值法」，保证剩余每人至少 0.01 元 |
| 有效期 | 24 小时；未被抢完的金额发送者可以随时退回 |
| 余额 | 发红包立刻扣款并写入 `trades`（`拼手速红包 -x.xx`），抢到的人写入 `+x.xx` |

- 消息类型为 `redpacket`，`message.packet` 携带 `totalCents / remainCents / count / allow / grabs[] / closed / expiresAt`
- 抢到后实时广播 `message:packet`，前端就地刷新红包卡片
- 列表预览显示「[拼手速红包] 1.00 元」

---

## 15. 1.2.0 安全修复补丁

这一版只做安全修复，没有新增业务功能。**部署前请先完成 15.1 的凭据处理**。

### 15.1 必须人工完成的凭据处理

1. **立刻吊销旧仓库 Token**：GitHub → Settings → Developer settings → Personal access tokens，
   删掉那个曾被加密塞进 `secure.json` 的 token（它已经随公开仓库泄露，删文件不代表安全）。
2. 清理 git 历史里的 `secure.json`（历史提交仍可被任何人下载）：
   `git filter-repo --invert-paths --path secure.json`，然后强推。
3. 重新部署 Worker：`cd worker && npx wrangler deploy`
   （1.2.0 新增 Durable Object `AccountsLock`，部署时会自动执行 `v2-accounts-lock` 迁移）。
4. 需要网页版仓库修改器时，打开 `admin.html` → 点「设置仓库 Token」临时填入一个新 token
   （只存在当前标签页，关闭即失效）。

### 15.2 修复内容

| 级别 | 问题 | 1.2.0 的处理 |
|---|---|---|
| 严重 | `secure.json` 用仓库里公开的常量加密 GitHub PAT，任何人都能解出**仓库写权限** | 删除 `secure.json`、`crypto.html`、`vtx-crypto.js`；停用浏览器直连 GitHub 的备用通道；Token 改为管理员临时输入 |
| 高 | `?api=` URL 参数可把 API 地址换成攻击者域名，登录密码与 token 会被直接发过去 | `vtx-api.js` 只接受同源或内置白名单地址，`login.html` 不再透传 `api` 参数 |
| 高 | 聊天附件原样回放客户端声明的 `content-type`，上传 HTML/SVG 即同源存储型 XSS | 附件类型白名单（仅 png/jpeg/gif/webp 内联），其余按 `attachment` + `application/octet-stream` 下载，并加 `nosniff` 与 `sandbox` CSP |
| 中 | `/api/me/purchase` 信任客户端传来的 `amount`，1 分钱可买任意数量 | 服务端按 `shop.json` 定价、用 KV 记库存并扣减，忽略客户端金额；新增 `GET /api/shop` |
| 中 | 邀请码用 `Math.random()`，且查询 / 加入接口没有限流 | 改用 `crypto.getRandomValues()`，邀请与群号加入接口按 IP 限流 10 次/分钟 |
| 中 | 管理员身份只认登录名 `Kitawaga`，该名可被抢先注册 | 注册与管理员建号都拒绝保留名（`409 account_reserved`） |
| 中 | `/api/admin/accounts` 返回明文密码；登录页把密码写进 `localStorage` | 管理员接口改为返回 `hasPassword`；登录页只记住登录名，并自动清除旧版残留密码 |
| 中 | 密码在 KV 中以明文保存，任何 KV 读取 / 管理员接口泄露都会暴露全部口令 | 改为 PBKDF2-SHA256（10 万次迭代 + 每账户独立盐）存储，旧明文密码在首次登录成功后就地升级 |
| 中 | 余额是「读-改-写」整份 KV JSON，跨 isolate 的并发请求会互相覆盖 | 新增 Durable Object `AccountsLock`（30 秒租约写锁），`commitAccounts` 拿锁后重新读 KV 再改再写 |
| 低 | 未捕获异常把内部错误信息回给客户端 | 统一返回「服务端内部错误」，细节只写 Worker 日志 |

### 15.3 仍然存在的风险（本次未改）

- KV 读仍是最终一致：拿到写锁后如果读到的是旧副本，理论上仍可能少扣一次；
  彻底解决需要把余额本身搬进 Durable Object 存储（本版只做了互斥，没做迁移）。
- `POST /api/me/trades` 的 `receipt` 与 `POST /api/me/billing` 的 `refund` 不校验密码即可给自己加钱，
  这是原有设计（站主凭截图人工发放），但配合 `/api/me/withdraw` 等于**任意用户可无限铸币**，请自行决定是否收紧。
- 4 位邀请码的组合空间只有 1 万，限流只是缓解；对安全要求高的群请使用 8 位邀请码。
- 密码哈希是 PBKDF2-SHA256；如需更强抗 GPU 能力，可后续迁移到 Argon2id / scrypt（需要新的哈希前缀与灰度升级）。

---

## 16. 1.3.0 修复已知问题

本版只改前端，Worker 接口没有任何变化；版本号按 13.11 的约定一起升到 `1.3.0`。

### 16.1 问题（issue #2）

[#2 聊天室 overflow 问题](https://github.com/Caldson/Vitual-XRing/issues/2)：
用 iPad 打开 `chatroom.html` 时聊天区域没有可用的滚动条，排版错乱，输入框被挤出可视范围。

### 16.2 原因

1. **`100vh` 不是可视高度**：iOS / iPadOS Safari 的 `100vh` 取的是「地址栏与工具栏收起后」
   的大视口，键盘弹出时也不会变。`body` 又是 `overflow: hidden`，于是整页比屏幕高出一截，
   消息列表与输入框落到屏幕外，且没有滚动条可以把它们找回来。
2. **flex / grid 子项缺少 `min-height: 0`**：`.sidebar`、`.chat-pane` 的自动最小高度是内容高度，
   消息一多就把面板撑高，滚动容器 `.messages` 拿不到固定高度，自然不滚动。
3. **输入框字号小于 16px**：iOS 在聚焦 `font-size < 16px` 的输入框时会自动放大页面，
   放大后 `fixed` 定位与可视区域错位，看上去就是「排版混乱」。

### 16.3 修复

| 项 | 处理 |
|---|---|
| 视口高度 | `.app` 由 `height: 100vh` 改为 `100dvh`，并由脚本 `syncViewportHeight()` 用 `visualViewport.height`（不可用时用 `window.innerHeight`）写成内联高度；监听 `resize`、`orientationchange` 以及 `visualViewport` 的 `resize` / `scroll`，键盘弹出、旋转、工具栏收起时都会重算 |
| 滚动容器 | `.messages`、`.sidebar-body`、`.modal-body` 补 `min-height: 0`、`-webkit-overflow-scrolling: touch`、`overscroll-behavior: contain`；`.layout`、`.sidebar`、`.chat-pane` 补 `min-height: 0` / `overflow: hidden`，消息再多也只让消息列表滚动 |
| 滚动条 | `.messages` 用 `scrollbar-width: thin` + `::-webkit-scrollbar` 画一条常驻细滚动条（iPadOS 仍是系统浮层滚动条，滚动时出现） |
| 输入框 | `@media (hover: none) and (pointer: coarse)` 下 `input` / `textarea` / `select` 统一 16px，避免聚焦自动放大；`button` 加 `touch-action: manipulation`，避免双击缩放 |
| 安全区 | `viewport` 加 `viewport-fit=cover`，顶栏、输入区、左侧导航按 `env(safe-area-inset-*)` 留出刘海与 Home 指示条的空间；`.modal` 最大高度改用 `dvh` |
| 键盘弹出 | 视口高度变化时，如果消息列表原本贴着底部，重新滚到底，输入框与最新消息都留在视野里 |

### 16.4 同步升级的版本号

`vtx-api.js` 的 `API_VERSION`、`chatroom.html` 的 `REQUIRED_API_VERSION`、各页面 `<script>` 的 `?v=`、
Worker 的 `VERSION` / `CHAT_VERSION`、`worker/package.json` 全部升到 `1.3.0`（`CHAT_VERSION` 为 `1.3`）。

---

## 17. 1.4.0 更新：自动登录、可查看的账户密码、聊天室去限流

### 17.1 恢复「记住上次登录的账户并自动登录」（`login.html`）

1.2.0 出于安全考虑把登录页改成了「只记登录名、必须重新输密码」。1.4.0 按需求恢复：

- 登录 / 注册成功后，`localStorage.vtxRemembered` 存 `{ "login": "...", "password": "..." }`；
- 打开 `login.html` 时 `tryAutoLogin()` 直接拿这对凭据调一次 `/api/login`，
  成功后立刻跳到 `?next=` 指定的页面（默认 `manager.html`）；
- 自动登录失败（密码被改、账户被删、网络异常）时不再死循环，只在提示条上写
  「上次登录：xxx（自动登录失败，请输入密码）」并回填登录名；
- 只有登录名、没有密码的旧版记录仍然兼容：回填登录名并提示输入密码；
- 点「切换账户」会清掉这条记录并清空表单。

> 这意味着密码以明文保存在该浏览器的 localStorage 里，只在用户自己的设备上有效；
> 共用设备请用「切换账户」清掉记录。

### 17.2 管理员可以查看账户当前密码

密码本体仍是 PBKDF2-SHA256 哈希（不可逆），另外保存一份 **AES-GCM 加密副本** `passwordSealed`：

| 项 | 说明 |
|---|---|
| 密钥 | secret `PASSWORD_VIEW_KEY`（任意字符串，经 SHA-256 派生 AES-GCM 密钥）；未配置时不写副本 |
| 写入时机 | 注册、登录成功（顺带给老账户补副本）、本人改密码、站主建号 / 改密码 |
| 存储格式 | `aes-gcm$<base64url(iv)>$<base64url(密文)>`，与 `password` 并列存在账户记录里 |
| 读取 | 只有 `GET /api/admin/accounts`、`POST /api/admin/accounts`、`PUT /api/admin/accounts/{login}`、`DELETE /api/admin/accounts/{login}` 的响应里带解密后的 `password`；其它接口（含 `GET /api/accounts`）都不返回 |
| 解不开时 | 换过 `PASSWORD_VIEW_KEY` 或记录缺失 → 返回 `password: null`，前端提示「服务端没有保存可显示的密码」 |

`accounts-admin.html` 的编辑面板新增「当前密码」一行：默认打码，点「显示 / 隐藏」切换；
保存新密码后自动刷新为新的密码。

部署前需要执行一次：

```bash
cd worker
npx wrangler secret put PASSWORD_VIEW_KEY    # 随便给一段足够长的随机字符串
npx wrangler deploy
```

### 17.3 聊天室与面对面加群不再限流

1.2.0 给 4 / 8 位邀请码查询、加入与 8 位群号加入加了「每 IP 60 秒 10 次」的限制，
现场面对面加群时很容易被 429 挡住。1.4.0 删除该限制：

- `GET /api/chat/invites/{code}`、`POST /api/chat/invites/{code}/join`、
  `POST /api/chat/groups/join`（群号加入）都不再检查 `inviteAttempts`；
- 相关的 `INVITE_WINDOW_MS` / `INVITE_MAX_ATTEMPTS` 常量与计数器一并删除。

同版本把聊天室剩下的三处限流也全部删除：

| 接口 | 原限制 | 现在 |
|---|---|---|
| `POST /api/chat/conversations/{id}/messages`（发言） | 每 IP 60 秒 30 条 → `429 too_many_requests` | 不限制 |
| `POST /api/chat/conversations/{id}/typing`（正在输入） | 每 IP + 会话 60 秒 120 次 → `{"ok":true,"throttled":true}` | 不限制 |
| `POST /api/chat/media`（上传图片 / 文件 / 音乐） | 每 IP 60 秒 12 次 → `429 too_many_requests` | 不限制 |

- 删除的代码：`CHAT_WINDOW_MS` / `CHAT_MAX_ATTEMPTS` / `CHAT_MEDIA_WINDOW_MS` /
  `CHAT_MEDIA_MAX_ATTEMPTS` / `CHAT_TYPING_WINDOW_MS` / `CHAT_TYPING_MAX_ATTEMPTS`
  常量，以及 `chatAttempts` / `chatMediaAttempts` / `chatTypingAttempts` 三个计数器；
- 仍然保留的限制与聊天室无关：登录失败、注册、写入、记账（转账 / 提款 / 记账 / 购买）、管理操作；
- 附件仍然限制 4 MB（音乐 20 MB）；聊天室媒体的保留时间见第 25 节（1.8.0 起为 14 天）。

---

## 18. 1.5.0 更新：mention（@ 提及）

### 18.1 服务端

| 项 | 说明 |
|---|---|
| 发送 | `POST /api/chat/conversations/{id}/messages` 的请求体新增 `mentions: ["Bob", "Carol"]`（也可以放在图片 / 文件的 caption 一起发） |
| 校验 | 服务端只保留**本会话成员**的登录名，去重后最多 20 个；`Kitawaga` 这类非成员会被静默丢弃 |
| 存储 | 消息记录里多一个 `mentions` 字段，`messageView` 原样返回 |
| 会话列表 | `GET /api/chat/conversations` 的每一项新增 `mentionUnread`：当前未读里 @ 我的条数（读过即清零） |

`mentionUnread` 与 `unread` 的关系：被 @ 的消息同时计入 `unread`，
但 `mentionUnread` 只统计 `mentions` 里包含自己的那几条。

### 18.2 前端（`chatroom.html`）

1. **选人**：在输入框里打 `@`（或 `@关` / `@bo`）会弹出成员选择器，显示用户名（群昵称 / 显示名）与 `@登录名`；
   - `↑` / `↓` 移动，`Enter` / `Tab` 选中，`Esc` 关闭；
   - 选中后插入 `@登录名 `，光标留在后面；
   - 只列当前会话成员（不含自己），最多 8 条，群聊与单聊都可用，已解散的群聊禁用。
2. **发送**：从输入框文本里按成员登录名反查真正被 @ 的人（要求 `@` 前是行首或空白，`@bob` 不会误伤 `@bobby`），
   随消息一起发出 `mentions`；图片 / 文件消息的说明文字同样支持。
3. **渲染**：消息里的 `@登录名` 显示成蓝色小标签；被 @ 的消息整条气泡变成暖色并标注「@ 你」。
   文本先 `escapeHtml` 再替换，`<b>` 之类的输入照旧按纯文本显示，不会变成 XSS。
4. **提醒**：
   - 会话列表：未读 @ 时显示「有人@你」标签与橙色 `@N` 徽标（优先于普通未读数）；
   - 左侧「聊天」入口：有未读 @ 时徽标变成橙色的 `@N`；
   - 标签页标题变成 `(N 条@你) 聊天室 | Vitual XRing`；
   - 收到别人 @ 我、且当前没打开那个会话时，右下角弹一条提示。

### 18.3 停服守卫（`vtx-closed.js` + `WebsiteClose.html`）

停服期间打开站内任何页面都会在渲染前跳到 `WebsiteClose.html`。2026-10-26 那次窗口用的版本号是 `1.5.0`，
守卫脚本用时间戳加载，改完时间表立刻生效，不需要改版本参数。

| 文件 | 作用 |
|---|---|
| `vtx-closed.js` | 时间表 `WINDOWS`（北京时间，`YYYY-MM-DD HH:mm` 的 `[开始, 结束]`）与守卫逻辑；命中窗口且当前不在停服页时 `location.replace("WebsiteClose.html?from=<相对路径>")` |
| `WebsiteClose.html` | 停服公告页：大标题、状态、倒计时（到 `end` 归零）、维护窗口、恢复后「回到刚才的页面」按钮；`?from=` 只接受站内相对路径（`//`、`scheme:`、`\` 一律丢弃，回落 `index.html`） |
| `websiteclose.txt` | 同一份时间的人工填写模板，共 6 行：开始 `YYYYMMDD`、开始时、开始分、结束 `YYYYMMDD`、结束时、结束分 |

引入方式（已加在每个页面 `<head>` 的 charset 之后，纯静态站点没有服务端可以做跳转）：

```html
<script>document.write('<script src="vtx-closed.js?t=' + Date.now() + '"><\/script>');</script>
```

- 用 `document.write` 而不是普通 `<script src>`：带上 `Date.now()` 可以绕开浏览器 / GitHub Pages 的 10 分钟缓存，
  停服前几分钟改时间表也能立刻生效；
- `WebsiteClose.html` 自身也会加载该脚本，但会在「已经在停服页」时直接返回，不会死循环；
- 停服结束后，公告页会自动变成「已恢复」状态，并显示「回到刚才的页面」；直接打开站点则恢复正常；
- 脚本加载失败（例如文件没部署）时页面照常可用，不会把全站锁死；
- 浏览器禁用 JS 时守卫失效——纯静态站点无法在服务端拦截，这是已知限制。

---

## 19. 1.6.0 更新：Vitx® 视频（`vitxvideo.html` + `vitxvideopublish.html`）

1.6.0 新增两个页面，浏览与投稿分开：

| 页面 | 地址 | 作用 |
|---|---|---|
| `vitxvideo.html` | `https://xsmmc.caldson.us.ci/vitxvideo.html` | 视频站首页：分区浏览、搜索、播放 |
| `vitxvideopublish.html` | `https://xsmmc.caldson.us.ci/vitxvideopublish.html` | 投稿页：上传、填表、勾选创作声明 |

两个页面都是纯前端：不新增任何 Worker 接口，数据是页面内置的示例集，点赞 / 投币 / 收藏 / 历史 / 待审核投稿
与通知开关都只存在浏览器 `localStorage`（键名前缀 `vitx:`，两个页面共用）。

### 19.1 页面结构（对应手绘稿）

| 区域 | 内容 |
|---|---|
| 顶栏 | V 标 + `Vitx®` + `Vitx Video`；分区导航 首页 / 游戏 / 娱乐 / 音乐 / VLOG / 生活 / 饮食 / 学习；搜索框（标题、UP 主、视频 ID、标签）；右侧 点赞 / 收藏 / 历史 / 通知 四个图标、投稿按钮、`v1.6.0` 徽标、返回账户 |
| 新功能预告 | V 标 + 「Vitual XRing 新功能预告」+ `1.5.0 → 1.6.0` 版本胶囊 + 「知道了」；竖排口号「你的一切都在这里」 |
| 多栏查找 | 标题 + 分区提示 + 快捷按钮（点赞 / 投币 / 收藏 / 历史 / 投稿） |
| 搜索结果 | 输入即筛，标题显示关键词与命中数，可一键清除 |
| 今日最热 | 按播放量排序、可「换一批」；自己投稿的视频以「审核中」徽标置顶 |
| 猜你想看 | 固定步长打散的推荐列表 |
| 投稿入口 | 顶栏「投稿」按钮、快捷栏「⬆ 投稿」、面板页脚「想投稿？打开投稿页 →」都跳到 `vitxvideopublish.html` |
| 页脚 | Contributors：Caldson；Copyright © 2026 Vitual XRing |

### 19.2 交互

- **播放器**：点卡片打开模态播放器，显示视频 ID / 分区 / 标签、UP 主与播放量；进度按视频时长推进，
  支持播放 / 暂停（`空格`）、拖动进度条、`Esc` 关闭；点赞 / 投币 / 收藏在这里切换，并同步卡片上的「已点赞」标记。
- **列表**：点赞、收藏、历史（最近 30 条）都能在「多栏查找」快捷按钮或顶栏图标里查看。
- **投稿**：在独立页面 `vitxvideopublish.html` 完成（见 19.4）；提交后新视频以「审核中」进入今日最热，
  未通过审核前点击会提示不能播放。
- **通知**：铃铛面板里两条规则与手绘稿一致 ——「追的视频 / 合集更新」「点赞、评论 / 你的视频 / 合集」，
  勾选状态保存在本机，顶部铃铛用红点提示。

### 19.3 说明与限制

- 页面没有任何真实视频源，播放器是「按时间推进的示例播放器」，页内已明确标注；
- 投稿只把信息写进 `localStorage`，不会上传文件，也不会出现在其它设备上；
- 投币是纯前端计数，**不会**扣 VTX 余额；
- 停服守卫同样生效（`vtx-closed.js` 已引入），停服期间打开本页会跳到 `WebsiteClose.html`；
- 版本号统一升到 `1.6.0`（Worker `VERSION` / `CHAT_VERSION`=`1.6`、SDK `API_VERSION`、各页面 `?v=`），
  `manager.html` 顶栏新增「视频」入口。

### 19.4 投稿页（`vitxvideopublish.html`）

结构与视频页一致（V 标 + Vitx®、返回视频 / 返回账户、`v1.6.0`），主体是表单 + 右侧「投稿须知」：

| 字段 | 说明 |
|---|---|
| 上传 | 选择本地视频文件，**格式不限**（mp4 / mov / mkv / avi / flv / ts… 都行，≤2 GB）；能解码的直接在页面里预览，文件存进浏览器 IndexedDB（`vtx-video-store.js`），仍**不会上传服务器** |
| 标题 | 2~60 字 |
| 简介 | ≤300 字 |
| 标签 | 逗号分隔，最多 5 个 |
| 原创 | 是，本人原创 / 否，转载或二创 |
| 分区 | 游戏 / 娱乐 / 音乐 / VLOG / 生活 / 饮食 / 学习 |
| **创作声明** | 多选，未勾选表示「以上都不是」 |

创作声明（勾选后会写进视频记录，并在视频页的卡片与播放页显示）：

| id | 声明 | 含义 |
|---|---|---|
| `ai` | 含AI内容 | 画面、配音或文案由 AI 生成或参与创作 |
| `marketing` | 包含营销内容 | 含带货、推广、引流或商业合作 |
| `fiction` | 含虚构演绎 | 剧情、台词或设定为虚构创作 |
| `repost` | 转载 / 二创 | 非本人原创素材，已获得授权或注明来源 |
| `sponsor` | 含赞助 / 广告 | 由品牌赞助或含贴片广告 |
| `warning` | 可能引起不适 | 包含强光、剧烈音效或易引起不适的画面 |

提交后：写入 `localStorage` 的 `vitx:pending`（视频文件另存 IndexedDB），表单换成成功页「发布成功，请等待审核通过」并列出已勾选的声明，
提供「去视频页看看」「再投一个」；右侧「本机已提交」列出待审核条目。

视频页读取同一份 `vitx:pending`：待审核视频以「审核中」徽标置顶在今日最热，声明以橙色小标签显示在卡片下方，
播放页的信息行会追加「声明：…」；审核中点击会提示不能播放。

---

## 20. 1.6.1 更新：观看页 `vitxvideo.html?videoid=xxx` 与评论区

1.6.1 把「弹窗播放」改成**独立观看页**：每个视频都有自己的地址，可以刷新、可以分享、可以前进后退。

### 20.1 地址与路由

| 地址 | 页面 |
|---|---|
| `vitxvideo.html` | 首页：分区、搜索、今日最热、猜你想看 |
| `vitxvideo.html?videoid=vt-0003` | 观看页：播放器 + 视频信息 + 评论区 + 相关推荐 |

- 首页点卡片：`history.pushState` 换地址并就地渲染观看页（不整页刷新）；
- 浏览器后退 / 前进：监听 `popstate`，按地址里的 `videoid` 决定显示首页还是观看页；
- 直接打开带 `videoid` 的链接（刷新、分享）也能正常渲染；`videoid` 不存在时回到首页并提示；
- 「← 回首页」与「🔗 复制链接」都基于这个地址。

### 20.2 播放器

| 情况 | 表现 |
|---|---|
| 本机有该视频的文件（IndexedDB 里有记录） | 用 `<video controls>` 真播放，支持全屏 / 音量 / 倍速等浏览器原生控件 |
| 演示条目（内置示例，没有文件） | 显示标题与说明「这是示例视频，没有真实文件」 |
| 文件存在但浏览器解不了码（如 mkv / avi / flv） | 显示「浏览器无法解码这个文件（xxx.mkv），换一个播放器或转码后再试」 |
| 换了浏览器 / 清过站点数据 | 显示「本机找不到这个视频的文件」 |

播放器下方一排：点赞 / 投币 / 收藏（计数与首页卡片同步）、复制链接、回首页。
审核中的视频会在信息区标「审核中」，首页列表里点它会提示等审核通过。

### 20.3 评论区

| 能力 | 说明 |
|---|---|
| 发表 | 上限 300 字（带计数），按钮发送；`Ctrl / Cmd + Enter` 也可发送 |
| 排序 | 「最新」（按时间倒序，默认）/「最热」（按点赞数） |
| 点赞 | 每条评论可点赞 / 取消，计数同步 |
| 回复 | 点「回复」把 `回复 @某人：` 填进输入框并聚焦 |
| 删除 | 只对自己的评论显示 |
| 身份 | 用 `sessionStorage.vtxAccount`（登录名），没有就记作「我」 |
| 存储 | `localStorage` 的 `vitx:comments`：`{ 视频ID: [{ id, user, text, at, likes, liked }] }` |
| 初始数据 | 首次打开时给几个示例视频灌入演示评论（只灌一次，标记在 `vitx:commentsSeeded`） |

### 20.4 上传任何格式（1.7.0 起改为服务端存储，见第 21 节）

投稿页不再限制 `accept`，任何文件都能选（≤2 GB）：

- 选完立刻本机预览：浏览器能解码的直接显示画面；解不了码的提示「这个格式浏览器没法解码，预览不可用」，但**仍可提交**；
- 提交时把文件写进 IndexedDB（库名 `vitx-video`，store `files`，键是视频 ID），元信息写进 `localStorage.vitx:pending`；
- 观看页用 `vtx-video-store.js` 取回文件、`URL.createObjectURL` 播放；取不到或解不了码时按 20.2 的兜底文案提示；
- 存储失败（配额不足 / 隐私模式）时提示「视频已提交，但文件没能存到本机（可能空间不足）」，记录本身仍然保留。

> 提醒：视频文件只在这台浏览器里，换设备、换浏览器或清站点数据后就没了——页面上的文案也如实写了这一点。
---

## 21. 1.7.0 更新：投稿视频改成服务端存储

1.6.1 的视频文件只存在浏览器 IndexedDB 里，换设备 / 换浏览器 / 清站点数据就没了，别人也看不到。1.7.0 把这些数据搬到 Cloudflare Worker 的 KV：**投稿的视频、点赞、评论都存服务端，审核通过后任何人打开链接都能播放**。

### 21.1 存储键

| 键 | 内容 |
|---|---|
| `video:index` | 视频 ID 数组（按投稿时间倒序，最多 400 条） |
| `video:meta:<id>` | 视频元信息 JSON：标题、简介、标签、分区、创作声明、文件名 / 类型 / 大小 / 时长、作者、状态、播放量、点赞数组、评论数 |
| `video:file:<id>` | 视频二进制（`ArrayBuffer`），直接用 KV 值存 |
| `video:comments:<id>` | 该视频的评论数组（按时间正序，保留最近 300 条） |
| `video:purged-seed` | 老的示例视频（`v_demo*`）是否已经清理过的标记 |

- `VIDEO_MAX_BYTES = 20 MB`：KV 单个值上限约 25 MB，留出余量；
- 视频 ID 形如 `v_xxxxxxxxxxxx`，服务端生成，不猜不改；
- **不再内置任何示例视频**：新部署后列表一开始就是空的；早期版本若往 KV 写过 `v_demo*`，第一次请求会连同文件与评论一起删掉，并且 `v_demo*` / `seed` 记录永远不会出现在列表与详情里。

### 21.2 状态流转

```
draft  ── 上传文件成功 ──▶ pending ── 站主通过 ──▶ published
   │                          │
   │                          └── 站主删除 ──▶ 记录与文件一起删除
   └── 上传失败（文件过大 / 存储写入失败）会回滚 meta 与索引
```

| 状态 | 谁能看到 | 能播放 |
|---|---|---|
| `draft` | 只有作者与站主 | 不能（还没文件） |
| `pending` | 作者与站主 | 站主可以预览，其他人不能 |
| `published` | 所有人（含未登录） | 可以 |

### 21.3 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/videos` | 视频列表。可选 `?cat=生活`、`?q=关键词`（匹配标题 / 作者 / 标签 / ID）；返回 `{ videos, login, isAdmin, maxBytes, following, count }`，每条带 `status / playable / liked / mine / canReview / following` |
| GET | `/api/videos/status` | 服务可用性、`maxBytes`、分区与声明枚举 |
| POST | `/api/videos` | 建投稿（需要登录）：`{ title, desc, tags, cat, original, declarations, fileName, fileType, fileSize, dur }` → 返回 `draft` 状态的视频 |
| PUT | `/api/videos/:id/file` | 上传文件本体（原始二进制 + `content-type`）；只能传自己的、只能传一次；成功后状态变 `pending` |
| GET | `/api/videos/:id` | 视频详情 + 评论列表：`{ video, comments }`；`video` 带 `following` / `followers` |
| GET | `/api/videos/:id/file` | 播放文件。支持 `Range`（返回 `206` + `content-range`），支持 `?token=xxx`（`<video src>` 带不了 Authorization 头） |
| POST | `/api/videos/:id/view` | 播放量 +1，返回最新 `views` |
| POST | `/api/videos/:id/like` | 点赞 / 取消点赞（同一账号幂等切换），返回 `{ liked, likes }` |
| POST | `/api/videos/:id/approve` | 站主通过审核：`pending → published` |
| POST | `/api/videos/:id/reject` | 站主驳回：删除记录与文件 |
| DELETE | `/api/videos/:id` | 作者或站主删除视频 |
| POST | `/api/videos/:id/comments` | 发评论（需要登录，1~300 字），返回 `{ comment, count }` |
| POST | `/api/videos/:id/comments/:commentId/like` | 点赞 / 取消评论点赞 |
| DELETE | `/api/videos/:id/comments/:commentId` | 删评论（只能删自己的，站主可以删任何人的） |
| GET | `/api/videos/follows` | 我关注的 UP 主列表（1.8.1） |
| POST | `/api/videos/follows/:owner` | 关注 UP 主（1.8.1） |
| DELETE | `/api/videos/follows/:owner` | 取消关注（1.8.1） |

错误码与其它接口一致：`400 bad_request`、`401 unauthorized`、`403 forbidden`、`404 not_found`、`409 conflict`（重复上传文件）、`413 payload_too_large`（超过 20 MB）、`503 not_ready`（没绑定 KV）、`507 storage_failed`（KV 写入失败）。

### 21.4 SDK

```js
const list = await VTXApi.video.list({ cat: "生活" });   // 可选 { cat, q }
const one = await VTXApi.video.get(videoId);             // { video, comments }

// 投稿：先建记录再传文件（两段式，便于上报进度 / 大小校验）
const video = await VTXApi.video.upload(file, {
    title: "标题", desc: "简介", tags: ["标签"], cat: "生活",
    original: true, declarations: ["ai"], fileName: file.name,
    fileType: file.type, fileSize: file.size, dur: "00:12"
});

await VTXApi.video.like(video.id);          // { liked, likes }
await VTXApi.video.comment(video.id, "好耶"); // { comment, count }
await VTXApi.video.likeComment(video.id, commentId);
await VTXApi.video.removeComment(video.id, commentId);

videoElement.src = VTXApi.video.fileUrl(video.id); // 自动带上 ?token=
await VTXApi.video.approve(video.id);       // 站主：通过审核
await VTXApi.video.reject(video.id);        // 站主：驳回并删除
```

### 21.5 前端变化

| 页面 | 1.6.1 | 1.7.0 |
|---|---|---|
| `vitxvideo.html` 首页 | 内置 12 条示例数组 + 本机 `vitx:pending` | `VTXApi.video.list()`，分区 / 搜索都是服务端数据；没有视频时显示「还没有任何视频，去投稿」 |
| 观看页 | IndexedDB 取文件 + `blob:` 播放 | `<video src="VTXApi.video.fileUrl(id)">`，服务端支持 Range 断点续播 |
| 点赞 | `localStorage.vitx:likes` | 服务端 `POST /like`（投币、收藏、历史仍只记本机） |
| 评论 | `localStorage.vitx:comments` | 服务端接口，支持删除权限与点赞 |
| 待审核 | 无 | 站主 / 作者可见「待审核」区，卡片上直接「通过 / 删除」 |
| 投稿页 | 写 IndexedDB + `localStorage.vitx:pending` | 先校验登录，再 `VTXApi.video.upload()` 传到服务器；未登录时顶部提示去登录 |
| 播放量 | 示例数据写死 | `POST /view` 真实累加 |

- 投稿页不再需要 `vtx-video-store.js`（IndexedDB 帮助脚本已删除）；
- 本机只保留投币 / 收藏 / 历史 / 通知开关这些偏好；
- 文件上限从文案里的「2 GB」改为服务端真实的 **20 MB**，超限时前端直接提示，服务端也会返回 413。

### 21.6 部署

```bash
cd worker
npx wrangler deploy          # 上传新的 Worker 代码
```

KV 结构是追加的，不需要迁移：老的 `accounts`、`chat:*` 键都不受影响。首次请求会顺手清理早期注入的 `v_demo*` 示例视频，站点从零开始（没有假数据）。

---

## 22. 1.7.1 更新：5 GB / 100 小时投稿与投币

1.7.0 为了适配 KV 的单值上限，把投稿文件卡在 20 MB。1.7.1 起视频文件改存 R2，上限提到 **5 GB**，时长上限 **100 小时**，同时上线「投币」：1 个币 = **5.00 VTX**，直接打进投稿人账户。

### 22.1 存储

| 绑定 | 文件存放 | 单文件上限 | 上传方式 |
|---|---|---|---|
| `VIDEO_BUCKET`（R2） | R2 对象 `video:file:<id>` | **5 GB** | 20 MB 分片（R2 multipart） |
| 未绑定 | `ACCOUNTS_KV` 的 `video:chunk:<id>:<n>` / `video:file:<id>` | 分片上传可到 5 GB（受 KV 免费额度 1 GB 限制），整包约 25 MB | 分片或一次 PUT |

> 1.7.2 起，没绑 R2 但配置了 `GITHUB_TOKEN` 时会走 GitHub Release 存储，见第 23 节；上表「未绑定」一行只在两者都没有时生效。

- 元信息与评论仍然在 KV：`video:index` / `video:meta:<id>` / `video:comments:<id>`；
- 分片大小 `VIDEO_CHUNK_BYTES = 20 MB`，5 GB 大约 256 片（R2 上限 10000 片）；
- 播放走同一个 `/file` 接口，R2 与 KV 都支持 `Range`（206 + `content-range`）。

```toml
# worker/wrangler.toml
[[r2_buckets]]
binding = "VIDEO_BUCKET"
bucket_name = "vtx-video"
```

```bash
npx wrangler r2 bucket create vtx-video
npx wrangler deploy
```

### 22.2 限制

| 项 | 值 | 校验位置 |
|---|---|---|
| 文件大小 | ≤ 5 GB | `POST /api/videos` 的 `fileSize`、每个分片累计、`PUT /file` 的 `content-length` |
| 视频时长 | ≤ 100 小时（360000 秒） | `POST /api/videos` 的 `durSeconds` / `dur` |
| 标题 / 简介 / 标签 | 2-60 字 / ≤300 字 / ≤5 个（每个 ≤16 字） | 同上 |

时长用 `durSeconds`（秒）传，也接受 `"1:02:05"` 或 `"90:00:00"` 这种字符串；服务端统一存成 `durSeconds` 与 `dur` 两个字段，超过 100 小时返回 `400 bad_request`。

### 22.3 分片上传（R2）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/videos/:id/upload/start` | 开始分片上传，返回 `{ uploadId, chunkBytes, maxBytes, maxParts }`；重复调用会作废上一次 |
| PUT | `/api/videos/:id/upload/:part` | 上传第 `part` 片（从 1 开始，原始二进制）；返回 `{ partNumber, etag, received }` |
| POST | `/api/videos/:id/upload/complete` | 合并所有分片，状态变 `pending` |
| POST | `/api/videos/:id/upload/abort` | 放弃这次分片上传（回到 `draft`） |

- 只有作者与站主能上传；
- 1.7.2 起 `start` 不再因为「没绑 R2」而失败：按 R2 → GitHub Release → KV 分块 的顺序挑一个可用存储，返回里带 `storage` 与对应的 `chunkBytes`；
- `PUT /api/videos/:id/file` 仍然保留：整包上传会写到当前存储（R2 / GitHub 单资源 / KV 单值）。

### 22.4 投币

`POST /api/videos/:id/coin`，需要登录；视频必须是 `published`。

| 操作 | 效果 |
|---|---|
| 首次投币 | 观众扣 **5.00 VTX**，投稿人加 **5.00 VTX**，双方各记一笔流水（`投币` / `收到投币`），返回 `{ coined: true, coins, coinCents, cost, account, ownerMoney }` |
| 再点一次（取消） | 从投币名单里移除，**不退钱、也不从投稿人账上扣回**，返回 `{ coined: false, refunded: false }` |
| 余额不足 | `400 insufficient_funds` |
| 投稿人 = 观众 | 只扣自己的 5.00 VTX，不做转账（不会凭空多钱） |
| 未审核 / 未公开 | `409 conflict` |

- 计数存在 `meta.coins`（登录名数组）与 `meta.coinCents`（累计收到的钱），`videoView` 输出 `coins` / `coined` / `coinCents`；
- 因为「取消不退」，反复投币会重复扣款，这是设计如此（每次投币都是一次真实的 5.00 VTX 转账）。

### 22.5 SDK

```js
const status = await VTXApi.video.status();   // { maxBytes: 5368709120, maxDurationSeconds: 360000, chunkBytes, coinCents, r2 }

// 一行上传：内部按 r2 自动选择分片或整包
const video = await VTXApi.video.upload(file, {
    title, desc, tags, cat, original: true, declarations: ["ai"],
    fileName: file.name, fileType: file.type, fileSize: file.size,
    durSeconds: 3725
}, (progress) => {
    console.log(progress.percent, progress.part, progress.parts);
});

await VTXApi.video.coin(video.id);   // { coined, coins, coinCents, cost, account, ownerMoney }
```

分片接口也单独暴露：`uploadStart(id)` / `uploadAbort(id)`。

### 22.6 页面

| 页面 | 变化 |
|---|---|
| `vitxvideopublish.html` | 提示改为「任何格式，≤5 GB，时长 ≤100 小时」；选文件后探测真实时长，超 100 小时直接拦下；上传过程中按钮显示百分比并有进度条 |
| `vitxvideo.html` | 投币改为服务端（按钮计数 = 真实投币数）；未登录提示先登录；余额不足、审核中都会提示；「我投过币的」列表按服务端 `coined` 生成 |
| 版本号 | 全套同步到 `1.7.1`（`VERSION` / `CHAT_VERSION` / `VIDEO_VERSION` / `API_VERSION` / 各页 `?v=`） |

## 23. 1.7.2 更新：没开通 R2 时文件改存 GitHub Release

Cloudflare 的 R2 必须先绑定支付方式才能开通，否则 `npx wrangler r2 bucket create` 会直接抛 `code: 10042 / Please enable R2 through the Cloudflare Dashboard`。1.7.2 起，**没绑 R2 但配置了 `GITHUB_TOKEN`** 时，投稿文件改存到仓库的 GitHub Release：单文件上限从「KV 单值约 25 MB」提到 **2 GB**，时长上限仍然是 **100 小时**，分片上传和 `Range` 播放都不受影响。

### 23.1 文件存在哪

每个视频一个**草稿** release，tag 为 `video-store/<视频 id>`，文件按 32 MB 切片，存成 release 资源 `p001`、`p002`…

| 存储 | 触发条件 | 单文件上限 | 分片大小 | 读文件 |
|---|---|---|---|---|
| R2 | 绑了 `VIDEO_BUCKET` | 5 GB | 20 MB | Worker → R2 |
| GitHub Release | 没绑 R2，且 `GITHUB_TOKEN` 可用 | 2 GB | 32 MB（一片一个资源） | Worker → GitHub（带令牌） |
| KV 分块 | 两者都没有 | 5 GB（实际受 KV 免费额度 1 GB 限制） | 20 MB | Worker → KV |

- 草稿 release 不公开：外部没有直链，`/file` 仍然只给「已通过审核」或作者 / 站主看，可见性规则和 R2 / KV 完全一致；
- 删除视频 = 删掉那个草稿 release，文件跟着一起清掉（一次 API 调用，不用逐片删）；
- 元信息、评论、索引还是在 `ACCOUNTS_KV`，存储位置记在 `meta.storage` 与 `meta.gh`。

### 23.2 需要什么

| 项 | 说明 |
|---|---|
| `GITHUB_TOKEN` | 现有 secret 直接能用，需要仓库 **Contents: Read and write** |
| 仓库 | 默认取 `wrangler.toml` 里的 `REPO`，也可以用 `VIDEO_GH_REPO` 指向另一个仓库 |
| Workers 套餐 | 免费版的 50 次子请求够用：上传一片只发 1 次请求，播放一次只读 1 片 |

> 一个视频一条草稿 release，仓库的 Releases 页面里只有管理员能看到（草稿不公开），删视频时一起删掉。GitHub 单个资源上限 2 GB，我们切片只有 32 MB，不会碰到。

### 23.3 与 1.7.1 的差异

| 项 | 1.7.1 | 1.7.2 |
|---|---|---|
| 没绑 R2 时 | 只能整包传，约 25 MB | 分片上传，2 GB |
| `chunkBytes` | 固定 20 MB | 按存储返回：R2 20 MB / GitHub 32 MB / KV 20 MB |
| `/api/videos/status` | 只有 `r2` | 增加 `storage: "r2"｜"gh"｜"kv-chunks"` |
| `/api/videos`（POST）与 `/upload/start` | `r2` + 固定 `chunkBytes` | 同样带 `storage` 与对应 `chunkBytes` / `maxBytes` |
| 删除视频 | 逐片删 | GitHub 存储下删 release |
| 版本号 | 1.7.1 | 全套同步到 `1.7.2` |

SDK 不用改：`VTXApi.video.upload()` 本来就是「先 `upload/start` 拿 `chunkBytes`，按片上传，失败再退回整包」，三种存储共用这一条路。

### 23.4 运维

```bash
# 仓库里的 GITHUB_TOKEN 已经是 secret，确认它有 Contents 读写权限即可
npx wrangler secret put GITHUB_TOKEN

# 部署后确认走了哪个存储
curl https://xsmmc.caldson.us.ci/api/videos/status
# → { "storage": "gh", "maxBytes": 2147483648, "chunkBytes": 33554432, ... }
```

- 想改回 R2：把 `[[r2_buckets]]` 放开并建桶，优先级高于 GitHub；
- 想强制退回 KV：在 `wrangler.toml` 的 `[vars]` 里加 `VIDEO_GH_REPO = "off"`（不影响 `GITHUB_TOKEN` 的其他用途），单文件上限会掉回受 KV 限制；
- 草稿 release 只在「开始上传后没传完、也没点放弃」时才会残留，`/upload/abort` 或删视频都会清掉。

---

## 24. 1.7.3 更新：聊天室长消息、Discord Markdown 与转账

1.7.3 只动聊天室：解除 500 字限制、把 Markdown 升级成 Discord 风格、增加聊天室转账。视频、商店、账户接口没有变化；版本号全套同步到 `1.7.3`。

### 24.1 解除 500 字限制与长消息折叠

| 项 | 1.7.2 | 1.7.3 |
|---|---|---|
| 单条文字 | 最长 500 字符（`400 bad_request`） | 不再按字符数限制；只有 **256 KB** 的 KV 安全阈值（`413 text_too_long`） |
| 前端输入框 | 无 `maxlength`，但服务端会拒 | 无 `maxlength`，正常输入即发送 |
| 会话列表 `lastMessage.text` | 完整正文 | 最多 200 字 + `…`（长消息不再拖垮轮询） |
| 消息存储 | 最近 300 条 | 最近 300 条，且按约 6M 字符预算从旧到新裁剪 |

前端行为（`chatroom.html`）：

- 消息正文 ≥ 500 字时，气泡只显示约 330px 高，底部渐隐，并出现 `.........展开`；
- 点 `.........展开` 弹窗显示**完整内容**（同样是渲染后的 Markdown），底部带「复制全文」；
- 切换会话、实时消息、轮询刷新后折叠状态保持；
- 接口本身仍返回完整 `text`，折叠只是显示层行为。

### 24.2 Discord 风格 Markdown

新增 `vtx-markdown.js`（零依赖、纯前端，Node 里也能 require 做单测），聊天室所有文字消息与图片 / 文件 / 音乐配文都走它渲染。

支持的语法（与 Discord 对齐）：

| 语法 | 效果 |
|---|---|
| `**粗体**` | **粗体** |
| `*斜体*` / `_斜体_` | 斜体（`snake_case` 不会误伤） |
| `***粗斜体***` | 粗体 + 斜体 |
| `__下划线__` | 下划线 |
| `~~删除线~~` | 删除线 |
| `\|\|剧透\|\|` | 点击才显示的剧透 |
| `` `行内代码` `` | 行内代码，里面的 Markdown 不生效 |
| ` ```语言 ... ``` ` | 代码块，带语言标签与「复制」按钮；未闭合也能渲染 |
| `> 引用` / `>>> 多行引用` | 引用块 |
| `#` / `##` / `###` 标题 | 标题 |
| `-# 小字` | 小字 |
| `- 项` / `1. 项` | 无序 / 有序列表 |
| `[文字](https://…)`、裸链接 | 链接（只允许 `http` / `https` / `mailto`） |
| `@登录名` | 高亮（只认本会话成员，代码块里的 @ 不处理） |
| `<t:1730000000>` | 时间块，见下 |

时间块支持 Discord 的 7 种样式：`<t:秒>` / `:t` / `:T` / `:d` / `:D` / `:F` / `:R`（相对时间每分钟自动刷新）。

| 写法 | 显示 |
|---|---|
| `<t:1700000000>` 或 `:f` | `2023年11月15日 06:13`（本地时区） |
| `:t` / `:T` | `06:13` / `06:13:20` |
| `:d` / `:D` | `2023/11/15` / `2023年11月15日` |
| `:F` | `2023年11月15日 星期三 06:13` |
| `:R` | `2年前` / `3分钟前` |

安全：

- 所有用户文本先做 HTML 转义，不支持任何原始 HTML；
- 链接只渲染 `http` / `https` / `mailto`，`javascript:` 等协议按普通文本显示；
- 代码块、时间块、链接优先占位，后续强调格式不会破坏它们；
- 相对时间用 `<time data-ts>` 保存毫秒时间戳，页面定时刷新。

### 24.3 聊天室转账

和微信转账一致：**发起即扣款 → 对方点「收款」才到账 → 24 小时未收可退回**。转账需要账户密码确认（和 `/api/me/transfer` 一致）。

```bash
# 发起转账（单聊可省略 to；群聊必须指定本群成员）
curl -X POST https://xsmmc.caldson.us.ci/api/chat/conversations/dm_xxxx/transfers \
  -H "authorization: ******" -H "content-type: application/json" \
  -d '{"to":"Bob","amount":"1.50","note":"午饭","password":"你的账户密码"}'

# 收款（只有收款人；返回抢到的金额与最新余额）
curl -X POST "https://xsmmc.caldson.us.ci/api/chat/messages/消息id/transfer/claim?conversation=dm_xxxx" \
  -H "authorization: ******"

# 退回（只有发送者；对方还没收款时随时可以退回，过期也能退）
curl -X POST "https://xsmmc.caldson.us.ci/api/chat/messages/消息id/transfer/refund?conversation=dm_xxxx" \
  -H "authorization: ******"
```

请求体：

| 字段 | 必填 | 说明 |
|---|---|---|
| `amount` / `total` | 是 | VTX 金额，大于 0，最多两位小数，单笔上限 1,000,000.00 VTX |
| `to` / `recipient` | 群聊必填 | 收款人登录名；必须是本会话成员，不能是自己；单聊只能转给对方 |
| `password` | 是 | 账户密码，错误返回 `400 invalid_password` |
| `note` | 否 | 备注，最多 100 字 |

消息结构：

```json
{
    "type": "transfer",
    "text": "午饭",
    "transfer": {
        "id": "tf_xxxxxx",
        "from": "Alice",
        "fromName": "爱丽丝",
        "to": "Bob",
        "toName": "鲍勃",
        "cents": 150,
        "note": "午饭",
        "status": "pending",
        "createdAt": 1760000000000,
        "claimedAt": 0,
        "expiresAt": 1760086400000
    }
}
```

- `status`：`pending`（待收款）→ `claimed`（已收款）或 `refunded`（已退回）；超过 24 小时未收，收款接口会把它标成 `expired` 并返回 `410 transfer_expired`
- 资金：发起时扣发送方余额并写 `trades`（`转账 -1.50`）；收款时加到收款人余额（`转账 +1.50`）；退回时写 `转账退回 +1.50`
- 限制：未收款的转账**不能撤回 / 删除**（`400 transfer_pending`），必须先退回，避免钱卡在消息里
- 转发转账消息时只会转发一条文字摘要（`[转账] 1.50 VTX 待收款`），不会复制资金
- 实时事件：收款 / 退回广播 `message:transfer`，前端就地刷新卡片
- 会话列表预览显示 `[转账] 1.50 VTX 待收款` / `已收款` / `已退回` / `已过期`
- 错误码：

| 状态码 | `error` | 场景 |
|---|---|---|
| `400` | `invalid_password` | 账户密码错误 |
| `400` | `insufficient_balance` | 余额不足 |
| `403` | `forbidden` | 收款人不是自己 / 不是发起人 / 不是会话成员 |
| `409` | `already_claimed` / `already_refunded` | 已经收过 / 已经退过 |
| `410` | `transfer_expired` / `transfer_refunded` | 超过 24 小时 / 已退回 |
| `429` | `too_many_requests` | 转账太频繁 |

### 24.4 版本与测试

- 全套版本号同步到 `1.7.3`：`worker/index.js` 的 `VERSION` / `CHAT_VERSION` / `VIDEO_VERSION`、`vtx-api.js` 的 `API_VERSION`、`chatroom.html` 的 `REQUIRED_API_VERSION`、各页 `<script src="...?v=1.7.3">`
- `worker/test/chat.test.mjs` 新增长消息与转账用例；`worker/test/markdown.test.mjs` 覆盖 Markdown / 时间块 / XSS / 链接协议
- 运行：`cd worker && npm test`

---

## 25. 1.8.0 更新：聊天室图片 / 文件改为保留 14 天

1.8.0 只调整聊天室媒体的保留时间：从 **20 分钟** 改为 **14 天**。1.7.3 的 Markdown、长消息折叠与转账功能不变。

### 25.1 变化

| 项 | 1.7.3 | 1.8.0 |
|---|---|---|
| `CHAT_MEDIA_TTL_SECONDS` | `1200`（20 分钟） | `1209600`（14 天） |
| KV `expirationTtl`（`chat:media:{id}` 与 `chat:media-meta:{id}`） | `1200` | `1209600` |
| 上传响应的 `media.expiresAt` | 上传后 20 分钟 | 上传后 14 天 |
| 上传响应的 `media.ttlSeconds` | `1200` | `1209600` |
| `GET /api/chat/status` 的 `mediaTtlSeconds` | `1200` | `1209600` |
| 前端提示 | 「20 分钟后自动删除」 | 「保留 14 天」 |

### 25.2 接口行为

```bash
# 上传（行为：普通文件 ≤ 4 MB，音乐 ≤ 20 MB）
curl -X POST https://xsmmc.caldson.us.ci/api/chat/media \
  -H "authorization: ******" -H "content-type: image/png" \
  -H "x-file-name: screenshot.png" --data-binary @screenshot.png

# 返回里的保留时间
# { "media": { "id": "…", "expiresAt": 1761300000000, "ttlSeconds": 1209600 } }

# 过期后读取
curl "https://xsmmc.caldson.us.ci/api/chat/media/媒体id?token=你的token"
# 410 { "error": "media_expired", "message": "图片或文件已过期（上传后 14 天自动删除）" }
```

- 上传大小上限、类型白名单、`Range` / 缓存头、权限校验都不变；
- 过期后聊天记录里的图片 / 文件 / 音乐消息仍然保留，前端显示「图片已过期（上传后 14 天自动删除）」；
- **旧文件不会被延长**：KV 的 `expirationTtl` 在写入时固定，1.8.0 部署前上传的文件仍按原来的 20 分钟过期；需要保留更久只能重新上传；
- `expiresAt` 是绝对毫秒时间戳，前端用它判断是否显示「已过期」，不会因为页面缓存而错乱。

### 25.3 版本与测试

- 版本号全套同步到 `1.8.0`：`worker/index.js` 的 `VERSION` / `CHAT_VERSION` / `VIDEO_VERSION`、`vtx-api.js` 的 `API_VERSION`、`chatroom.html` 的 `REQUIRED_API_VERSION`、各页 `<script src="...?v=1.8.0">`
- `worker/test/chat.test.mjs` 断言 `/api/chat/status` 的 `mediaTtlSeconds` 与上传响应的 `ttlSeconds` 都是 `14 * 24 * 60 * 60`
- 运行：`cd worker && npm test`

---

## 26. 1.8.0 更新：聊天室音乐文件直接播放

聊天室发送的音频文件（音乐）现在会渲染成 `<audio controls>`，点播放键就能直接听，不再只是一个下载链接。

### 26.1 服务端

- `/api/chat/media` 会把客户端声明的 `audio/*` 保留为音频类型；过去除图片外一律存成 `application/octet-stream`。
- 没带 MIME 时按扩展名补：`mp3` / `mp2` / `m4a` / `m4b` / `aac` / `wav` / `wave` / `flac` / `ogg` / `oga` / `opus` / `weba` / `mka` / `wma` / `aif` / `aiff` / `alac` / `mid` / `midi` / `amr` / `ape`。
- `GET /api/chat/media/{id}` 对音频返回 `content-type: audio/*` 与 `content-disposition: inline`；老文件即使元数据是 `octet-stream`，也会按文件名扩展名补出音频类型，保证还能播放。
- 上传上限：**音乐 20 MB**，其它文件仍是 **4 MB**；音乐同样保留 **14 天**（见第 25 节）。

### 26.2 前端

- 聊天室按 `media.type` 或扩展名识别音乐，气泡里显示 🎵 文件名 + 大小 + 原生音频播放器。
- 会话列表 / 引用 / 搜索预览显示 `[音乐] 歌名.mp3`；普通文件仍是 `[文件] …`。
- 还是用同一个「图片/文件」按钮上传，不需要额外入口。

### 26.3 格式与兼容性

- 现代浏览器一般能直接解码 MP3 / M4A / AAC / WAV / FLAC / OGG / OPUS；
- WMA、APE、AMR 等格式会显示播放器，但能否解码取决于浏览器和系统编解码器；
- 音频也受 14 天 TTL 限制，过期后消息保留并显示「音乐已过期（上传后 14 天自动删除）」；
- 旧的 20 分钟 TTL 文件不会被延长（见 25.2）。

### 26.4 测试

- `worker/test/chat.test.mjs`：验证 `audio/mpeg` 类型保留、`GET` 返回 `audio/mpeg` 与 `inline`、5 MB 音频可上传、5 MB 图片仍被 4 MB 限制拦截；
- `worker/test/chatroom.test.mjs`：验证 `.mp3` / `.m4a` / `.flac` 识别为音乐、`.png` 不识别、`[音乐]` 预览文本。

---

## 27. 1.8.1 更新：关注 UP 主

Vitx® 视频支持关注 / 取关 UP 主。关注状态存在服务端，换设备、清缓存都还在；首页工具栏新增「👥 关注」，可以集中查看已关注 UP 主的视频。

### 27.1 接口

```bash
# 关注 / 取关（需要登录，不能关注自己）
curl -X POST   https://xsmmc.caldson.us.ci/api/videos/follows/Bob -H "authorization: ******"
curl -X DELETE https://xsmmc.caldson.us.ci/api/videos/follows/Bob -H "authorization: ******"

# 我关注的 UP 主列表
curl https://xsmmc.caldson.us.ci/api/videos/follows -H "authorization: ******"
```

返回：

```json
{
    "ok": true,
    "owner": "Bob",
    "following": true,
    "followers": 12
}
```

`GET /api/videos/follows`：

```json
{
    "ok": true,
    "login": "Alice",
    "count": 1,
    "following": ["Bob"],
    "items": [{ "login": "Bob", "name": "鲍勃", "followers": 12 }]
}
```

- 关注不存在的账户返回 `404 not_found`，关注自己返回 `400 bad_request`
- 重复关注 / 重复取关是幂等的，不会重复计数
- 每位账户最多关注 **500** 位 UP 主；单个 UP 主最多记录 **5000** 个关注者
- KV 键：`video:follows:{登录名}`（我关注了谁）、`video:followers:{登录名}`（谁关注了我）

### 27.2 视频字段

| 字段 | 说明 |
|---|---|
| `video.following` | 当前登录用户是否关注了该视频的 UP 主 |
| `video.followers` | UP 主的关注者数量（详情接口返回真实数量；列表里为 0，不额外读 KV） |
| `GET /api/videos` 的 `following` | 当前登录用户关注的 UP 主登录名数组，前端用来做「关注」筛选 |

### 27.3 前端

- 播放页 UP 主名字旁边显示「+ 关注 / 已关注」和「N 人关注」，点一下即关注 / 取关
- 自己投稿的视频显示「你自己」，不能关注自己
- 首页工具栏新增「👥 关注」，列出已关注 UP 主的视频；列表为空时提示去首页挑视频
- 未登录点击关注会提示先登录；关注成功后按钮、关注人数和「关注」筛选即时更新

### 27.4 测试与版本

- `worker/test/videos.test.mjs` 新增关注 / 取关 / 关注列表 / 视频 `following` / `followers` / 自关注与匿名分支
- 版本号全套同步到 `1.8.1`：`worker/index.js` 的 `VERSION` / `CHAT_VERSION` / `VIDEO_VERSION`、`vtx-api.js` 的 `API_VERSION`、`vtx-markdown.js`、`chatroom.html` 的 `REQUIRED_API_VERSION`、各页 `<script src="...?v=1.8.1">`
- 运行：`cd worker && npm test`

---

## 28. 1.8.2 更新：举报视频（`vitxvideo.html`）

1.8.2 在播放页新增「🚩 举报」，登录用户可以提交举报理由、照片证据（选填）和补充文字（选填）；管理员在首页「举报处理」区删除视频或忽略举报。

### 28.1 举报理由

| 代码 | 文案 |
|---|---|
| `plagiarism` | 抄袭他人作品并投稿原创 |
| `copyright` | 侵犯版权 / 未经授权搬运 |
| `misleading` | 虚假信息 / 标题党 |
| `inappropriate` | 不适宜内容 |
| `spam` | 垃圾广告 |
| `other` | 其他 |

服务端只接受上表代码，其它值返回 `400 bad_request`。

### 28.2 接口

| 方法 | 路径 | 权限 | 作用 |
|---|---|---|---|
| `POST` | `/api/videos/{videoId}/report` | 登录 | 提交举报（同一用户对同一视频只能有一条待处理举报） |
| `POST` | `/api/videos/reports/media` | 登录 | 上传证据照片（PNG / JPG / GIF / WebP，≤ 4 MB） |
| `GET` | `/api/videos/reports/media/{mediaId}?token=...` | 登录 | 读取证据照片（保留 30 天） |
| `GET` | `/api/videos/reports` | 管理员 | 举报列表（待处理优先，最新优先） |
| `POST` | `/api/videos/reports/{reportId}/handle` | 管理员 | `{ "action": "remove" }` 删除视频；`{ "action": "dismiss" }` 忽略 |

提交举报：

```http
POST /api/videos/v_xxx/report
Authorization: Bearer <token>
Content-Type: application/json

{
  "reason": "plagiarism",
  "detail": "第 2 分钟开始与 av123456 完全一致",
  "evidence": "AbCdEf123"
}
```

`evidence` 是 `POST /api/videos/reports/media` 返回的 `media.id`，可以不传。

```json
{
    "ok": true,
    "report": {
        "id": "rp_xxxxxxxxx",
        "videoId": "v_xxx",
        "videoTitle": "视频标题",
        "videoOwner": "Bob",
        "reporter": "Alice",
        "reason": "plagiarism",
        "detail": "第 2 分钟开始与 av123456 完全一致",
        "evidence": {
            "id": "AbCdEf123",
            "name": "screenshot.png",
            "type": "image/png",
            "size": 48213
        },
        "status": "pending",
        "time": "2026-10-27 22:00:00"
    }
}
```

- 不能举报自己的视频：`400 bad_request`
- 同一用户对同一视频已有 `pending` 举报：`409 already_reported`
- 补充文字最长 **500** 字；证据照片最多 **4 MB**，服务端保留 **30 天**
- 管理员处理 `remove` 时会删除视频文件、元数据、评论和视频索引；`dismiss` 只把举报标记为 `rejected`
- 已处理的举报不能重复处理：`409 already_handled`

### 28.3 存储

- `video:reports`：举报数组（最多保留最近 **500** 条）；每条包含视频标题 / UP 主快照、举报人、理由、补充文字、证据元数据、状态与处理人
- `video:report-media:{mediaId}`：证据照片二进制（TTL 30 天）
- `video:report-media-meta:{mediaId}`：证据照片元数据（TTL 30 天）
- 举报状态：`pending` / `accepted`（已删除视频）/ `rejected`（已忽略）

### 28.4 前端

- 播放页操作栏新增「🚩 举报」，未登录点击提示先登录；自己的视频不显示举报按钮
- 弹窗包含：理由下拉框、照片证据（选填，上传后显示缩略图，可移除）、补充文字（选填，500 字计数）
- 管理员首页新增「举报处理」区：显示原因、补充文字、证据缩略图、举报人和时间；可「删除视频」或「忽略举报」
- 删除视频后自动刷新视频列表与举报列表；如果正在观看被删除的视频，会回到首页

### 28.5 测试与版本

- `worker/test/videos.test.mjs` 新增举报创建、非法理由、重复举报、证据上传 / 读取、管理员列表、忽略与删除处理
- 版本号全套同步到 `1.8.2`：`worker/index.js` 的 `VERSION` / `CHAT_VERSION` / `VIDEO_VERSION`、`vtx-api.js` 的 `API_VERSION`、`vtx-markdown.js`、`chatroom.html` 的 `REQUIRED_API_VERSION`、各页 `<script src="...?v=1.8.2">`
- 运行：`cd worker && npm test`

---

## 29. 1.9.0 更新：聊天室 UNO

1.9.0 在聊天室右上角新增 **UNO** 入口，可以在群聊 / 单聊里发送邀请卡片，支持人机对战、普通房间、混合对战和随机匹配，以及组队互看手牌、批量出牌、+2 / +4 / 禁止的生效玩家、连续生效、局内聊天和反转牌奇偶结算。

### 29.1 入口与邀请

- `chatroom.html` 顶栏右上角新增「UNO」按钮；会话输入框旁新增「UNO」按钮，可以直接把邀请卡片发到当前单聊 / 群聊
- 邀请卡片是消息类型 `uno`，内容由服务端生成，包含房间名、模式、人数、状态和 `roomId`；点击卡片会打开 / 加入房间
- 邀请卡片同样支持撤回、转发、会话预览（预览文案为 `[UNO 邀请] ……`）
- 房间码为 6 位大写字母数字，可在房间内复制发给好友

### 29.2 模式

| mode | 说明 | 人数 |
|---|---|---|
| `ai` | 1 人 vs 1~9 个人机，创建后立刻发牌 | 2~10 |
| `normal` | 普通房间：邀请好友，或等待随机匹配 | 2~10 |
| `mixed` | 混合对战：真人一队、人机一队，至少 2 名真人才能开始 | 2~9 真人 + 1~9 人机（最多 18） |
| `match` | 随机匹配：随机加入一间有空位的等待中普通房间；没有则创建一间 | 同 `normal` |

### 29.3 牌局规则与扩展

- 标准 108 张 UNO 牌：红 / 黄 / 绿 / 蓝各 25 张（0 一张、1~9 各两张、禁止 / 反转 / +2 各两张），万能牌与万能 +4 各 4 张；每人 7 张，翻开的起手牌固定为数字牌
- 出牌：颜色相同 **或** 数字 / 功能相同；万能牌随时可出，并指定生效颜色
- **批量出牌**：一次可选多张相同数字 / 功能的牌（颜色可以不同）。例：红 1 + 蓝 1 + 黄 1，出牌时在出现的颜色里选择最终生效颜色；红 1 + 蓝 1 + 蓝 1 只能选红或蓝；两张红 1 也可以一起出（1.10.1 起只要求其中一张能压住牌堆顶，见第 31 节）
- **组队**：普通房间房主可打开组队并手动分队（也可自动分两队）；队友之间能看到彼此的手牌，队内聊天只有队友能看；队友出完牌整队获胜。混合对战固定为「真人 vs 人机」
- **生效玩家**：出 +2 / +4 / 禁止后，如果房主没有关闭「设置生效玩家」，可以把效果指定给接下来 1~2 名玩家或自己的队友之一（1.10.2 起改为单选，见第 32 节）；关闭后自动只作用于下家
- **连续生效**：一次出 N 张 +2 / +4，目标要摸 2N / 4N 张，并跳过下一次出牌；一次出 N 张禁止，目标连续 N 个自己的回合不能出牌（1.10.0 起 +4 还可选 6N，见第 30 节）
- **反转牌奇偶**：一次出多张反转牌时，按张数对 2 取余结算——3 张只反转一次，4 张互相抵消；两人局的反转牌相当于让对手少出一次
- **局内聊天**：支持「全局」和「队内」两个频道；队内消息只有同队玩家能收到，服务端按队伍过滤
- 牌堆用完时自动把弃牌堆（保留牌堆顶）洗回牌堆
- 抽牌：每回合最多抽 1 张；抽到能出的牌可以继续出牌或过牌，抽到不能出的牌自动结束回合（1.10.0 起改为可连续抽多张，见第 30 节）
- 判负：牌局中主动离开视为认输，对手 / 对方队伍获胜
- 超时 / 清理：房间 KV 保留 24 小时，结束后的房间保留 2 小时；索引最多保留 200 间

### 29.4 数据模型与 KV

- `uno:room:{roomId}`：完整房间（玩家、手牌、牌堆、弃牌堆、方向、生效颜色、累计跳过、操作记录、局内聊天、设置）
- `uno:index`：等待中 / 进行中房间摘要，用于随机匹配和「我的房间」（最多 200 条，自动清理过期条目）
- 手牌只下发给本人和组队模式下的队友；对手只返回数量
- 公开视图字段：`id`、`code`、`mode`、`status`（`waiting` / `playing` / `finished`）、`name`、`hostName`、`settings`、`players`、`me`、`game`、`chats`

牌面对象：

```json
{ "id": "red:5:1", "color": "red", "value": "5" }
```

`value` 可以是 `0`~`9`、`skip`、`reverse`、`draw2`、`wild`、`wild4`。

### 29.5 接口

| 方法 | 路径 | 权限 | 作用 |
|---|---|---|---|
| `GET` | `/api/uno/status` | 公开 | 版本、开关、模式、人数上限与能力列表 |
| `GET` | `/api/uno/rooms` | 登录 | 等待中的普通房间 + 我的房间 |
| `POST` | `/api/uno/rooms` | 登录 | 创建房间 |
| `POST` | `/api/uno/rooms/join` | 登录 | 按 `roomId` 或 `code` 加入 |
| `POST` | `/api/uno/match` | 登录 | 随机匹配（没有空房时自动创建） |
| `GET` | `/api/uno/rooms/{roomId}` | 房间成员 | 读取牌局视图 |
| `POST` | `/api/uno/rooms/{roomId}/start` | 房主 | 开始牌局 |
| `POST` | `/api/uno/rooms/{roomId}/settings` | 房主 | 修改组队 / 生效玩家设置 / 房间名（仅等待中） |
| `POST` | `/api/uno/rooms/{roomId}/teams` | 房主 | 设置队伍：`{ "teams": [["Alice","Bob"],["Carol"]] }` 或 `{ "auto": true }` |
| `POST` | `/api/uno/rooms/{roomId}/leave` | 房间成员 | 离开；牌局中离开视为认输 |
| `POST` | `/api/uno/rooms/{roomId}/play` | 当前回合玩家 | 出牌 |
| `POST` | `/api/uno/rooms/{roomId}/draw` | 当前回合玩家 | 抽 1 张 |
| `POST` | `/api/uno/rooms/{roomId}/pass` | 当前回合玩家 | 抽牌后过牌 |
| `POST` | `/api/uno/rooms/{roomId}/chat` | 房间成员 | 局内聊天 |
| `POST` | `/api/chat/conversations/{conversationId}/uno` | 会话成员 | 在单聊 / 群聊发送 UNO 邀请卡片 |

创建房间：

```http
POST /api/uno/rooms
Authorization: Bearer <token>
Content-Type: application/json

{ "mode": "normal", "teamMode": true, "effectTargeting": true }
```

`mode` 为 `ai` 或 `mixed` 时 `bots` 必填（1~9）；`normal` 可省略。

出牌（批量出牌 + 最终颜色 + 生效玩家）：

```http
POST /api/uno/rooms/u_xxx/play
Authorization: Bearer <token>
Content-Type: application/json

{
  "cards": ["red:1:1", "blue:1:1", "yellow:1:1"],
  "color": "blue",
  "targets": ["Bob"]
}
```

- 所有牌必须是同一 `value`，且每张都能压住当前牌堆顶，否则 `409 illegal_play` / `409 mixed_batch`
- 彩色牌批量出牌时 `color` 必须是这批牌出现过的颜色，否则 `409 bad_color`
- 万能牌 / 万能 +4 必须传 `color`，否则 `409 need_color`
- `targets` 只能包含接下来 1~2 名玩家或自己的队友，否则 `409 bad_target`；不传时默认下家
- 返回 `{ "ok": true, "room": { ... } }`，服务端已经把机器人回合跑完

局内聊天：

```http
POST /api/uno/rooms/u_xxx/chat
Content-Type: application/json

{ "text": "队友注意，我剩一张", "scope": "team" }
```

`scope` 为 `global`（默认）或 `team`；队内消息需要房间开启组队且自己已经分队。

### 29.6 WebSocket 事件

复用 ChatHub，只发给房间里的真人玩家：

```json
{ "type": "uno:update", "room": "u_xxx", "seq": 12 }
{ "type": "uno:chat", "room": "u_xxx", "seq": 13, "scope": "team", "message": { "login": "Alice", "name": "爱丽丝", "scope": "team", "text": "…", "at": 1760000000000 } }
{ "type": "uno:started", "room": "u_xxx", "seq": 4 }
```

客户端收到 `uno:update` / `uno:started` 后重新拉取 `GET /api/uno/rooms/{roomId}`；收到 `uno:chat` 直接把消息追加到队内 / 全局聊天。

### 29.7 前端

- `vtx-uno.js`：大厅、等待房间、牌桌、选色 / 选生效玩家弹窗、局内聊天、轮询与 WebSocket 刷新
- `vtx-uno.css`：UNO 面板、牌面、聊天邀请卡片和移动端布局
- `chatroom.html`：右上角 UNO 按钮、输入框旁 UNO 邀请按钮、`type: "uno"` 消息卡片、`uno:*` 实时事件转发
- SDK：`VTXApi.uno` 提供 `status / rooms / create / join / match / room / leave / start / settings / teams / play / draw / pass / chat / invite`

### 29.8 测试与版本

- `worker/test/uno.test.mjs`：牌堆、批量出牌与最终颜色、反转奇偶、禁止叠加、+2 倍数、生效玩家限制、组队手牌可见性、队内聊天过滤、抽牌 / 过牌、机器人回合、随机匹配、混合对战、邀请卡片、房主权限与认输
- `worker/test/uno-ui.test.mjs`：大厅渲染、创建人机对战、选牌出牌、抽牌刷新与关闭面板
- `worker/test/chatroom.test.mjs`：邀请卡片、会话预览、UNO 按钮与脚本版本
- 版本号全套同步到 `1.9.0`：`worker/index.js` 的 `VERSION` / `CHAT_VERSION` / `VIDEO_VERSION`、`worker/uno.js` 的 `UNO_VERSION`、`vtx-api.js` 的 `API_VERSION`、`vtx-markdown.js`、`chatroom.html` 的 `REQUIRED_API_VERSION`、各页 `<script src="...?v=1.9.0">`
- 运行：`cd worker && node test/uno.test.mjs && node test/uno-ui.test.mjs`
---

## 30. 1.10.0 更新：UNO 多次抽牌与 +4 / +6

1.10.0 调整 UNO 的两条规则：一回合可以抽任意多张牌；打万能 +4 时可以选择让目标抽 4 张或 6 张。

### 30.1 一回合多次抽牌

- 以前：每回合最多抽 1 张，抽到不能出的牌自动结束回合
- 现在：轮到你时可以连续抽任意多张（直到牌堆空）；抽牌不会自动结束回合，你可以继续抽、出牌或过牌
- `game.drawCount`：本回合已抽张数，换人时归零；`game.drewThisTurn` 表示本回合至少抽过 1 张；只有它为 `true`（或牌堆和弃牌堆都抽不出牌）时才能 `pass`
- `POST /api/uno/rooms/{roomId}/draw` 不再返回 `already_drew`；每次抽 1 张，返回 `{ drawn, playable, drawCount, room }`
- 牌堆空时抽牌不会推进回合，返回 `drawn: null`；如果牌堆和弃牌堆都抽不出牌，可以直接过牌
- 机器人仍然抽 1 张后决定出牌或过牌（规则允许，不强制连续抽）

### 30.2 +4 / +6

- 出万能 +4（单张或多张）时，除了选颜色，还要选 `drawAmount`：`4` 或 `6`；不传默认按 `4` 处理（1.10.2 起改由被 +4 选中的玩家选择，见第 32 节）
- 如果选 `4`，但选定的颜色在**出完这批 +4 后**的手牌里已经不存在，服务端自动把它升级成 `6`
- 多个 +4：每个生效玩家抽 `drawAmount × 张数` 张（例如 2 张 +4 且升级为 +6 → 12 张），并跳过下一次出牌
- 响应新增 `autoUpgraded` 与 `wild4Draw`：

```json
{ "ok": true, "autoUpgraded": true, "wild4Draw": 6, "room": { } }
```

- 出牌请求示例：

```http
POST /api/uno/rooms/u_xxx/play
Content-Type: application/json

{ "cards": ["wild:wild4:1"], "color": "red", "drawAmount": 4, "targets": ["Bob"] }
```

- `drawAmount` 不是 4 / 6 → `409 bad_draw_amount`
- 前端：选完颜色后弹出「抽 4 张 / 抽 6 张」；如果手里没有所选颜色，会提示选 +4 会自动升级，并把 +6 标为主按钮。升级结果用 toast 提示（1.10.2 起改为由被 +4 选中的玩家选择，见第 32 节）

### 30.3 前端变化

- 抽牌按钮在轮到你的整个回合都保持可用（牌堆未空时）；抽牌后牌堆文案显示「本回合已抽 N 张」
- 出 +4 时新增惩罚选择弹窗；目标选择弹窗显示每个目标实际要抽的张数
- 大厅规则说明同步更新

### 30.4 测试与版本

- `worker/test/uno.test.mjs` 新增：连续抽多张不结束回合、抽到能出的牌后可继续抽、+4 选择 +6、选 +4 但缺色自动 +6、批量 +4 翻倍、HTTP 接口的 `autoUpgraded` / `drawCount`
- `worker/test/uno-ui.test.mjs` 新增 +4 先选颜色再选 +4 / +6 的流程
- 版本号全套同步到 `1.10.0`：`worker/index.js` 的 `VERSION` / `CHAT_VERSION` / `VIDEO_VERSION`、`worker/uno.js` 的 `UNO_VERSION`、`vtx-api.js` 的 `API_VERSION`、`vtx-markdown.js`、`chatroom.html` 的 `REQUIRED_API_VERSION`、各页 `<script src="...?v=1.10.0">`
- 运行：`cd worker && node test/uno.test.mjs && node test/uno-ui.test.mjs`
---

## 31. 1.10.1 更新：同点数批量出牌可以带上「压不住」的抽牌

1.10.1 放宽批量出牌的合法性：同一批牌仍必须同数字 / 同功能，但不再要求每一张都能压住牌堆顶；只要其中至少一张能出，其余同点数牌（包括本回合抽到的）可以一起出，并参与最终颜色选择。

### 31.1 规则

- 例：牌堆顶是黄 5，手里有黄 1；本回合抽到红 1（红 1 单独压不住黄 5）。可以同时出黄 1 + 红 1，并在最终颜色里选红或黄；选红后牌堆顶变成红 1
- 前端允许先选任意一张同点数牌（只要手里有能压住牌堆顶的同点数牌），服务端只要求整批至少一张合法（1.10.2 起不再要求第一张必须能出）
- 如果整批没有一张能压住牌堆顶 → `409 illegal_play`
- 批量牌仍必须同一 `value`；混合点数 → `409 mixed_batch`
- 对 +2 / +4 / 禁止的多张叠加不变：整批张数参与效果倍率
- 最终颜色仍只能是这批牌里出现过的颜色；万能牌仍可任选颜色

### 31.2 前端

- 点击一张本身压不住的牌时，如果它和已选牌同点数且已选牌里有一张能出，会加入批量选择；如果单独点它，会提示先选一张能压住牌堆顶的同点数牌
- 出牌按钮只在选择集包含至少一张能出的牌、且全部同点数时可用
- 颜色弹窗会包含抽到的牌的颜色

### 31.3 接口

- 没有新增接口；`POST /api/uno/rooms/{roomId}/play` 的合法性校验改为「整批至少一张可出」
- 错误码：`illegal_play`（整批都压不住）、`mixed_batch`（点数不同）

### 31.4 测试与版本

- 新增引擎 / 接口 / UI 测试：抽到红 1 + 原有黄 1 → 一起出并选红；整批都压不住会被拒绝
- 版本号全套同步到 `1.10.1`：`worker/index.js` 的 `VERSION` / `CHAT_VERSION` / `VIDEO_VERSION`、`worker/uno.js` 的 `UNO_VERSION`、`vtx-api.js` 的 `API_VERSION`、`vtx-markdown.js`、`chatroom.html` 的 `REQUIRED_API_VERSION`、各页 `<script src="...?v=1.10.1">`
- 运行：`cd worker && node test/uno.test.mjs && node test/uno-ui.test.mjs`
---

## 32. 1.10.2 更新：批量转色修复、生效玩家单选与 +4/+6 由目标选择

### 32.1 红 8 / 黄 4 转绿修复

- 问题：前端要求第一张选中的牌必须能压住牌堆顶；红 8 + 绿 8（或黄 4 + 绿 4）里绿牌本身压不住时，先点绿牌会被拒绝，导致无法转绿
- 修复：前端允许先选任意一张同点数牌，只要手里有同点数且能压住牌堆顶的牌；出牌按钮在批量里至少有一张合法牌时可用
- 服务端仍要求整批至少一张合法；整批都压不住返回 `409 illegal_play`
- 示例：牌堆顶红 9，手里红 8 + 绿 8 → 先点绿 8 或红 8 都可以，出牌后选绿，牌堆顶变绿 8；黄 4 + 绿 4 同理
- 新增服务端与 UI 回归测试

### 32.2 生效玩家改为单选

- +2 / +4 / 禁止的生效玩家改为单选
- 服务端传多个 `targets` → `409 bad_target`
- 前端弹窗从 checkbox 改为 radio，只能选一名
- 可选范围仍是接下来 1~2 名玩家或自己的队友之一

### 32.3 +4 / +6 由被选中的玩家选择

- 出牌者只选颜色和生效玩家，不再选择抽 4 张还是 6 张；旧字段 `drawAmount` 会被忽略
- 服务端创建 `game.pendingWild4`（出牌者、目标、颜色、张数、是否强制 +6），暂停牌局，不立即摸牌 / 推进回合
- 只有被选中的目标可以 `POST /api/uno/rooms/{roomId}/wild4`，body 为 `{ "drawAmount": 4 }` 或 `{ "drawAmount": 6 }`
  - 其他人调用 → `409 not_wild4_target`
  - 等待期间出牌 / 抽牌 / 过牌 → `409 pending_wild4`
- 目标选择后：摸 `drawAmount × +4 张数` 张牌，跳过下一次出牌，然后从出牌者位置推进回合并清空等待状态
- 响应：`autoUpgraded`、`wild4Draw`、`drawAmount`（总张数）、`drawnCount`
- 出牌者没有指定颜色（旧规则）时，目标选 +4 也按 +6 结算，并返回 `autoUpgraded: true`；直接选 6 不算自动升级
- 目标为机器人时，服务端自动选 4（缺色则 6），不需要真人操作
- +4 作为最后一张牌时，出牌者直接获胜，不进入等待选择
- 视图字段：`game.pendingWild4`（所有玩家可见的出牌者 / 目标 / 颜色 / 张数）、`me.wild4Choice`（仅目标可见，含 `forcedSix`）
- 前端：被 +4 的玩家看到「抽 4N 张 / 抽 6N 张」按钮，其他人看到「等待 X 选择」；等待期间出牌 / 抽牌 / 过牌禁用
- SDK：新增 `VTXApi.uno.wild4(roomId, drawAmount)`

### 32.4 测试与版本

- 新增：+4 等待目标选择、非目标不能选、等待期间不能出牌、目标选 4/6、缺色自动 +6、多张 +4 翻倍、机器人自动选择、+4 最后一张直接获胜
- 新增：+2 / +4 / 禁止多目标被拒绝；前端 radio 单选
- 新增：红 8 + 绿 8 / 黄 4 + 绿 4 转绿，先点任意一张均可
- 版本号全套同步到 `1.10.2`：`worker/index.js` 的 `VERSION` / `CHAT_VERSION` / `VIDEO_VERSION`、`worker/uno.js` 的 `UNO_VERSION`、`vtx-api.js` 的 `API_VERSION`、`vtx-markdown.js`、`chatroom.html` 的 `REQUIRED_API_VERSION`、各页 `<script src="...?v=1.10.2">`
- 运行：`cd worker && node test/uno.test.mjs && node test/uno-ui.test.mjs`
