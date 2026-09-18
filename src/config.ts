/**
 * Configuration loading.
 *
 * Layered, later wins:
 *   1. built-in defaults
 *   2. `<agentDir>/dingtalk.json`   (default `~/.omp/agent/dingtalk.json`)
 *   3. `~/.omp/dingtalk.json`
 *   4. `<cwd>/.omp/dingtalk.json`   (per-project override)
 *   5. environment variables       (highest priority, handy for secrets)
 *
 * The file named by `OMP_DINGTALK_CONFIG`, when set, replaces steps 2-4.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expandHome, homeDir, truncate } from "./util";

export interface WebhookConfig {
	/** Full custom-robot webhook URL, including `access_token`. */
	url: string;
	/** `SEC...` signing secret. Empty means signing is disabled. */
	secret: string;
	/** Keyword required by the "自定义关键词" security mode. Auto-prefixed when set. */
	keyword: string;
}

export interface StreamConfig {
	/** Whether to open the inbound channel at all. */
	enabled: boolean;
	/** 企业内部应用 AppKey. */
	clientId: string;
	/** 企业内部应用 AppSecret. */
	clientSecret: string;
	/** Robot code (`dingxxxx`), needed only for proactive 1:1 pushes via OpenAPI. */
	robotCode: string;
}

export interface OutboundConfig {
	/**
	 * Which transport carries notifications.
	 *
	 *   `webhook` (default) — the custom robot in a group. Only ever posts into
	 *                        that group; a custom robot has no way to DM.
	 *   `direct`            — the enterprise-app robot pushing 1:1, via OpenAPI.
	 *                        Needs `stream.clientId` / `clientSecret` /
	 *                        `robotCode`, plus at least one recipient.
	 *   `both`              — post to the group *and* DM.
	 */
	mode: "webhook" | "direct" | "both";
}

export interface NotifyConfig {
	turnEnd: {
		enabled: boolean;
		/** Only notify for turns that ran at least this long. */
		minDurationMs: number;
	};
	sessionStop: boolean;
	sessionShutdown: boolean;
	/** Auto-retry exhaustion, disabled credentials, compaction failures. */
	errors: boolean;
	/** Whether to announce approval requests (independent of the approval gate). */
	approval: boolean;
	goalUpdated: boolean;
	toolUse: {
		enabled: boolean;
		tools: string[];
	};
	/** DingTalk phone numbers to @-mention. */
	atMobiles: string[];
	/** DingTalk userIds to @-mention (enterprise robot webhooks only). */
	atUserIds: string[];
	atAll: boolean;
	/** Hard cap on the length of a single notification body. */
	maxTextChars: number;
	/**
	 * Suppress *every* notification until DingTalk has taken this session over.
	 *
	 * The natural companion to manual takeover: nothing arrives while you are
	 * sitting at the terminal, and notifications begin the moment you run
	 * `/dingtalk takeover` — then stop again on `/dingtalk release`.
	 *
	 * This is deliberately all-or-nothing. Startup, idle, approval, error and
	 * shutdown alerts are all dropped while the session is not taken over, which
	 * includes "the model credential was disabled". `/dingtalk test` and
	 * `bun run doctor` still send, because those are explicit requests.
	 */
	onlyWhenTakenOver: boolean;
}

export interface ApprovalRule {
	/** Tool names this rule applies to. */
	tools?: string[];
	/** Regexes matched against `bash` command strings. */
	patterns?: string[];
	/** Glob-ish patterns matched against `write`/`edit` target paths. */
	paths?: string[];
	/** Shown in the approval request so you know why you are being asked. */
	label?: string;
}

export interface ApprovalConfig {
	/** `off` = never gate. `remote` = gate matching calls behind a DingTalk reply. */
	mode: "off" | "remote";
	/** How long to wait for a reply before applying `onTimeout`. */
	timeoutMs: number;
	/** What to do when nobody answers in time. */
	onTimeout: "deny" | "allow";
	/** Empty means "use the built-in dangerous-operation rules". */
	rules: ApprovalRule[];
}

export interface QuestionConfig {
	/**
	 * Forward the agent's `ask` tool to DingTalk instead of letting it open a
	 * local TUI dialog.
	 *
	 * Only takes effect while DingTalk has taken over: if the terminal dialog is
	 * reachable there is no reason to reroute it. With `control.autoTakeover:
	 * true` every session is answerable from the phone.
	 */
	enabled: boolean;
	/** How long to wait for a DingTalk reply before telling the agent to move on. */
	timeoutMs: number;
}

