#!/usr/bin/env bun
/**
 * 配置自检 —— 不需要模型凭据，不需要启动 omp 会话。
 *
 * 直接读你真实的配置文件，然后：
 *   1. 打印生效配置（脱敏）与配置来源
 *   2. 真发一条测试消息到钉钉，验证出站通道（加签 / 关键词 / token 全链路）
 *   3. 真去钉钉网关换取 Stream 接入点并等 REGISTERED，验证入站通道凭据
 *
 * 用法：
 *   bun run doctor              完整自检
 *   bun run doctor --no-send    只验入站，不往群里发测试消息
 *   bun run doctor --stream-only
 */
import { OUTBOUND_MODE_LABELS, describeConfig, loadConfig, type DingTalkConfig } from "../src/config";
import { DingTalkSender, type SendResult } from "../src/dingtalk";
import { TakeoverLock } from "../src/lock";
import { createLogger } from "../src/logger";
import { DingTalkStream, type StreamStatus } from "../src/stream";

const args = process.argv.slice(2);
const skipSend = args.includes("--no-send");
const streamOnly = args.includes("--stream-only");

const GREEN = "\u001b[32m";
const RED = "\u001b[31m";
const YELLOW = "\u001b[33m";
const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";
const RESET = "\u001b[0m";

const ok = (text: string) => console.log(`${GREEN}✔${RESET} ${text}`);
const bad = (text: string) => console.log(`${RED}✘${RESET} ${text}`);
const warn = (text: string) => console.log(`${YELLOW}!${RESET} ${text}`);
const info = (text: string) => console.log(`  ${DIM}${text}${RESET}`);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 把常见错误码翻译成能直接照做的建议。 */
function explainWebhookError(errcode: number | undefined, errmsg: string | undefined): string[] {
	switch (errcode) {
		case 310000:
			return [
				"钉钉安全校验没过。两种可能：",
				"  · 机器人设的是「加签」，但 webhook.secret 没填或填错（必须是 SEC 开头那串）",
				"  · 机器人设的是「自定义关键词」，但 webhook.keyword 没填",
			];
		case 300001:
		case 300005:
			return ["webhook 的 access_token 无效，或机器人已被移出群。回群里重新复制一次 Webhook 地址。"];
		case 410100:
			return ["触发了钉钉限流（20 条/分钟）。等 10 分钟再试。"];
		default:
			return [`钉钉返回：errcode=${errcode ?? "?"} errmsg=${errmsg ?? "(空)"}`];
	}
}

/** 按 mode 说明「为什么一条都发不出去」。 */
function explainOutboundGap(cfg: DingTalkConfig): string[] {
	const lines: string[] = [];
	const wantsWebhook = cfg.outbound.mode === "webhook" || cfg.outbound.mode === "both";
	const wantsDirect = cfg.outbound.mode === "direct" || cfg.outbound.mode === "both";

	if (wantsWebhook && !cfg.webhook.url) {
		lines.push("· webhook.url 为空：群设置 → 智能群助手 → 添加机器人 → 自定义机器人，复制 Webhook 地址。");
	}
	if (wantsDirect) {
		const { clientId, clientSecret, robotCode } = cfg.stream;
		if (!clientId || !clientSecret || !robotCode) {
			lines.push("· 单聊推送要 stream.clientId / clientSecret / robotCode 三样齐全（robotCode 在机器人详情页，ding 开头）。");
		} else if (!cfg.control.allowUserId) {
			lines.push("· control.allowUserId 为空：把 /id 返回的 senderStaffId 填进这个字段才有推送对象。");
		}
	}
	if (lines.length === 0) {
		lines.push("· outbound.mode 只能是 webhook / direct / both，检查有没有拼错。");
	}
	return lines;
}

