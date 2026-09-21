/**
 * omp-dingtalk — extension entrypoint.
 *
 * Bridges a running OMP session to DingTalk in both directions:
 *
 *   out  session/turn/approval/error events  → DingTalk markdown notifications
 *   in   DingTalk text commands and prompts  → the live session
 *
 * Load it by linking the package and letting the plugin manifest pick it up:
 *   omp plugin link <path-to-this-repo>
 *
 * Design notes worth keeping in mind when editing:
 *  - Handlers must never throw: an unhandled rejection from a handler or a
 *    detached timer tears down the whole session. Every entry point is wrapped.
 *  - Registration (`pi.on` / `pi.registerTool` / `pi.registerCommand`) is only
 *    valid during the load phase, so everything is registered unconditionally
 *    and the runtime work happens inside the handlers.
 *  - The remote approval gate is fail-closed but *inert when unreachable*: with
 *    no webhook configured there is no way to ask, so blocking would just stall
 *    the agent until the timeout. In that case the gate stands down and warns.
 *    The same applies when DingTalk has not taken over — nobody could answer.
 *  - Inbound control is opt-in. The Stream channel only opens after an explicit
 *    `/dingtalk takeover` (or `control.autoTakeover: true`), so DingTalk can
 *    never drive a session you are sitting in front of by accident.
 */
import type { ExtensionAPI } from "./core/pi-types";
import { DEFAULT_APPROVAL_RULES, OUTBOUND_MODE_LABELS, SCOPE_LABELS, describeConfig, loadConfig, resolveRobotConfig, robotNames, type ApprovalRule, type DingTalkConfig, type LoadedConfig } from "./platforms/dingtalk/config";
import { DingTalkSender } from "./platforms/dingtalk/sender";
import {
	buildAskTimeoutResult,
	buildRemoteAskResult,
	registerAskTool,
	type AskRaceBridge,
	type AskRaceRequest,
	type AskToolResult,
} from "./core/ask-tool";
import {
	fmtApprovalBlocked,
	fmtApprovalRequest,
	fmtApprovalResolved,
	fmtError,
	fmtHelp,
	fmtQuestionAnsweredLocally,
	fmtQuestionRequest,
	fmtQuestionTimeout,
	fmtSessionStop,
	fmtTakeoverSuccess,
	fmtText,
	fmtTurnEnd,
	formatApprovalTimeout,
	setSessionTag,
	type Message,
} from "./platforms/dingtalk/format";
import { createLogger, type Logger } from "./core/logger";
import { heartbeatMs, TakeoverLock, type LockHolder } from "./core/lock";
import { ApprovalRegistry, CommandRouter, type ApiLike, type ApprovalDecision, type CtxLike, type PendingApproval } from "./platforms/dingtalk/router";
import { hashQuestions, QuestionRegistry, type PendingQuestion, type QuestionAnswerPayload } from "./core/questions";
import { DingTalkStream, type StreamStatus } from "./platforms/dingtalk/stream";
import { extractText, extractToolNames, safeJson, splitMessage, truncate, truncatePath } from "./core/util";
import { createHash } from "node:crypto";
import { basename } from "node:path";

/** Custom session-entry namespace used to persist the mute flag across resumes. */
const STATE_ENTRY = "com.omp-dingtalk.state";
/**
 * Hard cap on the shutdown notification send.
 *
 * OMP aborts an event handler that runs longer than **2000 ms** ("handler timed
 * out after 2000ms"), so this must stay comfortably under that. The goal is to
 * give the message a chance to leave the machine, not to guarantee delivery —
 * a slow network or a backed-up rate-limit queue will still drop it.
 */
const SHUTDOWN_SEND_TIMEOUT_MS = 1_500;

interface NotifyOptions {
	priority?: "high" | "normal" | "low";
	dedupeKey?: string;
	/** Approvals and errors go out even while muted. */
	bypassQuiet?: boolean;
	/**
	 * Send even when `notify.onlyWhenTakenOver` would suppress it.
	 *
	 * Reserved for one case: telling you that a takeover you were actively using
	 * has just been stolen by another session. Staying silent there would leave
	 * you believing DingTalk still drives this session.
	 */
	bypassTakeover?: boolean;
}

/**
 * Owns one cwd's worth of bridge state. Recreated when the working directory
 * changes so project-level config overrides are picked up.
 */
class Bridge {
	cfg: DingTalkConfig;
	loaded: LoadedConfig;
	readonly log: Logger;
	sender: DingTalkSender;
	readonly approvals: ApprovalRegistry;
	readonly questions: QuestionRegistry;
	router: CommandRouter;

	quiet: boolean;
	/**
	 * Whether DingTalk is currently allowed to drive this session.
	 *
	 * Starts `false` unless `control.autoTakeover` is set: the inbound channel
	 * stays closed until someone sitting at the terminal asks for it with
	 * `/dingtalk takeover`. Being connected is a deliberate state, not a default.
	 */
	takenOver = false;
	/**
	 * The robot this session is currently bound to. `default` is the implicit
	 * top-level config; a named robot is bound with `/dingtalk takeover <name>`.
	 * Changing it re-points the sender / lock / stream / router at that robot.
	 */
	activeRobotName = "default";
	/**
	 * When the current run started — the user prompt (or session start) up to the
	 * moment the agent goes idle again.
	 *
	 * Reset at `session_start` and at the first `turn_start` after a
	 * `session_stop`, so the idle card reports this run's duration instead of the
	 * whole session's (a long-lived TUI session would otherwise show hours).
	 */
	runStartedAt = Date.now();
	/** True between a `session_stop` and the first `turn_start` of the next run. */
	awaitingRun = false;
	turnCount = 0;
	turnStartedAt = new Map<number, number>();
	ctx: CtxLike | undefined;
	/**
	 * Session id of the omp session that owns this bridge. Set at the first
	 * `session_start`. A subagent runs its own extension runner against this same
	 * in-process module (preparedExtensions are shared), so its lifecycle events
	 * arrive with a *different* session id — the handlers use this field to tell
	 * the subagent's noise from the session that actually owns the channel.
	 */
	sessionId: string | undefined;
	stream: DingTalkStream | undefined;
	streamStatus: StreamStatus = { state: "idle", reconnects: 0 };
	/**
	 * Cross-process claim on the DingTalk Stream for this app credential.
	 *
	 * `takenOver` alone only stops *this* process from fighting itself; it says
	 * nothing about the other omp sessions sharing the same app. The lock is what
	 * makes "one live consumer per app credential" true across processes.
	 */
	lock: TakeoverLock | undefined;

	#pi: ApiLike;
	#lastAssistantText = "";
	#lockClientId = "";
	#lockTimer: ReturnType<typeof setInterval> | undefined;
	/** Last inbound DingTalk message — used to react with ✅/❌ on session_stop. */
	#lastInboundMessage: { msgId?: string; conversationId?: string; robotCode?: string } = {};
	/**
	 * Set when the run ends with an unrecovered error (`auto_retry_end` with
	 * success=false). `session_stop` consumes it to pick ❌ instead of ✅, then
	 * resets it so the next run starts clean.
	 */
	hadError = false;

	constructor(pi: ApiLike, readonly cwd: string) {
		this.#pi = pi;
		this.loaded = loadConfig(cwd);
		this.cfg = this.loaded.config;
		this.quiet = this.cfg.quiet;
		this.log = createLogger((pi as unknown as { logger?: unknown }).logger);
		// `approvals` outlives config reloads so in-flight requests are not lost.
		this.approvals = new ApprovalRegistry(this.log);
		this.questions = new QuestionRegistry(this.log);
		this.sender = new DingTalkSender(this.activeCfg, this.log);
		this.router = this.#buildRouter();
	}

	/** Names of every configured robot, `default` first. */
	get robotNames(): string[] {
		return robotNames(this.cfg);
	}

	/**
	 * The effective config for the currently bound robot.
	 *
	 * Every session starts bound to `default` (the top-level config). A named
	 * robot is bound explicitly with `/dingtalk takeover <name>` and combines
	 * the global settings with its own webhook / stream / outbound / control.
	 */
	get activeCfg(): DingTalkConfig {
		return resolveRobotConfig(this.cfg, this.activeRobotName);
	}

