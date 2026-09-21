/**
 * Bridge: the platform-neutral core of the omp messaging plugin.
 *
 * Owns one cwd's worth of bridge state: session ownership, takeover, the
 * cross-process lock, the approval registry, the question race, notification
 * scheduling and the inbound command router. It never touches a concrete
 * platform — every platform-specific call goes through the `ChannelAdapter<P>`
 * handed to it in the constructor.
 *
 * A new platform is a new `ChannelAdapter` implementation; nothing in this
 * file changes.
 */
import type { ChannelAdapter, ChannelFormatter, ChannelRouter, ChannelSender, ChannelStream, InboundMessage, Message, NotifyOptions, PlatformConfig, StreamStatus } from "./channel";
import { buildAskTimeoutResult, buildRemoteAskResult, type AskRaceRequest, type AskToolResult } from "./ask-tool";
import { ApprovalRegistry, type ApprovalDecision, type PendingApproval } from "./approval";
import { hashQuestions, QuestionRegistry, type PendingQuestion, type QuestionAnswerPayload } from "./questions";
import { heartbeatMs, TakeoverLock, type LockHolder } from "./lock";
import { createLogger, type Logger } from "./logger";
import { extractText, safeJson, splitMessage, truncate, truncatePath } from "./util";
import type { ApiLike, CtxLike } from "./pi-types-shared";
import type { ApprovalRule } from "./approval-types";
import { createHash } from "node:crypto";
import { basename } from "node:path";

/** Custom session-entry namespace used to persist the mute flag across resumes. */
export const STATE_ENTRY = "com.omp-dingtalk.state";

/**
 * Owns one cwd's worth of bridge state. Recreated when the working directory
 * changes so project-level config overrides are picked up.
 */
export class Bridge<P extends PlatformConfig> {
	readonly adapter: ChannelAdapter<P>;
	cfg: P;
	loaded: { config: P; warnings: string[]; sources: string[] };
	readonly log: Logger;
	sender: ChannelSender;
	readonly approvals: ApprovalRegistry;
	readonly questions: QuestionRegistry;
	router: ChannelRouter;

	quiet: boolean;
	/**
	 * Whether the channel is currently allowed to drive this session.
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
	stream: (ChannelStream & { status: () => StreamStatus }) | undefined;
	streamStatus: StreamStatus = { state: "idle", reconnects: 0 };
	/**
	 * Cross-process claim on the channel Stream for this app credential.
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
	/** Last inbound message — used to react with ✅/❌ on session_stop. */
	#lastInboundTarget: Record<string, unknown> | undefined;
	/**
	 * Set when the run ends with an unrecovered error (`auto_retry_end` with
	 * success=false). `session_stop` consumes it to pick ❌ instead of ✅, then
	 * resets it so the next run starts clean.
	 */
	hadError = false;

	constructor(pi: ApiLike, readonly cwd: string, adapter: ChannelAdapter<P>) {
		this.#pi = pi;
		this.adapter = adapter;
		this.loaded = adapter.loadConfig(cwd);
		this.cfg = this.loaded.config;
		this.quiet = this.cfg.quiet;
		this.log = createLogger((pi as unknown as { logger?: unknown }).logger);
		// `approvals` outlives config reloads so in-flight requests are not lost.
		this.approvals = new ApprovalRegistry(this.log);
		this.questions = new QuestionRegistry(this.log);
		this.sender = adapter.createSender(this.activeCfg, this.log);
		this.router = this.#buildRouter();
	}

	/** Names of every configured robot, `default` first. */
	get robotNames(): string[] {
		return this.adapter.robotNames(this.cfg);
	}

	/**
	 * The effective config for the currently bound robot.
	 *
	 * Every session starts bound to `default` (the top-level config). A named
	 * robot is bound explicitly with `/dingtalk takeover <name>` and combines
	 * the global settings with its own webhook / stream / outbound / control.
	 */
	get activeCfg(): P {
		return this.adapter.resolveRobot(this.cfg, this.activeRobotName);
	}

