/**
 * Inbound channel: DingTalk → OMP, via Stream mode.
 *
 * Stream mode is the right transport for a machine behind a corporate network:
 * the client dials *out* to DingTalk over WebSocket, so no public IP, no port
 * forwarding and no callback URL registration are needed.
 *
 * Protocol (matches `open-dingtalk/dingtalk-stream-sdk-nodejs`):
 *   1. POST the gateway to trade clientId/clientSecret for `{endpoint, ticket}`.
 *   2. Open `${endpoint}?ticket=${ticket}`.
 *   3. Downstream frames are `{specVersion, type, headers, data}` where `data`
 *      is a JSON string. `type` is SYSTEM | EVENT | CALLBACK.
 *   4. CALLBACK frames must be answered with an upstream frame echoing
 *      `headers.messageId`; the server retries after ~60s otherwise. SYSTEM
 *      frames (CONNECTED / REGISTERED) are not answered.
 *
 * Implemented directly on Bun's global WebSocket + fetch so the plugin stays
 * dependency-free (`omp plugin link` runs no install step).
 */
import type { Logger } from "./logger";
import { b64Decode } from "./util";

const GATEWAY_URL = "https://api.dingtalk.com/v1.0/gateway/connections/open";
/** Fixed topic for robot message callbacks. */
export const TOPIC_ROBOT = "/v1.0/im/bot/messages/get";

const GATEWAY_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
/** No downstream frame for this long is treated as a dead connection. */
const IDLE_TIMEOUT_MS = 180_000;
const LIVENESS_TICK_MS = 30_000;
const MAX_SEEN_IDS = 500;

/** Shape of a robot message as delivered by the stream. */
export interface RobotMessage {
	conversationId?: string;
	/** "1" = 单聊, "2" = 群聊 */
	conversationType?: string;
	conversationTitle?: string;
	chatbotCorpId?: string;
	chatbotUserId?: string;
	msgId?: string;
	senderNick?: string;
	/** Present in group chats: the sender's userId. */
	senderStaffId?: string;
	senderId?: string;
	isAdmin?: boolean;
	isInAtList?: boolean;
	/** Temporary per-conversation reply URL. */
	sessionWebhook?: string;
	sessionWebhookExpiredTime?: number;
	createAt?: number;
	robotCode?: string;
	msgtype?: string;
	/** Stream mode nests the body under `text`; HTTP mode flattens it. */
	text?: { content?: string };
	content?: string;
}

export type StreamState = "idle" | "connecting" | "connected" | "registered" | "reconnecting" | "stopped" | "error";

export interface StreamStatus {
	state: StreamState;
	detail?: string;
	lastFrameAt?: number;
	lastError?: string;
	reconnects: number;
}

export interface StreamOptions {
	clientId: string;
	clientSecret: string;
	ua?: string;
	logger: Logger;
	onMessage: (message: RobotMessage) => void | Promise<void>;
	onStatus?: (status: StreamStatus) => void;
}

/** Runs `fn`, swallowing anything it throws so a stray error can never kill the session. */
function guard(fn: () => void, log: Logger, what: string): void {
	try {
		fn();
	} catch (error) {
		log.error(`${what} 抛出异常`, error);
	}
}

export class DingTalkStream {
	#opts: StreamOptions;
	#log: Logger;

	#ws: WebSocket | undefined;
	#url = "";
	#stopped = true;
	#connecting = false;
	#attempts = 0;
	#connectTimer: ReturnType<typeof setTimeout> | undefined;
	#livenessTimer: ReturnType<typeof setInterval> | undefined;
	#lastFrameAt = 0;
	#seen = new Set<string>();
	#seenOrder: string[] = [];
	#status: StreamStatus = { state: "idle", reconnects: 0 };

	constructor(options: StreamOptions) {
		this.#opts = options;
		this.#log = options.logger;
	}

