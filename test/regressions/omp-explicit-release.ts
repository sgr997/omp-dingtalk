import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "omp-explicit-release-"));
process.env.OMP_DINGTALK_CONFIG = join(scratch, "config.json");
process.env.OMP_DINGTALK_MIN_GAP_MS = "1";
process.env.OMP_DINGTALK_MAX_PER_MIN = "1000";
const config = {
	webhook: { url: "https://mock.invalid/robot" },
	stream: { enabled: true, clientId: "shared-app", clientSecret: "fake", robotCode: "robot" },
	control: { enabled: true, allowUserId: "staff", autoTakeover: false },
	// This is the default that previously let every new stop notification through.
	notify: { onlyWhenTakenOver: false, sessionStop: true, errors: true },
};
writeFileSync(process.env.OMP_DINGTALK_CONFIG, JSON.stringify(config));
const messages: Array<{ title: string; text: string }> = [];
globalThis.fetch = (async (input, init) => {
	if (String(input).includes("/gateway/")) return new Response(JSON.stringify({ endpoint: "wss://mock.invalid", ticket: "fake" }));
	const body = JSON.parse(String(init?.body));
	if (body.markdown) messages.push(body.markdown);
	return new Response(JSON.stringify({ errcode: 0 }));
}) as typeof fetch;
class Socket {
	readyState = 1;
	onopen?: () => void;
	onclose?: () => void;
	onmessage?: (event: unknown) => void;
	constructor(_url: string) {}
	send() {}
	close() { this.readyState = 3; this.onclose?.(); }
}
globalThis.WebSocket = Socket as any;
const log = { debug() {}, info() {}, warn() {}, error() {} };
const schema = (): any => {
	const value: any = { describe: () => value, optional: () => value, min: () => value, default: () => value };
	return value;
};
let nextModule = 0;
async function boot(name: string, entries: any[] = []) {
	const handlers = new Map<string, any>();
	const tools = new Map<string, any>();
	const notices: string[] = [];
	let command: any;
	const module = await import(`../../src/index.ts?explicit-release=${++nextModule}`);
	module.default({
		logger: log,
		zod: Object.fromEntries(["object", "array", "string", "number", "boolean", "enum"].map((key) => [key, schema])),
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerCommand: (_name: string, options: any) => { command = options; },
		registerTool: (tool: any) => tools.set(tool.name, tool),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		sendUserMessage() {},
	});
	const ctx = { cwd: join(scratch, name), hasUI: true, mode: "tui",
		sessionManager: { getSessionId: () => name, getBranch: () => entries },
		ui: { notify: (text: string) => notices.push(text) }, isIdle: () => true,
	};
	const host = { name, handlers, tools, notices, entries, command, ctx,
		async action(action: string) {
			process.env.OMP_DINGTALK_LOCK_DIR = join(scratch, name, "locks");
			await command.handler(action, ctx);
			await Bun.sleep(10);
		},
		async event(event: string, data: unknown = {}) {
			process.env.OMP_DINGTALK_LOCK_DIR = join(scratch, name, "locks");
			await handlers.get(event)(data, ctx);
			await Bun.sleep(10);
		},
	};
	await host.event("session_start");
	return host;
}
const stop = (text: string) => ({ last_assistant_message: { role: "assistant", content: [{ type: "text", text }] } });
const count = (text: string) => messages.filter((message) => message.text.includes(text)).length;

// Independent lock directories model separate machines; both takeovers succeed.
const a = await boot("machine-A");
const b = await boot("machine-B");
await a.action("status");
assert.match(a.notices.at(-1)!, /^- \*\*当前会话接管状态\*\*: 未接管/);
assert.match(a.notices.at(-1)!, /入站连接\*\*: 已关闭/);
await a.action("takeover");
await a.action("status");
assert.match(a.notices.at(-1)!, /^- \*\*当前会话接管状态\*\*: 已接管/);
await b.action("takeover");
await a.event("session_stop", stop("before-release-A"));
assert.equal(count("before-release-A"), 1, "takeover should still allow notifications");
await a.action("release");
const releaseReceipts = () => messages.filter((message) => message.title.includes("解除接管") && message.text.includes(a.ctx.cwd));
assert.equal(releaseReceipts().length, 1, "explicit release should send one DingTalk confirmation");
for (let i = 0; i < 3; i++) await a.event("session_stop", stop(`after-release-A-${i}`));
assert.equal(count("after-release-A-"), 0, "release must block NEW completion notifications even when onlyWhenTakenOver=false");
await b.event("session_stop", stop("still-active-B"));
assert.equal(count("still-active-B"), 1, "release on A must not affect B");