export interface ControlConfig {
	/** Accept inbound commands at all. */
	enabled: boolean;
	/**
	 * Which conversations are allowed to command omp.
	 *   `direct` (default) — 1:1 chats only. Group chatter is ignored entirely.
	 *   `group`            — group chats only.
	 *   `all`              — both.
	 *
	 * 1:1 is the safer default: only people who can DM the robot can reach it,
	 * and nothing said in a shared group can trigger a command by accident.
	 */
	scope: "direct" | "group" | "all";
	/** Only react when the robot is @-mentioned (group chats only). */
	requireAt: boolean;
	/**
	 * Whether to connect the inbound channel automatically at session start.
	 *
	 * `false` (default) means the plugin stays *inert* until you explicitly hand
	 * control over with `/dingtalk takeover` from inside the session. That keeps
	 * DingTalk from silently being able to drive a session you are sitting in
	 * front of — takeover becomes a deliberate act.
	 */
	autoTakeover: boolean;
	/**
	 * The one DingTalk user allowed to command this session, and the recipient
	 * of its 1:1 pushes. Empty = refuse every inbound command (fail-closed).
	 */
	allowUserId: string;
	/** Plain text (not a slash command) is injected as a prompt. */
	freeText: boolean;
	/** `steer` interrupts the current run; `followUp` waits for it to finish. */
	freeTextDelivery: "steer" | "followUp";
	/** Reply through the per-message `sessionWebhook` instead of the group robot. */
	replyToSession: boolean;
}

/**
 * The robot-specific slice of a named robot. Global session settings
 * (`notify` / `approval` / `question` / `quiet` / `enabled`) stay at the top
 * level and are shared by every robot; a named robot overrides only the parts
 * that define its own identity and access control.
 */
export interface RobotConfig {
	webhook?: Partial<WebhookConfig>;
	stream?: Partial<StreamConfig>;
	outbound?: Partial<OutboundConfig>;
	control?: Partial<ControlConfig>;
}

export interface DingTalkConfig {
	/** Master switch — lets you keep the plugin installed but inert. */
	enabled: boolean;
	webhook: WebhookConfig;
	stream: StreamConfig;
	/** Where notifications go: the group robot, 1:1 DMs, or both. */
	outbound: OutboundConfig;
	notify: NotifyConfig;
	approval: ApprovalConfig;
	question: QuestionConfig;
	control: ControlConfig;
	/** Runtime mute toggled with `/quiet`. */
	quiet: boolean;
	/**
	 * Named robots. The top-level config is the implicit `default` robot; each
	 * entry here is another robot with its own webhook / stream / outbound /
	 * control. A session picks one with `/dingtalk takeover <name>`.
	 */
	robots?: Record<string, RobotConfig>;
}

/** Valid `outbound.mode` values, in the order they should be presented. */
export const OUTBOUND_MODES = ["webhook", "direct", "both"] as const;

export const OUTBOUND_MODE_LABELS: Record<OutboundConfig["mode"], string> = {
	webhook: "群机器人（webhook）",
	direct: "单聊推送（企业内部应用机器人）",
	both: "群 + 单聊，两边都发",
};

export const DEFAULT_APPROVAL_RULES: ApprovalRule[] = [
	{
		label: "危险 shell 命令",
		tools: ["bash"],
		patterns: [
			"rm\\s+(-[a-zA-Z]*[rf][a-zA-Z]*\\s+)+",
			"\\bsudo\\b",
			"git\\s+push",
			"git\\s+reset\\s+--hard",
			"\\bgit\\s+clean\\s+-[a-z]*[fd]",
			"\\bdrop\\s+(table|database|schema)\\b",
			"\\bnpm\\s+publish\\b|\\bpnpm\\s+publish\\b|\\byarn\\s+publish\\b",
			"\\bcurl\\b[^|]*\\|\\s*(ba|z)?sh",
			"\\bwget\\b[^|]*\\|\\s*(ba|z)?sh",
			"\\bchmod\\s+777\\b",
			"\\bmkfs\\b|\\bdd\\s+if=",
			"\\bshutdown\\b|\\breboot\\b",
			"\\bkill(all)?\\s+-9",
		],
	},
	{
		label: "敏感文件写入",
		tools: ["write", "edit"],
		paths: ["**/.env", "**/.env.*", "**/id_rsa*", "**/id_ed25519*", "**/*.pem", "**/.ssh/**", "**/.npmrc", "**/.aws/**"],
	},
];