/** 发送失败的解读：单聊推送走的是 OpenAPI，错误形态和 webhook 完全不同。 */
function explainSendError(result: SendResult, cfg: DingTalkConfig): string[] {
	if ((cfg.outbound.mode === "direct" || cfg.outbound.mode === "both") && /^HTTP \d/.test(String(result.errmsg ?? ""))) {
		return [
			"单聊推送被钉钉拒绝了。常见原因：",
			"  · 应用没开「机器人发送消息」权限，或该用户不在应用可见范围内",
			`  · 原始响应：${result.errmsg}`,
		];
	}
	return explainWebhookError(result.errcode, result.errmsg);
}

/** 按 control.scope 说明「该去哪跟机器人说话」。 */
function whereToTalk(cfg: DingTalkConfig): string {
	switch (cfg.control.scope) {
		case "group":
			return "群里 @机器人 ";
		case "all":
			return "单聊或群里 @机器人 ";
		default:
			return "单聊里 ";
	}
}

console.log(`\n${BOLD}omp-dingtalk 配置自检${RESET}\n${"─".repeat(60)}`);

// ---------------------------------------------------------------- 1. 配置
const loaded = loadConfig(process.cwd());
const { config } = loaded;

console.log(`\n${BOLD}[1/3] 读取配置${RESET}`);
if (loaded.sources.length === 0) {
	warn("没有找到任何配置文件，当前全部使用默认值。");
	info("把 config.example.json 复制到 ~/.omp/dingtalk.json 后重新运行。");
} else {
	ok(`配置来源 ${loaded.sources.length} 处`);
	for (const source of loaded.sources) info(source);
}
for (const warning of loaded.warnings) warn(warning);

console.log();
for (const line of describeConfig(loaded)) info(line.replace(/\*\*/g, ""));

let failures = 0;

