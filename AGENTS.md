# omp-dingtalk — Agent 配置引导手册

**这份 README 是写给执行 agent（大模型）看的**，不是给人看的操作手册。你（agent）被要求"把 omp 接入钉钉 / 配钉钉通知 / 远程控制 omp / 排查 omp-dingtalk 插件"时，按本手册引导用户完成配置。人读的版本见 `README.md`。

核心目标：让用户最少做决定、最快跑通，同时默认走安全配置。**不要把选项一股脑倒给用户让他自己挑**——那是人的文档做的事。

---

## 0. 先建立心智模型（3 个东西）

钉钉这边有两条独立的通道，互相不依赖，可以只配一条：

| 通道 | 是什么 | 能做什么 | 需要什么 | 限制 |
| --- | --- | --- | --- | --- |
| **出站 webhook** | 群里加的**自定义机器人** | **只发群**，发不了私聊 | 一个 Webhook 地址（+ 可选 SEC 密钥） | 20 条/分钟，超了封 10 分钟 |
| **出站 direct** | **企业内部应用机器人**（OpenAPI 1:1） | **只发单聊** | ClientID/Secret + robotCode + 收件人 userId | 单聊推送，不占 webhook 限流 |
| **入站 Stream** | 企业内部应用的机器人，**客户端主动拨 WebSocket** | **能收消息**（控制 omp） | ClientID/Secret | 自定义机器人**天生只能发不能收** |

三条铁律，记牢就不会配错：

1. **自定义机器人只能发群、不能收消息。** 想"控制 omp"（发文字下指令、审批）就必须配**企业内部应用** + Stream 模式。
2. **出站 webhook 和出站 direct 互斥选择**，用 `outbound.mode` 切：`webhook`（默认，发群）/ `direct`（私聊）/ `both`。
3. **入站 Stream 和出站 direct 共用同一套企业内部应用凭据**。配了 direct 出站，就顺带有了 Stream 的基础；但 Stream 还要单独在 omp 里 `/dingtalk takeover` 才接通（除非 `autoTakeover: true`）。

---

## 1. 引导决策：先问最少的，一次问完

**第一步先搞清楚用户想要哪种，不要让他自己研究通道。** 用一个问题定位：

> "你希望只收到 omp 的通知（跑完提醒我），还是也要能远程控制它（人不在电脑前，从钉钉发指令 / 审批）？"

然后按表选**推荐配置**，直接给出方案，别问第二个问题：

| 用户想要的 | 推荐方案 | 你要让用户准备的 | 配置要点 |
| --- | --- | --- | --- |
| 只收通知，发**群里** | webhook | 群自定义机器人 Webhook URL | `outbound.mode: webhook`（默认） |
| 只收通知，发**私聊** | direct | 企业内部应用 ClientID/Secret + robotCode | `outbound.mode: direct`（收件人 = `control.allowUserId`） |
| 也要**远程控制** | direct + Stream | 企业内部应用 ClientID/Secret + robotCode | `outbound.mode: direct` + `stream` 全填 + `autoTakeover` |

**私聊收件人的 userId** 不用一开始就抄——配置完能跑后，让用户在单聊给机器人发 `/whoami`，返回值就是 userId，再填进 `control.allowUserId`。这是最不容易抄错的路。

**安全默认（agent 直接按这个引导，不要问）：**
- `control.scope: "direct"` —— 只认单聊，群聊一律不理（防误触）。
- `control.autoTakeover: false` —— 会话启动不自动接管，用户明确 `/dingtalk takeover` 才接通；已接管的会话不会因新会话启动而松开（接管是显式状态，只有被别的会话抢占或 `/dingtalk release` 才解除）。
- `control.allowUserId` 必填，只填一个人 —— 他既是白名单（**留空 = 拒绝一切指令，fail-closed**），也是单聊推送的唯一收件人。引导用户用 `/id` 拿到 ID 后填入。
- 通知走私聊优先 `direct`（不打扰群），但要有企业内部应用。

---

## 2. 获取凭据的分步引导

用户在你的引导下自己操作钉钉后台（你无法登录钉钉），然后**把拿到的值回填给你**。按通道引导，每步告诉他做什么、回报什么：

