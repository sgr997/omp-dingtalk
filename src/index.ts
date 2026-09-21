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
import { registerAskTool, type AskRaceBridge, type AskRaceRequest } from "./core/ask-tool";
import { createLogger } from "./core/logger";
import { heartbeatMs } from "./core/lock";
import {
	Bridge,
	approvalKey,
	describeToolCall,
	matchApprovalRules,
	withTimeout,
} from "./core/bridge";
import { extractText, extractToolNames, safeJson, truncate, truncatePath } from "./core/util";
import { dingtalkAdapter } from "./platforms/dingtalk/adapter";
import type { DingTalkConfig } from "./platforms/dingtalk/config";
import type { ApiLike } from "./core/pi-types-shared";

/**
 * Hard cap on the shutdown notification send.
 *
 * OMP aborts an event handler that runs longer than **2000 ms** ("handler timed
 * out after 2000ms"), so this must stay comfortably under that. The goal is to
 * give the message a chance to leave the machine, not to guarantee delivery —
 * a slow network or a backed-up rate-limit queue will still drop it.
 */
const SHUTDOWN_SEND_TIMEOUT_MS = 1_500;

/**
 * Owns one cwd's worth of bridge state. Recreated when the working directory
 * changes so project-level config overrides are picked up.
 */

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

	let bridge: Bridge<DingTalkConfig> | undefined;

		/** Get (or lazily build) the bridge for a working directory. */
		const ensure = (cwd: string): Bridge<DingTalkConfig> => {
			if (bridge && bridge.cwd === cwd) return bridge;
			if (bridge) {
				// `dispose()` releases the takeover lock, so a cwd change silently hands
				// control back to the terminal. Say so — otherwise the channel just stops
				// reaching this session with no explanation.
				if (bridge.takenOver) bridge.log.warn("工作目录变更，已释放接管（本会话不再受通道控制）");
				bridge.dispose("工作目录变更");
			}
			bridge = new Bridge(api, cwd || process.cwd(), dingtalkAdapter);
			// The label lives in the platform formatter, which is shared by everything
			// in this process. Only one bridge is ever live at a time (`dispose()`
			// above), so re-asserting it here keeps the label pointing at the live
			// session even when the cwd changes without a fresh `session_start`.
			bridge.formatter.setSessionTag(bridge.buildSessionTag());
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
			b.formatter.setSessionTag(b.buildSessionTag());

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
						b.formatter.takeoverSuccess({
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
				b.formatter.turnEnd({
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
				b.formatter.sessionStop({
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

			const rules = b.cfg.approval.rules.length > 0 ? b.cfg.approval.rules : b.adapter.defaultApprovalRules;
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
							b.formatter.approvalRequest({
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
				reason: b.formatter.approvalBlocked({ id: approval.id, toolName, detail, timeoutMs: b.cfg.approval.timeoutMs }),
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
				b.formatter.error({
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
				b.formatter.error({
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
				b.formatter.error({
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
				b.formatter.text("🎯 目标更新", `- **状态**: ${goal.status ?? "?"}\n- **目标**: ${truncate(goal.title ?? goal.text ?? "", 300)}`),
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
				b.formatter.error({
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
							? `钉钉已接管本会话（机器人 ${robotName} · ${b.adapter.formatter.scopeLabel(b.activeCfg.control.scope)}）。现在可以在钉钉里发消息指挥它；用 /dingtalk release 解除。${stolen}${hint}`
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
							b.formatter.takeoverSuccess({
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
					`- **审批规则**: ${b.cfg.approval.mode === "remote" ? `${(b.cfg.approval.rules.length ? b.cfg.approval.rules : b.adapter.defaultApprovalRules).length} 条` : "未启用"}`,
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

// Kept for compatibility with older external importers of the plugin surface.
export { fmtHelp } from "./platforms/dingtalk/format";
