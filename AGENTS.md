# omp-dingtalk — Agent 配置引导手册

**这份 AGENTS.md 是写给执行 agent（大模型）看的**，不是给人看的操作手册。你（agent）被要求"把 omp 接入钉钉 / 配钉钉通知 / 远程控制 omp / 排查 omp-dingtalk 插件"时，按本手册引导用户完成配置。人读的版本见 `README.md`。

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
3. **入站 Stream 和出站 direct 共用同一套企业内部应用凭据**，但 direct 单聊发送不需要启动入站 Stream。远程控制还要给应用添加机器人、启用并发布 Stream；连接后由用户执行 `/dingtalk takeover` 才能控制会话（除非明确配置 `autoTakeover: true`）。

---

## 1. 先确认目标，再选一条配置路径

用户已经说清目标时直接按目标配置。否则只问这一句：

> "你希望钉钉只接收 omp 通知（发群还是私聊），还是也要从钉钉远程控制 omp？"

按回答选路径，不让用户先研究通道名称：

| 目标 | 配置路径 | 必需信息 |
| --- | --- | --- |
| 只收群通知 | `webhook` | 群机器人的 Webhook URL；若启用了加签，还要 SEC 密钥 |
| 只收单聊通知 | `direct` | 企业内部应用 ClientID、ClientSecret、robotCode、收件人的 `senderStaffId` |
| 远程控制 omp | `direct` + 入站 Stream | 企业内部应用 ClientID、ClientSecret、robotCode；操作者的 `senderStaffId` 在接通后通过 `/id` 获取 |

用户明确要求群和私聊都收时才选 `outbound.mode: "both"`。远程控制默认用单聊；只有用户明确要在群里控制时才把 `control.scope` 改成 `group`，并保持 `requireAt: true`。

**按目标应用安全默认：**
- 纯通知配置不需要开启入站控制。群通知不需要 `senderStaffId`；单聊通知需要它，因为 `control.allowUserId` 同时是单聊收件人。
- 远程控制使用 `control.scope: "direct"`、`control.autoTakeover: false`。只有用户明确要求每个新会话自动接管时才设为 `true`。
- `control.allowUserId` 留空时，除 `/id` 外所有入站指令都会被拒绝。远程控制的初始配置可暂时留空，取得 `/id` 返回的 `senderStaffId` 后必须回填；单聊通知不能在收件人 ID 为空时算配置完成。
- `/id`（`/whoami`）只有在 Stream 已启用、会话已 `/dingtalk takeover`、且消息符合 `control.scope` 时才能收到。纯 webhook 或 Stream 关闭时不能用它取 ID。
- 接管会话是钉钉的唯一出口：一旦有会话接管，通知、审批、提问澄清都只从那个会话发；旁观会话保持静默。接管状态跨会话保留，只有被其他会话抢占或执行 `/dingtalk release` 才解除。

---

## 2. 获取凭据的分步引导

用户在你的引导下自己操作钉钉后台（你无法登录钉钉），然后**把拿到的值回填给你**。按通道引导，每步告诉他做什么、回报什么：

### 通道 A：群自定义机器人（webhook 出站）
1. 用户：钉钉群 → 群设置 → 智能群助手 → 添加机器人 → 自定义机器人 → 起名。
2. 安全设置选一种，**优先"加签"**：
   - 加签 → 复制 `SEC` 开头的密钥 → 填 `webhook.secret`。
   - 或自定义关键词（如 `omp`）→ 填 `webhook.keyword`。
3. 用户回报：Webhook URL（`https://oapi.dingtalk.com/robot/send?access_token=xxx`）+ SEC 密钥（若有）。

### 通道 B：企业内部应用（direct 出站；可选连接入站 Stream）
1. 用户：钉钉开放平台 → 开发者后台 → **创建企业内部应用**，记下 **ClientID（AppKey）** 和 **ClientSecret（AppSecret）**。
2. 用户：给应用添加 **机器人** 能力，按项目推荐将接收消息方式设为 **Stream** 并发布应用；在机器人详情页找到 **robotCode**（`ding` 开头）。direct 出站需要 ClientID、ClientSecret 和 robotCode。
3. 插件配置里的 `stream.enabled` 决定是否实际连接入站：远程控制或用 `/id` 自助取 ID 时设为 `true`；纯 direct 通知设为 `false`，插件不会接收或处理钉钉指令。
4. 用户回报：ClientID、ClientSecret、robotCode。单聊使用不需要把机器人加进任何群；要用群聊控制时才加群并按需修改 `control.scope`。
5. 单聊通知还需要收件人的 `senderStaffId`。用户不知道时先问他是否能从钉钉后台取得；不要把 `/id` 说成无需启用 Stream 的操作。