	get status(): StreamStatus {
		return { ...this.#status };
	}

	start(): void {
		if (!this.#stopped) return;
		if (typeof WebSocket === "undefined") {
			this.#setStatus("error", "当前运行时没有全局 WebSocket，无法建立 Stream 连接");
			return;
		}
		if (!this.#opts.clientId || !this.#opts.clientSecret) {
			this.#setStatus("error", "缺少 clientId / clientSecret");
			return;
		}
		this.#stopped = false;
		this.#attempts = 0;
		void this.#connect();
	}

	stop(): void {
		this.#stopped = true;
		this.#clearConnectTimer();
		this.#clearLiveness();
		const ws = this.#ws;
		this.#ws = undefined;
		if (ws) {
			guard(() => ws.close(), this.#log, "关闭 WebSocket");
		}
		this.#setStatus("stopped");
	}

	#setStatus(state: StreamState, detail?: string): void {
		this.#status = {
			...this.#status,
			state,
			detail,
			lastFrameAt: this.#lastFrameAt || undefined,
		};
		guard(() => this.#opts.onStatus?.(this.status), this.#log, "状态回调");
	}

	async #getEndpoint(): Promise<{ endpoint: string; ticket: string }> {
		const response = await fetch(GATEWAY_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				// Without this the gateway answers with XML.
				Accept: "application/json",
			},
			body: JSON.stringify({
				clientId: this.#opts.clientId,
				clientSecret: this.#opts.clientSecret,
				ua: this.#opts.ua ?? "omp-dingtalk/0.1.0",
				subscriptions: [{ type: "CALLBACK", topic: TOPIC_ROBOT }],
			}),
			signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
		});