/** Valid `control.scope` values, in the order they should be presented. */
export const SCOPES = ["direct", "group", "all"] as const;
export const APPROVAL_MODES = ["off", "remote"] as const;

export const SCOPE_LABELS: Record<ControlConfig["scope"], string> = {
	direct: "仅单聊",
	group: "仅群聊",
	all: "单聊 + 群聊",
};

const DEFAULTS: DingTalkConfig = {
	enabled: true,
	webhook: { url: "", secret: "", keyword: "" },
	stream: { enabled: false, clientId: "", clientSecret: "", robotCode: "" },
	outbound: { mode: "webhook" },
	notify: {
		turnEnd: { enabled: false, minDurationMs: 60_000 },
		sessionStop: true,
		sessionShutdown: true,
		errors: true,
		approval: true,
		goalUpdated: false,
		toolUse: { enabled: false, tools: ["bash", "write", "edit"] },
		atMobiles: [],
		atUserIds: [],
		atAll: false,
		maxTextChars: 1800,
		onlyWhenTakenOver: false,
	},
	approval: {
		mode: "off",
		timeoutMs: 300_000,
		onTimeout: "deny",
		rules: [],
	},
	question: {
		enabled: true,
		timeoutMs: 600_000,
	},
	control: {
		enabled: true,
		scope: "direct",
		requireAt: true,
		autoTakeover: false,
		allowUserId: "",
		freeText: true,
		freeTextDelivery: "steer",
		replyToSession: true,
	},
	quiet: false,
	robots: {},
};

export interface LoadedConfig {
	config: DingTalkConfig;
	/** Files that actually contributed, for `/dingtalk status` and diagnostics. */
	sources: string[];
	/** Problems worth surfacing to the user (bad JSON, unreadable file). */
	warnings: string[];
}

function agentDir(): string {
	const override = process.env.PI_CODING_AGENT_DIR;
	if (override && override.trim()) return expandHome(override.trim());
	return join(homeDir(), ".omp", "agent");
}

function candidatePaths(cwd: string): string[] {
	const explicit = process.env.OMP_DINGTALK_CONFIG;
	if (explicit && explicit.trim()) return [expandHome(explicit.trim())];
	return [join(agentDir(), "dingtalk.json"), join(homeDir(), ".omp", "dingtalk.json"), join(cwd, ".omp", "dingtalk.json")];
}

function isPlainObject(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursive merge: objects merge, arrays and scalars replace. */
function merge<T>(base: T, patch: unknown): T {
	if (!isPlainObject(patch)) return base;
	const out: Record<string, any> = isPlainObject(base) ? { ...(base as Record<string, any>) } : {};
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		const current = out[key];
		if (isPlainObject(current) && isPlainObject(value)) {
			out[key] = merge(current, value);
		} else if (isPlainObject(value)) {
			out[key] = merge({}, value);
		} else {
			out[key] = value;
		}
	}
	return out as T;
}