---

## 3. 安装

```bash
omp plugin install github:sgr997/omp-dingtalk
```

升级：重跑同一条命令并加 `--force`。

验证（期望 4 ok / 0 errors，列表里有 `omp-dingtalk`）：
```bash
omp plugin doctor
omp plugin list
```

改源码时用 `omp plugin link <插件绝对路径>` 指向工作目录，改完不用重装。**Windows 普通用户**建不了符号链接，`link` 会留空目录，改用目录联接（README.md 第 2 节有现成命令）。

安装目录：`~/.omp/plugins/node_modules/omp-dingtalk`。

---

## 4. 写配置

复制样例到用户级配置再填：
```bash
cp config.example.json ~/.omp/dingtalk.json && chmod 600 ~/.omp/dingtalk.json
```

样例里 `webhook.url` 与 stream 凭据都是**空的**，开箱状态就是「未配置」——`chmod 600` 是因为文件里要放密钥；`doctor` 会列出还缺什么，不会出现一个看着像已配置的假地址。

配置查找顺序（后者覆盖前者）：内置默认 → `~/.omp/agent/dingtalk.json` → `~/.omp/dingtalk.json` → `<项目>/.omp/dingtalk.json` → 环境变量。

凭据不想落盘用环境变量（README.md 第 4 节有完整清单），常见几个：`DINGTALK_WEBHOOK_URL`、`DINGTALK_CLIENT_ID`、`DINGTALK_CLIENT_SECRET`、`DINGTALK_ROBOT_CODE`、`DINGTALK_ALLOW_USER_ID`、`DINGTALK_AUTO_TAKEOVER`。

**只给某个项目配**：放 `<项目>/.omp/dingtalk.json`，只覆盖要改的字段。

**远程控制的初始模板**（用户信息还没取到时，`allowUserId` 先留空；不要填占位字符串）：

```json
{
  "outbound": { "mode": "direct" },
  "stream": {
    "enabled": true,
    "clientId": "用户ClientId",
    "clientSecret": "用户ClientSecret",
    "robotCode": "用户RobotCode"
  },
  "control": {
    "enabled": true,
    "scope": "direct",
    "autoTakeover": false,
    "allowUserId": ""
  },
  "approval": { "mode": "off" },
  "notify": { "sessionStop": true, "errors": true }
}
```

- 只收群通知：`outbound.mode: "webhook"`，填 `webhook.url` 和实际需要的 `webhook.secret` 或 `webhook.keyword`；设 `stream.enabled: false`、`control.enabled: false`，不需要 `allowUserId`。
- 只收单聊通知：`outbound.mode: "direct"`，填 ClientID、ClientSecret、robotCode 和真实 `control.allowUserId`；设 `stream.enabled: false`、`control.enabled: false`。没有 `senderStaffId` 时先停在这一步询问用户，不要声称单聊已通。
- 远程控制：按上面的初始模板配置。取得 `/id` 的真实 ID 后回填 `control.allowUserId`；在此之前只有身份查询可用，其他控制指令会被拒绝。
- `autoTakeover: true` 仅在用户明确要求会话启动就自动接管时设置。默认由用户在会话内执行 `/dingtalk takeover`。
- 先完成通知或远控的基本配置与验证，再处理可选的多机器人、远程审批、提问卡片等设置；不要把这些选项塞进首次配置提问。

### 4.1 遇到旧配置就直接迁移

旧版有两个字段：`control.allowUserIds`（数组，指令白名单）和 `outbound.directUserIds`（数组，推送收件人）+ `outbound.learnFromInbound`。新版合并成**一个字符串** `control.allowUserId`——填的这一个人既能下指令，也是唯一收到单聊推送的人。用户配置里见到旧字段就按表改（写配置属于你可以直接做的事）：

| 旧字段 | 处理 |
| --- | --- |
| `control.allowUserIds: ["a", "b"]` | 取第一个，写成 `control.allowUserId: "a"`，删掉原键 |
| `outbound.directUserIds: [...]` | 删掉。`control.allowUserId` 为空时取这里的第一个值填进去（收件人就是这个字段） |
| `outbound.learnFromInbound` | 删掉，功能已移除 |

`outbound.mode` 保持不变。环境变量 `DINGTALK_ALLOW_USER_IDS`（逗号分隔）改成 `DINGTALK_ALLOW_USER_ID`（单值）。

代码对旧文件有兜底：读不到 `control.allowUserId` 时回退读旧键的第一个值并打告警，所以漏改不会让机器人变成「谁都不理」；但旧键留着会一直告警，要清掉。`bun run doctor` 也会提示。

### 4.2 多个钉钉机器人（可选）