	get formatter(): ChannelFormatter {
		return this.adapter.formatter;
	}

	#buildRouter(): ChannelRouter {
		return this.adapter.createRouter(this.activeCfg, {
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
		const next = this.adapter.loadConfig(this.cwd);
		if (JSON.stringify(next.config) === JSON.stringify(this.cfg)) return false;

		const streamChanged =
			JSON.stringify(this.adapter.resolveRobot(next.config, this.activeRobotName).stream) !==
			JSON.stringify(this.activeCfg.stream);
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
		this.log.info("配置已重新加载");
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
		// choice to have the channel say nothing until control was handed over, and
		// approvals cannot happen in that state anyway (the gate stands down).
		if (this.cfg.notify.onlyWhenTakenOver && !this.takenOver && !options.bypassTakeover) {
			this.log.debug("配置为接管前静默，跳过通知", { title: message.title });
			return;
		}
		// A takeover held by another live session makes this one a bystander:
		// the account already has an owner, and two sessions pushing
		// into the same conversation is noise the user cannot attribute.
		if (!options.bypassTakeover && this.channelHeldByOther) {
			this.log.debug("另一个会话正接管通道，本会话不发通知", { title: message.title });
			return;
		}
		if (this.quiet && !options.bypassQuiet) return;
		if (!this.sender.configured) {
			this.log.debug("没有可用的出站通道，跳过通知", { title: message.title });
			return;
		}
		// The platform rejects an over-long message instead of delivering its head,
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
			return "通道正被另一个 omp 会话接管，只有接管中的会话会推送。要在本会话推送，先执行 `/dingtalk takeover`。";
		}
		if (!this.sender.configured) {
			return `当前没有可用的出站通道（outbound.mode = ${this.activeCfg.outbound?.mode ?? "?"}）。`;
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
	 * Race the local TUI dialog against a remote answer.
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

		// The remote side settles through the registry (the router answers it);
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
				this.notify(
					this.formatter.questionRequest({ id: question.id, questions, timeoutMs }),
					{ priority: "high", bypassQuiet: true },
				);
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
			// Someone at the terminal answered first. Retract the remote copy so
			// a late reply cannot settle a question that is already closed.
			if (this.questions.drop(pending.id, "已在本地 TUI 回答")) {
				this.notify(
					this.formatter.questionAnsweredLocally({ id: pending.id, questions }),
					{ priority: "low", bypassQuiet: true },
				);
			}
			this.log.info(`提问 ${pending.id} 已在本地 TUI 回答，撤回远程推送`);
			return winner.result;
		}

		if (winner.source === "local-error") {
			// The local dialog was cancelled (Esc) or the whole turn was aborted.
			// That is not an answer: drop the remote copy and surface the same
			// error the native tool would have thrown.
			this.questions.drop(pending.id, "本地对话框已取消");
			throw winner.error;
		}

		if (winner.answer) {
			// Remote answered first — close the local dialog.
			localAbort.abort();
			this.log.info(`提问 ${pending.id} 已在远程回答，关闭本地对话框`);
			return buildRemoteAskResult(winner.answer);
		}

		// Empty settlement: the remote window elapsed with no answer. Close the
		// local dialog too and hand the decision back to the model, so a turn can
		// never stay blocked on a phone nobody is holding.
		localAbort.abort();
		this.log.info(`提问 ${pending.id} 无人回答，交回模型自行决定`);
		return buildAskTimeoutResult({ id: pending.id, questions, timeoutMs });
	}