await a.action("quiet off");
const beforeError = messages.length;
await a.event("auto_retry_end", { success: false, finalError: "after-release-error" });
assert.equal(messages.length, beforeError, "bypassQuiet must not bypass explicit release");
const notify = await a.tools.get("dingtalk_notify").execute("notify", { title: "automatic", message: "after-release-tool" }, undefined, undefined, a.ctx);
assert.equal(notify.details.sent, false, "model notification tool must respect explicit release");
assert.match(notify.content[0].text, /release|解除/);
await a.action("status");
assert.match(a.notices.at(-1)!, /自动推送已停止/);
assert.match(a.notices.at(-1)!, /^- \*\*当前会话接管状态\*\*: 已释放/);
assert.match(a.notices.at(-1)!, /入站 Stream 配置: 已启用（仅配置，不代表当前会话已接管）/);
await a.action("release");
assert.equal(releaseReceipts().length, 1, "repeated release should not duplicate the confirmation");
assert.match(a.notices.at(-1)!, /释放状态.*入站连接已关闭.*自动推送已停止/);
await a.event("session_start");
await a.event("session_stop", stop("repeated-release-A"));
assert.equal(count("repeated-release-A"), 0, "repeated release and same-session start must stay silent");

// A cwd switch rebuilds the bridge but must not undo the same session's release.
a.ctx.cwd = join(scratch, "machine-A-moved");
await a.event("session_stop", stop("cwd-after-release-A"));
assert.equal(count("cwd-after-release-A"), 0, "changing cwd in the released session must not resume notifications");
await a.action("status");
assert.match(a.notices.at(-1)!, /^- \*\*当前会话接管状态\*\*: 已释放/);

// A resumed session must restore the release latch, including old quiet-only entries.
config.control.autoTakeover = true;
writeFileSync(process.env.OMP_DINGTALK_CONFIG!, JSON.stringify(config));
const resumed = await boot("machine-A", [...a.entries, { type: "custom", customType: "com.omp-dingtalk.state", data: { quiet: false } }]);
await resumed.event("session_stop", stop("resumed-release-A"));
assert.equal(count("resumed-release-A"), 0, "autoTakeover must not undo an explicit saved release");
await resumed.action("status");
assert.match(resumed.notices.at(-1)!, /自动推送已停止/);

await resumed.action("takeover");
await resumed.event("session_stop", stop("resumed-takeover-A"));
assert.equal(count("resumed-takeover-A"), 1, "explicit successful takeover resumes notifications");
await resumed.action("release");
await b.action("release");

// Pure notification sessions must also be able to stop without ever taking over.
config.control.autoTakeover = false;
writeFileSync(process.env.OMP_DINGTALK_CONFIG!, JSON.stringify(config));
const fresh = await boot("notification-only");
await fresh.event("session_stop", stop("initial-notify"));
assert.equal(count("initial-notify"), 1, "new notification-only sessions retain the existing default behavior");
await fresh.action("release");
await fresh.action("test"); // A deliberate test send is allowed, but does not resume automatic pushes.
await fresh.event("session_stop", stop("released-notify"));
assert.equal(count("released-notify"), 0, "release also stops a session that had never taken over");

// A different session has its own state, rather than inheriting the old release.
fresh.ctx.sessionManager.getSessionId = () => "new-session";
fresh.ctx.sessionManager.getBranch = () => [];
await fresh.event("session_start");
await fresh.event("session_stop", stop("new-session-notify"));
assert.equal(count("new-session-notify"), 1, "an unrelated new session keeps its notification defaults");
await fresh.action("release");

console.log("explicit release: subsequent replies, errors, model pushes and resumed sessions stay silent; takeover resumes; other machine stays independent");