### 通道 A：群自定义机器人（webhook 出站）
1. 用户：钉钉群 → 群设置 → 智能群助手 → 添加机器人 → 自定义机器人 → 起名。
2. 安全设置选一种，**优先"加签"**：
   - 加签 → 复制 `SEC` 开头的密钥 → 填 `webhook.secret`。
   - 或自定义关键词（如 `omp`）→ 填 `webhook.keyword`。
3. 用户回报：Webhook URL（`https://oapi.dingtalk.com/robot/send?access_token=xxx`）+ SEC 密钥（若有）。

### 通道 B：企业内部应用（direct 出站 + Stream 入站）
1. 用户：钉钉开放平台 → 开发者后台 → **创建企业内部应用**，记下 **ClientID（AppKey）** 和 **ClientSecret（AppSecret）**。
2. 用户：应用能力 → 添加应用能力 → **机器人**，接收消息模式选 **Stream 模式**，然后**发布应用**（不发布 Stream 连不上）。
3. 用户回报：ClientID、ClientSecret、机器人详情页的 **robotCode**（`ding` 开头）。
4. 单聊使用：不用把机器人加进任何群，直接私聊发消息。要用群聊才把机器人加群并改 `control.scope`。

---

## 3. 安装

```bash
omp plugin link <插件绝对路径>
```

验证（期望无 error、列表里有 `omp-dingtalk@0.1.0`）：
```bash
omp plugin doctor
omp plugin list
```

**Windows 普通用户**建不了符号链接，`link` 会留空目录。用目录联接替代（README.md 第 2 节有现成命令）。

---

## 4. 写配置

复制样例到用户级配置再填：
```bash
cp config.example.json ~/.omp/dingtalk.json && chmod 600 ~/.omp/dingtalk.json
```

样例里 `webhook.url` 与 stream 凭据都是**空的**，开箱状态就是「未配置」——`chmod 600` 是因为文件里要放密钥；`doctor` 会列出还缺什么，不会出现一个看着像已配置的假地址。

配置查找顺序（后者覆盖前者）：内置默认 → `~/.omp/agent/dingtalk.json` → `~/.omp/dingtalk.json` → `<项目>/.omp/dingtalk.json` → 环境变量。改完**开新会话生效**，不用重启。

凭据不想落盘用环境变量（README.md 第 4 节有完整清单），常见几个：`DINGTALK_WEBHOOK_URL`、`DINGTALK_CLIENT_ID`、`DINGTALK_CLIENT_SECRET`、`DINGTALK_ROBOT_CODE`、`DINGTALK_ALLOW_USER_ID`、`DINGTALK_AUTO_TAKEOVER`。

**只给某个项目配**：放 `<项目>/.omp/dingtalk.json`，只覆盖要改的字段。

**推荐组合（agent 直接给这个模板，删掉注释按用户回报填）：**

```json
{
  "outbound": { "mode": "direct" },
  "stream": {
    "enabled": true,
    "clientId": "用户ClientId",
    "clientSecret": "用户ClientSecret",
    "robotCode": "用户RobotCode"
  },
  "control": { "scope": "direct", "autoTakeover": false, "allowUserId": "用户Id" },
  "approval": { "mode": "off" },
  "notify": { "sessionStop": true, "errors": true }
}
```

- 只想发群不要私聊 → `outbound.mode` 改 `webhook`，填 `webhook.url`/`webhook.secret`，`stream` 可不配。
- 想要会话一启动就自动接管（长任务里的提问能手机答）→ `autoTakeover: true`。

### 4.1 遇到旧配置就直接迁移

旧版有两个字段：`control.allowUserIds`（数组，指令白名单）和 `outbound.directUserIds`（数组，推送收件人）+ `outbound.learnFromInbound`。新版合并成**一个字符串** `control.allowUserId`——填的这一个人既能下指令，也是唯一收到单聊推送的人。用户配置里见到旧字段就按表改（写配置属于你可以直接做的事）：

| 旧字段 | 处理 |
| --- | --- |
| `control.allowUserIds: ["a", "b"]` | 取第一个，写成 `control.allowUserId: "a"`，删掉原键 |
| `outbound.directUserIds: [...]` | 删掉。`control.allowUserId` 为空时取这里的第一个值填进去（收件人就是这个字段） |
| `outbound.learnFromInbound` | 删掉，功能已移除 |

`outbound.mode` 保持不变。环境变量 `DINGTALK_ALLOW_USER_IDS`（逗号分隔）改成 `DINGTALK_ALLOW_USER_ID`（单值）。