		const raw = await response.text();
		let payload: { endpoint?: string; ticket?: string; message?: string; code?: string };
		try {
			payload = JSON.parse(raw);
		} catch {
			throw new Error(`网关返回了非 JSON 响应 (HTTP ${response.status}): ${raw.slice(0, 200)}`);
		}
		if (!payload.endpoint || !payload.ticket) {
			throw new Error(`网关未返回接入点: ${raw.slice(0, 300)}`);
		}
		return { endpoint: payload.endpoint, ticket: payload.ticket };
	}

	async #connect(): Promise<void> {
		if (this.#stopped || this.#connecting) return;
		this.#connecting = true;
		this.#setStatus("connecting");
		try {
			const { endpoint, ticket } = await this.#getEndpoint();
			if (this.#stopped) return;
			this.#url = `${endpoint}?ticket=${ticket}`;
			this.#open();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#status.lastError = message;
			this.#log.warn(`建立 Stream 连接失败: ${message}`);
			this.#setStatus("reconnecting", message);
			this.#scheduleReconnect();
		} finally {
			this.#connecting = false;
		}
	}

	#open(): void {
		let ws: WebSocket;
		try {
			ws = new WebSocket(this.#url);
		} catch (error) {
			this.#log.warn("WebSocket 构造失败", error);
			this.#scheduleReconnect();
			return;
		}
		this.#ws = ws;
		this.#lastFrameAt = Date.now();

		ws.onopen = () =>
			guard(
				() => {
					this.#attempts = 0;
					this.#log.info("Stream 已连接");
					this.#setStatus("connected");
					this.#startLiveness();
				},
				this.#log,
				"open",
			);

		ws.onmessage = (event: MessageEvent) =>
			guard(() => this.#onFrame(event.data), this.#log, "onmessage");

		ws.onerror = () =>
			guard(() => {
				// A close always follows; reconnection is handled there.
				this.#log.debug("Stream WebSocket 报错");
			}, this.#log, "onerror");

		ws.onclose = () =>
			guard(() => {
				if (this.#ws !== ws) return;
				this.#ws = undefined;
				this.#clearLiveness();
				if (this.#stopped) return;
				this.#log.warn("Stream 连接已断开，准备重连");
				this.#scheduleReconnect();
			}, this.#log, "onclose");
	}

	#onFrame(raw: unknown): void {
		this.#lastFrameAt = Date.now();
		let frame: { type?: string; headers?: Record<string, any>; data?: string };
		try {
			frame = JSON.parse(typeof raw === "string" ? raw : String(raw));
		} catch {
			this.#log.debug("收到无法解析的 Stream 帧");
			return;
		}
		const headers = frame.headers ?? {};
		switch (frame.type) {
			case "SYSTEM":
				this.#onSystem(frame, headers);
				break;
			case "CALLBACK":
				this.#onCallback(frame, headers);
				break;
			// EVENT frames are not subscribed; ignore.
			default:
				break;
		}
	}

	#onSystem(frame: { data?: string }, headers: Record<string, any>): void {
		const topic = String(headers.topic ?? "");
		if (topic === "ping" || topic === "disconnect") {
			this.#send({ code: 200, headers, message: "OK", data: frame.data ?? "" });
			if (topic === "disconnect") {
				this.#log.info("服务端要求断开 Stream 连接，立即重连");
				this.#forceReconnect();
			}
			return;
		}
		if (topic === "REGISTERED") {
			this.#attempts = 0;
			this.#setStatus("registered");
			return;
		}
		if (topic === "CONNECTED") {
			this.#setStatus("connected");
		}
	}

	#onCallback(frame: { data?: string }, headers: Record<string, any>): void {
		const messageId = String(headers.messageId ?? "");

		if (messageId) {
			if (this.#seen.has(messageId)) {
				// The server redelivers unacknowledged frames; ack again and skip.
				this.#ack(headers, { response: {} });
				return;
			}
			this.#remember(messageId);
		}

		// Ack before running the handler. A remote approval can block for minutes,
		// and anything slower than the server's ~60s retry window would otherwise
		// be redelivered; dedupe above makes redelivery harmless either way.
		this.#ack(headers, { response: {} });

		let message: RobotMessage;
		try {
			message = parseFrameData(frame.data ?? "") as RobotMessage;
		} catch (error) {
			this.#log.warn("入站消息解析失败", error);
			return;
		}

		Promise.resolve()
			.then(() => this.#opts.onMessage(message))
			.catch((error) => this.#log.error("处理入站消息失败", error));
	}

	#ack(headers: Record<string, any>, response: unknown): void {
		this.#send({
			code: 200,
			headers: { contentType: "application/json", messageId: headers.messageId },
			message: "OK",
			data: JSON.stringify(response),
		});
	}

	#send(payload: unknown): void {
		const ws = this.#ws;
		// 1 === WebSocket.OPEN
		if (!ws || ws.readyState !== 1) return;
		guard(() => ws.send(JSON.stringify(payload)), this.#log, "发送 Stream 帧");
	}

	#remember(messageId: string): void {
		this.#seen.add(messageId);
		this.#seenOrder.push(messageId);
		while (this.#seenOrder.length > MAX_SEEN_IDS) {
			const oldest = this.#seenOrder.shift();
			if (oldest) this.#seen.delete(oldest);
		}
	}

	#startLiveness(): void {
		this.#clearLiveness();
		this.#livenessTimer = setInterval(() => {
			guard(
				() => {
					if (this.#stopped) return;
					if (Date.now() - this.#lastFrameAt > IDLE_TIMEOUT_MS) {
						this.#log.warn("Stream 长时间未收到任何帧，主动重连");
						this.#forceReconnect();
					}
				},
				this.#log,
				"liveness",
			);
		}, LIVENESS_TICK_MS);
		this.#livenessTimer.unref?.();
	}

	#clearLiveness(): void {
		if (this.#livenessTimer) {
			clearInterval(this.#livenessTimer);
			this.#livenessTimer = undefined;
		}
	}

	#clearConnectTimer(): void {
		if (this.#connectTimer) {
			clearTimeout(this.#connectTimer);
			this.#connectTimer = undefined;
		}
	}

	#forceReconnect(): void {
		this.#clearLiveness();
		const ws = this.#ws;
		this.#ws = undefined;
		if (ws) guard(() => ws.close(), this.#log, "关闭 WebSocket");
		this.#attempts = 0;
		this.#scheduleReconnect();
	}

	#scheduleReconnect(): void {
		if (this.#stopped || this.#connectTimer) return;
		const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.#attempts, RECONNECT_MAX_MS) + Math.floor(Math.random() * 1_000);
		this.#attempts += 1;
		this.#status.reconnects += 1;
		this.#log.info(`将在 ${(delay / 1000).toFixed(1)}s 后重连 (第 ${this.#attempts} 次)`);
		this.#setStatus("reconnecting", `${(delay / 1000).toFixed(1)}s 后重试`);

		this.#connectTimer = setTimeout(() => {
			this.#connectTimer = undefined;
			guard(() => void this.#connect(), this.#log, "重连");
		}, delay);
		this.#connectTimer.unref?.();
	}
}

/**
 * Decodes a downstream frame's `data` field.
 *
 * The gateway sends it as a **plain JSON string** — verified against a real
 * CALLBACK frame captured from a live robot, where `data` was
 * `"{\"senderPlatform\":\"iOS\",...}"`, not base64. Some documentation and older
 * SDK builds show it base64-encoded, so fall back to decoding when the direct
 * parse fails. Base64's alphabet contains neither `{` nor `[`, so checking the
 * first character reliably tells the two shapes apart.
 */
function parseFrameData(data: string): unknown {
	const trimmed = data.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);
	return JSON.parse(b64Decode(trimmed));
}

/** Text of an inbound robot message, trimmed of the leading @-mention space. */
export function robotMessageText(message: RobotMessage): string {
	const raw = message.text?.content ?? message.content ?? "";
	return String(raw).replace(/^[\s\u2005]+/, "").trim();
}
