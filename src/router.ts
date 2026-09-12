/**
 * Inbound routing: DingTalk message → OMP action.
 *
 * Also owns the approval registry, because approvals are the one flow where the
 * inbound and outbound paths have to rendezvous: a `tool_call` blocks while the
 * registry waits for a reply that only the router can deliver.
 */
import type { DingTalkConfig } from "./config";
import { DingTalkSender } from "./dingtalk";
import { fmtHelp, fmtQuiet, fmtStatus, fmtText, type Message } from "./format";
import type { Logger } from "./logger";
import { robotMessageText, type RobotMessage } from "./stream";
import { humanDuration, shortId, truncate } from "./util";

export type ApprovalDecision = "approve" | "deny" | "timeout";

export interface PendingApproval {
	id: string;
	toolName: string;
	reason: string;
	detail: string;
	createdAt: number;
}

interface PendingEntry extends PendingApproval {
	settle: (decision: ApprovalDecision) => void;
}

/** Holds in-flight approval requests until a DingTalk reply settles them. */
export class ApprovalRegistry {
	#log: Logger;
	#pending = new Map<string, PendingEntry>();
	#latest: string | undefined;

	constructor(logger: Logger) {
		this.#log = logger;
	}

	get size(): number {
		return this.#pending.size;
	}