// ------------------------------------------------------------- 2. 出站
console.log(`\n${BOLD}[2/3] 出站通道（通知）${RESET}`);
const sender = new DingTalkSender(config, createLogger(undefined));
if (streamOnly) {
	info("已跳过（--stream-only）");
} else if (!sender.configured) {
	bad(`当前没有可用的出站通道（outbound.mode = ${config.outbound.mode}）—— 你收不到任何通知。`);
	for (const line of explainOutboundGap(config)) info(line);
	failures += 1;
} else if (skipSend) {
	info(`通道：${OUTBOUND_MODE_LABELS[config.outbound.mode] ?? config.outbound.mode}`);
	info("已跳过实际发送（--no-send）");
} else {
	info(`通道：${OUTBOUND_MODE_LABELS[config.outbound.mode] ?? config.outbound.mode}`);
	console.log(`  ${DIM}正在发送测试消息…${RESET}`);
	const result = await sender.send({
		title: "omp-dingtalk 自检",
		text: [
			"## 👋 出站通道正常",
			"",
			config.outbound.mode === "direct"
				? "如果你在钉钉单聊里看到这条消息，说明单聊推送配对了。"
				: "如果你在钉钉里看到这条消息，说明 webhook、加签/关键词都配对了。",
			"",
			`- 目录：\`${process.cwd()}\``,
			`- 时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
		].join("\n"),
		priority: "high",
	});
	if (result.ok) {
		ok("测试消息已发送 —— 去钉钉确认一下能看到。");
	} else {
		bad(`发送失败：${result.errmsg ?? "未知错误"}`);
		for (const line of explainSendError(result, config)) info(line);
		failures += 1;
	}
}

// ------------------------------------------------------------- 3. 入站
console.log(`\n${BOLD}[3/3] 入站通道（控制）${RESET}`);
if (!config.stream.enabled) {
	warn("stream 未启用 —— 你只能收通知，不能在钉钉里指挥 omp。");
	info("要开通：钉钉开放平台建「企业内部应用」→ 添加「机器人」能力 → 选 Stream 模式 → 发布 →");
	info("把 ClientID / ClientSecret 填进 stream.clientId / stream.clientSecret，并设 stream.enabled = true。");
} else {
	// This probe opens a second live Stream connection for the same app. If a
	// session is already taken over, the two coexist for the duration of the
	// check — DingTalk may hand this probe a message meant for that session. Say
	// so up front rather than letting the user discover it the hard way.
	const lock = new TakeoverLock(config.stream.clientId, createLogger(undefined));
	const holder = lock.readOwner();
	let holderAlive = false;
	if (holder) {
		try {
			process.kill(holder.pid, 0);
			holderAlive = true;
		} catch (error) {
			holderAlive = (error as NodeJS.ErrnoException).code === "EPERM";
		}
	}
	if (holder && holderAlive) {
		warn(`另一个会话正在接管（目录 ${holder.cwd || "?"} · PID ${holder.pid}）—— 本次自检的连接会与它并存。`);
		info("自检期间钉钉可能把消息推给这里而不是那个会话。要避免就先在那边 /dingtalk release。");
		info(`锁文件：${lock.path}`);
	} else if (holder) {
		warn(`发现一个失效的接管锁（PID ${holder.pid} 已不在）—— 下一个 takeover 会自动回收它。`);
		info(`锁文件：${lock.path}`);
	} else {
		ok("当前没有其他会话在接管。");
	}

	const statuses: StreamStatus[] = [];
	const stream = new DingTalkStream({
		clientId: config.stream.clientId,
		clientSecret: config.stream.clientSecret,
		logger: createLogger(undefined),
		onMessage: async () => {
			/* 自检不处理消息 */
		},
		onStatus: (status) => statuses.push(status),
	});

	console.log(`  ${DIM}正在向钉钉网关换取接入点…${RESET}`);
	stream.start();

	const deadline = Date.now() + 25_000;
	let state = stream.status.state;
	while (Date.now() < deadline) {
		state = stream.status.state;
		if (state === "registered" || state === "error") break;
		await sleep(250);
	}
	const finalStatus = stream.status;
	stream.stop();

	if (state === "registered") {
		ok("Stream 已注册成功 —— 入站通道可用。");
		info(`${whereToTalk(config)}给机器人发 /ping 就能测通。`);
	} else if (state === "connected") {
		ok("WebSocket 已连上 —— 凭据有效，入站通道可用。");
		info("实测钉钉不一定会推 REGISTERED 帧，能连上就说明鉴权通过了。");
		info(`想确认真能收到消息：另开一个终端跑 \`bun run watch\`，再去${whereToTalk(config)}发一条。`);
	} else {
		bad(`入站通道未建立（最终状态：${state}）`);
		if (finalStatus.lastError) info(`错误：${finalStatus.lastError}`);
		info("常见原因：");
		info("  · ClientID / ClientSecret 填错，或应用没「发布」");
		info("  · 应用没添加「机器人」能力，或机器人接收模式不是 Stream");
		info("  · 公司代理拦截 —— 给进程设 HTTPS_PROXY 再试");
		failures += 1;
	}
}

// ------------------------------------------------------------- 结论
console.log(`\n${"─".repeat(60)}`);
if (failures === 0) {
	console.log(`${GREEN}${BOLD}自检通过${RESET} —— 可以正常用了。`);
	console.log(`\n下一步：`);
	console.log(`  1. ${whereToTalk(config)}发 ${BOLD}/id${RESET}，拿到 senderStaffId`);
	console.log(`  2. 填进 control.allowUserId（否则谁都能控制你的 omp）`);
	if (config.outbound.mode === "direct" && !config.control.allowUserId) {
		console.log(`  3. allowUserId 那个人就是单聊推送收件人`);
	}
	console.log(`  4. 正常启动 omp，用 /dingtalk status 看运行状态；入站要等 /dingtalk takeover 才会接通`);
} else {
	console.log(`${RED}${BOLD}有 ${failures} 项没通过${RESET} —— 按上面的提示改完再跑一次：bun run doctor`);
}
console.log();
process.exit(failures === 0 ? 0 : 1);