一个 omp 实例可以接多个钉钉机器人，不同会话各绑定一个，互不抢占。**默认不需要**——没配 `robots` 时一切行为和单机器人一样，老配置不用动。

```json
{
  "webhook": { "url": "https://oapi.dingtalk.com/robot/send?access_token=默认机器人" },
  "stream": { "enabled": true, "clientId": "default-client", "clientSecret": "…", "robotCode": "ding…" },
  "robots": {
    "home": {
      "webhook": { "url": "https://oapi.dingtalk.com/robot/send?access_token=home机器人" },
      "stream": { "enabled": true, "clientId": "home-client", "clientSecret": "…", "robotCode": "dinghome" }
    },
    "work": {
      "outbound": { "mode": "direct" },
      "control": { "allowUserId": "另一个人的Id" }
    }
  }
}
```

规则（agent 按这些引导，别让用户自己研究）：
- 命名机器人只写自己不同的字段，其余继承全局设置；机器人名不能叫 `default`。
- 切换：`/dingtalk takeover <机器人名>`，不带名字 = `default`。`/dingtalk release` 解除接管、回到 `default` 并停止本会话自动推送；再次成功 takeover 后恢复。 主动释放已接管的会话时，会向刚释放的机器人发送一条「钉钉已解除接管」确认；重复 release 不重复发送。确认走原发送队列，释放立即生效；发送失败会在终端提示，不会恢复接管或自动推送。
- 锁按 `stream.clientId` 隔离：会话 A 接管 `home`、会话 B 接管 `work` 互不冲突，可以同时远程控制；两个会话抢同一个机器人，后来者赢。
- 通知、审批、提问澄清都从**当前接管的机器人**发，且只在接管期间发：未接管的会话一律静默。显式 release 后保持停止；恢复同一会话或取消静音不会重新推送。查询时以 status 首行的当前会话状态、实际入站连接和自动推送状态为准，Stream 配置启用只代表允许连接。
- `control.allowUserId` 可以每个机器人不同，把不同机器人交给不同人管。

---

## 5. 按配置路径验证并收尾

`bun run doctor` 会实际发送一条测试通知，并连接一次入站 Stream。**在任何会话执行 `/dingtalk takeover` 之前运行它**；已有会话接管时再跑 doctor 会同时打开第二条 Stream，钉钉可能把消息分给自检连接。

按路径验证：

| 配置路径 | 检查方式 | 完成判据 |
| --- | --- | --- |
| 群 webhook 通知 | `bun run doctor` | 自检通过，用户在目标群看到测试消息。Stream 未启用的提示对纯通知路径是预期状态。 |
| direct 单聊通知 | 填好真实 `control.allowUserId` 后运行 `bun run doctor` | 自检通过，收件人在单聊看到测试消息。ID 为空时 direct 没有收件人，不能算完成。 |
| 远程控制 | 先运行 `bun run doctor --stream-only`；通过后启动 omp 并执行 `/dingtalk takeover` | Stream 检查通过；接管成功；白名单回填后，用户发来的允许指令确实控制当前会话。 |

远程控制的 ID 回填顺序：

1. `doctor --stream-only` 在接管前验证 Stream，不发送通知。配置里的 `allowUserId` 暂时为空是安全的：除 `/id` 外，其他指令都会被拒绝。
2. 启动 omp 会话，在目标会话执行 `/dingtalk takeover`；确认终端显示接管成功。
3. 按 `control.scope` 从钉钉给机器人发 `/id` 或 `/whoami`。推荐的 `direct` 配置下从单聊发；群模式要在群里 @ 机器人。
4. 将返回的 `senderStaffId` 写入对应机器人的 `control.allowUserId`。它也是 direct 单聊推送的唯一收件人。
5. 回填后先在当前接管会话执行 `/dingtalk release`，再开或切换到新会话让配置重载，然后重新执行 `/dingtalk takeover`。原因是接管中的旧会话会把新会话当作旁观者并跳过配置刷新。用 `/dingtalk status` 核对配置来源和收件人，再用 `/dingtalk test` 确认出站消息到达，最后让用户发一条允许的控制指令确认端到端生效。

`bun run doctor --no-send` 只跳过实际发送；如果 direct 因 `allowUserId` 为空而没有收件人，它仍不能代替 ID 回填。尚未配置收件人但只想查入站时用 `--stream-only`。

如果用户只要单聊通知、不要远程控制，先让用户从钉钉后台提供收件人的 `senderStaffId`；不要默认打开 Stream 来取 ID。`/id` 是远控引导步骤，只有 Stream 已启用、会话已 takeover 且消息符合 scope 才能使用。配置文件改动在可处理的新会话 `session_start` 时加载；当前会话若持有 takeover，先 `/dingtalk release`，再开新会话并重新 takeover，然后用 `/dingtalk status` 查看实际生效来源。

