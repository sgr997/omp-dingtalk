/**
 * Inbound routing: DingTalk message → OMP action.
 *
 * Also owns the approval registry, because approvals are the one flow where the
 * inbound and outbound paths have to rendezvous: a `tool_call` blocks while the
 * registry waits for a reply that only the router can deliver.
 */
import type { DingTalkConfig } from "./config";
import { DingTalkSender } from "./sender";
import { fmtHelp, fmtQuestionAnswerEcho, fmtQuiet, fmtStatus, fmtText, formatApprovalInjection, formatQuestionInjection, type Message } from "./format";
import type { Logger } from "../../core/logger";
import type { ApiLike, CtxLike } from "../../core/pi-types-shared";
import { QuestionRegistry } from "../../core/questions";
import type { ApprovalRegistry } from "../../core/approval";
import { robotMessageText, type RobotMessage } from "./stream";
import { truncate } from "../../core/util";

export type { ApprovalDecision, PendingApproval } from "../../core/approval";
export { ApprovalRegistry } from "../../core/approval";

/** Minimal structural view of the injected extension API. */
export type { ApiLike, CtxLike } from "../../core/pi-types-shared";

export interface RouterDeps {
	cfg: DingTalkConfig;
	log: Logger;
	sender: DingTalkSender;
	approvals: ApprovalRegistry;
	questions: QuestionRegistry;
	pi: ApiLike;
	getCtx: () => CtxLike | undefined;
	/** Extra lines for `/status` supplied by the extension entrypoint. */
	statusLines: () => string[];
	isQuiet: () => boolean;
	setQuiet: (value: boolean) => void;
}

