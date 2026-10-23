/**
 * Outbound channel: OMP → DingTalk.
 *
 * `outbound.mode` picks the transport (see `OutboundConfig`):
 *
 *  1. `webhook` — POST to the group's custom-robot webhook. Works standalone
 *     with nothing but a URL, which is why it is the default. A custom robot can
 *     only ever post into its own group; it has no way to send a 1:1 message.
 *  2. `direct` — enterprise-app robot 1:1 push through OpenAPI. Reaches the user
 *     wherever they are, needs `clientId` / `clientSecret` / `robotCode`, and is
 *     not subject to the custom robot's 20/min block.
 *  3. `both` — do both; one transport getting through counts as delivered.
 *
 * On top of either, `replyToSession()` answers inside the conversation an
 * inbound message came from, using the per-message `sessionWebhook` — no extra
 * credentials, but the URL expires, so it is only used for replies.
 *
 * DingTalk throttles a custom robot at 20 messages/minute and then blocks it for
 * 10 minutes, so every send funnels through one serialized queue with a
 * conservative budget (15/minute, 2.2s minimum gap) and same-key coalescing.
 */
import type { DingTalkConfig } from "./config";
import type { Logger } from "../../core/logger";
import { hmacSha256Base64, sleep } from "../../core/util";
import { decorateMessage } from "./format";

export interface SendOptions {
	title: string;
	text: string;
	/** Higher priority jumps the queue; `low` messages may be dropped when saturated. */
	priority?: "high" | "normal" | "low";
	/** Replaces an identical queued message instead of stacking a duplicate. */
	dedupeKey?: string;
	/** Re-check queue-time validity immediately before delivery. */
	isStillValid?: () => boolean;
	atMobiles?: string[];
	atUserIds?: string[];
	atAll?: boolean;
}

export interface SendResult {
	ok: boolean;
	errcode?: number;
	errmsg?: string;
	/** Set when the message was dropped locally rather than attempted. */
	dropped?: boolean;
}

interface QueueItem {
	opts: SendOptions;
	/** Explicit command receipts keep their original robot after release resets config. */
	target?: DingTalkConfig;
	rank: number;
	resolve?: (result: SendResult) => void;
}

interface EmotionTag {
	name: string;
	emotionId: string;
	backgroundId: string;
}

const WINDOW_MS = 60_000;
/** DingTalk allows 20/min; stay under it so a burst never trips the 10-minute block. */
const MAX_PER_WINDOW = Number(process.env.OMP_DINGTALK_MAX_PER_MIN) || 15;
const MIN_GAP_MS = Number(process.env.OMP_DINGTALK_MIN_GAP_MS) || 2_200;
const MAX_QUEUE = 60;
const HTTP_TIMEOUT_MS = 10_000;
/** DingTalk blocks a robot for ~10 minutes once the per-minute cap is exceeded. */
const THROTTLE_COOLDOWN_MS = 10 * 60_000;
/** Enterprise-app robot 1:1 push. */
const OTO_MESSAGE_URL = "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";
const EMOTION_API = "https://api.dingtalk.com/v1.0/robot/emotion";
const MAX_REACTION_STATES = 500;
const RANK: Record<NonNullable<SendOptions["priority"]>, number> = { high: 0, normal: 1, low: 2 };

function emotionTag(emoji: string): EmotionTag {
	if (emoji === "👀") return { name: "👀", emotionId: "2659900", backgroundId: "im_bg_1" };
	if (emoji === "✅") return { name: "✅ 已完成", emotionId: "54054", backgroundId: "im_bg_5" };
	if (emoji === "❌") return { name: "❌ 失败", emotionId: "34019", backgroundId: "im_bg_6" };
	return { name: emoji, emotionId: "34019", backgroundId: "im_bg_6" };
}

export class DingTalkSender {
	#cfg: DingTalkConfig;
	#log: Logger;

	#queue: QueueItem[] = [];
	#pumping = false;
	#sentAt: number[] = [];
	#lastSentAt = 0;
	#cooldownUntil = 0;
	#dropped = 0;
	#failed = 0;
	#delivered = 0;

