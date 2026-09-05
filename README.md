# KataBump 自动续期（GitHub Actions）

通过 GitHub Actions 定时登录 [KataBump](https://dashboard.katabump.com) 自动完成服务器 **Renew** 续期，支持多账号、代理池（VMess / Socks5 / HTTP / 订阅）、Cloudflare Turnstile 与 ALTCHA 验证码自动处理、Telegram 实时通知。

> 仓库中另有一个旧版 workflow `renew.yml`（跑 `action_renew.js`），功能与本 workflow 重复，建议在 Actions 页面禁用其中一个，避免重复续期。

## 工作流程

- 每天 UTC 23:28（北京时间 07:28）自动运行（错开整点，减少 GitHub 定时任务延迟），也可在 Actions 页面手动触发（可勾选 debug 模式）
- 登录（自动过 Cloudflare Turnstile）→ 进入服务器续期页 → 点击 Renew → 处理 ALTCHA 验证码 → 确认续期
- 站点续期周期为 **每 4 天一次**，未到续期窗口时网站会返回下次可续期日期，脚本自动记录并每日重试，无需人工干预
- 续期结果写入 `renew_dates.json` 并自动 commit 回仓库

## Secrets 配置

仓库后台 → **Settings** → **Secrets and variables** → **Actions**，依次添加以下变量。

### 一、核心必填

#### `USERS_JSON`

账号配置信息（JSON 格式，支持多账号）：

```json
[
  { "username": "邮箱", "password": "密码", "serverId": "123456" },
  { "username": "邮箱", "password": "密码", "serverId": "234567" }
]
```

**`serverId` 注意事项（重要）**：必须填服务器详情页 URL 中 `?id=` 后面的**数字 ID**
（例如 `https://dashboard.katabump.com/servers/edit?id=123456` 中的 `123456`），
**不是**服务器页面上显示的那串十六进制 Identifier。
填错（填成 Identifier）会被网站静默重定向回首页——脚本已支持自动回落到服务器列表路径，
但同一账号下有多台服务器时，列表路径只会进入第一台，请务必填对数字 ID。

#### `SUB_URL` / `PROXY_URL` / `S5_URL` / `HTTP_PROXY`（可选）

代理源，填任意一个即可，脚本会智能识别类型。不配置则直连。支持以下任意格式：

| 格式 | 示例 |
|------|------|
| VMess 分享链接 | `vmess://…`（直接粘贴 v2rayN 等客户端生成的分享链接） |
| Clash/Mihomo 订阅链接 | `https://example.com/api/subscribe?token=...`（返回含 `proxies:` 的 YAML） |
| Socks5 代理 | `socks5://user:pass@host:port` |
| HTTP(S) 代理 | `https://user:pass@host:port`（TLS 封装的 HTTP 代理） |
| Telegram 代理 | `https://t.me/socks?server=..&port=..&user=..&pass=..` |
| 纯文本节点列表 | `IP:PORT:USER:PASS`，每行一个，可带标题行 |
| Base64 订阅体 | 上述任意内容的整体 Base64 |

节点会先进行健康检查与测速，按账号轮换使用；节点全部失效时自动降级直连。

> 提示：机房 IP 可能触发 Cloudflare 盾，建议使用干净一点的节点。

### 二、通知（可选）

| 变量 | 说明 |
|------|------|
| `TG_BOT_TOKEN` | Telegram Bot Token |
| `TG_CHAT_ID` | 接收通知的 chat ID（个人 / 频道 / 群组） |
| `TG_THREAD_ID` | 群组内话题 ID，不需要可留空 |

### 三、调试（可选）

| 变量 | 说明 |
|------|------|
| `DEBUG` / `DEBUG_SCREENSHOT` | 设为 `true` 开启；手动触发时勾选 `debug` 输入等效 |

开启后关键步骤（登录、Renew 弹窗等）会截图并实时推送到 Telegram，便于排查。

## Telegram 通知类型

- ✅ **续期成功**：含更新后的有效期与剩余天数
- ⏳ **未到续期时间**：含下次可续期日期（脚本已记录，到点自动续）
- ❌ **失败**：登录失败、找不到入口等异常

## 常见问题

- **日志提示"未找到 Renew 按钮"**：多数情况是未到续期窗口（每 4 天开放一次），脚本会每日重试；若长期不出现，请核对 `USERS_JSON` 的账号与 `serverId` 是否匹配、是否为数字 ID。
- **日志提示"未能识别出代理节点，将直接使用默认网络"**：代理源格式不被识别（旧版本），当前版本已支持 VMess 与带凭据代理 URL；若仍出现请检查 `SUB_URL` 内容是否为上表所列格式。
- **想看现场**：手动触发 workflow 并勾选 `debug`，或设置 `DEBUG` secret 为 `true`，截图会推送到 Telegram。

## 隐私说明

- 代理节点在 Actions 日志中只以「类型-序号」显示（如 `VMess-1`、`HTTP-2`），**不会**泄露分享链接备注、服务器地址或 UUID
- 订阅内容、mihomo 完整日志不会输出到 Actions 日志（失败时仅打印日志末 40 行）
- `renew_dates.json` 中的账号以脱敏形式记录（如 `ea***@hotmail.com`），不含完整邮箱