/** Words that must appear alone, so "stop the server" stays a prompt, not an abort. */
const APPROVE_WORDS = new Set(["approve", "ok", "yes", "y", "同意", "批准", "通过"]);
const DENY_WORDS = new Set(["deny", "no", "n", "reject", "拒绝", "驳回", "不批准"]);
const STOP_WORDS = new Set(["stop", "abort", "cancel", "停止", "中断", "取消"]);
const STATUS_WORDS = new Set(["status", "状态"]);
const HELP_WORDS = new Set(["help", "?", "h", "帮助", "菜单"]);
const TOOLS_WORDS = new Set(["tools", "工具"]);
const IDENTITY_WORDS = new Set(["id", "whoami", "我是谁"]);

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

		// Identity answers *before* the allowlist: learning your own staffId is
		// the first step of onboarding, at a time when you are not in the list
		// yet. A stranger only learns their own id back, nothing else.
		const identityWord = (text.split(/\s+/)[0] ?? "").toLowerCase().replace(/^\//, "");
		if (IDENTITY_WORDS.has(identityWord)) {
			await this.#handleId(message, senderId);
			return;
		}

		// Fail-closed: an empty allowlist is not an open door. `/id` above still
		// works, so onboarding is: send /id → fill control.allowUserId → commands
		// start being accepted.
		const allow = cfg.control.allowUserId;
		if (!allow || allow !== senderId) {
			log.warn("拒绝未授权指令", { senderId, nick: message.senderNick, allowlistEmpty: !allow });
			await this.#reply(
				message,
				fmtText(
					"⛔ 未授权",
					[
						`你的 senderStaffId 是 \`${senderId || "未知"}\`。`,
						``,
						!allow
							? `本机器人还没配置白名单（\`control.allowUserId\` 为空 = 拒绝所有指令）。把上面的 ID 填进该配置项即可开启控制。`
							: `你不在白名单（\`control.allowUserId\`）中，无法控制 omp。`,
					].join("\n"),
				),
			);
			return;
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
				case "answer":
				case "回答":
					await this.#handleAnswer(message, rest);
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
					await this.#reply(message, fmtText("🏓 pong", "omp 在线，接收正常。"));
					return;
				default:
					break;
			}

			// While a remote question is pending, plain text answers it — the ask
			// dialog is the thing blocking the agent, so that outranks a new prompt.
			if (this.#deps.questions.size > 0) {
				await this.#handleAnswer(message, text);
				return;
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
		const by = message.senderNick ?? message.senderStaffId ?? "?";
		await this.#reply(
			message,
			fmtText(
				approve ? `✅ 已批准 ${approval.id}` : `⛔ 已拒绝 ${approval.id}`,
				`\`${approval.toolName}\` · 由 ${by} 处理`,
			),
		);

		// The model was told to stop and wait; hand it the decision so an
		// approved call can be re-issued (and released by the registry).
		this.#deps.pi.sendUserMessage(
			formatApprovalInjection({ id: approval.id, toolName: approval.toolName, detail: approval.detail, approved: approve, by }),
			{ deliverAs: "steer" },
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
		await this.#reply(
			message,
			fmtStatus({
				lines,
				pending: this.#deps.approvals.list().map((a) => ({ id: a.id, toolName: a.toolName, ageMs: Date.now() - a.createdAt })),
				pendingQuestions: this.#deps.questions.list().map((q) => ({
					id: q.id,
					text: q.questions[0]?.question ?? "(无内容)",
					ageMs: Date.now() - q.createdAt,
				})),
			}),
		);
	}

	async #handleTools(message: RobotMessage): Promise<void> {
		const tools = this.#deps.pi.getActiveTools?.() ?? [];
		await this.#reply(
			message,
			fmtText(`🧰 当前启用 ${tools.length} 个工具`, tools.map((t) => `- \`${t}\``).join("\n") || "(无)"),
		);
	}

	async #handleAnswer(message: RobotMessage, raw: string): Promise<void> {
		const questions = this.#deps.questions;
		if (questions.size === 0) {
			await this.#reply(message, fmtText("ℹ️ 当前没有待回答的提问", "收到“❓ 需要你的回答”时直接回复选项号即可。"));
			return;
		}

		// `/answer <编号> <内容>` lets you target a specific pending question.
		let text = String(raw ?? "").trim();
		let target: string | undefined;
		const first = text.split(/\s+/)[0]?.toUpperCase();
		if (first && questions.list().some((q) => q.id === first)) {
			target = first;
			text = text.slice(first.length).trim();
		}

		const senderId = message.senderStaffId || message.senderId || "";
		const by = message.senderNick || senderId || "?";
		const result = questions.resolve(target, text, by);
		if (!result.ok) {
			await this.#reply(message, fmtText("⚠️ 无法记录回答", result.error ?? ""));
			return;
		}

		const { answer } = result;
		this.#deps.log.info(`远程提问 ${answer.id} 已回答`, { items: answer.items.length, from: by });
		await this.#reply(message, fmtQuestionAnswerEcho({ id: answer.id, items: answer.items, by }));

		// A dual-surface racer is holding the `ask` call open, and the answer
		// becomes that call's own result — injecting it again would answer twice.
		if (result.raced) return;

		// Otherwise the model never saw a dialog at all, so deliver the answer as
		// a fresh user message with the question and answer both in context.
		this.#deps.pi.sendUserMessage(formatQuestionInjection({ id: answer.id, items: answer.items, by }), {
			deliverAs: "steer",
		});
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

		// Acknowledge with an emoji reaction instead of a reply card.
		// The emotion API uses the message's msgId/conversationId, which
		// do not expire (unlike sessionWebhook), so it works on long sessions.
		const emoji = idle ? "👀" : delivery === "steer" ? "⚡" : "📋";
		const result = await this.#deps.sender.sendEmotion(message, emoji);
		if (!result.ok) {
			// Fallback to a reply card if the emotion API is unavailable.
			const how = idle ? "已开始执行" : delivery === "steer" ? "已插入当前轮次（会打断）" : "已排队，等当前轮次结束";
			await this.#reply(message, fmtText("📨 已投递给 omp", `${how}\n\n> ${truncate(text, 300)}`));
		}
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

	/**
	 * Answers the caller's own identity — deliberately open before the allowlist
	 * (it is the onboarding step), but it echoes ONLY what the caller already
	 * knows about themselves: their own id and nick. Conversation metadata and
	 * the session's config stay behind the allowlist.
	 */
	async #handleId(message: RobotMessage, senderId: string): Promise<void> {
		await this.#reply(
			message,
			fmtText(
				"🪪 你的身份",
				[
					`- **senderStaffId**: \`${senderId || "(空)"}\``,
					`- **昵称**: ${message.senderNick ?? "(未知)"}`,
					``,
					`> 把这个 ID 填进 \`control.allowUserId\`（白名单为空时拒绝所有指令），然后重新发消息即可控制 omp。`,
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