	#buildRouter(): CommandRouter {
		return new CommandRouter({
			cfg: this.activeCfg,
			log: this.log,
			sender: this.sender,
			approvals: this.approvals,
			questions: this.questions,
			pi: this.#pi,
			getCtx: () => this.ctx,
			statusLines: () => this.statusLines(),
			isQuiet: () => this.quiet,
			setQuiet: (value) => this.setQuiet(value),
		});
	}

	/**
	 * Point this session at a named robot: re-target the sender, rebuild the
	 * router against the active config. Must be followed by a takeover or
	 * refresh, or the stream is not re-opened. Reusing the sender instance
	 * keeps the rate-limit window (a fresh instance would reset it and reorder
	 * the backlog).
	 */
	#setActiveRobot(name: string): void {
		this.activeRobotName = name;
		this.sender.updateConfig(this.activeCfg);
		this.router = this.#buildRouter();
	}

	/**
	 * Re-read the config files. Editing `dingtalk.json` and starting a new
	 * session picks the change up without restarting omp; the Stream connection
	 * is only torn down when its own credentials changed.
	 */
	refreshConfig(): boolean {
		const next = loadConfig(this.cwd);
		if (JSON.stringify(next.config) === JSON.stringify(this.cfg)) return false;

		const streamChanged =
			JSON.stringify(next.config.stream) !== JSON.stringify(this.cfg.stream) ||
			JSON.stringify(next.config.robots) !== JSON.stringify(this.cfg.robots);
		if (this.cfg.quiet !== next.config.quiet) this.quiet = next.config.quiet;

		this.loaded = next;
		this.cfg = next.config;
		// Reuse the sender: a new instance would reset the rate-limit window and
		// race the old one's backlog, so messages could arrive out of order.
		// Re-point it at the still-active robot, which may itself have moved.
		this.sender.updateConfig(this.activeCfg);
		this.router = this.#buildRouter();

		if (streamChanged) {
			this.stream?.stop();
			this.stream = undefined;
			// Reconnect with the new credentials only if control was already handed
			// over — a config edit must not silently take over the session.
			this.startStream();
		}
		this.log.info("钉钉配置已重新加载");
		return true;
	}

	/** Warnings produced while loading config — surfaced once per session. */
	get warnings(): string[] {
		return this.loaded.warnings;
	}

	/** Push a notification, honouring mute and the master switch. */
	notify(message: Message, options: NotifyOptions = {}): void {
		if (!this.cfg.enabled) return;
		// "Silent until takeover" outranks `bypassQuiet`: it is an explicit
		// choice to have DingTalk say nothing until control was handed over, and
		// approvals cannot happen in that state anyway (the gate stands down).
		if (this.cfg.notify.onlyWhenTakenOver && !this.takenOver && !options.bypassTakeover) {
			this.log.debug("配置为接管前静默，跳过通知", { title: message.title });
			return;
		}
		// A takeover held by another live session makes this one a bystander:
		// the DingTalk account already has an owner, and two sessions pushing
		// into the same conversation is noise the user cannot attribute.
		if (!options.bypassTakeover && this.channelHeldByOther) {
			this.log.debug("另一个会话正接管钉钉通道，本会话不发通知", { title: message.title });
			return;
		}
		if (this.quiet && !options.bypassQuiet) return;
		if (!this.sender.configured) {
			this.log.debug("没有可用的出站通道，跳过通知", { title: message.title });
			return;
		}
		// DingTalk rejects an over-long message instead of delivering its head,
		// so a long reply is sent as several messages rather than cut short.
		// `maxTextChars` is the per-message budget, not the total.
		const chunks = splitMessage(message.text, this.cfg.notify.maxTextChars);
		for (let i = 0; i < chunks.length; i++) {
			const part = chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : "";
			this.sender.enqueue({
				title: `${message.title}${part}`,
				text: chunks[i],
				priority: options.priority ?? "normal",
				// Each chunk needs its own dedupe key, or the second one would
				// be merged into the first and the rest of the reply lost.
				dedupeKey: options.dedupeKey ? `${options.dedupeKey}#${i}` : undefined,
			});
		}
	}

	/** Whether an outbound push is allowed right now (takeover gate + config). */
	get canPush(): boolean {
		if (!this.cfg.enabled) return false;
		if (this.cfg.notify.onlyWhenTakenOver && !this.takenOver) return false;
		if (this.channelHeldByOther) return false;
		return this.sender.configured;
	}

	/** Why `canPush` is false, for the model-facing tool to relay. */
	get pushBlockedReason(): string | undefined {
		if (!this.cfg.enabled) return "插件被 `enabled: false` 关闭了。";
		if (this.cfg.notify.onlyWhenTakenOver && !this.takenOver) {
			return "配置为「接管前静默」（notify.onlyWhenTakenOver），需要先在 omp 里执行 `/dingtalk takeover`。";
		}
		if (this.channelHeldByOther) {
			return "钉钉通道正被另一个 omp 会话接管，只有接管中的会话会推送。要在本会话推送，先执行 `/dingtalk takeover`。";
		}
		if (!this.sender.configured) {
			return `当前没有可用的出站通道（outbound.mode = ${this.activeCfg.outbound.mode}）。`;
		}
		return undefined;
	}

	/**
	 * The lock for this app's credential, for *reading* even before a takeover.
	 *
	 * `#ensureLock()` only runs when this session takes over, so a session that
	 * never took over has no lock instance — and that is exactly the session
	 * that has to notice someone else owns the channel. Constructing a lock
	 * reads nothing and claims nothing: it just computes the file path.
	 */
	#lockForRead(): TakeoverLock {
		const clientId = this.activeCfg.stream.clientId;
		// `lock` may belong to a previously bound robot; only reuse it when it
		// matches the active robot's credential.
		if (this.lock && this.#lockClientId === clientId) return this.lock;
		return new TakeoverLock(clientId, this.log);
	}

	/** Another live session holds this app's channel; this session is a bystander. */
	get channelHeldByOther(): boolean {
		return this.#lockForRead().heldByOther();
	}

	/** The other session currently holding this app's channel, if any. */
	get channelOwner(): LockHolder | undefined {
		const lock = this.#lockForRead();
		return lock.heldByOther() ? lock.readOwner() : undefined;
	}

	/**
	 * Race the local TUI dialog against a DingTalk answer.
	 *
	 * Called from the re-registered `ask` tool (`ask-tool.ts`), which is the only
	 * place that holds the call's `AbortSignal`. Both surfaces show the same
	 * questions, the first answer wins, and the loser is cancelled so it cannot
	 * settle a question that is already closed.
	 *
	 * Returns `undefined` when this session cannot act as the human (not in
	 * control / no outbound / disabled / an identical question is already
	 * pending), in which case the caller runs the native dialog alone.
	 */
	async runAskRace(request: AskRaceRequest): Promise<AskToolResult | undefined> {
		if (!this.cfg.enabled || !this.cfg.question.enabled) return undefined;
		// Without a takeover there is no inbound channel, so nobody could answer
		// remotely — leave the local dialog alone.
		if (!this.takenOver) {
			this.log.debug("ask 未接管会话，只走本地对话框");
			return undefined;
		}
		if (!this.sender.configured) {
			this.log.warn("双端提问需要可用的出站通道，本次只走本地对话框");
			return undefined;
		}
		const questions = request.questions;
		if (questions.length === 0) return undefined;

		const hash = hashQuestions(questions);
		const timeoutMs = this.cfg.question.timeoutMs;

		// The DingTalk side settles through the registry (the router answers it);
		// this deferred carries that settlement into the race. An empty item list
		// means nobody answered — a timeout or a retraction, not a real answer.
		let settleRemote: ((answer: QuestionAnswerPayload | null) => void) | undefined;
		const remoteAnswered = new Promise<QuestionAnswerPayload | null>((resolve) => {
			settleRemote = resolve;
		});

		let reused = false;
		const pending = this.questions.register({
			questions,
			hash,
			timeoutMs,
			onRegistered: (question) => {
				this.log.info(`远程提问 ${question.id} 已推送（本地对话框同时打开）`, { count: questions.length });
				this.notify(fmtQuestionRequest({ id: question.id, questions, timeoutMs }), {
					priority: "high",
					bypassQuiet: true,
				});
			},
			duplicate: (existing) => {
				// An identical question set is already pending. Two local dialogs
				// racing one registry row is not a state worth supporting, so this
				// call falls back to the plain native dialog.
				reused = true;
				this.log.info(`远程提问去重：复用 ${existing.id}，本次只走本地对话框`);
			},
			onTimeout: (question) => {
				this.#questionTimeout(question);
			},
			onSettled: (answer) => {
				settleRemote?.(answer.items.length > 0 ? answer : null);
			},
		});
		if (reused) return undefined;

		const localAbort = new AbortController();
		const localPromise = request.runLocal(localAbort.signal).then(
			(result) => ({ source: "local" as const, result }),
			(error: unknown) => ({ source: "local-error" as const, error }),
		);
		const remotePromise = remoteAnswered.then((answer) => ({ source: "remote" as const, answer }));

		const winner = await Promise.race([localPromise, remotePromise]);

		if (winner.source === "local") {
			// Someone at the terminal answered first. Retract the DingTalk copy so
			// a late reply cannot settle a question that is already closed.
			if (this.questions.drop(pending.id, "已在本地 TUI 回答")) {
				this.notify(fmtQuestionAnsweredLocally({ id: pending.id, questions }), {
					priority: "low",
					bypassQuiet: true,
				});
			}
			this.log.info(`提问 ${pending.id} 已在本地 TUI 回答，撤回钉钉推送`);
			return winner.result;
		}

		if (winner.source === "local-error") {
			// The local dialog was cancelled (Esc) or the whole turn was aborted.
			// That is not an answer: drop the DingTalk copy and surface the same
			// error the native tool would have thrown.
			this.questions.drop(pending.id, "本地对话框已取消");
			throw winner.error;
		}

		if (winner.answer) {
			// DingTalk answered first — close the local dialog.
			localAbort.abort();
			this.log.info(`提问 ${pending.id} 已在钉钉回答，关闭本地对话框`);
			return buildRemoteAskResult(winner.answer);
		}

		// Empty settlement: the DingTalk window elapsed with no answer. Close the
		// local dialog too and hand the decision back to the model, so a turn can
		// never stay blocked on a phone nobody is holding.
		localAbort.abort();
		this.log.info(`提问 ${pending.id} 无人回答，交回模型自行决定`);
		return buildAskTimeoutResult({ id: pending.id, questions, timeoutMs });
	}

	/**
	 * The DingTalk window elapsed. Tell the human, and let the racer hand the
	 * decision back to the model — the timeout must never leave the turn blocked.
	 */
	#questionTimeout(question: PendingQuestion): void {
		this.log.info(`远程提问 ${question.id} 超时（${question.timeoutMs}ms）`);
		this.notify(
			fmtQuestionTimeout({ id: question.id, questions: question.questions, timeoutMs: question.timeoutMs }),
			{ priority: "normal", bypassQuiet: true },
		);
	}

	/** An approval timed out: tell omp the outcome so the turn never hangs. */
	approvalExpired(approval: PendingApproval, decision: ApprovalDecision): void {
		const released = decision === "approve";
		this.log.info(`远程审批 ${approval.id} 超时，按 ${released ? "配置放行" : "安全默认拒绝"} 处理`, { toolName: approval.toolName });
		try {
			this.#pi.sendUserMessage(
				formatApprovalTimeout({
					id: approval.id,
					toolName: approval.toolName,
					released,
					timeoutMs: this.cfg.approval.timeoutMs,
				}),
				{ deliverAs: "followUp" },
			);
		} catch (error) {
			this.log.error("通知 omp 审批超时失败", error);
		}
		this.notify(
			fmtApprovalResolved({ id: approval.id, approved: released, by: "超时" }),
			{ priority: "normal", bypassQuiet: true },
		);
	}

	setQuiet(value: boolean): void {
		this.quiet = value;
		try {
			this.#pi.appendEntry?.(STATE_ENTRY, { quiet: value });
		} catch (error) {
			this.log.debug("持久化静音状态失败", error);
		}
	}

	/** Restore the persisted mute flag for the session being resumed. */
	restoreState(ctx: CtxLike & { sessionManager?: { getBranch?: () => unknown[] } }): void {
		try {
			const branch = ctx.sessionManager?.getBranch?.() ?? [];
			for (const entry of branch as Array<{ type?: string; customType?: string; data?: { quiet?: boolean } }>) {
				if (entry?.type === "custom" && entry.customType === STATE_ENTRY && typeof entry.data?.quiet === "boolean") {
					this.quiet = entry.data.quiet;
				}
			}
		} catch (error) {
			this.log.debug("恢复静音状态失败", error);
		}
	}

	statusLines(): string[] {
		const stats = this.sender.stats;
		const pending = this.approvals.size;
		const inbound = !this.takenOver
			? "未接管 · 在 omp 里执行 `/dingtalk takeover` 后钉钉才能指挥本会话"
			: this.streamStatus.state === "registered"
				? "已接管（已连接）"
				: `已接管（${this.streamStatus.state}${this.streamStatus.detail ? `: ${this.streamStatus.detail}` : ""}）`;
		const owner = this.lock?.readOwner();
		const lockLine = this.takenOver
			? "- **接管锁**: 本会话持有"
			: owner
				? `- **接管锁**: 被其他会话占用（\`${truncatePath(owner.cwd || "?", 80)}\` · PID ${owner.pid}）`
				: "- **接管锁**: 空闲";

		return [
			`- **当前机器人**: ${this.activeRobotName === "default" ? "default（顶层配置）" : this.activeRobotName} · 可选: ${this.robotNames.join(" / ")}`,
			`- **出站通道**: ${OUTBOUND_MODE_LABELS[this.activeCfg.outbound.mode] ?? this.activeCfg.outbound.mode}${this.sender.configured ? "" : "（当前不可用）"}`,
			`- **单聊收件人**: ${this.sender.recipientCount} 人`,
			`- **通知队列**: ${stats.queued} 待发 / 已发 ${stats.delivered} / 丢弃 ${stats.dropped} / 失败 ${stats.failed}`,
			`- **钉钉接管**: ${inbound}`,
			lockLine,
			this.sessionId ? `- **桥绑定会话**: ${this.sessionId}` : "- **桥绑定会话**: (未绑定)",
			`- **入站通道**: ${this.streamStatus.state}${this.streamStatus.detail ? ` (${this.streamStatus.detail})` : ""} · 重连 ${this.streamStatus.reconnects} 次`,
			`- **待审批**: ${pending}`,
			`- **待回答提问**: ${this.questions.size}`,
			`- **配置来源**: ${this.loaded.sources.join(" | ") || "(默认值)"}`,
		];
	}

	/** Open the inbound channel for the active robot. Idempotent — safe to call on every takeover. */
	startStream(): void {
		const ac = this.activeCfg;
		if (!this.cfg.enabled || !ac.stream.enabled || this.stream) return;
		if (!this.takenOver) {
			this.log.debug("尚未接管，跳过 Stream 建连");
			return;
		}
		this.stream = new DingTalkStream({
			clientId: ac.stream.clientId,
			clientSecret: ac.stream.clientSecret,
			logger: this.log,
			onMessage: (message) => {
				if (message?.msgId) this.#lastInboundMessage = { msgId: message.msgId, conversationId: message.conversationId, robotCode: message.robotCode };
				this.router.handle(message);
			},
			onStatus: (status) => {
				this.streamStatus = status;
			},
		});
		this.stream.start();
	}

	/** A short label identifying this session in every notification it sends. */
	buildSessionTag(): string {
		const dir = basename(this.cwd) || "omp";
		const seed = `${this.#pi.getSessionName?.() ?? ""}|${this.cwd}|${process.pid}`;
		const short = createHash("sha1").update(seed).digest("hex").slice(0, 4);
		return `${dir}·${short}`;
	}

	/** (Re)create the lock if the app credential changed since we last took over. */
	#ensureLock(): TakeoverLock {
		const clientId = this.activeCfg.stream.clientId;
		if (!this.lock || this.#lockClientId !== clientId) {
			this.lock?.release();
			this.lock = new TakeoverLock(clientId, this.log);
			this.#lockClientId = clientId;
		}
		return this.lock;
	}

	#startLockHeartbeat(): void {
		this.#stopLockHeartbeat();
		this.#lockTimer = setInterval(() => {
			try {
				this.#onLockTick();
			} catch (error) {
				this.log.error("接管锁心跳异常", error);
			}
		}, heartbeatMs());
		this.#lockTimer.unref?.();
	}

	#stopLockHeartbeat(): void {
		if (this.#lockTimer) {
			clearInterval(this.#lockTimer);
			this.#lockTimer = undefined;
		}
	}

	/**
	 * Stand down if another session took the lock from us.
	 *
	 * Without this the two Stream connections would both stay open, and DingTalk
	 * would route messages to whichever it feels like — the exact split-brain the
	 * lock exists to prevent.
	 */
	#onLockTick(): void {
		const lock = this.lock;
		if (!lock?.held) return;
		const preemptedBy = lock.heartbeat();
		if (!preemptedBy) return;

		// DingTalk has exactly one voice: whoever owns the channel. A session
		// that just lost the takeover is a bystander now — the winner's card
		// already named it, so push nothing; the warning stays in this log.
		this.log.warn(`接管已被另一个会话抢占：${preemptedBy.cwd} (PID ${preemptedBy.pid})，本会话不再推送钉钉消息`);
		this.release();
	}

	/**
	 * Hand inbound control to DingTalk, bound to `name` (default `default`).
	 * Switching robots mid-takeover re-points the sender / lock / stream at the
	 * new robot's credentials — each robot has its own lock, so a session bound
	 * to robot A and one bound to robot B can both be live at once. Refuses
	 * (rather than half-working) when the channel cannot actually be opened, so
	 * the terminal gets a real reason.
	 */
	takeOver(name = "default"): { ok: boolean; reason?: string; preempted?: LockHolder } {
		if (!this.cfg.enabled) return { ok: false, reason: "插件被 `enabled: false` 关闭了" };
		if (!this.robotNames.includes(name)) {
			return { ok: false, reason: `没有叫 \`${name}\` 的机器人。可用: ${this.robotNames.join(" / ")}` };
		}
		// Validate the *target* robot before re-pointing anything: switching
		// first and failing after would leave the session bound to a robot
		// whose channel never opened (takenOver=true, no stream).
		const target = resolveRobotConfig(this.cfg, name);
		if (!target.control.enabled) return { ok: false, reason: "`control.enabled: false`，入站控制已禁用" };
		if (!target.stream.enabled) {
			return {
				ok: false,
				reason: target.stream.clientId && target.stream.clientSecret
					? "`stream.enabled: false`"
					: "缺少 stream.clientId / clientSecret（或 stream.enabled 为 false）",
			};
		}
		// Re-point at the requested robot, so the stream / lock below see the
		// same config. A live stream belongs to the previous robot; drop it
		// before opening the new one (startStream below restarts it).
		if (name !== this.activeRobotName) {
			this.#setActiveRobot(name);
			this.stream?.stop();
			this.stream = undefined;
			this.streamStatus = { state: "idle", reconnects: this.streamStatus.reconnects };
		}
		const already = this.takenOver;
		const acquired = this.#ensureLock().acquire(this.cwd);
		if (!acquired.ok) return { ok: false, reason: acquired.error };

		this.takenOver = true;
		this.#startLockHeartbeat();
		this.startStream();
		if (!already) this.log.info("钉钉已接管本会话", { robot: name, scope: target.control.scope });
		if (acquired.previous) {
			this.log.warn(`已从另一个会话手里抢占接管：${acquired.previous.cwd} (PID ${acquired.previous.pid})`);
		}
		return { ok: true, preempted: acquired.previous };
	}

	/** Hand control back to the terminal and close the inbound channel. */
	release(): { wasTakenOver: boolean } {
		const wasTakenOver = this.takenOver;
		this.takenOver = false;
		// Releasing control also unbinds the robot: with nothing taken over,
		// notifications go through the default robot again (see activeCfg).
		if (this.activeRobotName !== "default") this.#setActiveRobot("default");
		this.#stopLockHeartbeat();
		this.lock?.release();
		if (this.stream) {
			this.stream.stop();
			this.stream = undefined;
		}
		this.streamStatus = { state: "idle", reconnects: this.streamStatus.reconnects };
		// Nobody can answer them any more; resolving as deny is the safe default.
		this.approvals.clear("已解除钉钉接管");
		this.questions.clear("已解除钉钉接管");
		if (wasTakenOver) this.log.info("已解除钉钉接管");
		return { wasTakenOver };
	}

	dispose(reason: string): void {
		this.takenOver = false;
		this.#stopLockHeartbeat();
		this.lock?.release();
		this.approvals.clear(reason);
		this.questions.clear(reason);
		if (this.stream) {
			this.stream.stop();
			this.stream = undefined;
		}
	}

	/** Track the last assistant text so the idle notification can quote it. */
	setLastAssistant(message: unknown): void {
		const text = extractText(message).trim();
		if (text) this.#lastAssistantText = text;
	}

	/**
	 * React with an emoji to the most recent inbound DingTalk message.
	 *
	 * Used at `session_stop`: ✅ when the run finished cleanly, ❌ when it ended
	 * on an unrecovered error. No-op when nothing has been received yet, or the
	 * emotion call fails — reactions are best-effort, never block the settle.
	 */
	async reactToLastInbound(emoji: string): Promise<void> {
		if (!this.#lastInboundMessage.msgId) return;
		const result = await this.sender.sendEmotion(this.#lastInboundMessage, emoji);
		if (!result.ok) this.log.debug(`表情回复失败：${result.errmsg}`);
	}

	get lastAssistantText(): string {
		return this.#lastAssistantText;
	}

	/** Build the config summary shown by `/dingtalk status`. */
	configSummary(): string[] {
		return describeConfig(this.loaded);
	}
}

// ---------------------------------------------------------------------------
// Approval matching
// ---------------------------------------------------------------------------

/** Stable key matching a tool call to its approval — exact arguments required. */
function approvalKey(toolName: string, input: unknown): string {
	return `${toolName}\u0000${JSON.stringify(input ?? {})}`;
}

/** Translate a glob (`*`, `**`, `?`) into an anchored regex. */
function globToRegExp(glob: string): RegExp {
	let out = "^";
	for (let i = 0; i < glob.length; i += 1) {
		const char = glob[i];
		if (char === "*") {
			if (glob[i + 1] === "*") {
				out += ".*";
				i += 1;
			} else {
				out += "[^/]*";
			}
		} else if (char === "?") {
			out += "[^/]";
		} else {
			out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`${out}$`, "i");
}

/** Returns a human-readable reason when the call needs remote approval. */
function matchApprovalRules(event: { toolName?: string; input?: Record<string, unknown> }, rules: ApprovalRule[]): string | null {
	const toolName = String(event.toolName ?? "");
	const input = (event.input ?? {}) as Record<string, any>;

	for (const rule of rules) {
		const label = rule.label ? `（${rule.label}）` : "";
		const scoped = Array.isArray(rule.tools) && rule.tools.length > 0;
		if (scoped && !rule.tools!.includes(toolName)) continue;

		if (toolName === "bash" && rule.patterns?.length) {
			const command = String(input.command ?? "");
			for (const pattern of rule.patterns) {
				try {
					if (new RegExp(pattern, "i").test(command)) return `命中规则${label}：/${pattern}/`;
				} catch {
					// A malformed user regex must not break every tool call.
				}
			}
		}

		if (rule.paths?.length) {
			const target = String(input.path ?? input.file_path ?? input.filePath ?? "");
			if (target) {
				const normalized = target.replace(/\\/g, "/");
				for (const glob of rule.paths) {
					if (globToRegExp(glob).test(normalized)) return `命中规则${label}：路径 ${glob}`;
				}
			}
		}

		// A rule that only names tools means "always ask for these".
		if (scoped && !rule.patterns?.length && !rule.paths?.length) {
			return `工具 ${toolName} 在审批清单中${label}`;
		}
	}
	return null;
}

/** Readable rendering of a tool call for the approval prompt. */
function describeToolCall(event: { toolName?: string; input?: Record<string, unknown> }): string {
	const toolName = String(event.toolName ?? "");
	const input = (event.input ?? {}) as Record<string, any>;
	switch (toolName) {
		case "bash":
			return `$ ${truncate(String(input.command ?? ""), 900)}`;
		case "write":
			return `write ${input.path ?? ""}\n\n${truncate(String(input.content ?? ""), 700)}`;
		case "edit":
			return `edit ${input.path ?? ""}\n\n${safeJson(input, 700)}`;
		default:
			return safeJson(input, 900);
	}
}

/** Resolve after `ms` no matter what the promise does. */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms).unref?.())]);
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

