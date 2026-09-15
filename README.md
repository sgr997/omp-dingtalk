# omp-dingtalk

把 OMP 接到钉钉上：**它跑长任务时给你发通知，你不在电脑前也能指挥它。**

- **出站（通知）**：会话启动、本轮跑完变空闲、需要审批、重试耗尽、凭据失效 → 钉钉消息。
- **入站（控制）**：在钉钉里发文字就能给 omp 下指令、批准/拒绝敏感操作、中断执行、切模型、压缩上下文。
- **双端提问**：模型用「提问（ask）」工具问你问题时，终端和钉钉**同时**弹出，在任意一端作答都算——长任务不会因为没人回答而卡住，你也不会被手机抢走键盘。

零运行时依赖，只用 Node/Bun 内置能力（`node:crypto`、全局 `fetch`、全局 `WebSocket`），所以 `omp plugin link` 之后不需要再跑 `bun install`。

---

## 1. 钉钉侧准备

入站和出站互相独立，可以只配一条。

### 通道 A — 出站通知（至少配一条）

出站有两条**完全不同**的路，用 `outbound.mode` 选：

| mode | 走哪条路 | 能发到哪 | 需要什么 |
| --- | --- | --- | --- |
| `webhook`（默认） | 群里的**自定义机器人** | **只能发群**，没法私聊 | 一个 Webhook 地址 |
| `direct` | **企业内部应用机器人**（OpenAPI 1:1 推送） | 只发**单聊**，不进群 | 通道 B 的 ClientID/Secret + `robotCode` + 收件人 |
| `both` | 两条都发 | 群 + 单聊 | 上面两套都要 |

> 想要「**只在单聊里收通知，不往群里发**」→ 设 `outbound.mode: "direct"`。
> 关键限制：**自定义机器人天生只能发群**，它没有私聊能力；私聊推送只能走 `direct`，而 `direct` 依赖通道 B 的企业内部应用。

**走 `webhook`（默认，5 分钟）**

在钉钉群里加一个**自定义机器人**：

> 群设置 → 智能群助手 → 添加机器人 → 自定义机器人 → 起个名字

安全设置三选一，推荐**加签**：

| 方式 | 做法 | 配置到 |
| --- | --- | --- |
| **加签**（推荐） | 复制 `SEC` 开头的密钥 | `webhook.secret` |
| 自定义关键词 | 设一个词，比如 `omp` | `webhook.keyword`（插件会自动带上） |
| IP 白名单 | 填公司出口 IP | 无需额外配置 |

拿到 Webhook 地址（形如 `https://oapi.dingtalk.com/robot/send?access_token=xxx`），填进 `webhook.url`。样例配置里这一项默认留空——留空即未配置，`doctor` 会直接告诉你缺什么，不会假装能发。

> ⚠️ 自定义机器人有 **20 条/分钟** 的硬限制，超了会被封 10 分钟。插件已经内置保守限流（15 条/分钟、最短间隔 2.2 秒）和同 key 合并，正常使用不会触发。

**走 `direct`（单聊推送）**

先把通道 B 建好（要 `clientId` / `clientSecret` / `robotCode`），然后：

```json
{
  "outbound": { "mode": "direct" }
}
```

- 收件人不用单独配：`control.allowUserId` 里那一个人**既是唯一能下指令的人，也是唯一收到推送的人**。填的值就是 `senderStaffId` —— 给机器人发 `/whoami` 就能拿到（`/id` 是别名）。
- 也就是说白名单为空时单聊通道同样没有收件人：先在单聊发一次 `/whoami`，把返回的 ID 填进 `control.allowUserId` 即可。
- 应用侧还需要**机器人发送消息**权限，且收件人在应用的可见范围内；不满足会返回 403，`bun run doctor` 会把这条列出来。
- 走 `direct` 时**不受**自定义机器人 20 条/分钟的限制。

### 通道 B — 入站控制（想要「我控制它」就必配）

自定义机器人**只能发不能收**，要能收消息必须用 **Stream 模式**：