function readJson(path: string, warnings: string[]): unknown {
	if (!existsSync(path)) return undefined;
	try {
		const raw = readFileSync(path, "utf8");
		return JSON.parse(raw);
	} catch (error) {
		warnings.push(`无法解析 ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

function envOverrides(): Record<string, any> {
	const env = process.env;
	const out: Record<string, any> = {};

	if (env.DINGTALK_WEBHOOK_URL) out.webhook = { ...out.webhook, url: env.DINGTALK_WEBHOOK_URL.trim() };
	if (env.DINGTALK_WEBHOOK_SECRET) out.webhook = { ...out.webhook, secret: env.DINGTALK_WEBHOOK_SECRET.trim() };
	if (env.DINGTALK_WEBHOOK_KEYWORD) out.webhook = { ...out.webhook, keyword: env.DINGTALK_WEBHOOK_KEYWORD.trim() };

	if (env.DINGTALK_CLIENT_ID) out.stream = { ...out.stream, clientId: env.DINGTALK_CLIENT_ID.trim() };
	if (env.DINGTALK_CLIENT_SECRET) out.stream = { ...out.stream, clientSecret: env.DINGTALK_CLIENT_SECRET.trim() };
	if (env.DINGTALK_ROBOT_CODE) out.stream = { ...out.stream, robotCode: env.DINGTALK_ROBOT_CODE.trim() };
	if (env.DINGTALK_STREAM_ENABLED) {
		out.stream = { ...out.stream, enabled: /^(1|true|yes|on)$/i.test(env.DINGTALK_STREAM_ENABLED.trim()) };
	}

	if (env.DINGTALK_OUTBOUND_MODE) {
		out.outbound = { ...out.outbound, mode: env.DINGTALK_OUTBOUND_MODE.trim() };
	}
	if (env.DINGTALK_ALLOW_USER_ID) {
		out.control = { ...out.control, allowUserId: env.DINGTALK_ALLOW_USER_ID.trim() };
	}
	if (env.DINGTALK_APPROVAL_MODE) {
		out.approval = { ...out.approval, mode: env.DINGTALK_APPROVAL_MODE.trim() };
	}
	if (env.DINGTALK_QUESTION_ENABLED) {
		out.question = { ...out.question, enabled: /^(1|true|yes|on)$/i.test(env.DINGTALK_QUESTION_ENABLED.trim()) };
	}
	if (env.DINGTALK_QUESTION_TIMEOUT_MS) {
		const parsed = Number(env.DINGTALK_QUESTION_TIMEOUT_MS.trim());
		if (Number.isFinite(parsed) && parsed > 0) {
			out.question = { ...out.question, timeoutMs: parsed };
		}
	}
	if (env.DINGTALK_CONTROL_SCOPE) {
		out.control = { ...out.control, scope: env.DINGTALK_CONTROL_SCOPE.trim() };
	}
	if (env.DINGTALK_AUTO_TAKEOVER) {
		out.control = { ...out.control, autoTakeover: /^(1|true|yes|on)$/i.test(env.DINGTALK_AUTO_TAKEOVER.trim()) };
	}
	if (env.DINGTALK_DISABLED && /^(1|true|yes|on)$/i.test(env.DINGTALK_DISABLED.trim())) {
		out.enabled = false;
	}
	return out;
}

/** The names of all configured robots, `default` first. */
export function robotNames(config: DingTalkConfig): string[] {
	return ["default", ...Object.keys(config.robots ?? {}).filter((name) => name !== "default")];
}

/**
 * Resolve the effective configuration for a named robot.
 *
 * The top-level config is the implicit `default` robot. A named robot inherits
 * every global setting and the default robot's own parts, then overrides its
 * webhook / stream / outbound / control. Shared session settings (`enabled`,
 * `notify`, `approval`, `question`, `quiet`) always come from the top level.
 */
export function resolveRobotConfig(config: DingTalkConfig, name: string): DingTalkConfig {
	if (name === "default" || !config.robots?.[name]) return config;
	const robot: RobotConfig = config.robots[name]!;
	return merge(config, {
		webhook: robot.webhook,
		stream: robot.stream,
		outbound: robot.outbound,
		control: robot.control,
	}) as DingTalkConfig;
}

/**
 * Credential / transport validation for one robot's effective config.
 * `label` names the robot for warning prefixes (`default` = no prefix).
 * Mutates `robot` in place (callers pass a resolved copy for named robots).
 */
function validateRobotTransport(robot: DingTalkConfig, label: string, warnings: string[]): void {
	const prefix = label === "default" ? "" : `[机器人 ${label}] `;

	// Empty allowUserId = every inbound command is refused (fail-closed). That
	// is the safe default, but it is surprising mid-onboarding, so say it out
	// loud.
	if (robot.control.enabled && !robot.control.allowUserId) {
		warnings.push(`${prefix}control.allowUserId 为空：除 /id 外所有入站指令都会被拒绝。把 /id 返回的 senderStaffId 填进这个字段才能控制 omp。`);
	}

	// The stream channel is only usable with real credentials.
	if (robot.stream.enabled && (!robot.stream.clientId || !robot.stream.clientSecret)) {
		warnings.push(`${prefix}stream.enabled 为 true，但缺少 clientId / clientSecret，入站控制通道不会启动。`);
		robot.stream.enabled = false;
	}

	// Report each unusable transport by name, so "why am I getting no
	// notifications" is answerable from the warnings alone.
	const wantsWebhook = robot.outbound.mode === "webhook" || robot.outbound.mode === "both";
	const wantsDirect = robot.outbound.mode === "direct" || robot.outbound.mode === "both";
	const hasDirectCreds = Boolean(robot.stream.clientId && robot.stream.clientSecret && robot.stream.robotCode);

	if (wantsWebhook && !robot.webhook.url) {
		warnings.push(`${prefix}outbound.mode 含 "webhook"，但 webhook.url 为空：群通知发不出去。`);
	}
	if (wantsDirect && !hasDirectCreds) {
		warnings.push(`${prefix}outbound.mode 含 "direct"，但缺少 stream.clientId / clientSecret / robotCode：单聊推送发不出去。`);
	} else if (wantsDirect && !robot.control.allowUserId) {
		warnings.push(`${prefix}outbound.mode 含 "direct"，但 control.allowUserId 为空：没有推送对象（白名单的这一个人就是推送收件人）。`);
	}

	// Nothing can be sent without a usable outbound transport, and nothing can be
	// received without the stream — report that clearly instead of failing silently.
	const anyOutbound = (wantsWebhook && Boolean(robot.webhook.url)) || (wantsDirect && hasDirectCreds);
	if (!anyOutbound && !robot.stream.enabled) {
		warnings.push(`${prefix}出站和入站都没有可用配置：插件不会发送也不会接收任何消息。`);
	}
}

/** Load and validate the effective configuration for `cwd`. */
export function loadConfig(cwd: string): LoadedConfig {
	const warnings: string[] = [];
	const sources: string[] = [];
	let config = merge(DEFAULTS, {});

	for (const path of candidatePaths(cwd)) {
		const parsed = readJson(path, warnings);
		if (parsed === undefined) continue;
		config = merge(config, parsed);
		sources.push(path);
	}

	const fromEnv = envOverrides();
	if (Object.keys(fromEnv).length > 0) {
		config = merge(config, fromEnv);
		sources.push("environment");
	}

	// Normalize a few fields that are easy to get subtly wrong in JSON.
	config.webhook.url = String(config.webhook.url ?? "").trim();
	config.webhook.secret = String(config.webhook.secret ?? "").trim();
	config.webhook.keyword = String(config.webhook.keyword ?? "").trim();
	config.stream.clientId = String(config.stream.clientId ?? "").trim();
	config.stream.clientSecret = String(config.stream.clientSecret ?? "").trim();
	config.stream.robotCode = String(config.stream.robotCode ?? "").trim();
	config.approval.rules = Array.isArray(config.approval.rules) ? config.approval.rules : [];
	config.question.enabled = config.question.enabled !== false;
	const rawQuestionTimeout = config.question.timeoutMs as unknown;
	if (typeof rawQuestionTimeout !== "number" || !Number.isFinite(rawQuestionTimeout) || rawQuestionTimeout <= 0) {
		warnings.push("question.timeoutMs 无效，已回退为 600000（10 分钟）。");
		config.question.timeoutMs = 600_000;
	}
	// Migration: a single `allowUserId` replaced the old `allowUserIds` array and
	// `outbound.directUserIds` (the allowlist now doubles as the push recipient).
	// Read the old keys once so an existing config does not silently fail closed,
	// and warn whenever they are still there — a file carrying both is half-migrated.
	const legacyControl = config.control as unknown as Record<string, unknown>;
	const legacyOutbound = config.outbound as unknown as Record<string, unknown>;
	if (legacyControl.allowUserIds !== undefined || legacyOutbound.directUserIds !== undefined) {
		const pick = (value: unknown): string =>
			Array.isArray(value) ? String(value.find((v) => typeof v === "string" && v.trim()) ?? "").trim() : "";
		let migrated = "";
		if (!config.control.allowUserId) {
			migrated = pick(legacyControl.allowUserIds) || pick(legacyOutbound.directUserIds);
			if (migrated) config.control.allowUserId = migrated;
		}
		warnings.push(
			migrated
				? "旧版 control.allowUserIds / outbound.directUserIds 已迁移到 control.allowUserId（取第一个值）。请删掉旧字段。"
				: config.control.allowUserId
					? "配置里还留着旧版 control.allowUserIds / outbound.directUserIds，已被忽略；现在生效的是 control.allowUserId。请删掉旧字段。"
					: "检测到旧版 control.allowUserIds / outbound.directUserIds，但里面没有可用的 ID；请把 /id 返回的 senderStaffId 填进 control.allowUserId。",
		);
	}
	config.control.allowUserId = typeof config.control.allowUserId === "string" ? config.control.allowUserId.trim() : "";
	config.notify.onlyWhenTakenOver = config.notify.onlyWhenTakenOver === true;

	// A typo in `outbound.mode` must not silently pick a transport for you.
	const rawOutboundMode = config.outbound.mode as unknown;
	if (typeof rawOutboundMode !== "string" || !(OUTBOUND_MODES as readonly string[]).includes(rawOutboundMode)) {
		if (rawOutboundMode !== undefined) {
			warnings.push(`outbound.mode 的值 ${JSON.stringify(rawOutboundMode)} 无效，已回退为 "webhook"（群机器人）。`);
		}
		config.outbound.mode = "webhook";
	}

	// A typo in `scope` must not silently widen (or narrow) who can command omp.
	const rawScope = config.control.scope as unknown;
	if (typeof rawScope !== "string" || !(SCOPES as readonly string[]).includes(rawScope)) {
		if (rawScope !== undefined) {
			warnings.push(`control.scope 的值 ${JSON.stringify(rawScope)} 无效，已回退为 "direct"（仅单聊）。`);
		}
		config.control.scope = "direct";
	}
	// A typo in `approval.mode` must not silently disable the approval gate —
	// same treatment as scope / outbound.mode.
	const rawApprovalMode = config.approval.mode as unknown;
	if (typeof rawApprovalMode !== "string" || !(APPROVAL_MODES as readonly string[]).includes(rawApprovalMode)) {
		if (rawApprovalMode !== undefined) {
			warnings.push(`approval.mode 的值 ${JSON.stringify(rawApprovalMode)} 无效，已回退为 "off"（只通知不拦截）。`);
		}
		config.approval.mode = "off";
	}
	config.control.requireAt = config.control.requireAt !== false;
	config.control.autoTakeover = config.control.autoTakeover === true;

	// Validate the default robot's credentials, then each named robot on its
	// own resolved copy (resolveRobotConfig deep-copies, so fixing a named
	// robot's stream.enabled=false never mutates the shared config).
	validateRobotTransport(config, "default", warnings);
	for (const name of Object.keys(config.robots ?? {})) {
		validateRobotTransport(resolveRobotConfig(config, name), name, warnings);
	}

	// "Silent until takeover" plus a takeover that can never happen is permanently silent —
	// the worst possible failure mode, because it looks like nothing is wrong.
	if (config.notify.onlyWhenTakenOver && !(config.enabled && config.control.enabled && config.stream.enabled)) {
		warnings.push(
			"notify.onlyWhenTakenOver 为 true，但当前无法接管" +
				"（需要 enabled / control.enabled / stream.enabled 同时为 true 且 stream 凭据齐全）：" +
				"这样一条通知也不会有。",
		);
	}

	return { config, sources, warnings };
}

/** Redact secrets so the status output is safe to paste into a chat. */
export function describeConfig(loaded: LoadedConfig): string[] {
	const { config } = loaded;
	const mask = (value: string) => (value ? `${truncate(value, 8)}…(${value.length})` : "(未设置)");
	const token = (() => {
		try {
			return new URL(config.webhook.url).searchParams.get("access_token") ?? "";
		} catch {
			return "";
		}
	})();

	return [
		`插件启用: ${config.enabled ? "是" : "否"}`,
		`出站通道: ${OUTBOUND_MODE_LABELS[config.outbound.mode] ?? config.outbound.mode}`,
		`出站 webhook: ${config.webhook.url ? "已配置" : "未配置"} (token ${mask(token)})`,
		`加签密钥: ${mask(config.webhook.secret)}`,
		`关键词: ${config.webhook.keyword || "(未设置)"}`,
		`单聊收件人: ${config.control.allowUserId || "(空)"}`,
		`入站 Stream: ${config.stream.enabled ? "已启用" : "未启用"} (clientId ${mask(config.stream.clientId)})`,
		`控制范围: ${SCOPE_LABELS[config.control.scope] ?? config.control.scope}`,
		`接管方式: ${config.control.autoTakeover ? "会话启动时自动接管" : "需在会话内执行 /dingtalk takeover"}`,
		`审批模式: ${config.approval.mode}`,
	`远程提问: ${config.question.enabled ? `已启用（超时 ${Math.round(config.question.timeoutMs / 1000)}s）` : "已关闭"}`,
		`指令白名单: ${config.control.allowUserId || "(空 — 拒绝所有指令)"}`,
		`静音: ${config.quiet ? "是" : "否"}`,
		`接管前静默: ${config.notify.onlyWhenTakenOver ? "是（接管后才开始发通知）" : "否"}`,
		`配置来源: ${loaded.sources.length ? loaded.sources.join(" | ") : "(全部使用默认值)"}`,
	];
}