	#accessToken = "";
	#accessTokenExpiresAt = 0;
	#credentialGeneration = 0;
	/** Last successful reaction per inbound message, so a status change can replace it. */
	#reactionStates = new Map<string, EmotionTag>();
	/** Serialize transitions per message; reply/recall races otherwise leave two reactions behind. */
	#reactionTails = new Map<string, Promise<void>>();

	constructor(cfg: DingTalkConfig, logger: Logger) {
		this.#cfg = cfg;
		this.#log = logger;
	}

	/**
	 * Swap in a reloaded config without touching the queue or the rate-limit
	 * window.
	 *
	 * Building a fresh sender on every config change would be wrong twice over:
	 * it resets `#sentAt` / `#lastSentAt` / `#cooldownUntil`, so an edit made
	 * during a burst would let the robot sail past DingTalk's 20/min cap; and the
	 * old instance keeps draining its own backlog in parallel, so a notification
	 * queued *before* the reload can be delivered *after* one queued afterwards.
	 */
	updateConfig(cfg: DingTalkConfig): void {
		if (cfg.stream.clientId !== this.#cfg.stream.clientId || cfg.stream.clientSecret !== this.#cfg.stream.clientSecret) {
			this.#credentialGeneration += 1;
			this.#accessToken = "";
			this.#accessTokenExpiresAt = 0;
		}
		this.#cfg = cfg;
	}