	/**
	 * The remote window elapsed. Tell the human, and let the racer hand the
	 * decision back to the model — the timeout must never leave the turn blocked.
	 */
	#questionTimeout(question: PendingQuestion): void {
		this.log.info(`远程提问 ${question.id} 超时（${question.timeoutMs}ms）`);
		this.notify(
			this.formatter.questionTimeout({ id: question.id, questions: question.questions, timeoutMs: question.timeoutMs }),
			{ priority: "normal", bypassQuiet: true },
		);
	}

	/** An approval timed out: tell omp the outcome so the turn never hangs. */
	approvalExpired(approval: PendingApproval, decision: ApprovalDecision): void {
		const released = decision === "approve";
		this.log.info(`远程审批 ${approval.id} 超时，按 ${released ? "配置放行" : "安全默认拒绝"} 处理`, { toolName: approval.toolName });
		try {
			this.#pi.sendUserMessage(
				this.formatter.approvalTimeout({
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
			this.formatter.approvalResolved({ id: approval.id, approved: released, by: "超时" }),
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
			`- **出站通道**: ${this.adapter.describeOutbound(this.activeCfg)}${this.sender.configured ? "" : "（当前不可用）"}`,
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
		this.stream = this.adapter.createStream(ac, this.log, {
			onMessage: (message: InboundMessage) => {
				if (message.reactionTarget) this.#lastInboundTarget = message.reactionTarget;
				void this.router.handle(message);
			},
			onStatus: (status: StreamStatus) => {
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
	 * Without this the two Stream connections would both stay open, and the
	 * platform would route messages to whichever it feels like — the exact
	 * split-brain the lock exists to prevent.
	 */
	#onLockTick(): void {
		const lock = this.lock;
		if (!lock?.held) return;
		const preemptedBy = lock.heartbeat();
		if (!preemptedBy) return;

		// The channel has exactly one voice: whoever owns it. A session
		// that just lost the takeover is a bystander now — the winner's card
		// already named it, so push nothing; the warning stays in this log.
		this.log.warn(`接管已被另一个会话抢占：${preemptedBy.cwd} (PID ${preemptedBy.pid})，本会话不再推送消息`);
		this.release();
	}

	/**
	 * Hand inbound control to the platform, bound to `name` (default `default`).
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
		const target = this.adapter.resolveRobot(this.cfg, name);
		if (!target.control.enabled) return { ok: false, reason: "`control.enabled: false`，入站控制已禁用" };
		if (!target.stream.enabled) {
			return {
				ok: false,
				reason: target.stream.clientId
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
		if (!already) this.log.info("已接管本会话", { robot: name, scope: target.control.scope });
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
		this.approvals.clear("已解除接管");
		this.questions.clear("已解除接管");
		if (wasTakenOver) this.log.info("已解除接管");
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
	 * React with an emoji to the most recent inbound message.
	 *
	 * Used at `session_stop`: ✅ when the run finished cleanly, ❌ when it ended
	 * on an unrecovered error. No-op when nothing has been received yet, or the
	 * emotion call fails — reactions are best-effort, never block the settle.
	 */
	async reactToLastInbound(emoji: string): Promise<void> {
		if (!this.#lastInboundTarget) return;
		if (!this.sender.sendEmotion) return;
		const result = await this.sender.sendEmotion(this.#lastInboundTarget, emoji);
		if (!result.ok) this.log.debug(`表情回复失败：${result.errmsg}`);
	}

	get lastAssistantText(): string {
		return this.#lastAssistantText;
	}

	/** Build the config summary shown by `/dingtalk status`. */
	configSummary(): string[] {
		return this.adapter.describeConfig(this.loaded);
	}
}

// ---------------------------------------------------------------------------
// Approval matching (platform-neutral helpers)
// ---------------------------------------------------------------------------

/** Stable key matching a tool call to its approval — exact arguments required. */
export function approvalKey(toolName: string, input: unknown): string {
	return `${toolName}\u0000${JSON.stringify(input ?? {})}`;
}

/** Translate a glob (`*`, `**`, `?`) into an anchored regex. */
export function globToRegExp(glob: string): RegExp {
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
export function matchApprovalRules(event: { toolName?: string; input?: Record<string, unknown> }, rules: ApprovalRule[]): string | null {
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
export function describeToolCall(event: { toolName?: string; input?: Record<string, unknown> }): string {
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
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms).unref?.())]);
}