**配置任务完成条件：**
- 群通知：用户确认目标群收到自检消息。
- 单聊通知：用户确认指定收件人收到消息，且 `control.allowUserId` 是真实 ID。
- 远程控制：Stream 连接检查通过、接管成功、白名单已回填，且一条允许的指令到达当前会话。仅 doctor 通过不代表远程控制已验收。

---

## 6. 排查速查（现象 → 判断，别瞎试）

| 现象 | 判断 / 做法 |
| --- | --- |
| 一条通知都没有 | 先 `bun run doctor`。若 doctor 全绿 → 多半是还没 `/dingtalk takeover`（通知只在接管期间发，设计行为，不是故障） |
| 设了 direct 却单聊收不到 | ① `stream.robotCode` 填没填 ② `control.allowUserId` 是否为空 ③ 应用有没有**机器人发送消息**权限、收件人在不在可见范围 |
| 通知发到了群里（想要私聊） | `outbound.mode` 没改成 `direct`。自定义机器人只能发群 |
| 群里 @ 机器人没反应 | 默认 `scope: "direct"` 就是不理群聊。要群聊得改 `group`/`all` |
| 钉钉发消息没反应 | ① `stream.enabled` 是否 true ② 有没有 `/dingtalk takeover` ③ 群聊是否 @ 了 ④ 应用有没有**发布** ⑤ `bun run watch` 发一条看帧 |
| 每个新会话都要重新 takeover | 旧版本的「接管不跨会话继承」已废弃。接管现在是显式状态：`/dingtalk takeover` 后跨会话保留，新会话启动不会松开，只有被别的会话抢占或 `/dingtalk release` 才解除 |
| 开了两个窗口，B 也会推通知 | 通知只在接管期间发。如果 B 没接管却在推，先看 A 的接管是否已经失效（进程退出、心跳超时、工作目录变更都会释放锁）；正常情况下别的会话完全静默（含 `/dingtalk test`）。想让 B 推，就在 B 里 `/dingtalk takeover`（会抢走 A） |
| 子代理退出/重试被推送、退出去还像主会话退出 | 已修复。宿主按会话重建扩展工厂：主会话一份插件副本，子代理在**自己的 cwd** 里再绑一份，各自持有独立 `bridge`——只靠 session id 门控挡不住这类泄漏（那是同一副本内的比较）。现在归属是**进程级**的：第一个见到 session id 的绑定拥有插件，其余绑定（子代理）完全静默：不建桥、不推送、不连 Stream。同一副本内带不同 session id 的事件按会话身份区分：子代理是无 UI 的 headless 会话（`hasUI === false`、`mode === "print"`），其事件照旧忽略；**顶层**的第二个会话（切会话/新建/恢复，`hasUI === true` 且 `mode === "tui"`，两个条件都要）会让桥改随新会话，`/dingtalk takeover` 成功也会把桥重绑到接管会话，`autoTakeover:true` 时新会话「后来者覆盖」直接接管——否则会出现「接管成功、锁和 Stream 都正常，却一条都不推」。**例外**：无 UI 的顶层会话（`omp -p`/ACP/SDK 等 `rpc`/`json`/`print` 模式）与子代理在宿主暴露的字段上不可区分，不会自动改绑，须显式 `/dingtalk takeover`；`/dingtalk status` 展示桥绑定会话 id，与被问会话不一致时给出显式提示，被归属过滤丢弃的事件另统计为丢弃计数（丢弃日志保持 debug 级，避免子代理常规流量刷屏）。若再出现，先确认跑的是新版插件（旧 omp 会话要退出重开才载入新代码） |
| 终端提示「接管已被另一个会话抢占」 | 另一个会话在同一钉钉应用上 takeover 了。本会话已自动释放、Stream 已关闭，**不再往钉钉推任何卡**（钉钉只有一个出口）。想抢回就在本会话再 takeover；不想被抢就给每个会话配不同的 `stream.clientId`（或多机器人模式各自接管不同机器人，见 §4.2） |
| 想多窗口同时远程控制 | 多机器人模式：每个机器人一把独立的锁（按 `stream.clientId` 隔离），会话 A 接管 A 机器人、会话 B 接管 B 机器人即可并存；抢同一个机器人仍是后来者赢（见 §4.2） |
| 命令回复延迟几秒 | 正常，出站限流最短间隔 2.2 秒 |
| 改了配置没生效 | 配置在可处理的 `session_start` 时重载。若旧会话仍持有 takeover，先执行 `/dingtalk release`，再开新会话并重新 takeover。`/dingtalk status` 会列实际生效的来源 |

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