1. 进入 [钉钉开放平台](https://open.dingtalk.com) → 开发者后台 → **创建企业内部应用**。
2. 记下 **ClientID**（即 AppKey）和 **ClientSecret**（即 AppSecret）。
3. 应用能力 → **添加应用能力 → 机器人**，机器人接收消息模式选 **Stream 模式**，然后**发布应用**。
4. 决定在哪跟它说话：
   - **只用单聊**（推荐，也是默认）：不用把机器人加进任何群，**在单聊里直接发消息**即可。要能收到单聊推送的话，在机器人详情页复制 **robotCode**（`ding` 开头）填进 `stream.robotCode`。
   - 要用群聊：把机器人**加进你要用的群**，并把 `control.scope` 改成 `group` 或 `all`。
5. 把 ClientID / ClientSecret 填进 `stream.clientId` / `stream.clientSecret`。

**为什么用 Stream 模式**：它是客户端主动往外拨 WebSocket，不需要公网 IP、不需要端口映射、不需要注册回调地址 —— 公司内网、代理后面都能用。如果公司走 HTTP 代理，给 omp 进程设置 `HTTPS_PROXY` 即可。

> **群聊里机器人需要被 @** 才会把消息推给你（插件默认也只在被 @ 时响应，`control.requireAt`）。**单聊不需要 @**。
>
> 默认 `control.scope = "direct"`：**只认单聊，群里 @ 机器人也一律不理**。想开放群聊得显式改 `scope`。

---

## 2. 安装

```bash
omp plugin link <本插件的绝对路径>
```

验证：

```bash
omp plugin doctor     # 期望：0 errors
omp plugin list       # 期望看到 omp-dingtalk@0.1.0
```

<details>
<summary>Windows 上 <code>link</code> 创建软链接失败怎么办</summary>

普通用户没有创建符号链接的权限，`omp plugin link` 会留下一个**空目录**，插件看起来装了其实没生效。用**目录联接**（junction，不需要管理员）替代：

```powershell
$link = "$env:USERPROFILE\.omp\plugins\node_modules\omp-dingtalk"
Remove-Item $link -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Junction -Path $link -Target "<本插件的绝对路径>"
```

之后 `omp plugin doctor` 应该显示 `plugin:omp-dingtalk` 为绿色。
</details>

---

## 3. 配置自检（填完凭据先跑这个）

不用启动 omp、不需要模型凭据，就能确认配置对不对：

```bash
cd <本插件的绝对路径>
bun run doctor
```

它会做三件事：

| 阶段 | 做什么 | 失败时告诉你 |
| --- | --- | --- |
| `[1/3] 读取配置` | 列出实际生效的配置和它来自哪个文件（密钥已脱敏） | 没找到配置文件、字段互相矛盾 |
| `[2/3] 出站通道` | 按 `outbound.mode` **真发一条测试消息**（群 / 单聊），验证全链路 | webhook 侧翻译错误码（`310000` 加签/关键词不对、`300001` token 失效、`410100` 被限流）；单聊侧提示缺 `robotCode`、没权限、userId 填错 |
| `[3/3] 入站通道` | **真去钉钉网关换取 Stream 接入点**并建立 WebSocket（连上即说明凭据有效） | ClientID/Secret 错、应用没发布、代理拦截 |

参数：

```bash
bun run doctor --no-send       # 只验入站，不往群里发测试消息
bun run doctor --stream-only   # 只验入站
```

还有一个用来确认「**真的能收到消息**」的工具：

```bash
bun run watch          # 连上 Stream 并把每一帧原样打印出来，默认抓 20 秒
bun run watch 60000    # 抓 60 秒
```

跑起来之后去群里 @机器人 发一条，终端会打印原始帧和解出来的内容。这是验证入站通道的最终手段。

> 钉钉**不一定会推 `REGISTERED` 帧**。连上却没有收到它，不代表配置有问题——只有真收到消息帧才算通。`bun run doctor` 已经把「能连上」判定为通过。

全绿之后就照它结尾的提示做：群里 `@机器人` 发 `/whoami`，把返回的 `senderStaffId` 填进 `control.allowUserId`。


<details>
<summary>不想用插件系统？直接挂到 config.yml</summary>

在 `~/.omp/agent/config.yml` 里加一行：

```yaml
extensions:
  - <本插件的绝对路径>/src/index.ts
```

编辑源码后新会话会自动重载（加载器带 mtime 缓存失效）。
</details>

---

## 4. 配置

复制样例到用户级配置，然后填凭据（每个字段都有中文注释）：

```bash
cp config.example.json ~/.omp/dingtalk.json
```

**配置查找顺序**（后者覆盖前者）：内置默认值 → `~/.omp/agent/dingtalk.json` → `~/.omp/dingtalk.json` → `<项目>/.omp/dingtalk.json` → 环境变量。

- 指定单个文件：`OMP_DINGTALK_CONFIG=/path/to/dingtalk.json`
- 调限流：`OMP_DINGTALK_MIN_GAP_MS`（默认 2200）、`OMP_DINGTALK_MAX_PER_MIN`（默认 20）。
- 调接管：`OMP_DINGTALK_HEARTBEAT_MS`（心跳周期，默认 5000，决定被抢占后多久让位）、`OMP_DINGTALK_LOCK_DIR`（锁文件目录，默认 `~/.omp/agent`）。
- 改完配置**开新会话**即生效，不用重启 omp。
- 秘密不想落盘就用环境变量：`DINGTALK_WEBHOOK_URL`、`DINGTALK_WEBHOOK_SECRET`、`DINGTALK_CLIENT_ID`、`DINGTALK_CLIENT_SECRET`、`DINGTALK_ROBOT_CODE`、`DINGTALK_ALLOW_USER_ID`、`DINGTALK_APPROVAL_MODE`、`DINGTALK_QUESTION_ENABLED`、`DINGTALK_QUESTION_TIMEOUT_MS`、`DINGTALK_CONTROL_SCOPE`、`DINGTALK_AUTO_TAKEOVER`、`DINGTALK_OUTBOUND_MODE`。
- 只给某个项目配（比如公司项目）：放到 `<项目>/.omp/dingtalk.json`，只覆盖要改的字段。

### 只认单聊 + 显式接管（推荐的保守配置）

```json
{
  "outbound": { "mode": "direct" },
  "control": { "scope": "direct", "autoTakeover": false },
  "notify": { "onlyWhenTakenOver": true }
}
```

- `scope: "direct"` —— 群里 @ 机器人也**完全不响应**，只有单聊能指挥它。
- `autoTakeover: false` —— 会话启动时**不会**自动连上入站通道，必须在 omp 里敲 `/dingtalk takeover` 才接通。已经接管的会话，新会话启动**不会**把它松开（接管是显式状态，只由 `/dingtalk takeover` 抢占或 `/dingtalk release` 主动解除）。
- **接管会话是钉钉的唯一出口**：你在哪个会话 `/dingtalk takeover`，通知、审批、提问澄清就只从那个会话发——`onlyWhenTakenOver` 即使是 `false` 也一样。别的会话（旁观者）完全静默：不推轮次 / 空闲 / 退出通知，不推提问卡，不拦截审批，`dingtalk_notify` 与 `/dingtalk test` 也都不发；接管被别的会话抢走时，被抢的一方同样闭嘴（只在终端日志里记一笔）。没人接管时，各会话按 `onlyWhenTakenOver` 正常发。
- `onlyWhenTakenOver: true` —— **接管前一条通知都不发**，接管后才开始发，`/dingtalk release` 之后又停。适合「坐在电脑前不想被打扰，出门前 takeover 一下」。
  - 它是**全有全无**的：启动、空闲、审批、错误告警、退出通知**全部**被压住。⚠️ 这意味着未接管期间「模型凭据被禁用」这类告警你也收不到。
  - 要求**能**接管（`stream` 凭据齐全）。如果配了它却又无法接管，配置加载时会明确告警「一条通知也不会有」——这个组合是永久静默，最容易误判成「没问题」。
  - `/dingtalk test` 和 `bun run doctor` 不受影响，仍是验证出站通道的手段。
- 注意 `autoTakeover: false` 时 `stream.enabled` 仍应为 `true`，否则 `/dingtalk takeover` 会拒绝接管并告诉你原因。

### 先锁定权限（强烈建议）

任何能触达机器人的 1:1 对话都能控制 omp 是危险的。让机器人告诉你自己的 ID：

> 在**单聊**里给机器人发 `/whoami`（`/id`、`我是谁` 也一样）

这条指令**在配白名单之前就能用**——首次接入时你还没进 `allowUserId`，机器人也会回复你的身份卡。

把返回的 `senderStaffId` 填进 `control.allowUserId`。**留空 = 拒绝所有指令**（fail-closed：白名单为空时除 `/id` 外一律拒绝，陌生人触达机器人也控制不了 omp）。`/id` 只回显你自己的 ID，不带任何会话信息，所以白名单没配好之前也能用。
（这个 ID 同时就是推送收件人，一份配置两用。）

### 升级到单值白名单（旧版 → 新版）

旧版配置里有两个字段：`control.allowUserIds`（数组，指令白名单）和 `outbound.directUserIds`（数组，推送收件人）+ `outbound.learnFromInbound`。新版把两者合并成**一个字符串** `control.allowUserId`：填进去的这个人既能下指令，也是唯一收到单聊推送的人，不再需要第二份名单。

读到旧字段就照下面改：

- `control.allowUserIds: ["a", "b"]` → `control.allowUserId: "a"`（只保留第一个），删掉原键
- `outbound.directUserIds: [...]` → 删掉；若 `control.allowUserId` 为空，取这里的第一个值填进去
- `outbound.learnFromInbound` → 删掉（学习收件人的功能已移除）
- `outbound.mode` 保持不变
- 环境变量 `DINGTALK_ALLOW_USER_IDS`（逗号分隔）→ `DINGTALK_ALLOW_USER_ID`（单值）

`bun run doctor` 会提示旧字段残留。代码对旧文件有兜底：读不到 `control.allowUserId` 时会回退读旧键的第一个值并打告警，所以漏改不会让机器人变成「谁都不理」，但配置里留着旧键会一直告警。

---

## 5. 两种用法

### 模式 A：本地全自动 + 远程闸门（推荐）

在公司跑长任务时，本地不再弹审批，全部交给钉钉：

```bash
omp --approval-mode=yolo
```

同时配置：

```json
{
  "outbound": { "mode": "direct" },
  "approval": { "mode": "remote", "timeoutMs": 300000, "onTimeout": "deny" },
  "notify": { "sessionStop": true, "approval": true }
}
```

效果：omp 自己一路跑，**只有命中危险规则的操做才会停下来问你**，你在钉钉单聊里回「同意」就继续。

审批的运作方式（和 omp 的 handler 超时有关）：

1. 命中规则的工具调用被**立即拦截**（`block: true`），模型被告知「已推送到钉钉，结束本轮等待」。
2. 你在钉钉回「同意」后，插件把决定**注入**成一条新消息（「已批准，请原样重发」），模型重新发起同一个调用。
3. 重发的调用按**参数完全相同**匹配，一次性放行——只放这一次，换个参数、或批准后拖过了 `timeoutMs` 窗口才重发，都会重新走审批（防止陈旧放行在很久以后被原样重放）。
4. `approval.timeoutMs` 内没回复，按 `onTimeout` 处理并注入结果，会话不会被挂住。

> 为什么不是「处理器里等着你回复」：omp 会在 `extensionHandlers.toolCallTimeoutMs`（默认 30 秒）后中止 handler 并拦截该调用。如果在这里 await 人类回复，超过 30 秒才回的「同意」就再也放行不了工具了。所以采用「立即拦截 + 批准后重发」。

内置危险规则（`approval.rules` 留空时生效）：

- `bash`：`rm -rf`、`sudo`、`git push`、`git reset --hard`、`git clean -fd`、`DROP TABLE/DATABASE`、`npm publish`、`curl|sh`、`chmod 777`、`mkfs`、`dd if=`、`shutdown`、`kill -9`
- `write` / `edit`：`.env`、`id_rsa*`、`*.pem`、`.ssh/**`、`.npmrc`、`.aws/**`

想自己定义就填 `approval.rules`：

```json
{
  "approval": {
    "mode": "remote",
    "rules": [
      { "label": "禁止动生产配置", "tools": ["write", "edit"], "paths": ["**/prod/**", "**/*.tf"] },
      { "label": "只拦这几个命令", "tools": ["bash"], "patterns": ["kubectl\\s+delete", "terraform\\s+apply"] },
      { "label": "每次都要问", "tools": ["apply_patch"] }
    ]
  }
}
```

规则语义：`tools` 限定工具；`patterns` 用正则匹配 bash 命令；`paths` 用 glob（`*` / `**` / `?`）匹配写文件路径。只有 `tools` 而没 `patterns`/`paths` = 这个工具每次都问。

### 模式 B：本地照常询问 + 只做通知

你大部分时间在键盘前，只想离开时收到提醒：

```json
{
  "approval": { "mode": "off" },
  "notify": {
    "onlyWhenTakenOver": true,
    "sessionStop": true,
    "turnEnd": { "enabled": true, "minDurationMs": 120000 }
  }
}
```

`onlyWhenTakenOver: true` 让**接管前完全静默**：平时零打扰，出门前在 omp 里敲一句 `/dingtalk takeover`，之后才开始收通知；回来 `/dingtalk release` 又恢复安静。

### 提问（Ask/AskUserQuestion）：终端和钉钉**同时**出现，任一端作答都算

omp 的「提问」工具会在终端弹一个选择框并**卡住当前轮次**。以前只有两种糟糕的选择：人在电脑前时它只在终端弹，你走了之后又没人能答。现在两端同时展示：

- 终端里照常弹出原生选择框，键盘操作一点没变。
- 同一时刻，单聊里收到「❓ 需要你的回答」，选项按 `1. 2.` 编号，推荐项标了「（推荐）」。
- **谁先答谁赢**：你在终端按了回车，钉钉那边立刻收到「💻 已在本地回答 #XX」并作废；你在手机上回了 `2`，终端的框会自动关闭，模型拿着答案继续。
- 手机上的回复格式：单选 `2`、多选 `2,4`、多个问题 `1:2 2:1`；回复选项文字也行；回任意文字就是自定义答案。

> 为什么能做到：插件**重注册了同名的 `ask` 工具**，由此拿到这次调用的取消信号——「另一端先答就把这一端取消」必须要它。omp 内部的对话框竞速只对内置的 `/collab` 共享会话开放，扩展拿不到那个位置。细节见 `src/ask-tool.ts` 顶部的注释。

超时与边界：

- `question.timeoutMs`（默认 10 分钟）内两端都没人答：终端的框会被关掉，并把「自行决定」交回模型，轮次不会永久卡住。
- 在终端按 Esc 取消 = 整体取消，钉钉那条同时作废（取消不算作答）。
- `question.enabled: false` 可以整体关掉（默认开），提问只走终端、不推钉钉。
- **未接管时不推钉钉**：本人在电脑前（未接管）时提问照常只弹本地框，不打扰。
- 想让“离开后没人看的任务”也能被钉钉接管，把 `control.autoTakeover: true` 打开——会话一启动就自动接管，长任务里的每个提问都能在手机上答。
- 同一问题在等待期间模型重复提问不会重复推送（自动去重）；被去重的那一次只走终端框。
- 子代理会话和非交互（headless）会话不参与，`ask` 保持原生行为。

### 多个会话都想接管：后来者覆盖，旧会话自动让位

一个钉钉应用在同一个连接层面只应该有**一个**消费者。如果两个 omp 会话同时连着，钉钉把消息推给哪个连接是不确定的——你的 `停止` 可能打断了另一个会话，你的 `同意` 可能被一个从没发问的会话应答，而真正在等审批的那个只能超时被拒。这不是「两个人一起管」，而是掷硬币。

所以接管做成了**抢占式**的，并且有跨进程的锁来保证：

- 在**新会话**里敲 `/dingtalk takeover`，**会直接抢过来**（不会被拒绝），并提示你抢的是哪个会话：
  ```
  钉钉已接管本会话（单聊）。已从另一个会话手里抢占（`D:\proj\old` · PID 12345），它会在 5 秒内自动释放。
  ```
- 被抢的那个会话在**一个心跳周期内**（默认 5 秒）自己发现，然后自动**关闭入站连接**、解除接管。它**不再往钉钉推任何卡片**——钉钉只有一个出口，抢走通道的那个会话已经发过接管卡，被抢的一方只在终端日志里记一条（`接管已被另一个会话抢占：…，本会话不再推送钉钉消息`），不去污染同一个对话。
- 想抢回来：在被抢的会话里**再敲一次** `/dingtalk takeover` 即可。

锁按 **`clientId`** 维度，不按机器：两个**不同的**钉钉应用互不影响，可以同时各自接管。

几个边界情况：

| 情况 | 行为 |
| --- | --- |
| 会话崩溃 / 被强杀 | 锁里的 PID 已死，下一个 `takeover` 立即回收，不会被永久锁死 |
| 进程活着但卡死（心跳停） | 超过 30 秒没心跳同样算失效，可被回收 |
| 被抢的会话一直不关 | 最多晚一个心跳周期（默认 5 秒）才让位 |
| 被抢的会话之后又 `release` | 不会误删新持有者的锁（只有锁还是自己的才会删） |
| 手动删掉锁文件 | 持有者下一次心跳会重新写入，不会因此丢掉控制 |
| 换工作目录 | 会释放接管（`dispose()` 的语义），终端里会明确告警 |

> ⚠️ **锁是本地文件，只保护同一台机器。** 两台机器共用同一个钉钉应用凭据时，跨机器仍然会掷硬币——那种情况下必须各自建应用（见第 10 节）。

心跳周期可以用 `OMP_DINGTALK_HEARTBEAT_MS` 调（毫秒，默认 5000，低于 50 会被忽略），锁文件位置可以用 `OMP_DINGTALK_LOCK_DIR` 覆盖（默认与 omp 的 agent 目录相同，即 `~/.omp/agent`）。锁文件形如 `dingtalk-takeover-<clientId 的 sha1 前 12 位>.json`，里面是持有者的 PID / 目录 / 心跳时间，`/dingtalk status` 的「接管锁」一行会显示当前状态。

---

## 6. 指令表

在钉钉里发送（默认**只在单聊**生效；`scope` 改为 `group` 后需 @机器人）：

| 指令 | 作用 |
| --- | --- |
| *任意文字* | 作为新指令喂给 omp（流式中会打断当前轮次） |
| `/follow <文字>` | 等当前轮次跑完再执行 |
| `停止` / `/stop` | 中断当前执行 |
| `同意` / `/approve [编号]` | 批准待审批操作（不写编号则批准最新一条） |
| `拒绝` / `/deny [编号]` | 拒绝 |
| `1` / `2,4` / 选项文字 | 回答远程提问（有「❓ 需要你的回答」时，非指令文字优先当作答案） |
| `1:2 2:1` | 多个问题的回答格式（问题号:选项号） |
| `状态` / `/status` | 会话、模型、待审批、发送队列、通道状态 |
| `/tools` | 当前启用的工具 |
| `/model <模型名>` | 切换模型，如 `/model opus` |
| `/compact [说明]` | 压缩上下文 |
| `/quiet on\|off` | 静音 / 恢复通知（静音后审批仍然会发） |
| `/id` / `/whoami` / `我是谁` | 查看自己的 senderStaffId（配置白名单用，**白名单生效前就能用**） |
| `/ping` | 连通性测试 |
| `帮助` / `/help` | 指令表 |

> 为了安全，`停止`、`同意`、`拒绝` 这类**危险指令必须单独发送**（不带参数）—— 所以「stop the server on port 3000」会被当成正常指令投给 omp，而不是中断。

### 消息反馈用表情，不刷屏

给 omp 发**自由文字**时，机器人不会回一条「已投递」卡片，而是**给你那条消息打一个表情**，既确认收到又不占消息流：

| 表情 | 含义 |
| --- | --- |
| 👀 | 已收到，omp 空闲，立刻开跑 |
| ⚡ | 已插入当前轮次（会打断正在跑的那一轮） |
| 📋 | 已排队，等当前轮次跑完再执行（`/follow` 也是这个） |
| ✅ | 本轮跑完、omp 空闲，任务正常结束 |
| ❌ | 本轮以**未恢复的错误**结束（如重试耗尽），需要你关注 |

> 表情走钉钉企业应用的 `emotion/reply` 接口，**不过期**（不像 sessionWebhook）——长任务跑几十分钟，结尾的 ✅/❌ 照样打得到。表情接口不可用时自动回落到回复卡片。

终端里还有个本地命令：`/dingtalk status | test | quiet on|off`。输入 `/dingtalk `（带空格）或前缀（如 `/dingtalk ta`）会弹出子命令补全，带中文说明。

另外注册了一个 `dingtalk_notify` 工具，模型在任务跑完但你不确定用户还在不在时，可以自己主动推送一条通知。

---

## 7. 架构

```
                    ┌──────────── 钉钉 ────────────┐
                    │  自定义机器人 webhook（出站）  │
                    │  Stream WebSocket（入站）     │
                    └───────┬──────────────┬───────┘
                            │              │
              src/dingtalk.ts│              │src/stream.ts
                 限流+加签+合并              帧分发/ACK/去重/重连
                            │              │
                    ┌───────▼──────────────▼───────┐
                    │        src/index.ts          │
                    │  session/turn/tool_call 事件  │
                    │  ↕ 审批闸门（命中规则即拦截）  │
                    └───────┬──────────────────────┘
                            │
                    src/router.ts  指令解析 / 鉴权
                            │
                      OMP 会话（sendUserMessage / abort / setModel / compact）
```

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 扩展入口：事件订阅、审批闸门、本地命令、`dingtalk_notify` 工具 |
| `src/stream.ts` | Stream 模式 WebSocket 客户端（零依赖自实现） |
| `src/dingtalk.ts` | 出站发送：限流队列、加签、`webhook` / `direct` 两条通道、sessionWebhook 回复 |
| `src/router.ts` | 入站指令路由 + 待审批注册表 |
| `src/format.ts` | 事件 → 钉钉 markdown |
| `src/config.ts` | 分层配置加载与合并 |
| `src/util.ts` / `src/logger.ts` | 工具函数 / 日志 |

### 关键设计取舍

- **失败安全但不硬卡**：审批超时默认按 `deny` 处理（fail-closed）；但如果**没有任何可用的出站通道**（没法联系到人），闸门会主动放行并告警，而不是让模型白等一场。拦截时 handler **同步返回** `block`，不 await 人类——omp 只给 handler `toolCallTimeoutMs`（默认 30 秒），在里面等几分钟的审批必被中止。批准后由模型重发同一调用，注册表一次性放行。
- **绝不拖垮会话**：OMP 扩展与宿主同进程，未捕获的异常会杀掉整个会话。所有事件处理器、定时器、WebSocket 回调都做了包裹。
- **先 ACK 再处理**：Stream 服务端约 60 秒重投未应答的消息，而远程审批可能要等好几分钟。所以入站帧先回 ACK，再用 `messageId` 去重兜住重投。
- **重载配置不重建发送器**：`refreshConfig()` 用 `updateConfig()` 原地换配置。重建实例会重置限流窗口（可能撞上钉钉 20 条/分钟被封 10 分钟），而且老实例并行排空积压会让通知乱序。
- **收件人就是白名单里那个人**：没有单独的收件人列表，能命令会话的人才收得到推送。反过来若做成「谁发消息谁订阅」，陌生人 DM 一下机器人就能订阅到你的会话通知。
- **单聊锁定是默认值**：`control.scope` 默认 `direct`，非法值会告警并回退到 `direct` —— 拼错不会把控制面意外放大。同理 `autoTakeover` 默认 `false`。
- **接管是抢占式的，靠锁兜底**：`takenOver` 只是进程内的布尔值，管不住别的会话。跨会话靠 `src/lock.ts` 的锁文件（按 `clientId` 分片、PID + 心跳双重存活判定、token 防止误删）。语义上**后来者赢**：这正是用户敲 `/dingtalk takeover` 时想表达的意思；旧持有者在一个心跳周期内自己让位，所以两个连接不会长期并存。
- **通知带会话标识**：每条通知的落款是 `omp · <目录名>·<4位短码> · HH:MM:SS`，审批这类没有落款的消息会多一行 `来自`。多个会话（或多台机器）共用一个钉钉账号时才分得清是谁在说话。

---

## 8. 测试

先跑配置自检（不需要模型凭据、不需要真凭据也能跑）：

```bash
bun run doctor
```

再跑单元/加载测试：

```bash
bun run test        # 全量：smoke + 加载（smoke 纯 mock，加载需要本机已装 omp）
bun run typecheck   # tsc 严格模式全量检查（0 错误）
bun run lint        # oxlint（0 警告）
```

- `test/smoke.ts` — 230 项断言，全部 mock（假 `fetch` + 假 `WebSocket`），不需要真凭据。覆盖限流发送、加签、帧处理与 ACK、去重、鉴权、指令路由、审批的批准/拒绝/超时三条路径（含一次性放行与同参数去重）、静音、`webhook`/`direct`/`both` 三条出站路径、白名单里那个人即推送收件人、`scope` 双向过滤、接管前静默的开关与解除、通知里的会话标识、回复的 markdown 渲染（含表格连续性）、表情反馈（👀 确认与 ✅/❌ 结束），以及「没凭据时必须安全降级」。多会话部分覆盖：后抢的会话覆盖先抢的、被抢者在一个心跳周期内自动关闭 Stream 且**不推任何卡片**（钉钉只有一个出口）、被抢者 `release` 不误删新持有者的锁、死进程 / 心跳超时的锁可回收、不同 `clientId` 互不干扰、抢占后消息只到达新持有者、新会话启动不释放已有接管、A 接管后 B 的轮次/空闲通知与 `dingtalk_notify` 一律被挡（`onlyWhenTakenOver = false` 也要挡）、A 释放后 B 恢复推送、`autoTakeover = true` 下第二个顶层会话「后来者覆盖」接管通道（旧会话的归属随后失效）、子代理（无 UI 的 headless 会话）的 `session_start`/`session_shutdown`/轮次一律忽略——既不推「omp 已退出」也不拆主会话的桥，且不误伤同一进程里的第二个顶层会话（桥改随新会话，接管后事件照常推送）；子代理在**自己的 cwd** 里重新绑定插件（宿主按会话重建工厂，每个副本一份 bridge）时，整份副本必须完全静默：不推送、不建连接，只有主会话照常推送。`/dingtalk status` 展示桥绑定会话 id，并在被问的会话与桥归属不一致时给出显式接管提示；被归属过滤丢弃的事件只在 debug 记录（子代理是常规流量），但 status 会展示累计丢弃计数。
- `test/verify-load.ts` — 直接调用 **OMP 自己的 `discoverAndLoadExtensions()`**，确认插件真能被发现、无加载错误、handler/工具/命令都挂上了。（这一层能抓到软链接坏掉这类只存在于加载器里的问题。）

---

## 9. 排障

| 现象 | 排查 |
| --- | --- |
| 收不到任何通知 | 先跑 `bun run doctor`（会自动翻译错误码）；或在 omp 里跑 `/dingtalk test` |
| 一条通知都没有，但 doctor 全绿 | 多半是 `notify.onlyWhenTakenOver: true` 而**还没执行** `/dingtalk takeover`。这是设计行为，不是故障 —— 接管后才开始发。配置加载时的告警会直接告诉你这个组合是否会导致「永远静默」 |
| 接管成功、锁和 Stream 都正常，却一条都不推 | 同一个 omp 进程里先跑过别的会话（切会话 / 新建 / 恢复），桥的归属还停在那一个 session 上，于是接管会话自己的事件被当成「外来会话」过滤掉了。已在插件侧修好：顶层会话切换时桥自动改随新会话，接管成功时也会重新绑定；`autoTakeover = true` 时新会话「后来者覆盖」直接接管；子代理（无 UI 的 headless runner）依旧完全静默。**例外**：无 UI 的顶层会话（`omp -p` / ACP / SDK 这类 `rpc`/`json`/`print` 模式）与子代理在宿主暴露的字段上无法区分，不会被自动改绑——在这类会话里执行 `/dingtalk takeover` 即可接手。用 `/dingtalk status` 看「桥绑定会话」是否与当前会话一致，不一致时会直接给出提示。旧版遇到这个现象：退出重开该 omp 会话，或在本会话再执行一次 `/dingtalk takeover` |
| 启动时不推「omp 已启动」 | 这是设计行为：会话启动不再推送任何消息（`notify.sessionStart` 已移除）。启动后真正在 omp 里执行 `/dingtalk takeover` 时，钉钉会收到一条「🎧 钉钉已接管本会话」确认消息 |
| 设了 `direct` 但单聊收不到通知 | ① `stream.robotCode` 是否填了（`ding` 开头）② `control.allowUserId` 是否为空（它同时是白名单和推送收件人） ③ 应用是否有**机器人发送消息**权限、收件人是否在应用可见范围内 ④ `/dingtalk status` 看「出站通道」和「单聊收件人」两行 |
| 通知还是发到群里 | `outbound.mode` 是不是 `webhook` 或 `both`。自定义机器人**只能发群**，要私聊必须用 `direct` |
| 群里 @机器人 没反应 | 默认就是这样：`control.scope = "direct"` 时群聊消息一律忽略。要用群聊得显式改成 `group` / `all` |
| 钉钉里发消息没反应 | ① `stream.enabled` 是否为 true ② 是否已在 omp 里 `/dingtalk takeover` ③ 是否 @ 了机器人（群聊）④ 另开终端跑 `bun run watch`，再发一条看有没有帧 ⑤ 应用是否**已发布** |
| 新会话里钉钉还能指挥，是不是串了 | 不是。接管是显式状态且跨会话保留：`/dingtalk takeover` 之后新会话启动**不会**松开它。`control.autoTakeover: false` 只表示新会话不**自动**接管。要断开就用 `/dingtalk release`，想会话一启动自动接管就改成 `true` |
| 终端提示「接管已被另一个会话抢占」 | 有另一个会话在同一个钉钉应用上执行了 `/dingtalk takeover`。本会话已自动释放、Stream 已关闭，**不会再往钉钉推送**（钉钉只有一个出口，接管卡由抢走的一方发）。想抢回来就在本会话再敲一次 `/dingtalk takeover`；不想被抢，给每个会话配**不同的** `stream.clientId` |
| `/dingtalk status` 显示「接管锁被其他会话占用」 | 说明那个会话还活着并持有锁。要么去那个会话 `release`，要么在本会话 `takeover` 直接抢。显示 PID 和目录，可以据此找到它 |
| 崩溃后 takeover 说被占用 | 不该发生：锁里 PID 已死会立即回收，心跳超时 30 秒也会回收。若确实卡住，检查 `/dingtalk status` 里的锁文件路径，确认没有**同 PID 被复用**的进程 |
| 锁文件在哪、能手动删吗 | 默认 `~/.omp/agent/dingtalk-takeover-<hash>.json`（`/dingtalk status` 会显示路径）。可以删——持有者下次心跳会重新写入，不会因此丢掉控制 |
| 连上了但一直没有 `registered` | 正常现象：钉钉不保证推这个帧。用 `bun run watch` 验证能否收到消息即可 |
| 入站通道一直 `reconnecting` | 多为公司代理问题，给 omp 进程设 `HTTPS_PROXY` / `HTTP_PROXY`；`/dingtalk status` 会显示最近一次错误 |
| 通知被静音了 | 钉钉里发 `/quiet off`，或看 `quiet` 配置项 |
| 命令回复延迟几秒 | 正常：出站限流最短间隔 2.2 秒 |
| 改了配置没生效 | 配置在**会话启动时**重载，开个新会话；`/dingtalk status` 会列出实际生效的配置来源 |
| 审批总是超时被拒 | 调大 `approval.timeoutMs`；或把 `onTimeout` 改成 `allow`（不推荐） |
| 收到「❓ 需要你的回答」怎么答 | 直接回复选项号（单选 `2`、多选 `2,4`、多问题 `1:2 2:1`），回复选项文字也可以，任意其它文字当作自定义答案 |
| 终端和钉钉同时弹了提问，正常吗 | 正常，这是设计：两端同时展示，谁先答谁赢，另一端自动关闭/作废 |
| 没收到提问推送 | ① 是否已 `/dingtalk takeover`（未接管时只弹终端框）② `question.enabled` 是否为 false ③ 检查提问工具是否真的被模型调用（看 omp 会话里有没有「提问」块）④ `/dingtalk status` 看「待回答提问」 |
| 提问一直没人答会怎样 | 到 `question.timeoutMs`（默认 10 分钟）后关闭终端框并告知 omp 自行决定，不会永久卡住 |
| 日志出现 `handler timed out after …ms` | omp 对 `tool_call` 处理器有 `extensionHandlers.toolCallTimeoutMs`（默认 **30 秒**）上限，超时会中止并拦截该调用；退出通知单独把上限压到 1.5 秒。新增阻塞调用要移出 handler，或改成「立即返回 + 异步注入」 |
| 远程审批（`approval.mode: remote`）没生效 | 三件事都满足才会拦截：`approval.mode` 为 `remote`、已 `/dingtalk takeover`、出站通道可用。缺任一条件闸门会主动放行并在日志告警 |

`omp plugin doctor --fix` 可以修掉 `package_manifest: Not created yet` 这个无害告警。

---

## 10. 分发到其他电脑

**把目录拷过去，或从源码装。** 插件是零运行时依赖的——没有 `node_modules`，不需要 `npm install`，代码里也没有硬编码路径或平台特定逻辑（Windows / macOS / Linux 都能跑）。

### 手动安装

1. 下载 Release 资产：
   ```bash
   curl -fsSL -o omp-dingtalk.tar.gz \
     https://github.com/sgr997/omp-dingtalk/releases/download/v0.1.0/omp-dingtalk-0.1.0.tar.gz
   ```
2. 解压到任意目录，比如 `~/tools/omp-dingtalk`
3. `omp plugin link ~/tools/omp-dingtalk`
4. `mkdir -p ~/.omp && cp ~/tools/omp-dingtalk/config.example.json ~/.omp/dingtalk.json && chmod 600 ~/.omp/dingtalk.json`，然后填凭据（样例里 `webhook.url` 与 stream 凭据都是空的，`doctor` 会提示还缺什么）
5. `cd ~/tools/omp-dingtalk && bun run doctor`

（Windows 普通用户建不了符号链接时，按第 2 节的 junction 办法处理。）

前提是新电脑已经装了 omp，**并且 omp 配好了模型凭据**——否则插件装了也没有会话可挂。

### 不要多台机器共用同一套钉钉凭据

这是最容易踩的坑，两个通道各有各的问题：

**出站 webhook 共用** — 钉钉自定义机器人的限流是**按机器人算的 20 条/分钟**。几台机器同时跑任务会叠加，很容易撞上限流被**封 10 分钟**。而且通知全混在一个群里，分不清是哪台机器发出来的。

**入站 Stream 共用（更严重）** — 同一个应用的多个 Stream 连接同时在线时，钉钉把消息推给哪个连接是不确定的。你在群里发「停止」，可能被 A 机器收到也可能被 B 机器收到——**你想停的那台很可能根本没收到**。

插件对此的防护是**一台机器内**的：同一台机器上多个会话共用一套凭据时，接管锁（`src/lock.ts`）保证只有一个会话真正连着入站通道，后来者抢占、旧会话自动让位。但**锁文件是本地的**，跨机器它管不到——两台机器共用一套凭据时，仍然是上面说的掷硬币。所以跨机器必须各自建应用，不能靠这个锁兜底。

推荐做法：

| 场景 | 做法 |
| --- | --- |
| 每台机器都要收通知 | 每台建**自己的**自定义机器人（各自的 `webhook.url`），通知分群或分话题 |
| 每台机器都要能远程控制 | 每台建**自己的**企业内部应用（各自的 ClientID/Secret），机器人各自加群 |
| 只有一台需要被远程控制 | 只在那台配 `stream`，其他机器设 `stream.enabled: false` 纯做通知 |

`control.allowUserId` 填的是你本人的 `senderStaffId`，同一个人在多台机器上可以复用同一个值。
