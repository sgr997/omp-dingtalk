import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "omp-reaction-lifecycle-"));
process.env.OMP_DINGTALK_CONFIG = join(scratch, "config.json");
process.env.OMP_DINGTALK_LOCK_DIR = join(scratch, "locks");
process.env.OMP_DINGTALK_MIN_GAP_MS = "1";
process.env.OMP_DINGTALK_MAX_PER_MIN = "1000";
writeFileSync(process.env.OMP_DINGTALK_CONFIG, JSON.stringify({
	stream: { enabled: true, clientId: "app", clientSecret: "secret", robotCode: "robot" },
	outbound: { mode: "direct" },
	control: { enabled: true, allowUserId: "staff", autoTakeover: false, freeText: true },
	notify: { sessionStop: false, turnEnd: { enabled: false } },
}));

const reactions = new Map<string, Set<string>>();
const reactionBodies: Array<{ endpoint: string; body: any }> = [];
globalThis.fetch = (async (input, init) => {
	const url = String(input);
	const body = init?.body ? JSON.parse(String(init.body)) : {};
	if (url.includes("/gateway/")) return new Response(JSON.stringify({ endpoint: "wss://mock.invalid", ticket: "ticket" }));
	if (url.includes("/oauth2/")) return new Response(JSON.stringify({ accessToken: "token", expireIn: 7200 }));
	if (url.includes("/robot/emotion/")) {
		const key = `${body.openConversationId}:${body.openMsgId}`;
		const state = reactions.get(key) ?? new Set<string>();
		const endpoint = url.endsWith("/recall") ? "recall" : "reply";
		if (endpoint === "recall") state.delete(body.emotionName);
		else state.add(body.emotionName);
		reactions.set(key, state);
		reactionBodies.push({ endpoint, body });
	}
	return new Response(JSON.stringify({ errcode: 0, processQueryKey: "q" }));
}) as typeof fetch;

class Socket {
	static latest: Socket | undefined;
	readyState = 1;
	onopen?: () => void;
	onclose?: () => void;
	onmessage?: (event: { data: string }) => void;
	constructor(_url: string) { Socket.latest = this; }
	send() {}
	close() { this.readyState = 3; this.onclose?.(); }
	message(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
}
globalThis.WebSocket = Socket as any;

const handlers = new Map<string, any>();
let command: any;
let prompts = 0;
const schema = (): any => {
	const value: any = { describe: () => value, optional: () => value, min: () => value, default: () => value };
	return value;
};
const module = await import("../../src/index.ts");
module.default({
	logger: { debug() {}, info() {}, warn() {}, error() {} },
	zod: Object.fromEntries(["object", "array", "string", "number", "boolean", "enum"].map((key) => [key, schema])),
	on: (event: string, handler: any) => handlers.set(event, handler),
	registerCommand: (_name: string, options: any) => { command = options; },
	registerTool() {},
	appendEntry() {},
	sendUserMessage() { prompts += 1; },
});
const ctx = {
	cwd: scratch, hasUI: true, mode: "tui", isIdle: () => true,
	sessionManager: { getSessionId: () => "owner", getBranch: () => [] },
	ui: { notify() {} },
};
async function waitFor(predicate: () => boolean): Promise<void> {
	const timeoutAt = Date.now() + 1000;
	while (!predicate() && Date.now() < timeoutAt) await Bun.sleep(1);
}
await handlers.get("session_start")({}, ctx);
await command.handler("takeover", ctx);
await waitFor(() => Boolean(Socket.latest?.onmessage));
assert.ok(Socket.latest?.onmessage, "stream should be connected");

Socket.latest!.message({
	type: "CALLBACK",
	headers: { messageId: "frame-1", topic: "/v1.0/im/bot/messages/get" },
	data: JSON.stringify({
		msgId: "message-1", conversationId: "conversation-1", conversationType: "1",
		robotCode: "robot", senderStaffId: "staff", text: { content: "帮我处理这个任务" },
	}),
});
await waitFor(() => prompts > 0);
await waitFor(() => Boolean(reactions.get("conversation-1:message-1")?.has("👀")));
assert.equal(prompts, 1);
assert.deepEqual([...reactions.get("conversation-1:message-1")!], ["👀"], "accepted message starts in viewing state");

await handlers.get("session_stop")({ last_assistant_message: { role: "assistant", content: [{ type: "text", text: "完成" }] } }, ctx);
assert.deepEqual([...reactions.get("conversation-1:message-1")!], ["✅ 已完成"], "completion must replace the viewing reaction with one terminal reaction");
assert.deepEqual(reactionBodies.map(({ endpoint, body }) => `${endpoint}:${body.emotionName}:${body.textEmotion.emotionId}:${body.textEmotion.backgroundId}`), [
	"reply:👀:2659900:im_bg_1",
	"recall:👀:2659900:im_bg_1",
	"reply:✅ 已完成:54054:im_bg_5",
]);
const completedCalls = reactionBodies.length;
await handlers.get("session_stop")({ last_assistant_message: { role: "assistant", content: [{ type: "text", text: "仍然完成" }] } }, ctx);
assert.equal(reactionBodies.length, completedCalls, "repeating the same terminal state is idempotent");

Socket.latest!.message({
	type: "CALLBACK",
	headers: { messageId: "frame-2", topic: "/v1.0/im/bot/messages/get" },
	data: JSON.stringify({
		msgId: "message-2", conversationId: "conversation-1", conversationType: "1",
		robotCode: "robot", senderStaffId: "staff", text: { content: "运行一个会失败的任务" },
	}),
});
await waitFor(() => prompts >= 2);
await waitFor(() => Boolean(reactions.get("conversation-1:message-2")?.has("👀")));
await handlers.get("auto_retry_end")({ success: false, finalError: "boom" }, ctx);
await handlers.get("session_stop")({ last_assistant_message: { role: "assistant", content: [{ type: "text", text: "失败" }] } }, ctx);
assert.deepEqual([...reactions.get("conversation-1:message-2")!], ["❌ 失败"], "failure also replaces the transient reaction");
assert.deepEqual(reactionBodies.slice(-2).map(({ endpoint, body }) => `${endpoint}:${body.emotionName}:${body.textEmotion.emotionId}:${body.textEmotion.backgroundId}`), [
	"recall:👀:2659900:im_bg_1",
	"reply:❌ 失败:34019:im_bg_6",
]);
console.log("reaction lifecycle: viewing reaction is recalled and replaced by one idempotent completed or failed reaction");
