#!/usr/bin/env bun
/**
 * 调试工具：连上钉钉 Stream 网关，把收到的每一帧原样打印出来。
 *
 * 用途：当入站通道「连上了但收不到消息」时，用它确认服务端到底发了什么
 * （SYSTEM 帧的 topic 值、CALLBACK 帧的结构），而不是靠猜。
 *
 * 用法：
 *   bun scripts/debug-stream.ts            抓 20 秒
 *   bun scripts/debug-stream.ts 60000      抓 60 秒
 */
import { loadConfig } from "../src/platforms/dingtalk/config";

const durationMs = Number(process.argv[2] ?? 20_000);
const { config } = loadConfig(process.cwd());

if (!config.stream.clientId || !config.stream.clientSecret) {
	console.error("stream.clientId / clientSecret 未配置，先跑 bun run doctor");
	process.exit(1);
}

const response = await fetch("https://api.dingtalk.com/v1.0/gateway/connections/open", {
	method: "POST",
	headers: { "Content-Type": "application/json", Accept: "application/json" },
	body: JSON.stringify({
		clientId: config.stream.clientId,
		clientSecret: config.stream.clientSecret,
		ua: "omp-dingtalk/0.1.0",
		subscriptions: [
			{ type: "EVENT", topic: "*" },
			{ type: "CALLBACK", topic: "/v1.0/im/bot/messages/get" },
		],
	}),
});
const opened = (await response.json()) as { endpoint?: string; ticket?: string; code?: string; message?: string };
console.log("网关响应:", JSON.stringify(opened));

if (!opened.endpoint || !opened.ticket) process.exit(1);

const ws = new WebSocket(`${opened.endpoint}?ticket=${opened.ticket}`);
let count = 0;

ws.onopen = () => console.log("WS 已打开\n");
ws.onerror = (event) => console.log("WS 错误:", String((event as ErrorEvent).message ?? event));

const anyWs = ws as unknown as Record<string, unknown>;
anyWs.onping = () => console.log("  [底层 ping]");
anyWs.onpong = () => console.log("  [底层 pong]");

ws.onmessage = (event) => {
	count += 1;
	const raw = String((event as MessageEvent).data);
	console.log(`\n──── 第 ${count} 帧 ────`);
	console.log("原始:", raw.slice(0, 800));

	try {
		const frame = JSON.parse(raw) as { type?: string; headers?: Record<string, unknown>; data?: unknown };
		console.log("type:", frame.type, " headers:", JSON.stringify(frame.headers));

		// The gateway sends `data` as a plain JSON string (not base64).
		const text = typeof frame.data === "string" ? frame.data.trim() : "";
		if (text) {
			const decoded = text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : JSON.parse(Buffer.from(text, "base64").toString("utf8"));
			console.log("data 解出来:", JSON.stringify(decoded).slice(0, 600));
		}

		ws.send(
			JSON.stringify({
				code: 200,
				headers: { contentType: "application/json", messageId: frame.headers?.messageId },
				message: "OK",
				data: frame.data,
			}),
		);
	} catch (error) {
		console.log("解析失败:", error instanceof Error ? error.message : String(error));
	}
};

ws.onclose = (event) => console.log(`WS 关闭: code=${event.code} reason=${event.reason}`);

console.log(`\n抓帧 ${durationMs / 1000} 秒…（现在去群里 @机器人 发一条消息）\n`);
setTimeout(() => {
	console.log(`\n共收到 ${count} 帧`);
	ws.close();
	process.exit(0);
}, durationMs);
