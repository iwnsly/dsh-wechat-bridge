# DSH ↔ 微信 ClawBot 桥接（带配置网页）

把「DeepSeek Harness Web」的对话接到**微信官方 ClawBot**（ilink 协议），**免部署 OpenClaw**。
内置配置网页，可完成：微信扫码绑定/解绑、配置默认会话、实时监控服务状态、查看最近日志。

配套的代码级文档见同目录 **[代码说明.md](./代码说明.md)**。

## 架构

```
微信 App（官方 ClawBot 插件）
      ↕ iLink 协议（ilinkai.weixin.qq.com，腾讯官方服务器）
control.mjs   控制服务：扫码绑定 → 长轮询收消息 → 路由到 DSH → 回发消息
      │   ├── 配置网页 http://127.0.0.1:3083（绑定/默认会话/监控/日志）
      │   ├── POST /api/session.prompt + 轮询 session.history（阶段回复/同步推送）
      │   └── RPC：session.create|prompt|cancel|history|list、workspace.* 等
DeepSeek Harness Web（127.0.0.1:3080，即 DSH 网页）
```

路由规则：**单默认会话**。微信消息进入「默认会话」（可随时切换）；绑定会话里由 DSH 网页端发起的对话，其回复也会**反向同步推送**到微信。

## 目录结构

```
wechat-bridge/
├── control.mjs         主服务（单文件）：微信 Bot + DSH 客户端 + 配置网页 + 同步推送
├── index.html          配置网页（状态卡片/微信绑定/默认会话/会话列表/最近日志）
├── dsh-bridge.mjs      [备用] Anthropic /v1/messages 兼容适配器（独立进程版）
├── wechat-bot.mjs      [备用] 独立微信 Bot（默认对接 dsh-bridge.mjs）
├── package.json        npm start = node control.mjs
├── config.json         DSH 地址 + 微信登录态(botToken) + 默认会话（权限 600，重启免扫码）
├── state.json          微信发送凭证(context_token) 持久化：桥接重启后同步推送不中断
├── logs/
│   ├── control.out.log 运行日志（消息/阶段回复/同步推送全链路可查）
│   └── control.err.log 异常输出
└── README.md / 代码说明.md
```

## 前置条件

- Node.js ≥ 18（本机已装 v24）。
- 微信 App 已支持「ClawBot」插件（官方推送，部分版本/地区灰度）。
- DeepSeek Harness Web 正在运行（`http://127.0.0.1:3080`）。

## 快速开始

```bash
cd /Users/macbot/Documents/dp-remote/wechat-bridge
npm start                 # 等价 node control.mjs
```

打开 **http://127.0.0.1:3083**：

1. **微信绑定**：点「绑定微信」→ 手机微信扫码并确认授权 → 自动开始监听。
2. **默认会话**：下拉选择微信消息进入的 DSH 会话（也可在微信里用「切换对话」命令切换）。
3. **会话列表**：展示全部会话（标题/ID/状态），15 秒自动刷新，与微信切换命令同清单。

## 微信命令

| 你发的内容 | 效果 |
|---|---|
| `切换对话`（兼容旧叫法 `切换会话`） | 返回会话清单（编号 + 标题 + 「当前」标记） |
| `1`（清单编号） | 切换微信当前会话到该 DSH 会话 |
| `0` | 先回工作区清单，选编号后在该工作区**新建对话窗口**并切换 |
| `新对话`（兼容 `新建对话`） | 直接列工作区清单，选择后**新开对话窗口**并切换 |
| `取消`（执行中） | 停止当前任务：中断 DSH 生成并回「⏹ 已取消当前对话的执行」 |
| `取消`（待选状态） | 放弃切换，继续当前会话 |

语音友好：命令匹配自动去标点、兼容口语变体、编号支持中文数字（「二」=2）。
清单过滤已归档与空白会话，按最近活跃排序；切换结果写入并持久化默认会话。

## 功能特性

- **收到回执**：每条交给 DSH 的消息先回「✅ 已收到，开始处理…」；微信渠道超过 2 小时没消息时，回执附带当前**工作区名 + 会话名**。
- **阶段回复（流式）**：DSH 每完成一个生成步骤（`assistant/message` 定稿）就立即把该步文本发到微信，不用等全部生成完；最终文本若已随阶段发出则不重复发送。发送失败不记"已送达"，最终回复自动补发——**内容不丢**。
- **30 秒状态**：距上次发到微信的消息超过 30 秒才发「⏳ 正在处理中…（已等待 N 秒）」，N = 从发消息起的**总等待时间**；每发一条消息都重新计时，有回复在回就不刷状态。
- **取消执行**：执行中发「取消/停/停止/算了」→ `session.cancel` 中断当前生成并回执。
- **错误与停止兜底**：DSH 端报错/中断（error/aborted/interrupted）把原因发回微信；轮询连续失败且持续 ≥4 秒判定 DSH 失联，立即停止轮询并发送「DSH 服务似乎已停止或报错」。
- **绑定会话回复同步**：默认会话里由 **DSH 网页端发起**的对话，每步回复（含最终结果、出错/中断提示）也同步推送到微信；与微信任务共用会话级游标，**每条只发一次**；凭证持久化（`state.json`），重启不丢。推送到最近联系过的微信用户。
- **语音消息**：优先用平台自带转写文本（`voice_item.text`）当文字对话；无转写时明确提示。
- **媒体保存**：图片/文件/视频自动下载 + AES 解密，存到默认会话工作区 `wechat-media/<YYYYMMDD>/`，回发保存路径；之后可用文字让机器人继续处理。
- **优雅停机**：收到停止信号时，在途任务先把「⚠️ 服务正在升级重启，本条任务已被中断」发回微信再退出——部署重启不再静默丢回复。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `3083` / `127.0.0.1` | 配置网页监听地址 |
| `DSH_URL` | `http://127.0.0.1:3080` | DSH Web 地址 |
| `CONFIG_PATH` | `./config.json` | 配置持久化文件 |
| `TURN_TIMEOUT_MS` / `POLL_MS` | `600000` / `500` | 回复等待超时 / 轮询间隔 |

