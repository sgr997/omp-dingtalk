/**
 * ChannelAdapter: the platform boundary of the omp messaging plugin.
 *
 * Everything in `core/` is platform-neutral. A concrete platform (DingTalk,
 * WeChat, QQ, Telegram…) implements this single interface and the core bridge
 * does the rest: session ownership, takeover, cross-process lock, approval
 * registry, question race, notification scheduling, command routing.
 *
 * A new platform is: implement `ChannelAdapter` + a config schema + a message
 * renderer + an inbound connection, then call `createChannelPlugin(pi,
 * adapter)` — nothing in core changes.
 *
 * The config is generic over `P`, the platform's own config type. Core reads
 * only the fields declared on `PlatformConfig` (which the platform's config
 * must satisfy); everything else stays opaque.
 */
import type { ApiLike, CtxLike } from "./pi-types-shared";
import type { Logger } from "./logger";
import type { ApprovalRule } from "./approval-types";
import type { RemoteQuestion } from "./questions";

/** The platform-agnostic slice of a config that core needs to read. */
export interface PlatformConfig {
	enabled: boolean;
	quiet: boolean;
	notify: {
		onlyWhenTakenOver: boolean;
		turnEnd: { enabled: boolean; minDurationMs: number };
		sessionStop: boolean;
		sessionShutdown: boolean;
		errors: boolean;
		goalUpdated: boolean;
		approval: boolean;
		toolUse: { enabled: boolean; tools: string[] };
	};
	approval: { mode: "off" | "remote"; timeoutMs: number; onTimeout: "deny" | "allow"; rules: ApprovalRule[] };
	question: { enabled: boolean; timeoutMs: number };
	control: { enabled: boolean; autoTakeover: boolean; scope: string; allowUserId?: string };
}

/** A rendered message ready to hand to the platform sender. */
export interface Message {
	title: string;
	text: string;
}

export interface SendOptions {
	title: string;
	text: string;
	priority?: "high" | "normal" | "low";
	dedupeKey?: string;
}

export interface SendResult {
	ok: boolean;
	errcode?: number;
	errmsg?: string;
	/** Set when the message was dropped locally rather than attempted. */
	dropped?: boolean;
}

/** Outbound half of a platform: serialized, rate-limited, coalescing. */
export interface ChannelSender {
	readonly configured: boolean;
	readonly recipientCount: number;
	readonly stats: { queued: number; delivered: number; dropped: number; failed: number };
	updateConfig(config: unknown): void;
	enqueue(message: Message & SendOptions): void;
	send(message: Message & SendOptions): Promise<SendResult>;
	/** Best-effort reaction (✅/❌) to the most recent inbound message. */
	sendEmotion?(target: Record<string, unknown> | undefined, emoji: string): Promise<SendResult>;
}

export type StreamState = "idle" | "connecting" | "connected" | "registered" | "reconnecting" | "stopped" | "error";

export interface StreamStatus {
	state: StreamState;
	/** Extra detail, e.g. the reconnect error. */
	detail?: string;
	reconnects: number;
}

/** Inbound half of a platform: connect once, deliver normalized messages. */
export interface ChannelStream {
	start(): void;
	stop(): void;
}

/** A message delivered by the inbound channel, normalized across platforms. */
export interface InboundMessage {
	/** Stable per-conversation id, used for replies/reactions. */
	conversationId?: string;
	/** Sender identity, used by the allow-list gate. */
	senderId?: string;
	/** The plain text the human sent. */
	text: string;
	/** Platform-specific identity the adapter can act on (reply, react). */
	reactionTarget?: Record<string, unknown>;
	/** Everything else the platform carried. */
	raw: Record<string, unknown>;
}

/**
 * How the human answers approvals / questions on this platform. Core never
 * cares about the mechanism (button card, quoted reply, keyword); it only
 * needs the router to be fed with normalized decisions.
 */
export interface ChannelQuestionPack {
	questions: RemoteQuestion[];
	timeoutMs: number;
}

/** The complete message-rendering surface. Core only ever calls these. */
export interface ChannelFormatter {
	setSessionTag(tag: string): void;
	takeoverSuccess(info: { cwd: string; robot?: string; scope: "direct" | "group" | "all"; preempted?: { cwd: string; pid: number }; releaseSeconds?: number }): Message;
	sessionStop(info: { durationMs: number; turns: number; text: string }): Message;
	turnEnd(info: { turnIndex: number; durationMs: number; text?: string; tools?: string[] }): Message;
	approvalRequest(info: { id: string; toolName: string; reason: string; detail: string; timeoutMs: number; rulesCount?: number }): Message;
	approvalResolved(info: { id: string; approved: boolean; by: string; note?: string }): Message;
	approvalBlocked(info: { id: string; toolName: string; detail: string; timeoutMs: number }): string;
	approvalTimeout(info: { id: string; toolName: string; released: boolean; timeoutMs: number }): string;
	questionRequest(info: ChannelQuestionPack & { id: string }): Message;
	questionAnsweredLocally(info: { id: string; questions: RemoteQuestion[] }): Message;
	questionTimeout(info: { id: string; questions: RemoteQuestion[]; timeoutMs: number }): Message;
	error(info: { kind: string; detail: string; hint?: string }): Message;
	help(): Message;
	status(info: {
		lines: string[];
		pending: { id: string; toolName: string; ageMs: number }[];
		pendingQuestions: { id: string; text: string; ageMs: number }[];
	}): Message;
	quiet(on: boolean): Message;
	text(title: string, text: string): Message;
}

/** Everything the router needs from the platform to route inbound messages. */
export interface ChannelRouter {
	handle(message: InboundMessage): Promise<void>;
}

/**
 * The platform bundle. `loadConfig` returns a platform config object; core
 * reads it through the generic `P extends PlatformConfig` bound and hands it
 * back to the adapter's factories unchanged.
 */
export interface ChannelAdapter<P extends PlatformConfig = PlatformConfig> {
	/** e.g. "dingtalk" — shown in status lines and logs. */
	readonly kind: string;
	/** Command name registered on the host, e.g. "dingtalk". */
	readonly commandName: string;

	// Configuration -----------------------------------------------------------
	loadConfig(cwd: string): { config: P; warnings: string[]; sources: string[] };
	/** Effective config for the currently bound robot ("default" = top level). */
	resolveRobot(config: P, name: string): P;
	/** Names of every configured robot, "default" first. */
	robotNames(config: P): string[];
	/** Platform-specific config summary for `/status`. */
	describeConfig(loaded: { config: P; sources: string[] }): string[];
	/** Rules used when the user left `approval.rules` empty. */
	readonly defaultApprovalRules: ApprovalRule[];

	// Channel construction -----------------------------------------------------
	createSender(config: P, log: Logger): ChannelSender;
	createStream(config: P, log: Logger, handlers: {
		onMessage: (message: InboundMessage) => void;
		onStatus: (status: StreamStatus) => void;
	}): ChannelStream & { status: () => StreamStatus };
	createRouter(config: P, deps: {
		log: Logger;
		sender: ChannelSender;
		approvals: import("./approval").ApprovalRegistry;
		questions: import("./questions").QuestionRegistry;
		pi: ApiLike;
		getCtx: () => CtxLike | undefined;
		statusLines: () => string[];
		isQuiet: () => boolean;
		setQuiet: (value: boolean) => void;
	}): ChannelRouter;
	formatter: ChannelFormatter;
}

// Keep the import used in the JSDoc above resolvable at type level.
export type { ApprovalRule } from "./approval-types";