	/** Settle invalid queued sends immediately, including during a cooldown. */
	discardInvalidated(): void {
		this.#queue = this.#queue.filter((item) => {
			if (!item.opts.isStillValid || item.opts.isStillValid()) return true;
			this.#dropped += 1;
			item.resolve?.({ ok: false, dropped: true, errmsg: "通知状态已变化，已取消发送" });
			return false;
		});
	}

	/**
	 * Which transports this config — plus anything learned at runtime — can use.
	 * A transport is only "on" when its mode is selected *and* it is usable.
	 */
	#channels(cfg = this.#cfg): { webhook: boolean; direct: boolean } {
		const { mode } = cfg.outbound;
		const { clientId, clientSecret, robotCode } = cfg.stream;
		return {
			webhook: (mode === "webhook" || mode === "both") && Boolean(cfg.webhook.url),
			direct:
				(mode === "direct" || mode === "both") &&
				Boolean(clientId && clientSecret && robotCode) &&
				Boolean(cfg.control.allowUserId),
		};
	}

	/** Whether at least one transport is configured and reachable. */
	get configured(): boolean {
		const channels = this.#channels();
		return channels.webhook || channels.direct;
	}

	/** How many 1:1 recipients are currently known. */
	get recipientCount(): number {
		return this.#recipients().length;
	}

	/**
	 * 1:1 push recipients. The allowlisted operator is the recipient: whoever
	 * can command the session can receive its notifications, so there is exactly
	 * one id to configure.
	 */
	#recipients(): string[] {
		const id = this.#cfg.control.allowUserId;
		return id ? [id] : [];
	}

	get stats() {
		return {
			queued: this.#queue.length,
			delivered: this.#delivered,
			dropped: this.#dropped,
			failed: this.#failed,
			cooldownMs: Math.max(0, this.#cooldownUntil - Date.now()),
		};
	}

	/** Fire-and-forget notification. Never throws. */
	enqueue(opts: SendOptions): void {
		this.#push(opts);
	}

	/** Queued send that resolves with the result — used for command replies. */
	async send(opts: SendOptions): Promise<SendResult> {
		return this.#push({ priority: "high", ...opts });
	}

	captureTarget(): (opts: SendOptions) => Promise<SendResult> {
		const target = this.#cfg;
		return (opts) => this.#push({ priority: "high", ...opts }, target);
	}

	#push(opts: SendOptions, target?: DingTalkConfig): Promise<SendResult> {
		const rank = RANK[opts.priority ?? "normal"];

		if (opts.dedupeKey) {
			const existing = this.#queue.find((item) => item.opts.dedupeKey === opts.dedupeKey);
			if (existing) {
				existing.opts = opts;
				existing.target = target;
				existing.rank = rank;
				return Promise.resolve({ ok: true, dropped: true, errmsg: "已合并到队列中同 key 的消息" });
			}
		}

		if (this.#queue.length >= MAX_QUEUE) {
			// Drop the newest lowest-priority item rather than the oldest, so the
			// backlog keeps the messages that were queued when things went wrong.
			let victimIndex = -1;
			for (let i = this.#queue.length - 1; i >= 0; i -= 1) {
				if (this.#queue[i].rank === RANK.low) {
					victimIndex = i;
					break;
				}
			}
			if (victimIndex === -1) victimIndex = this.#queue.length - 1;
			const [victim] = this.#queue.splice(victimIndex, 1);
			this.#dropped += 1;
			this.#log.warn("发送队列已满，丢弃一条消息", { dropped: victim?.opts.title });
			victim?.resolve?.({ ok: false, dropped: true, errmsg: "本地队列已满" });
		}

		let resolve!: (result: SendResult) => void;
		const promise = new Promise<SendResult>((r) => {
			resolve = r;
		});

		const item: QueueItem = { opts, target, rank, resolve };
		const insertAt = this.#queue.findIndex((queued) => queued.rank > rank);
		if (insertAt === -1) this.#queue.push(item);
		else this.#queue.splice(insertAt, 0, item);

		this.#pump();
		return promise;
	}

	#pump(): void {
		if (this.#pumping) return;
		this.#pumping = true;
		void this.#drain().finally(() => {
			this.#pumping = false;
			// A push that landed while the flag was still set found the queue
			// "busy" and did not start its own drain, so re-check here or that
			// item would sit in the queue forever.
			if (this.#queue.length > 0) this.#pump();
		});
	}

	async #drain(): Promise<void> {
		try {
			while (this.#queue.length > 0) {
				const wait = this.#waitMs();
				if (wait > 0) await sleep(wait);
				const item = this.#queue.shift();
				if (!item) break;
				if (item.opts.isStillValid && !item.opts.isStillValid()) {
					this.#dropped += 1;
					this.#log.debug("排队通知已失效，跳过发送", { title: item.opts.title });
					item.resolve?.({ ok: false, dropped: true, errmsg: "通知状态已变化，已取消发送" });
					continue;
				}

				let result: SendResult;
				try {
					result = await this.#deliver(item.opts, item.target);
				} catch (error) {
					result = { ok: false, errmsg: error instanceof Error ? error.message : String(error) };
				}

				this.#sentAt.push(Date.now());
				this.#lastSentAt = Date.now();
				if (result.ok) this.#delivered += 1;
				else this.#failed += 1;
				item.resolve?.(result);
			}
		} catch (error) {
			// The queue worker must never reject into the host: an unhandled
			// rejection from a detached timer would tear down the session.
			this.#log.error("发送队列异常", error);
		}
	}

	#waitMs(): number {
		const now = Date.now();
		this.#sentAt = this.#sentAt.filter((at) => now - at < WINDOW_MS);

		let wait = 0;
		if (this.#sentAt.length >= MAX_PER_WINDOW) {
			wait = Math.max(wait, this.#sentAt[0] + WINDOW_MS - now);
		}
		if (this.#lastSentAt > 0) {
			wait = Math.max(wait, this.#lastSentAt + MIN_GAP_MS - now);
		}
		if (this.#cooldownUntil > now) {
			wait = Math.max(wait, this.#cooldownUntil - now);
		}
		return Math.max(0, wait);
	}

	/** Append `timestamp` + `sign` when a signing secret is configured. */
	#signedUrl(cfg = this.#cfg): string {
		const { url, secret } = cfg.webhook;
		if (!secret) return url;
		try {
			const timestamp = Date.now();
			// DingTalk's spec: HMAC-SHA256 over `${timestamp}\n${secret}` keyed by secret.
			const sign = encodeURIComponent(hmacSha256Base64(secret, `${timestamp}\n${secret}`));
			const parsed = new URL(url);
			parsed.searchParams.set("timestamp", String(timestamp));
			parsed.searchParams.set("sign", sign);
			return parsed.toString();
		} catch (error) {
			this.#log.warn("webhook URL 解析失败，改为不带签名发送", error);
			return url;
		}
	}

	/** "自定义关键词" mode requires the keyword to appear in the body. */
	#applyKeyword(text: string, cfg = this.#cfg): string {
		const { keyword } = cfg.webhook;
		if (!keyword) return text;
		return text.includes(keyword) ? text : `${keyword}\n${text}`;
	}

	async #deliver(opts: SendOptions, target?: DingTalkConfig): Promise<SendResult> {
		const cfg = target ?? this.#cfg;
		// Every outbound message gets the session badge and footer here, so
		// command replies and receipts are labelled exactly like notifications.
		const decorated = decorateMessage({ title: opts.title, text: opts.text });
		opts = { ...opts, title: decorated.title, text: decorated.text };
		const valid = () => (target !== undefined || cfg === this.#cfg) && (opts.isStillValid?.() ?? true);
		const channels = this.#channels(cfg);
		const results: SendResult[] = [];
		if (!valid()) return { ok: false, dropped: true, errmsg: "发送状态已变化" };
		if (channels.webhook) results.push(await this.#deliverWebhook(opts, cfg));
		if (channels.direct && valid()) results.push(await this.#deliverDirect(opts, cfg, valid, target !== undefined));
		if (results.length === 0) {
			return { ok: false, errmsg: "没有可用的出站通道（检查 outbound.mode 与凭据）" };
		}

		// In `both` mode one transport getting through counts as delivered, but
		// the failure of the other one should still be visible in the log.
		const failure = results.find((result) => !result.ok);
		if (!failure) return { ok: true, errcode: 0, errmsg: "ok" };
		if (results.some((result) => result.ok)) {
			this.#log.warn("部分出站通道发送失败", failure.errmsg);
			return { ok: true, errcode: 0, errmsg: "ok（部分通道失败）" };
		}
		return failure;
	}

	/** Post into the group the custom robot lives in. */
	async #deliverWebhook(opts: SendOptions, cfg: DingTalkConfig): Promise<SendResult> {
		const { url } = cfg.webhook;
		if (!url) return { ok: false, errmsg: "未配置 webhook.url" };

		const atMobiles = opts.atMobiles ?? cfg.notify.atMobiles;
		const atUserIds = opts.atUserIds ?? cfg.notify.atUserIds;
		const atAll = opts.atAll ?? cfg.notify.atAll;

		const body: Record<string, unknown> = {
			msgtype: "markdown",
			markdown: { title: opts.title, text: this.#applyKeyword(opts.text, cfg) },
		};
		if (atAll || atMobiles.length > 0 || atUserIds.length > 0) {
			body.at = {
				isAtAll: Boolean(atAll),
				...(atMobiles.length > 0 ? { atMobiles } : {}),
				...(atUserIds.length > 0 ? { atUserIds } : {}),
			};
		}

		try {
			const response = await fetch(this.#signedUrl(cfg), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
			});
			const raw = await response.text();
			let payload: { errcode?: number; errmsg?: string } = {};
			try {
				payload = JSON.parse(raw) as typeof payload;
			} catch {
				return { ok: false, errmsg: `响应不是 JSON: ${raw.slice(0, 200)}` };
			}

			const errcode = payload.errcode ?? -1;
			if (errcode === 0) return { ok: true, errcode: 0, errmsg: "ok" };

			if (errcode === 410100) {
				this.#cooldownUntil = Date.now() + THROTTLE_COOLDOWN_MS;
				this.#log.warn("触发钉钉限流，暂停发送 10 分钟");
			} else if (errcode === 310000) {
				this.#log.warn("钉钉安全校验失败（关键词不匹配或签名错误）", payload.errmsg);
			} else if (errcode === 300001 || errcode === 300005) {
				this.#log.warn("钉钉 webhook token 无效或机器人已被移除", payload.errmsg);
			}
			return { ok: false, errcode, errmsg: payload.errmsg };
		} catch (error) {
			return { ok: false, errmsg: error instanceof Error ? error.message : String(error) };
		}
	}

	/**
	 * 1:1 push through the enterprise-app robot OpenAPI.
	 *
	 * The keyword is deliberately *not* applied here: it is a custom-robot
	 * webhook security setting and would just prefix every DM with junk.
	 */
	async #deliverDirect(opts: SendOptions, cfg: DingTalkConfig, valid: () => boolean, pinned = false): Promise<SendResult> {
		const { robotCode } = cfg.stream;
		const recipients = cfg.control.allowUserId ? [cfg.control.allowUserId] : [];
		if (!robotCode) return { ok: false, errmsg: "单聊推送需要 stream.robotCode" };
		if (recipients.length === 0) {
			return { ok: false, errmsg: "单聊推送没有收件人（control.allowUserId 为空）" };
		}

		try {
			const token = await this.#getAccessToken(cfg, pinned);
			if (!valid()) return { ok: false, dropped: true, errmsg: "发送状态已变化" };
			if (!token) return { ok: false, errmsg: "获取 access_token 失败" };

			const response = await fetch(OTO_MESSAGE_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-acs-dingtalk-access-token": token,
				},
				body: JSON.stringify({
					robotCode,
					userIds: recipients,
					msgKey: "sampleMarkdown",
					msgParam: JSON.stringify({ title: opts.title, text: opts.text }),
				}),
				signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
			});
			const raw = await response.text();
			if (!response.ok) {
				this.#log.warn("单聊推送失败", { status: response.status, body: raw.slice(0, 300) });
				return { ok: false, errmsg: `HTTP ${response.status}: ${raw.slice(0, 200)}` };
			}
			return { ok: true };
		} catch (error) {
			return { ok: false, errmsg: error instanceof Error ? error.message : String(error) };
		}
	}

	/**
	 * Reply inside the conversation an inbound message came from.
	 * `sessionWebhookExpiredTime` is a ms epoch; expired URLs are rejected early.
	 */
	async replyToSession(sessionWebhook: string, title: string, text: string, expiresAt?: number): Promise<SendResult> {
		if (!sessionWebhook) return { ok: false, errmsg: "缺少 sessionWebhook" };
		if (expiresAt && Date.now() > expiresAt) {
			return { ok: false, errmsg: "sessionWebhook 已过期" };
		}
		try {
			const response = await fetch(sessionWebhook, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ msgtype: "markdown", markdown: { title, text } }),
				signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
			});
			const raw = await response.text();
			try {
				const payload = JSON.parse(raw) as { errcode?: number; errmsg?: string };
				const ok = (payload.errcode ?? -1) === 0;
				if (!ok) this.#log.warn("sessionWebhook 回复失败", payload);
				return { ok, errcode: payload.errcode, errmsg: payload.errmsg };
			} catch {
				return { ok: false, errmsg: raw.slice(0, 200) };
			}
		} catch (error) {
			return { ok: false, errmsg: error instanceof Error ? error.message : String(error) };
		}
	}

	/** Cached app access_token, refreshed a minute before it expires. */
	async #getAccessToken(cfg = this.#cfg, pinned = false): Promise<string> {
		const generation = this.#credentialGeneration;
		const current = cfg.stream.clientId === this.#cfg.stream.clientId && cfg.stream.clientSecret === this.#cfg.stream.clientSecret;
		if (!current && !pinned) return "";
		if (current && this.#accessToken && Date.now() < this.#accessTokenExpiresAt) return this.#accessToken;
		const { clientId, clientSecret } = cfg.stream;
		const response = await fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ appKey: clientId, appSecret: clientSecret }),
			signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
		});
		const payload = (await response.json()) as { accessToken?: string; expireIn?: number; message?: string };
		// A pinned receipt may use its old robot's token, but must never put that
		// token into the currently selected robot's cache.
		if (!current || generation !== this.#credentialGeneration) return pinned ? payload.accessToken ?? "" : "";
		if (!payload.accessToken) {
			this.#log.warn("获取 access_token 失败", payload);
			return "";
		}
		this.#accessToken = payload.accessToken;
		// Refresh a minute early.
		this.#accessTokenExpiresAt = Date.now() + Math.max(60, (payload.expireIn ?? 7200) - 60) * 1000;
		return this.#accessToken;
	}

	/**
	 * Set the robot reaction on an inbound message.
	 *
	 * Uses the enterprise-app robot OpenAPI (`/v1.0/robot/emotion/reply`), which
	 * needs `access_token` + `robotCode` + the message's `msgId` and
	 * `conversationId` — both available on every `RobotMessage` the Stream
	 * delivers. Unlike `sessionWebhook` this does not expire, so it works even
	 * on long-running sessions.
	 *
	 * DingTalk's reply endpoint adds a reaction; it does not replace an existing
	 * one. Remember the previous successful tag and recall it before attaching a
	 * new status, so 👀 closes into one ✅/❌ terminal state.
	 */
	async sendEmotion(message: {
		msgId?: string;
		conversationId?: string;
		robotCode?: string;
	}, emoji: string, isStillValid: () => boolean = () => true): Promise<SendResult> {
		const cfg = this.#cfg;
		if (!isStillValid()) return { ok: false, dropped: true, errmsg: "接管状态已变化" };
		const msgId = message.msgId;
		const conversationId = message.conversationId;
		const robotCode = message.robotCode ?? cfg.stream.robotCode;
		if (!msgId || !conversationId || !robotCode) {
			return { ok: false, errmsg: "缺少 msgId / conversationId / robotCode，无法发送表情" };
		}
		const key = `${robotCode}\u0000${conversationId}\u0000${msgId}`;
		const tag = emotionTag(emoji);
		const previousTail = this.#reactionTails.get(key);
		const replace = () => this.#replaceEmotion({ cfg, key, msgId, conversationId, robotCode, tag, isStillValid });
		const operation = previousTail ? previousTail.then(replace) : replace();
		const tail = operation.then(() => undefined, () => undefined);
		this.#reactionTails.set(key, tail);
		try {
			return await operation;
		} finally {
			if (this.#reactionTails.get(key) === tail) this.#reactionTails.delete(key);
		}
	}

	async #replaceEmotion(options: {
		cfg: DingTalkConfig;
		key: string;
		msgId: string;
		conversationId: string;
		robotCode: string;
		tag: EmotionTag;
		isStillValid: () => boolean;
	}): Promise<SendResult> {
		const { cfg, key, msgId, conversationId, robotCode, tag, isStillValid } = options;
		if (cfg !== this.#cfg || !isStillValid()) return { ok: false, dropped: true, errmsg: "接管状态已变化" };
		try {
			const token = await this.#getAccessToken(cfg);
			if (cfg !== this.#cfg || !isStillValid()) return { ok: false, dropped: true, errmsg: "接管状态已变化" };
			if (!token) return { ok: false, errmsg: "获取 access_token 失败" };
			const previous = this.#reactionStates.get(key);
			if (previous?.name === tag.name) return { ok: true };
			if (previous) {
				const recalled = await this.#callEmotion("recall", { msgId, conversationId, robotCode, tag: previous, token });
				if (!recalled.ok) return recalled;
				this.#reactionStates.delete(key);
			}
			if (cfg !== this.#cfg || !isStillValid()) return { ok: false, dropped: true, errmsg: "接管状态已变化" };
			const replied = await this.#callEmotion("reply", { msgId, conversationId, robotCode, tag, token });
			if (replied.ok) {
				this.#reactionStates.delete(key);
				this.#reactionStates.set(key, tag);
				if (this.#reactionStates.size > MAX_REACTION_STATES) {
					const oldest = this.#reactionStates.keys().next().value;
					if (oldest) this.#reactionStates.delete(oldest);
				}
			}
			return replied;
		} catch (error) {
			return { ok: false, errmsg: error instanceof Error ? error.message : String(error) };
		}
	}

	async #callEmotion(endpoint: "reply" | "recall", options: {
		msgId: string;
		conversationId: string;
		robotCode: string;
		tag: EmotionTag;
		token: string;
	}): Promise<SendResult> {
		const { msgId, conversationId, robotCode, tag, token } = options;
		try {
			const response = await fetch(`${EMOTION_API}/${endpoint}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-acs-dingtalk-access-token": token,
				},
				body: JSON.stringify({
					robotCode,
					openMsgId: msgId,
					openConversationId: conversationId,
					emotionType: 2,
					emotionName: tag.name,
					textEmotion: {
						emotionId: tag.emotionId,
						emotionName: tag.name,
						text: tag.name,
						backgroundId: tag.backgroundId,
					},
				}),
				signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
			});
			if (!response.ok) {
				const raw = await response.text();
				this.#log.warn(`表情${endpoint === "recall" ? "撤回" : "回复"}失败`, { status: response.status, body: raw.slice(0, 300) });
				return { ok: false, errmsg: `HTTP ${response.status}: ${raw.slice(0, 200)}` };
			}
			return { ok: true };
		} catch (error) {
			return { ok: false, errmsg: error instanceof Error ? error.message : String(error) };
		}
	}
}
