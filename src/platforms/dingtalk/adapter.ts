/**
 * DingTalk adapter: the first implementation of `ChannelAdapter`.
 *
 * Wraps the DingTalk-specific pieces (config schema, sender, stream, message
 * renderer, inbound router) behind the platform-neutral interface from
 * `core/channel.ts`. `core/` never imports this file; `src/index.ts` wires the
 * two together. A second platform is a sibling directory with the same shape.
 */
import type {
	ChannelAdapter,
	ChannelFormatter,
	ChannelRouter,
	ChannelSender,
	ChannelStream,
	InboundMessage,
	Message,
	SendOptions,
	SendResult,
	StreamStatus,
} from "../../core/channel";
import type { ApprovalRegistry } from "../../core/approval";
import type { QuestionRegistry } from "../../core/questions";
import type { ApiLike, CtxLike } from "../../core/pi-types-shared";
import type { Logger } from "../../core/logger";

import {
	DEFAULT_APPROVAL_RULES,
	OUTBOUND_MODE_LABELS,
	SCOPE_LABELS,
	describeConfig,
	loadConfig,
	resolveRobotConfig,
	robotNames,
	type DingTalkConfig,
	type LoadedConfig,
} from "./config";
import { DingTalkSender } from "./sender";
import { DingTalkStream, robotMessageText, type RobotMessage, type StreamStatus as DtStreamStatus } from "./stream";
import {
	fmtApprovalBlocked,
	fmtApprovalRequest,
	fmtApprovalResolved,
	formatApprovalTimeout,
	fmtError,
	fmtHelp,
	fmtQuestionAnsweredLocally,
	fmtQuestionRequest,
	fmtQuestionTimeout,
	fmtQuiet,
	fmtSessionStop,
	fmtStatus,
	fmtTakeoverSuccess,
	fmtText,
	fmtTurnEnd,
	setSessionTag,
} from "./format";
import { CommandRouter, type RouterDeps } from "./router";

// ---------------------------------------------------------------------------
// Sender adapter
// ---------------------------------------------------------------------------

class AdapterSender implements ChannelSender {
	#inner: DingTalkSender;

	constructor(config: DingTalkConfig, log: Logger) {
		this.#inner = new DingTalkSender(config, log);
	}

	get configured(): boolean {
		return this.#inner.configured;
	}

	get recipientCount(): number {
		return this.#inner.recipientCount;
	}

	get stats(): { queued: number; delivered: number; dropped: number; failed: number } {
		return this.#inner.stats;
	}

	updateConfig(config: unknown): void {
		this.#inner.updateConfig(config as DingTalkConfig);
	}

	enqueue(message: Message & SendOptions): void {
		this.#inner.enqueue(message as Parameters<DingTalkSender["enqueue"]>[0]);
	}

	send(message: Message & SendOptions): Promise<SendResult> {
		return this.#inner.send(message as Parameters<DingTalkSender["send"]>[0]) as Promise<SendResult>;
	}

	sendEmotion(target: Record<string, unknown> | undefined, emoji: string): Promise<SendResult> {
		return this.#inner.sendEmotion(target as Parameters<DingTalkSender["sendEmotion"]>[0], emoji);
	}

	/** Reply in the originating conversation (session webhook), used by the router. */
	replyToSession(sessionWebhook: string, title: string, text: string, expiresAt?: number): Promise<SendResult> {
		return this.#inner.replyToSession(sessionWebhook, title, text, expiresAt);
	}
}

// ---------------------------------------------------------------------------
// Stream adapter
// ---------------------------------------------------------------------------

class AdapterStream implements ChannelStream {
	#inner: DingTalkStream;

	constructor(
		config: DingTalkConfig,
		log: Logger,
		handlers: {
			onMessage: (message: InboundMessage) => void;
			onStatus: (status: StreamStatus) => void;
		},
	) {
		this.#inner = new DingTalkStream({
			clientId: config.stream.clientId,
			clientSecret: config.stream.clientSecret,
			logger: log,
			onMessage: (message: RobotMessage) => handlers.onMessage(normalizeInbound(message)),
			onStatus: (status: DtStreamStatus) => handlers.onStatus(status as StreamStatus),
		});
	}

	start(): void {
		this.#inner.start();
	}

	stop(): void {
		this.#inner.stop();
	}

	status(): StreamStatus {
		return this.#inner.status as unknown as StreamStatus;
	}
}