代码对旧文件有兜底：读不到 `control.allowUserId` 时回退读旧键的第一个值并打告警，所以漏改不会让机器人变成「谁都不理」；但旧键留着会一直告警，要清掉。`bun run doctor` 也会提示。

---

## 5. 验证（配置自检，不需要模型凭据）

```bash
cd <插件绝对路径>
bun run doctor
```

它会：读配置 → **真发一条测试消息**（群/单聊）→ **真连 Stream**。失败时自动翻译钉钉错误码（`310000` 加签/关键词错、`300001` token 失效、`410100` 限流、`403` direct 缺权限/收件人不可见）。

**关键理解**：`doctor` 全绿只代表"能发出去、能连上"，不代表"能收到消息"。钉钉不保证推 `REGISTERED` 帧，连上没收到不代表坏。**最终验证入站**用：

```bash
bun run watch          # 连 Stream 打印每一帧，默认 20 秒
```

让用户去给机器人发一条消息，终端打出帧才算真通。

**全绿后收尾**：让用户在**单聊**给机器人发 `/whoami`（`/id`、`我是谁` 也行），把返回的 `senderStaffId` 填进 `control.allowUserId`。这条指令**在白名单之前就能用**——首次接入还没进白名单也能拿到自己的 ID。

---

## 6. 排查速查（现象 → 判断，别瞎试）

| 现象 | 判断 / 做法 |
| --- | --- |
| 一条通知都没有 | 先 `bun run doctor`。若 doctor 全绿 → 多半是 `notify.onlyWhenTakenOver: true` 而还没 `/dingtalk takeover`（设计行为，不是故障） |
| 设了 direct 却单聊收不到 | ① `stream.robotCode` 填没填 ② `control.allowUserId` 是否为空 ③ 应用有没有**机器人发送消息**权限、收件人在不在可见范围 |
| 通知发到了群里（想要私聊） | `outbound.mode` 没改成 `direct`。自定义机器人只能发群 |
| 群里 @ 机器人没反应 | 默认 `scope: "direct"` 就是不理群聊。要群聊得改 `group`/`all` |
| 钉钉发消息没反应 | ① `stream.enabled` 是否 true ② 有没有 `/dingtalk takeover` ③ 群聊是否 @ 了 ④ 应用有没有**发布** ⑤ `bun run watch` 发一条看帧 |
| 每个新会话都要重新 takeover | 旧版本的「接管不跨会话继承」已废弃。接管现在是显式状态：`/dingtalk takeover` 后跨会话保留，新会话启动不会松开，只有被别的会话抢占或 `/dingtalk release` 才解除 |
| 子代理退出时收到「omp 已退出」 | 已修复。子代理（共享同一进程模块、session id 不同）的 `session_start`/`session_shutdown` 会按会话 id 被忽略，不推退出卡、不拆主会话的桥。若再出现，先确认跑的是新版插件 |
| 收到"钉钉接管已被抢占" | 另一个会话在同一钉钉应用上 takeover 了。想抢回就在本会话再 takeover |
| 命令回复延迟几秒 | 正常，出站限流最短间隔 2.2 秒 |
| 改了配置没生效 | 配置会话启动时重载，开新会话。`/dingtalk status` 会列实际生效的来源 |

---

## 7. Agent 自动化边界（什么直接做、什么必须问）

**你可以直接做（不用问）：**
- 复制 `config.example.json` 到 `~/.omp/dingtalk.json`，写配置。
- 跑 `bun run doctor` / `bun run watch` / `omp plugin doctor` 并解析输出。
- 解析钉钉错误码给出下一步。
- 生成推荐配置模板。

**你必须让用户做（你无法代劳）：**
- 在钉钉后台建机器人 / 建企业内部应用 / 选 Stream 模式 / 发布应用 / 把机器人加群。你只能给步骤、收回报值。
- 在钉钉里发 `/whoami` 拿 userId（你操作不了用户手机）。
- 在 omp 终端执行 `/dingtalk takeover`（那是用户的会话）。

**填凭据时**：任何 key / secret 都由用户口头提供，你只负责写进配置文件或环境变量，不凭空捏造。写完后自己读文件验证（注意 Hermes 会把 key 脱敏显示，用长度校验，别被脱敏骗了）。