数据文件：
- `config.json`：DSH 地址、微信登录态（`botToken`，权限 600）、`defaultSessionId` 默认会话。
- `state.json`：微信发送凭证（`peerTokens` / `lastActivePeer`），桥接重启后同步推送仍可用。

## 管理接口

| 接口 | 说明 |
|---|---|
| `GET /` | 配置网页（index.html） |
| `GET /api/status` | DSH 可达性、Bot 状态、消息数、错误数 |
| `GET /api/sessions` | 从 DSH 列出所有会话 |
| `GET /api/config` / `POST /api/config` | 读取 / 设置默认会话 |
| `POST /api/bind` / `POST /api/unbind` | 微信绑定 / 解绑 |
| `GET /api/logs` | 最近日志（网页「最近日志」面板） |

## 部署与自启（launchd）

已注册两个 macOS 自启任务（`~/Library/LaunchAgents/`，均可用 `launchctl print gui/$(id -u)/<label>` 查看状态）：

| Label | 内容 | 日志 |
|---|---|---|
| `com.macbot.dsh-wechat-bridge` | 运行本桥接（`node control.mjs`），崩溃自动重启 | `wechat-bridge/logs/control.{out,err}.log` |
| `com.macbot.dsh-web` | 登录时自动拉起 `dsh web --no-open`；**带 3080 端口预检**（DSH 已在跑则跳过），仅在进程崩溃时重启（防端口冲突死循环） | `~/.dsh/logs/dsh-web.{out,err}.log` |

常用命令：

```bash
launchctl kickstart -k gui/$(id -u)/com.macbot.dsh-wechat-bridge   # 重启桥接（重新加载代码）
launchctl print gui/$(id -u)/com.macbot.dsh-wechat-bridge          # 查看任务状态
```

> ⚠️ 重启桥接会中断在途任务，但优雅停机会在微信里发中断通知；升级/改配置建议挑空闲时进行。

## 故障排查速查

| 现象 | 处理 |
|---|---|
| 微信收到阶段消息但**没有最终回复** | 查日志最后一行是否为「已回复/本轮无最终回复」；多为部署重启打断——优雅停机下你会收到「任务被中断」通知，重发即可 |
| 日志：「同步推送待发送：尚无微信发送凭证」 | 在微信发一条消息即可（凭证会持久化） |
| 日志：「DSH 服务似乎已停止或报错」 | 检查 127.0.0.1:3080 的 DSH web 是否在跑 |
| 日志：「微信登录过期，已自动解绑」 | 重新扫码绑定（iLink 平台正常现象） |
| 收不到任何消息 / 服务疑似崩溃 | 看 `logs/control.err.log`；`launchctl print gui/$(id -u)/com.macbot.dsh-wechat-bridge` |
| 想确认某条回复是否发出 | 日志里搜「收到消息 / 阶段回复已发送 / 同步推送已发送 / 已回复」对应时间点 |

## 备用（独立进程版）

`dsh-bridge.mjs`（Anthropic 兼容 `/v1/messages` 适配器）+ `wechat-bot.mjs`（独立微信 Bot）仍保留，适合拆开部署、或把 DSH 当通用 Anthropic 端点复用：

```bash
node dsh-bridge.mjs     # 监听 127.0.0.1:3081
node wechat-bot.mjs     # 独立的扫码/监听 Bot
```

## 注意事项

- DSH 的 `/api` 只监听回环地址、无鉴权，control.mjs 必须与 DSH **同机运行**；配置网页默认只监听 `127.0.0.1`，勿暴露公网。
- 微信与网页同时发消息时按 `queue` 模式排队依次处理。

## 开发与维护（Git）

仓库：`https://github.com/iwnsly/dsh-wechat-bridge`

**敏感文件保护**（已写入 `.gitignore`，勿强行 `git add -f` 提交）：

| 文件 | 内容 | 是否入库 |
| --- | --- | --- |
| `config.json` | 微信 botToken 登录态 | ❌ 排除 |
| `state.json` | 微信 context_token 发送凭证 | ❌ 排除 |
| `logs/` | 运行时日志 | ❌ 排除 |
| `config.example.json` | 配置示例（占位符） | ✅ 提交 |

**日常更新流程**（改完代码 → 推送）：

```bash
cd /Users/macbot/Documents/dp-remote/wechat-bridge
git add -A            # 或 git add <具体文件>
git commit -m "feat: 说明本次改动"
git push              # 推送 origin/main
```

- 改动涉及运行中进程时，先 `node --check control.mjs` 再按部署纪律重启（见「部署与自启」）。
- 新增运行时依赖若改动了 `package.json`，记得一并提交。
- 用 `gh auth login` 或系统钥匙串免密推送；也可改用 SSH：`git remote set-url origin git@github.com:iwnsly/dsh-wechat-bridge.git`。
- 每次扫码 Bot ID 会变，属 iLink 平台正常现象；登录态存 `config.json`（600），重启免扫码。