// ---------------------------------------------------------------------------
// Router adapter
// ---------------------------------------------------------------------------

class AdapterRouter implements ChannelRouter {
	#inner: CommandRouter;

	constructor(
		config: DingTalkConfig,
		deps: {
			log: Logger;
			sender: ChannelSender;
			approvals: ApprovalRegistry;
			questions: QuestionRegistry;
			pi: ApiLike;
			getCtx: () => CtxLike | undefined;
			statusLines: () => string[];
			isQuiet: () => boolean;
			setQuiet: (value: boolean) => void;
		},
	) {
		const routerDeps: RouterDeps = {
			cfg: config,
			log: deps.log,
			sender: deps.sender as unknown as DingTalkSender,
			approvals: deps.approvals,
			questions: deps.questions,
			pi: deps.pi,
			getCtx: deps.getCtx,
			statusLines: deps.statusLines,
			isQuiet: deps.isQuiet,
			setQuiet: deps.setQuiet,
		};
		this.#inner = new CommandRouter(routerDeps);
	}

	handle(message: InboundMessage): Promise<void> {
		return this.#inner.handle(message.raw as RobotMessage);
	}
}

// ---------------------------------------------------------------------------
// Formatter adapter
// ---------------------------------------------------------------------------

const formatter: ChannelFormatter = {
	setSessionTag,
	takeoverSuccess: (info) => fmtTakeoverSuccess(info as Parameters<typeof fmtTakeoverSuccess>[0]),
	sessionStop: (info) => fmtSessionStop(info),
	turnEnd: (info) => fmtTurnEnd(info),
	approvalRequest: (info) => fmtApprovalRequest(info),
	approvalResolved: (info) => fmtApprovalResolved(info),
	approvalBlocked: (info) => fmtApprovalBlocked(info),
	approvalTimeout: (info) => formatApprovalTimeout(info),
	questionRequest: (info) => fmtQuestionRequest(info),
	questionAnsweredLocally: (info) => fmtQuestionAnsweredLocally(info),
	questionTimeout: (info) => fmtQuestionTimeout(info),
	error: (info) => fmtError(info),
	help: () => fmtHelp(),
	scopeLabel: (scope) => SCOPE_LABELS[scope as keyof typeof SCOPE_LABELS] ?? scope,
	status: (info) => fmtStatus(info),
	quiet: (on) => fmtQuiet(on),
	text: (title, text) => fmtText(title, text),
};

// ---------------------------------------------------------------------------
// Inbound normalization
// ---------------------------------------------------------------------------

/** The router consumes the raw DingTalk message; carry it through unchanged. */
function normalizeInbound(message: RobotMessage): InboundMessage {
	return {
		conversationId: message.conversationId,
		senderId: message.senderStaffId ?? message.senderId,
		text: robotMessageText(message),
		reactionTarget: message.msgId ? { msgId: message.msgId, conversationId: message.conversationId, robotCode: message.robotCode } : undefined,
		raw: message as unknown as Record<string, unknown>,
	};
}

// ---------------------------------------------------------------------------
// Adapter bundle
// ---------------------------------------------------------------------------

export const dingtalkAdapter: ChannelAdapter<DingTalkConfig> = {
	kind: "dingtalk",
	commandName: "dingtalk",

	loadConfig: (cwd) => {
		const loaded = loadConfig(cwd);
		return { config: loaded.config, warnings: loaded.warnings, sources: loaded.sources };
	},
	resolveRobot: (config, name) => resolveRobotConfig(config, name),
	robotNames: (config) => robotNames(config),
	describeConfig: (loaded) => describeConfig(loaded as unknown as LoadedConfig),
	describeOutbound: (config) => OUTBOUND_MODE_LABELS[config.outbound.mode] ?? config.outbound.mode,
	defaultApprovalRules: DEFAULT_APPROVAL_RULES,

	createSender: (config, log) => new AdapterSender(config, log),
	createStream: (config, log, handlers) => new AdapterStream(config, log, handlers),
	createRouter: (config, deps) => new AdapterRouter(config, deps),
	formatter,
};

export type { DingTalkConfig, LoadedConfig } from "./config";