	list(): PendingApproval[] {
		return [...this.#pending.values()].map(({ settle: _settle, ...rest }) => rest);
	}

	/**
	 * Register a request and wait for a decision. Always resolves — a timeout
	 * falls back to `onTimeout`, and `clear()` (session shutdown) resolves as deny.
	 */
	request(options: {
		toolName: string;
		reason: string;
		detail: string;
		timeoutMs: number;
		onTimeout: "deny" | "allow";
		onRequested?: (approval: PendingApproval) => void;
	}): Promise<ApprovalDecision> {
		const id = this.#uniqueId();
		let timer: ReturnType<typeof setTimeout> | undefined;

		return new Promise<ApprovalDecision>((resolve) => {
			let settled = false;
			const finish = (decision: ApprovalDecision) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				this.#pending.delete(id);
				if (this.#latest === id) this.#latest = undefined;
				resolve(decision);
			};

			const entry: PendingEntry = {
				id,
				toolName: options.toolName,
				reason: options.reason,
				detail: options.detail,
				createdAt: Date.now(),
				settle: finish,
			};
			this.#pending.set(id, entry);
			this.#latest = id;

			timer = setTimeout(() => {
				this.#log.info(`审批 ${id} 超时，按 ${options.onTimeout} 处理`);
				finish(options.onTimeout === "allow" ? "approve" : "timeout");
			}, Math.max(5_000, options.timeoutMs));
			timer.unref?.();

			options.onRequested?.({ id, toolName: entry.toolName, reason: entry.reason, detail: entry.detail, createdAt: entry.createdAt });
		});
	}

	/** Settle a request by explicit id, or the most recent one when id is omitted. */
	resolve(target: string | undefined, decision: "approve" | "deny"): { ok: boolean; approval?: PendingApproval; error?: string } {
		const id = (target ?? "").trim().toUpperCase() || this.#latest;
		if (!id) return { ok: false, error: "当前没有待审批的请求" };
		const entry = this.#pending.get(id);
		if (!entry) {
			const known = [...this.#pending.keys()];
			return { ok: false, error: known.length ? `找不到编号 ${id}，当前待审批：${known.join(", ")}` : `找不到编号 ${id}` };
		}
		const { settle: _settle, ...approval } = entry;
		entry.settle(decision);
		return { ok: true, approval };
	}

	/** Resolve everything as denied — used when the session goes away. */
	clear(reason: string): void {
		for (const entry of [...this.#pending.values()]) {
			this.#log.info(`审批 ${entry.id} 因 ${reason} 自动拒绝`);
			entry.settle("deny");
		}
		this.#pending.clear();
		this.#latest = undefined;
	}

	#uniqueId(): string {
		for (let i = 0; i < 50; i += 1) {
			const id = shortId();
			if (!this.#pending.has(id)) return id;
		}
		return `${shortId()}${shortId()}`;
	}
}

/** Minimal structural view of the injected extension API. */
export interface ApiLike {
	sendUserMessage: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => void;
	setModel?: (model: unknown) => Promise<boolean>;
	getActiveTools?: () => string[];
	getSessionName?: () => string | undefined;
}

/** Minimal structural view of the handler context. */
export interface CtxLike {
	abort?: () => void;
	compact?: (instructions?: string) => Promise<void>;
	isIdle?: () => boolean;
	hasPendingMessages?: () => boolean;
	models?: { resolve: (spec: string) => unknown; current: () => unknown };
	model?: { id?: string; provider?: string } | undefined;
	cwd?: string;
}

export interface RouterDeps {
	cfg: DingTalkConfig;
	log: Logger;
	sender: DingTalkSender;
	approvals: ApprovalRegistry;
	pi: ApiLike;
	getCtx: () => CtxLike | undefined;
	/** Extra lines for `/status` supplied by the extension entrypoint. */
	statusLines: () => string[];
	isQuiet: () => boolean;
	setQuiet: (value: boolean) => void;
	/**
	 * Called for every sender that cleared the allowlist.
	 *
	 * Used to learn 1:1 notification recipients. Deliberately *after* the
	 * allowlist check: a stranger must not be able to subscribe themselves to the
	 * session's notifications just by messaging the robot.
	 */
	onAuthorizedSender?: (senderId: string, nick?: string) => void;
}

/** Words that must appear alone, so "stop the server" stays a prompt, not an abort. */
const APPROVE_WORDS = new Set(["approve", "ok", "yes", "y", "同意", "批准", "通过"]);
const DENY_WORDS = new Set(["deny", "no", "n", "reject", "拒绝", "驳回", "不批准"]);
const STOP_WORDS = new Set(["stop", "abort", "cancel", "停止", "中断", "取消"]);
const STATUS_WORDS = new Set(["status", "状态"]);
const HELP_WORDS = new Set(["help", "?", "h", "帮助", "菜单"]);
const TOOLS_WORDS = new Set(["tools", "工具"]);

export class CommandRouter {
	#deps: RouterDeps;

	constructor(deps: RouterDeps) {
		this.#deps = deps;
	}

	async handle(message: RobotMessage): Promise<void> {
		const text = robotMessageText(message);
		const { cfg, log } = this.#deps;

		// Defense in depth: the stream is only opened after a takeover, but a
		// stale socket must never be able to drive the session either.
		if (!cfg.enabled || !cfg.control.enabled) {
			log.debug("入站控制已关闭，忽略消息");
			return;
		}

		// Conversation scope first: with the default `direct` scope a shared group
		// can never command omp, no matter who is in it or how they phrase it.
		const isGroup = message.conversationType === "2";
		const scope = cfg.control.scope;
		if (scope === "direct" && isGroup) {
			log.debug("忽略群聊消息（control.scope = direct）", { conversationId: message.conversationId });
			return;
		}
		if (scope === "group" && !isGroup) {
			log.debug("忽略单聊消息（control.scope = group）", { conversationId: message.conversationId });
			return;
		}

		// Group chats: stay silent unless actually @-mentioned.
		if (isGroup && cfg.control.requireAt && message.isInAtList === false) {
			return;
		}

		const senderId = message.senderStaffId || message.senderId || "";
		const allow = cfg.control.allowUserIds;
		if (allow.length > 0 && !allow.includes(senderId)) {
			log.warn("拒绝未授权指令", { senderId, nick: message.senderNick });
			await this.#reply(message, fmtText("⛔ 未授权", `你的 senderStaffId 是 \`${senderId || "未知"}\`，不在白名单中。`));
			return;
		}

		// Authorized: remember them as a 1:1 notification recipient. Runs even for
		// empty messages, so `/id` is not the only way to register yourself.
		try {
			this.#deps.onAuthorizedSender?.(senderId, message.senderNick);
		} catch (error) {
			log.debug("记录通知收件人失败", error);
		}

		if (!text) {
			await this.#reply(message, fmtText("👋 收到空消息", "发 **帮助** 查看可用指令。"));
			return;
		}

		log.info("收到指令", { text: truncate(text, 120), from: message.senderNick ?? senderId });

		const [head, ...tail] = text.split(/\s+/);
		const word = head.toLowerCase().replace(/^\//, "");
		const rest = tail.join(" ").trim();

		try {
			if (APPROVE_WORDS.has(word) || DENY_WORDS.has(word)) {
				await this.#handleApproval(message, word, rest);
				return;
			}
			if (STOP_WORDS.has(word) && !rest) {
				await this.#handleStop(message);
				return;
			}
			if (STATUS_WORDS.has(word) && !rest) {
				await this.#handleStatus(message);
				return;
			}
			if (HELP_WORDS.has(word) && !rest) {
				await this.#reply(message, fmtHelp());
				return;
			}
			if (TOOLS_WORDS.has(word) && !rest) {
				await this.#handleTools(message);
				return;
			}
			switch (word) {
				case "follow":
					await this.#handlePrompt(message, rest, "followUp");
					return;
				case "compact":
					await this.#handleCompact(message, rest);
					return;
				case "model":
					await this.#handleModel(message, rest);
					return;
				case "quiet":
					await this.#handleQuiet(message, rest);
					return;
				case "ping":
					await this.#reply(message, fmtText("🏓 pong", `omp 在线，接收正常。`));
					return;
				case "id":
					await this.#handleId(message, senderId);
					return;
				default:
					break;
			}

			// Anything else is a prompt for the agent.
			await this.#handlePrompt(message, text, this.#deps.cfg.control.freeTextDelivery);
		} catch (error) {
			this.#deps.log.error("处理指令失败", error);
			await this.#reply(
				message,
				fmtText("❌ 指令执行失败", `\`\`\`\n${truncate(error instanceof Error ? error.message : String(error), 600)}\n\`\`\``),
			);
		}
	}

	async #handleApproval(message: RobotMessage, word: string, rest: string): Promise<void> {
		const approve = APPROVE_WORDS.has(word);
		const target = rest ? rest.split(/\s+/)[0] : undefined;
		const result = this.#deps.approvals.resolve(target, approve ? "approve" : "deny");
		if (!result.ok) {
			await this.#reply(message, fmtText("⚠️ 没有匹配的审批", result.error ?? ""));
			return;
		}
		const approval = result.approval!;
		await this.#reply(
			message,
			fmtText(
				approve ? `✅ 已批准 ${approval.id}` : `⛔ 已拒绝 ${approval.id}`,
				`\`${approval.toolName}\` · 由 ${message.senderNick ?? message.senderStaffId ?? "?"} 处理`,
			),
		);
	}

	async #handleStop(message: RobotMessage): Promise<void> {
		const ctx = this.#deps.getCtx();
		if (!ctx?.abort) {
			await this.#reply(message, fmtText("⚠️ 无法中断", "当前没有可用的会话上下文。"));
			return;
		}
		const idle = ctx.isIdle?.() ?? false;
		ctx.abort();
		await this.#reply(
			message,
			fmtText(idle ? "ℹ️ omp 本来就空闲" : "🛑 已发送中断信号", idle ? "没有正在执行的任务。" : "当前轮次会被打断。"),
		);
	}

	async #handleStatus(message: RobotMessage): Promise<void> {
		const ctx = this.#deps.getCtx();
		const model = ctx?.model ? `${ctx.model.provider ?? "?"}/${ctx.model.id ?? "?"}` : "(未知)";
		const lines = [
			`- **目录**: \`${truncate(ctx?.cwd ?? "(未知)", 120)}\``,
			`- **模型**: \`${model}\``,
			`- **空闲**: ${ctx?.isIdle ? (ctx.isIdle() ? "是" : "否（正在执行）") : "(未知)"}`,
			`- **排队消息**: ${ctx?.hasPendingMessages ? (ctx.hasPendingMessages() ? "有" : "无") : "(未知)"}`,
			`- **静音**: ${this.#deps.isQuiet() ? "是" : "否"}`,
			...this.#deps.statusLines(),
		];
		await this.#reply(message, fmtStatus({ lines, pending: this.#deps.approvals.list().map((a) => ({ id: a.id, toolName: a.toolName, ageMs: Date.now() - a.createdAt })) }));
	}

	async #handleTools(message: RobotMessage): Promise<void> {
		const tools = this.#deps.pi.getActiveTools?.() ?? [];
		await this.#reply(
			message,
			fmtText(`🧰 当前启用 ${tools.length} 个工具`, tools.map((t) => `- \`${t}\``).join("\n") || "(无)"),
		);
	}

	async #handlePrompt(message: RobotMessage, text: string, delivery: "steer" | "followUp"): Promise<void> {
		if (!this.#deps.cfg.control.freeText) {
			await this.#reply(message, fmtText("ℹ️ 自由文本已关闭", "只能使用指令，发 **帮助** 查看。"));
			return;
		}
		if (!text.trim()) {
			await this.#reply(message, fmtText("⚠️ 内容为空", "用法：`/follow 你的指令`"));
			return;
		}
		const ctx = this.#deps.getCtx();
		const idle = ctx?.isIdle?.() ?? true;
		this.#deps.pi.sendUserMessage(text, { deliverAs: delivery });

		const how = idle ? "已开始执行" : delivery === "steer" ? "已插入当前轮次（会打断）" : "已排队，等当前轮次结束";
		await this.#reply(message, fmtText("📨 已投递给 omp", `${how}\n\n> ${truncate(text, 300)}`));
	}

	async #handleCompact(message: RobotMessage, instructions: string): Promise<void> {
		const ctx = this.#deps.getCtx();
		if (!ctx?.compact) {
			await this.#reply(message, fmtText("⚠️ 无法压缩", "当前上下文不支持 compact。"));
			return;
		}
		await this.#reply(message, fmtText("🗜 开始压缩上下文", instructions ? `说明：${truncate(instructions, 200)}` : "使用默认摘要提示词。"));
		try {
			await ctx.compact(instructions || undefined);
		} catch (error) {
			this.#deps.log.error("compact 失败", error);
		}
	}

	async #handleModel(message: RobotMessage, spec: string): Promise<void> {
		if (!spec) {
			const current = this.#deps.getCtx()?.model;
			await this.#reply(
				message,
				fmtText("🧠 当前模型", `\`${current ? `${current.provider ?? "?"}/${current.id ?? "?"}` : "(未知)"}\`\n\n用法：\`/model opus\``),
			);
			return;
		}
		const ctx = this.#deps.getCtx();
		const model = ctx?.models?.resolve(spec);
		if (!model) {
			await this.#reply(message, fmtText("⚠️ 找不到模型", `\`${truncate(spec, 80)}\` 没有匹配项。`));
			return;
		}
		if (!this.#deps.pi.setModel) {
			await this.#reply(message, fmtText("⚠️ 不支持切换", "当前扩展 API 未暴露 setModel。"));
			return;
		}
		const ok = await this.#deps.pi.setModel(model);
		await this.#reply(
			message,
			ok
				? fmtText("✅ 模型已切换", `\`${truncate(spec, 80)}\``)
				: fmtText("⚠️ 切换失败", `\`${truncate(spec, 80)}\` 缺少可用的 API Key。`),
		);
	}

	async #handleQuiet(message: RobotMessage, arg: string): Promise<void> {
		const value = arg.trim().toLowerCase();
		const on = value ? ["on", "1", "true", "yes", "开", "开启"].includes(value) : !this.#deps.isQuiet();
		this.#deps.setQuiet(on);
		await this.#reply(message, fmtQuiet(on));
	}

	async #handleId(message: RobotMessage, senderId: string): Promise<void> {
		const scope = this.#deps.cfg.control.scope;
		await this.#reply(
			message,
			fmtText(
				"🪪 你的身份",
				[
					`- **senderStaffId**: \`${senderId || "(空)"}\``,
					`- **昵称**: ${message.senderNick ?? "(未知)"}`,
					`- **会话类型**: ${message.conversationType === "1" ? "单聊" : "群聊"}`,
					`- **会话 ID**: \`${truncate(message.conversationId ?? "", 80)}\``,
					``,
					`把 senderStaffId 填进 \`control.allowUserIds\` 即可锁定只有你能控制。`,
					scope === "direct"
						? `当前 \`control.scope = "direct"\`，只有单聊消息会被处理。`
						: `当前 \`control.scope = "${scope}"\`。`,
				].join("\n"),
			),
		);
	}

	/** Prefer replying in the originating conversation; fall back to the group robot. */
	async #reply(message: RobotMessage, payload: Message): Promise<void> {
		const { sender, cfg, log } = this.#deps;
		if (cfg.control.replyToSession && message.sessionWebhook) {
			const result = await sender.replyToSession(
				message.sessionWebhook,
				payload.title,
				payload.text,
				message.sessionWebhookExpiredTime,
			);
			if (result.ok) return;
			log.debug(`sessionWebhook 回复失败，回落到群机器人: ${result.errmsg}`);
		}
		await sender.send({ title: payload.title, text: payload.text, priority: "high" });
	}
}