/**
 * Which factory invocation owns the plugin in this process.
 *
 * The host rebinds this factory once per session — the interactive session gets
 * one copy, a subagent session gets its own, usually in a different cwd — and
 * every copy keeps a private `bridge`. A subagent's copy would therefore build a
 * bridge for the subagent's cwd and push the subagent's retries, turn ends and
 * exit under a wrong session label. Ownership is process-wide instead: the first
 * binding to see a session id claims the plugin and every other binding stays
 * inert (no bridge, no notifications).
 */
let ownerBinding: symbol | undefined;

export default function ompDingTalk(pi: ExtensionAPI): void {
	/** Identity of this factory invocation; compared against {@link ownerBinding}. */
	const binding = Symbol("omp-dingtalk-binding");

	const api = pi as unknown as ApiLike & {
		appendEntry?: (customType: string, data?: unknown) => void;
		logger?: unknown;
		zod?: any;
		on: (event: string, handler: (...args: any[]) => any) => void;
		registerCommand: (name: string, options: any) => void;
		registerTool: (definition: any) => void;
	};

	let bridge: Bridge | undefined;

	/** Get (or lazily build) the bridge for a working directory. */
	const ensure = (cwd: string): Bridge => {
		if (bridge && bridge.cwd === cwd) return bridge;
		if (bridge) {
			// `dispose()` releases the takeover lock, so a cwd change silently hands
			// control back to the terminal. Say so — otherwise DingTalk just stops
			// reaching this session with no explanation.
			if (bridge.takenOver) bridge.log.warn("工作目录变更，已释放钉钉接管（本会话不再受钉钉控制）");
			bridge.dispose("工作目录变更");
		}
		bridge = new Bridge(api, cwd || process.cwd());
		// The label lives in `format.ts`, which is shared by everything in this
		// process. Only one bridge is ever live at a time (`dispose()` above), so
		// re-asserting it here keeps the label pointing at the live session even
		// when the cwd changes without a fresh `session_start`.
		setSessionTag(bridge.buildSessionTag());
		return bridge;
	};

	/**
	 * Session id of the current host ctx, when the host exposes one. Subagent
	 * sessions have their own session manager, so their events carry a different
	 * id than the main session that owns the bridge.
	 */
	const sessionIdOf = (ctx: any): string | undefined => {
		try {
			return ctx?.sessionManager?.getSessionId?.() ?? undefined;
		} catch {
			return undefined;
		}
	};

	/**
	 * Whether `ctx` is an interactive top-level session — the kind a human drives
	 * in the TUI — as opposed to a nested subagent.
	 *
	 * A session id alone cannot tell the two apart: handlers live in one
	 * process-wide list, and both a subagent's runner and a second top-level
	 * session dispatch through it carrying an id other than the bridge's own.
	 * What does differ is how the runner was initialized. The TUI session is
	 * initialized with a UI context and mode `"tui"`; a subagent's runner is
	 * initialized with neither, so it reports `hasUI: false` and
	 * `mode: "print"`. Both must hold: requiring only `hasUI === true` would
	 * misclassify a future interactive subagent (one day a subagent could get
	 * a UI context), and requiring only `mode === "tui"` would misclassify a
	 * non-TUI host. Headless top-level sessions (`rpc`/`json`/`print`) are
	 * indistinguishable from subagents by these fields, so they are NOT
	 * re-homed here — the loss is made explicit in `safe()`/`/dingtalk status`
	 * instead of silent.
	 */
	const isInteractiveSession = (ctx: any): boolean => ctx?.hasUI === true && ctx?.mode === "tui";

	/**
	 * Process-wide ownership: may this factory invocation act on `ctx`?
	 *
	 * The host rebinds this factory once per session, so a subagent's events
	 * arrive on handlers that closed over a different, still empty `bridge`. The
	 * first binding to see a session id owns the plugin; a later binding is a
	 * subagent session and stays inert, otherwise it builds a bridge for the
	 * subagent's cwd and pushes under a bogus session label. Events without a
	 * session id (older hosts, test doubles) keep the pre-gate behavior.
	 */
	const ownsPlugin = (ctx: any): boolean => {
		const id = sessionIdOf(ctx);
		if (!id) return true;
		if (ownerBinding === undefined) ownerBinding = binding;
		return ownerBinding === binding;
	};

	/** True when `ctx` belongs to a different session than this binding's bridge. */
	const isForeignSession = (ctx: any, id = sessionIdOf(ctx)): boolean =>
		Boolean(id && bridge?.sessionId && id !== bridge.sessionId);

	/**
	 * How many events have been dropped because they carried a session id
	 * other than the bridge's. Most of these are routine subagent traffic and
	 * should not pollute the log; `/dingtalk status` surfaces the count so a
	 * headless top-level session being silently filtered is discoverable on
	 * demand instead of hidden at debug level.
	 */
	let foreignDroppedEvents = 0;

	/** Wrap a handler so nothing it does can escape into the host. */
	const safe =
		(name: string, handler: (event: any, ctx: any) => unknown) =>
		async (event: any, ctx: any): Promise<unknown> => {
			try {
				if (!ownsPlugin(ctx)) return undefined;
				// A subagent sharing this binding's cwd carries a different session
				// id. The bridge belongs to one session: ignore anything that does
				// not carry the bridge's own id, otherwise a subagent's
				// session_shutdown would push an "omp 已退出" card and dispose the
				// live stream mid-run. `session_start` is handled separately (before
				// `ensure`, so a foreign start in a different cwd cannot dispose the
				// main bridge).
				const incomingId = name === "session_start" ? undefined : sessionIdOf(ctx);
				if (incomingId && isForeignSession(ctx, incomingId)) {
					foreignDroppedEvents++;
					bridge?.log.debug(`忽略来自会话 ${incomingId} 的 ${name} 事件（该会话不拥有钉钉通道）`);
					return undefined;
				}
				return await handler(event, ctx);
			} catch (error) {
				(bridge?.log ?? createLogger(undefined)).error(`事件 ${name} 处理失败`, error);
				return undefined;
			}
		};

	/**
	 * Race handler for the re-registered `ask` tool, or `undefined` when this
	 * binding must not act on `ctx` — a subagent's copy of the plugin, or a
	 * session other than the bridge's own. Returning `undefined` leaves the
	 * native dialog in charge.
	 */
	const askBridgeFor = (ctx: any): AskRaceBridge | undefined => {
		if (!ownsPlugin(ctx) || isForeignSession(ctx)) return undefined;
		const b = ensure(ctx?.cwd ?? process.cwd());
		b.ctx = ctx;
		return { runAskRace: (request: AskRaceRequest) => b.runAskRace(request) };
	};

	// -------------------------------------------------------------------------
	// Session lifecycle
	// -------------------------------------------------------------------------

	pi.on(
		"session_start",
		safe("session_start", async (_event, ctx) => {
			const incomingId = sessionIdOf(ctx);
			if (incomingId && bridge?.sessionId && incomingId !== bridge.sessionId) {
				// A second session id in this process means one of three things:
				//   - a subagent (headless runner): stay silent, so its retries,
				//     turn ends and "omp 已退出" never reach DingTalk;
				//   - a new top-level session the user switched to: the bridge
				//     must follow it, otherwise every event it emits is filtered
				//     out as foreign and DingTalk goes quiet while the lock and
				//     the stream still look healthy;
				//   - a top-level session while another one holds the channel
				//     from `/dingtalk takeover`: it stays a bystander unless
				//     autoTakeover is on (then later wins).
				if (!isInteractiveSession(ctx)) {
					// Skip BEFORE `ensure`, so a subagent start in a different cwd
					// cannot dispose the main bridge (which would silently drop the
					// takeover and the live stream). A headless top-level session
					// (rpc/json/print) is indistinguishable from a subagent by the
					// fields the host exposes, so it is not re-homed automatically
					// either; it can still take the channel with an explicit
					// /dingtalk takeover, and /dingtalk status shows the binding so
					// the mismatch is not silent. Stays at debug: subagents are
					// routine and a warn here would flood the log.
					foreignDroppedEvents++;
					bridge.log.debug(
						`忽略无 UI 会话的 session_start（${incomingId}）：子代理或 headless 顶层会话不参与钉钉`,
					);
					return;
				}
				if (bridge.takenOver) {
					if (bridge.cfg.control.autoTakeover) {
						// Later wins: with autoTakeover on the user expects the
						// newest top-level session to hold the channel. Fall
						// through, rebind the session id, and let the
						// autoTakeover block below preempt the earlier session.
						bridge.log.info(`会话切换（自动接管开启）：钉钉桥改随新会话（${incomingId}）`);
					} else {
						// Always a real, interactive session (we got past the
						// check above), so warn once: the user opened a window
						// that will stay silent until it takes over.
						bridge.log.warn(
							`忽略会话 ${incomingId} 的 session_start：钉钉通道已由本进程的接管会话持有。若此会话要接管，执行 /dingtalk takeover。`,
						);
						return;
					}
				} else {
					bridge.log.info(`会话切换：钉钉桥改随新会话（${incomingId}）`);
				}
			}
			const b = ensure(ctx?.cwd ?? process.cwd());
			if (incomingId) b.sessionId = incomingId;
			b.ctx = ctx;
			b.refreshConfig();
			b.runStartedAt = Date.now();
			b.awaitingRun = false;
			b.turnCount = 0;
			b.turnStartedAt.clear();
			b.restoreState(ctx);
			// Label every notification from here on, so two sessions sharing one
			// DingTalk account are still tellable apart.
			setSessionTag(b.buildSessionTag());

			for (const warning of b.warnings) b.log.warn(warning);

			// Inbound control is opt-in: only `control.autoTakeover` opens the
			// channel by itself, otherwise the session waits for an explicit
			// `/dingtalk takeover`. A takeover the user asked for is kept across
			// session starts (autoTakeover=false must not silently drop it); the
			// lock still arbitrates who actually holds the channel.
			if (b.cfg.control.autoTakeover) {
				const result = b.takeOver();
				if (!result.ok) {
					b.log.warn(`自动接管失败：${result.reason}`);
				} else {
					b.notify(
						fmtTakeoverSuccess({
							cwd: b.cwd,
							scope: b.activeCfg.control.scope,
							preempted: result.preempted ? { cwd: result.preempted.cwd, pid: result.preempted.pid } : undefined,
							releaseSeconds: result.preempted ? Math.round(heartbeatMs() / 1000) : undefined,
						}),
						{ priority: "high", bypassQuiet: true, bypassTakeover: true },
					);
				}
			} else if (b.takenOver) {
				// Keep it. `control.autoTakeover = false` only means a new session must
				// not grab the channel by itself; it must not silently drop a takeover
				// the user asked for with `/dingtalk takeover`. Only an explicit
				// takeover elsewhere (later wins) or `/dingtalk release` changes holders.
				b.log.info("沿用已有钉钉接管（control.autoTakeover = false 既不自动接管、也不自动释放）");
			} else if (b.cfg.enabled && b.activeCfg.stream.enabled) {
				// Name the other owner explicitly: plain "未接管" reads as "nobody
				// controls the account", when in fact another session does.
				const owner = b.channelOwner;
				if (owner) {
					b.log.info(
						`钉钉通道已由另一个会话接管（PID ${owner.pid}，目录 ${owner.cwd || "?"}），本会话静默、不推送通知；需要接手就执行 /dingtalk takeover`,
					);
				} else {
					b.log.info("钉钉未接管本会话（默认）。需要远程控制时执行 /dingtalk takeover");
				}
			}
			// No startup notification on purpose: a launch is ordinary, and a
			// DingTalk ping for every new session is noise. Takeover — whether
			// automatic (`control.autoTakeover`) or via `/dingtalk takeover` —
			// is the event worth announcing, and it pushes its own confirmation.
		}),
	);

	pi.on(
		"turn_start",
		safe("turn_start", async (event, ctx) => {
			const b = ensure(ctx?.cwd ?? process.cwd());
			b.ctx = ctx;
			// A turn after a stop is the first turn of a new run: the previous idle
			// card already reported its duration, so restart the clock here.
			if (b.awaitingRun) {
				b.runStartedAt = Date.now();
				b.awaitingRun = false;
			}
			b.turnStartedAt.set(Number(event?.turnIndex ?? 0), Date.now());
		}),
	);

	pi.on(
		"turn_end",
		safe("turn_end", async (event, ctx) => {
			const b = ensure(ctx?.cwd ?? process.cwd());
			b.ctx = ctx;
			b.setLastAssistant(event?.message);

			const turnIndex = Number(event?.turnIndex ?? 0);
			const startedAt = b.turnStartedAt.get(turnIndex) ?? b.runStartedAt;
			b.turnStartedAt.delete(turnIndex);
			const durationMs = Date.now() - startedAt;

			if (!b.cfg.notify.turnEnd.enabled) return;
			if (durationMs < b.cfg.notify.turnEnd.minDurationMs) return;

			b.notify(
				fmtTurnEnd({
					turnIndex,
					durationMs,
					text: extractText(event?.message),
					tools: extractToolNames(event?.message),
				}),
				{ priority: "low", dedupeKey: `turn-${turnIndex}` },
			);
		}),
	);

	// `session_stop` is the reliable "the agent is now waiting for you" signal:
	// it fires before settle and is awaited, unlike `agent_end`, which also
	// fires for automatic continuations we should not announce.
	pi.on(
		"session_stop",
		safe("session_stop", async (event, ctx) => {
			const b = ensure(ctx?.cwd ?? process.cwd());
			b.ctx = ctx;
			b.turnCount += 1;
			// This run is over: report how long it took (not the whole session) and
			// let the next `turn_start` restart the clock.
			const runDurationMs = Date.now() - b.runStartedAt;
			b.awaitingRun = true;
			if (event?.last_assistant_message) b.setLastAssistant(event.last_assistant_message);

			// React to the message that drove this run: ✅ on a clean finish, ❌
			// when it ended on an unrecovered error. Best-effort and independent
			// of the notify switches — a reaction is a lightweight signal, not a
			// push. Reset the flag so the next run starts from a clean state.
			if (b.takenOver && !b.quiet) {
				await b.reactToLastInbound(b.hadError ? "❌" : "✅");
			}
			b.hadError = false;

			if (!b.cfg.notify.sessionStop) return;
			b.notify(
				fmtSessionStop({
					durationMs: runDurationMs,
					turns: b.turnCount,
					text: b.lastAssistantText,
				}),
				{ priority: "normal", dedupeKey: "session-stop" },
			);
		}),
	);

	pi.on(
		"session_shutdown",
		safe("session_shutdown", async () => {
			if (!bridge) return;
			const b = bridge;
			// Send (not enqueue) so the message actually leaves the machine before
			// the process tears down, with a hard cap so shutdown cannot hang.
			if (b.canPush && b.cfg.notify.sessionShutdown && !b.quiet) {
				await withTimeout(
					b.sender.send({
						title: "omp 已退出",
						text: `🔌 omp 已退出\n\n目录 \`${truncatePath(b.cwd, 120)}\``,
						priority: "high",
					}),
					SHUTDOWN_SEND_TIMEOUT_MS,
					{ ok: false },
				);
			}
			b.dispose("会话退出");
		}),
	);

	// -------------------------------------------------------------------------
	// Remote approval gate
	// -------------------------------------------------------------------------

	pi.on(
		"tool_call",
		safe("tool_call", async (event, ctx) => {
			const b = ensure(ctx?.cwd ?? process.cwd());
			b.ctx = ctx;

			// NOTE: `ask` is deliberately not intercepted here. The plugin
			// re-registers the tool (`ask-tool.ts`) so that it owns the call and
			// can race the TUI dialog against DingTalk; returning `{block: true}`
			// from this handler would stop the dialog from ever appearing.

			if (!b.cfg.enabled || b.cfg.approval.mode !== "remote") return undefined;
			if (!b.sender.configured) {
				// No way to reach a human: blocking would stall until timeout.
				b.log.warn("审批模式为 remote 但没有任何可用的出站通道，本次不做远程拦截");
				return undefined;
			}
			if (!b.takenOver) {
				// Same reasoning as above: without a takeover there is no inbound
				// channel, so nobody can answer — gating here would just deny every
				// dangerous command after a long timeout.
				b.log.warn("审批模式为 remote 但钉钉尚未接管，无人能应答，本次不做远程拦截（执行 /dingtalk takeover 可开启）");
				return undefined;
			}

			const toolName = String(event?.toolName ?? "?");
			const detail = describeToolCall(event);
			const key = approvalKey(toolName, event?.input);

			// The user just approved this exact call in DingTalk — release it once.
			if (b.approvals.consumeApproved(key)) {
				b.log.info(`审批已通过，放行 ${toolName}`, { key });
				return undefined;
			}

			const rules = b.cfg.approval.rules.length > 0 ? b.cfg.approval.rules : DEFAULT_APPROVAL_RULES;
			const reason = matchApprovalRules(event, rules);
			if (!reason) return undefined;

			// Never await the human: OMP aborts a handler after
			// `extensionHandlers.toolCallTimeoutMs` (30s) and blocks the call, so a
			// reply arriving later could no longer release it. Register and block
			// now; the reply settles the registry and the model re-issues the call.
			const approval = b.approvals.register({
				toolName,
				reason,
				detail,
				key,
				timeoutMs: b.cfg.approval.timeoutMs,
				onTimeout: b.cfg.approval.onTimeout,
				onRequested: (a) => {
					b.log.info(`等待远程审批 ${a.id}`, { toolName, reason });
					if (b.cfg.notify.approval) {
						b.notify(
							fmtApprovalRequest({
								id: a.id,
								toolName,
								reason,
								detail,
								timeoutMs: b.cfg.approval.timeoutMs,
							}),
							{ priority: "high", bypassQuiet: true },
						);
					}
				},
				onExpired: (a, decision) => b.approvalExpired(a, decision),
				duplicate: (a) => b.log.info(`审批去重：复用 ${a.id}，不再重复推送`),
			});
			return {
				block: true,
				reason: fmtApprovalBlocked({ id: approval.id, toolName, detail, timeoutMs: b.cfg.approval.timeoutMs }),
			};
		}),
	);

	// -------------------------------------------------------------------------
	// Reliability notifications
	// -------------------------------------------------------------------------

	pi.on(
		"auto_retry_start",
		safe("auto_retry_start", async (event, ctx) => {
			const b = ensure(ctx?.cwd ?? process.cwd());
			if (!b.cfg.notify.errors) return;
			if (Number(event?.attempt ?? 1) < 2) return; // the first retry is routine noise
			b.notify(
				fmtError({
					kind: `🔄 第 ${event?.attempt ?? "?"}/${event?.maxAttempts ?? "?"} 次重试`,
					detail: truncate(String(event?.errorMessage ?? ""), 600),
					hint: `将在 ${Math.round(Number(event?.delayMs ?? 0) / 1000)}s 后重试`,
				}),
				{ priority: "normal", dedupeKey: "retry" },
			);
		}),
	);

	pi.on(
		"auto_retry_end",
		safe("auto_retry_end", async (event, ctx) => {
			const b = ensure(ctx?.cwd ?? process.cwd());
			// Remember the failure so session_stop can react with ❌ instead of ✅,
			// even when error notifications are muted.
			if (!event?.success) b.hadError = true;
			if (!b.cfg.notify.errors || event?.success) return;
			b.notify(
				fmtError({
					kind: "❌ 重试已耗尽",
					detail: truncate(String(event?.finalError ?? "未知错误"), 800),
					hint: "模型侧持续失败，可能需要换模型或检查网络/额度。",
				}),
				{ priority: "high", bypassQuiet: true },
			);
		}),
	);

	pi.on(
		"credential_disabled",
		safe("credential_disabled", async (event, ctx) => {
			const b = ensure(ctx?.cwd ?? process.cwd());
			if (!b.cfg.notify.errors) return;
			b.notify(
				fmtError({
					kind: `🔑 凭据被禁用：${event?.provider ?? "?"}`,
					detail: truncate(String(event?.disabledCause ?? ""), 600),
					hint: "该提供商的凭据已被自动停用，需要重新登录或更换 API Key。",
				}),
				{ priority: "high", bypassQuiet: true, dedupeKey: `cred-${event?.provider ?? "?"}` },
			);
		}),
	);

	pi.on(
		"goal_updated",
		safe("goal_updated", async (event, ctx) => {
			const b = ensure(ctx?.cwd ?? process.cwd());
			if (!b.cfg.notify.goalUpdated) return;
			const goal = event?.goal as { text?: string; title?: string; status?: string } | null;
			if (!goal) return;
			b.notify(
				fmtText("🎯 目标更新", `- **状态**: ${goal.status ?? "?"}\n- **目标**: ${truncate(goal.title ?? goal.text ?? "", 300)}`),
				{ priority: "low", dedupeKey: "goal" },
			);
		}),
	);

	pi.on(
		"tool_execution_end",
		safe("tool_execution_end", async (event, ctx) => {
			const b = ensure(ctx?.cwd ?? process.cwd());
			const watch = b.cfg.notify.toolUse;
			if (!b.cfg.notify.toolUse.enabled) return;
			const toolName = String(event?.toolName ?? "");
			if (watch.tools.length > 0 && !watch.tools.includes(toolName)) return;
			if (!event?.isError) return; // successes are too chatty to report one by one
			b.notify(
				fmtError({
					kind: `工具执行失败：${toolName}`,
					detail: safeJson(event?.result, 700),
				}),
				{ priority: "low", dedupeKey: `tool-${toolName}` },
			);
		}),
	);

	// -------------------------------------------------------------------------
	// Local (in-terminal) surface
	// -------------------------------------------------------------------------

	pi.registerCommand("dingtalk", {
		description: "钉钉机器人：status | takeover [机器人名] | release | test | quiet on|off | help",
		getArgumentCompletions: (prefix: string) => {
			const subs = [
				{ value: "status", description: "会话 / 模型 / 待审批 / 发送队列 / 通道状态" },
				{ value: "takeover", description: "让钉钉接管本会话（远程控制 + 审批），可指定机器人名" },
				{ value: "release", description: "解除接管，关闭入站通道" },
				{ value: "test", description: "发一条测试通知到钉钉，确认能收到" },
				{ value: "quiet", description: "静音开关：quiet on | quiet off" },
				{ value: "help", description: "钉钉指令说明" },
			];
			const p = String(prefix ?? "").trim().toLowerCase();
			// After `takeover`, complete the robot names (including `default`).
			if (prefix && /^takeover\s+/i.test(String(prefix ?? "").trim())) {
				const rest = String(prefix ?? "").trim().split(/\s+/).slice(1).join(" ").toLowerCase();
				const live = bridge ? bridge.robotNames : ["default"];
				return live
					.filter((name) => !rest || name.toLowerCase().startsWith(rest))
					.map((name) => ({ value: name, label: name, description: name === "default" ? "顶层配置机器人" : `命名机器人 ${name}` }));
			}
			return subs
				.filter((s) => !p || s.value.startsWith(p))
				.map((s) => ({ value: s.value, label: s.value, description: s.description }));
		},
		handler: async (args: string, ctx: any) => {
			try {
				if (!ownsPlugin(ctx)) {
					ctx?.ui?.notify?.("当前是子代理会话，钉钉由主会话负责。", "error");
					return;
				}
				const b = ensure(ctx?.cwd ?? process.cwd());
				b.ctx = ctx;
				const [sub, ...rest] = String(args ?? "").trim().split(/\s+/);
				const action = (sub ?? "").toLowerCase();

				if (action === "takeover" || action === "接管") {
					const robotName = (rest[0] ?? "").trim() || "default";
					const result = b.takeOver(robotName);
					const hint = b.cfg.notify.onlyWhenTakenOver
						? " 通知从现在起才会发到钉钉（notify.onlyWhenTakenOver），建议先 `/dingtalk test` 确认能收到。"
						: "";
					const stolen = result.preempted
						? ` 已从另一个会话手里抢占（\`${truncatePath(result.preempted.cwd || "?", 80)}\` · PID ${result.preempted.pid}）。`
						: "";
					ctx.ui?.notify?.(
						result.ok
							? `钉钉已接管本会话（机器人 ${robotName} · ${SCOPE_LABELS[b.activeCfg.control.scope] ?? b.activeCfg.control.scope}）。现在可以在钉钉里发消息指挥它；用 /dingtalk release 解除。${stolen}${hint}`
							: `无法接管：${result.reason}`,
						result.ok ? "info" : "error",
					);
					// Takeover is the moment DingTalk actually gains control, so it
					// is worth a push — this is the only "handed over" signal the
					// phone gets when the session was launched with autoTakeover off.
					if (result.ok) {
						// Bind the bridge to the session that just took over. In a
						// process that hosted an earlier session the bridge still
						// carries that session's id, and without this every event
						// of THIS one would be filtered out as foreign — the
						// takeover card goes out, then silence.
						const id = sessionIdOf(ctx);
						if (id) b.sessionId = id;
						b.notify(
							fmtTakeoverSuccess({
								cwd: b.cwd,
								robot: robotName,
								scope: b.activeCfg.control.scope,
								preempted: result.preempted ? { cwd: result.preempted.cwd, pid: result.preempted.pid } : undefined,
								releaseSeconds: result.preempted ? Math.round(heartbeatMs() / 1000) : undefined,
							}),
							{ priority: "high", bypassQuiet: true, bypassTakeover: true },
						);
					}
					return;
				}

				if (action === "release" || action === "解除") {
					const { wasTakenOver } = b.release();
					const tail = wasTakenOver && b.cfg.notify.onlyWhenTakenOver ? " 通知也一并停了。" : "";
					ctx.ui?.notify?.(wasTakenOver ? `已解除钉钉接管，入站通道已关闭。${tail}` : "当前本来就没有接管。", "info");
					return;
				}

				if (action === "test") {
					if (!b.sender.configured) {
						ctx.ui?.notify?.(
							`当前没有可用的出站通道（outbound.mode = ${b.activeCfg.outbound.mode}），无法发送测试消息。`,
							"error",
						);
						return;
					}
					// 静默期（notify.onlyWhenTakenOver）是允许手动测试的——否则没法确认
					// 出站通道通不通。只有钉钉已经被别的会话接管时才拒绝：那时这条消息
					// 会被算到别人头上。
					if (b.channelHeldByOther) {
						ctx.ui?.notify?.(
							"测试消息未发送：钉钉通道正被另一个 omp 会话接管，只有接管中的会话会推送。要在本会话推送，先执行 /dingtalk takeover。",
							"error",
						);
						return;
					}
					const result = await b.sender.send({
						title: "omp 测试消息",
						text: `## 👋 测试消息\n\n来自 \`${truncatePath(b.cwd, 120)}\`\n\n如果你看到这条消息，出站通道是通的。`,
						priority: "high",
					});
					ctx.ui?.notify?.(result.ok ? "已发送测试消息，请查看钉钉。" : `发送失败：${result.errmsg ?? "未知错误"}`, result.ok ? "info" : "error");
					return;
				}

				if (action === "quiet") {
					const value = (rest[0] ?? "").toLowerCase();
					const on = value ? ["on", "1", "true", "yes", "开"].includes(value) : !b.quiet;
					b.setQuiet(on);
					ctx.ui?.notify?.(on ? "钉钉通知已静音。" : "钉钉通知已恢复。", "info");
					return;
				}

				if (action === "help" || action === "?") {
					ctx.ui?.notify?.(
						[
							"/dingtalk status                  — 配置 + 运行状态（含当前机器人）",
							"/dingtalk takeover                — 让钉钉接管本会话（默认机器人，开启入站控制）",
							"/dingtalk takeover <机器人名>     — 绑定并接管指定机器人",
							"/dingtalk release                 — 解除接管，关闭入站通道",
							"/dingtalk test                    — 发一条测试通知",
							"/dingtalk quiet on|off            — 静音 / 恢复通知",
							`可用机器人: ${b.robotNames.join(" / ")}`,
						].join("\n"),
						"info",
					);
					return;
				}

				const lines = [
					...b.configSummary(),
					...b.statusLines(),
					`- **审批规则**: ${b.cfg.approval.mode === "remote" ? `${(b.cfg.approval.rules.length ? b.cfg.approval.rules : DEFAULT_APPROVAL_RULES).length} 条` : "未启用"}`,
				];
				const curId = sessionIdOf(ctx);
				if (b.sessionId && curId && b.sessionId !== curId) {
					lines.push(
						`- **⚠️ 会话归属不符**: 桥绑定在 \`${b.sessionId}\`，当前会话是 \`${curId}\`。若当前会话要接管，执行 /dingtalk takeover。`,
					);
				}
				if (foreignDroppedEvents > 0) {
					lines.push(`- **归属过滤**: 已丢弃 ${foreignDroppedEvents} 个来自外来会话的事件（多为子代理，属正常）`);
				}
				ctx.ui?.notify?.(lines.join("\n"), "info");
			} catch (error) {
				ctx?.ui?.notify?.(`/dingtalk 执行失败: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	// A tool the model can call when it decides the user needs to know something
	// without being at the keyboard.
	const zod = api.zod;
	if (zod) {
		pi.registerTool({
			name: "dingtalk_notify",
			label: "DingTalk Notify",
			description:
				"Push a notification to the user's DingTalk. Use when the user asked to be told when a long task finishes, or when you are blocked and need a decision before continuing.",
			parameters: zod.object({
				title: zod.string().describe("Short notification title"),
				message: zod.string().describe("Markdown body, keep it under ~500 characters"),
				urgency: zod.enum(["low", "normal", "high"]).default("normal").describe("low may be dropped when rate limited"),
			}),
			async execute(_toolCallId: string, params: any, argA: any, argB: any, argC: any) {
				// The host has shipped two different `execute` argument orders
				// (`signal, onUpdate, ctx` and `onUpdate, ctx, signal`), so find the
				// context structurally instead of trusting a position.
				const candidates = [argA, argB, argC];
				const ctx = candidates.find((c) => c && typeof c === "object" && ("cwd" in c || "ui" in c)) as any;
				if (!ownsPlugin(ctx) || isForeignSession(ctx)) {
					return {
						content: [{ type: "text" as const, text: "通知未发送：当前会话不拥有钉钉通道（子代理会话由主会话负责）。" }],
						details: { sent: false, errcode: undefined as number | undefined },
						isError: true,
					};
				}
				const b = ensure(ctx?.cwd ?? process.cwd());
				b.ctx = ctx;
				const blocked = b.pushBlockedReason;
				if (blocked) {
					return {
						content: [{ type: "text" as const, text: `通知未发送：${blocked}` }],
						details: { sent: false, errcode: undefined as number | undefined },
						isError: true,
					};
				}
				const result = await b.sender.send({
					title: truncate(params?.title ?? "omp 通知", 60),
					text: `${String(params?.message ?? "")}\n\n---\n<font color="#999999" size="1">来自 omp · ${truncatePath(b.cwd, 80)}</font>`,
					priority: params?.urgency ?? "normal",
				});
				return {
					content: [{ type: "text", text: result.ok ? "通知已发送到钉钉。" : `发送失败：${result.errmsg ?? "未知错误"}` }],
					details: { sent: result.ok, errcode: result.errcode },
					isError: !result.ok,
				};
			},
		});
	} else {
		createLogger(api.logger).warn("pi.zod 不可用，跳过 dingtalk_notify 工具注册");
	}

	// Re-register `ask` so this plugin owns the call and can race the local TUI
	// dialog against DingTalk — see `ask-tool.ts` for why re-registration is the
	// only way an extension can do this.
	if (!registerAskTool(pi, askBridgeFor)) {
		createLogger(api.logger).warn("pi.zod 不可用，ask 保持原生行为（无法双端提问）");
	}
}

export { fmtHelp };
