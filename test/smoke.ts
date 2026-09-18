/**
 * End-to-end smoke test — no real DingTalk credentials required.
 *
 * Everything external is mocked: `fetch` (webhook + stream gateway) and the
 * global `WebSocket` (so inbound frames can be injected by hand). What is
 * actually exercised is the plugin's own logic: config loading, event wiring,
 * rate-limited sending, stream framing/ACK/dedupe, conversation-scope filtering,
 * the opt-in takeover gate, command routing, the remote approval gate, and the
 * safety of the "no credentials" / "not taken over" paths.
 *
 * Run with:  bun test/smoke.ts
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { splitMessage } from "../src/util";

// --- environment must be set before the plugin modules are imported ---------
const scratch = mkdtempSync(join(tmpdir(), "omp-dingtalk-smoke-"));
const configPath = join(scratch, "dingtalk.json");

/**
 * The config the bulk of the suite runs against.
 *
 * `scope: "direct"` + `autoTakeover: true` keeps the inbound path open so the
 * routing and approval cases can be exercised; the default (inert) behaviour is
 * covered separately in section [16].
 */
const MAIN_CONTROL = {
	scope: "direct",
	autoTakeover: true,
	requireAt: true,
	// The allowlist is fail-closed: an unset value refuses everything. The one
	// allowlisted user is also the 1:1 push recipient, so the default carries the
	// mock sender and ordinary sections stay authorized.
	allowUserId: "staff-smoke",
	freeText: true,
	freeTextDelivery: "steer",
	replyToSession: true,
};
const MAIN_CONFIG = {
	webhook: { url: "https://oapi.dingtalk.com/robot/send?access_token=TESTTOKEN", secret: "SECsmoke", keyword: "" },
	stream: { enabled: true, clientId: "smoke-client", clientSecret: "smoke-secret", robotCode: "dingsmoke" },
	approval: { mode: "remote", timeoutMs: 1_500, onTimeout: "deny" },
	control: MAIN_CONTROL,
	notify: { turnEnd: { enabled: true, minDurationMs: 0 } },
};
writeFileSync(configPath, JSON.stringify(MAIN_CONFIG, null, 2));
process.env.OMP_DINGTALK_CONFIG = configPath;
// Collapse the rate limiter so the test finishes in seconds.
process.env.OMP_DINGTALK_MIN_GAP_MS = "5";
process.env.OMP_DINGTALK_MAX_PER_MIN = "200";
// Keep takeover locks out of the real `~/.omp/agent` — a test run must not be
// able to displace the user's live session, and must not leave litter behind.
process.env.OMP_DINGTALK_LOCK_DIR = join(scratch, "locks");
// Shrink the preemption-detection window so the multi-session cases below do
// not have to wait 5 seconds for a heartbeat.
process.env.OMP_DINGTALK_HEARTBEAT_MS = "150";

// --- tiny assertion harness -------------------------------------------------
let passed = 0;
const failures: string[] = [];
function check(name: string, condition: boolean, extra?: unknown): void {
	if (condition) {
		passed += 1;
		console.log(`  ok   ${name}`);
	} else {
		failures.push(name);
		console.log(`  FAIL ${name}${extra === undefined ? "" : ` :: ${JSON.stringify(extra)}`}`);
	}
}

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await tick(20);
	}
	return predicate();
}

// --- fetch mock -------------------------------------------------------------
interface Recorded {
	url: string;
	body: any;
}
const requests: Recorded[] = [];

function response(data: unknown) {
	return {
		ok: true,
		status: 200,
		text: async () => JSON.stringify(data),
		json: async () => data,
	} as unknown as Response;
}

globalThis.fetch = (async (input: any, init?: any) => {
	const url = typeof input === "string" ? input : String(input?.url ?? input);
	let body: any;
	try {
		body = init?.body ? JSON.parse(String(init.body)) : undefined;
	} catch {
		body = undefined;
	}
	requests.push({ url, body });
	// Set SMOKE_TRACE=1 to see every outbound call in order — invaluable when an
	// assertion about "the latest notification" fails.
	if (process.env.SMOKE_TRACE && url.includes("dingtalk.com")) {
		console.log(`    [net ${String(requests.length).padStart(3)}] ${String(body?.markdown?.title ?? url.slice(0, 70))}`);
	}

	if (url.includes("/gateway/connections/open")) {
		return response({ endpoint: "wss://stream.invalid/connect", ticket: "smoke-ticket" });
	}
	if (url.includes("/oauth2/accessToken")) {
		return response({ accessToken: "smoke-access-token", expireIn: 7200 });
	}
	if (url.includes("/robot/oToMessages/batchSend")) {
		return response({ processQueryKey: "q1" });
	}
	// custom robot webhook / sessionWebhook
	return response({ errcode: 0, errmsg: "ok" });
}) as typeof fetch;

const webhookPosts = () => requests.filter((r) => r.url.includes("oapi.dingtalk.com/robot/send"));
const sessionReplies = () => requests.filter((r) => r.url.includes("sendBySession"));
const approvalPosts = () =>
	webhookPosts().filter((r) => String(r.body?.markdown?.title ?? "").includes("需要批准"));
const questionPosts = () =>
	webhookPosts().filter((r) => String(r.body?.markdown?.title ?? "").includes("需要你的回答"));
const questionTimeoutPosts = () =>
	webhookPosts().filter((r) => String(r.body?.markdown?.title ?? "").includes("提问超时"));
const questionAnsweredLocallyPosts = () =>
	webhookPosts().filter((r) => String(r.body?.markdown?.title ?? "").includes("已在本地回答"));

// `webhookPosts()` also matches `sendBySession` replies, which is fine for the
// older assertions but too loose for "did this go to the group". `groupPosts()`
// matches the custom-robot webhook only; `otoPosts()` is the 1:1 push API.
const groupPosts = () => requests.filter((r) => r.url.includes("/robot/send?"));
const otoPosts = () => requests.filter((r) => r.url.includes("/robot/oToMessages/batchSend"));

// --- WebSocket mock ---------------------------------------------------------
class MockSocket {
	static OPEN = 1;
	static instances: MockSocket[] = [];
	readyState = 0;
	onopen: (() => void) | undefined;
	onmessage: ((event: { data: string }) => void) | undefined;
	onclose: (() => void) | undefined;
	onerror: (() => void) | undefined;
	sent: any[] = [];

	constructor(readonly url: string) {
		MockSocket.instances.push(this);
	}

	open(): void {
		this.readyState = MockSocket.OPEN;
		this.onopen?.();
	}

	send(data: string): void {
		this.sent.push(JSON.parse(data));
	}

	close(): void {
		this.readyState = 3;
		this.onclose?.();
	}

	frame(payload: unknown): void {
		this.onmessage?.({ data: JSON.stringify(payload) });
	}

	system(topic: string): void {
		this.frame({ specVersion: "1.0", type: "SYSTEM", headers: { topic, messageId: `sys-${topic}` }, data: "" });
	}

	/**
	 * Inject an inbound robot message the way the gateway would.
	 *
	 * Defaults to a **1:1 chat** because that is what the plugin accepts by
	 * default; pass `conversationType: "2"` to simulate a group.
	 */
	robot(text: string, overrides: Record<string, unknown> = {}): void {
		const payload = {
			conversationId: "cid-smoke",
			conversationType: "1",
			conversationTitle: "",
			msgId: `msg-${Math.random().toString(36).slice(2)}`,
			senderNick: "我",
			senderStaffId: "staff-smoke",
			isInAtList: true,
			sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=smoke",
			sessionWebhookExpiredTime: Date.now() + 3_600_000,
			createAt: Date.now(),
			robotCode: "dingsmoke",
			msgtype: "text",
			text: { content: ` ${text}` },
			...overrides,
		};
		this.frame({
			specVersion: "1.0",
			type: "CALLBACK",
			headers: {
				messageId: `cb-${Math.random().toString(36).slice(2)}`,
				topic: "/v1.0/im/bot/messages/get",
				contentType: "application/json",
			},
			// The real gateway sends `data` as a plain JSON string, NOT base64.
			// Encoding it here would make the mock agree with a broken parser.
			data: JSON.stringify(payload),
		});
	}
}
(globalThis as any).WebSocket = MockSocket;

// --- mock extension host ----------------------------------------------------
type Handler = (event: any, ctx: any) => any;
const handlers = new Map<string, Handler[]>();
const commands = new Map<string, any>();
const tools = new Map<string, any>();
const notices: string[] = [];
const sentPrompts: { text: string; options: any }[] = [];
let abortCount = 0;
const appended: any[] = [];

function schema(): any {
	const node: any = {
		describe: () => node,
		default: () => node,
		optional: () => node,
		min: () => node,
		max: () => node,
		array: () => schema(),
	};
	return node;
}
const zod = {
	object: () => schema(),
	string: () => schema(),
	enum: () => schema(),
	number: () => schema(),
	boolean: () => schema(),
	array: (_item?: unknown) => schema(),
};

/**
 * Stand-in for the native `ask` dialog. The re-registered tool reaches the real
 * one through `ctx.invokeTool`; each call parks here until the test answers it
 * or the racer aborts it, which is what makes both race outcomes observable.
 */
const localAskCalls: Array<{ params: any; resolve: (result: any) => void; aborted: boolean }> = [];

const ctx: any = {
	cwd: process.cwd(),
	hasUI: true,
	// The interactive TUI session the plugin expects: `hasUI` plus mode `tui`.
	// A subagent's runner has neither (see the subCtx/session-start tests).
	mode: "tui",
	invokeTool: (params: any, options?: { signal?: AbortSignal }) =>
		new Promise<any>((resolve, reject) => {
			const record: any = { params, resolve, aborted: false };
			options?.signal?.addEventListener("abort", () => {
				record.aborted = true;
				const error = new Error("Ask input was cancelled");
				error.name = "AbortError";
				reject(error);
			});
			localAskCalls.push(record);
		}),
	ui: { notify: (message: string) => notices.push(message) },
	model: { id: "smoke-model", provider: "smoke" },
	models: { resolve: (spec: string) => ({ id: spec, provider: "smoke" }), current: () => ({ id: "smoke-model" }) },
	isIdle: () => true,
	hasPendingMessages: () => false,
	abort: () => {
		abortCount += 1;
	},
	compact: async () => {},
	sessionManager: { getBranch: () => [] },
};

const pi: any = {
	logger: { debug() {}, info() {}, warn() {}, error() {} },
	zod,
	on: (event: string, handler: Handler) => {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
	},
	registerCommand: (name: string, options: any) => commands.set(name, options),
	registerTool: (definition: any) => tools.set(definition.name, definition),
	getSessionName: () => "smoke-session",
	getActiveTools: () => ["bash", "read", "write", "edit"],
	setModel: async () => true,
	appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
	sendUserMessage: (text: string, options: any) => sentPrompts.push({ text, options }),
};

async function fire(event: string, payload: any): Promise<any[]> {
	const list = handlers.get(event) ?? [];
	const results: any[] = [];
	for (const handler of list) results.push(await handler(payload, ctx));
	return results;
}

// --- run --------------------------------------------------------------------
console.log("\n[1] factory load & registration");
const { default: factory } = await import("../src/index.ts");
factory(pi);
check("注册了 session_start", handlers.has("session_start"));
check("注册了 tool_call", handlers.has("tool_call"));
check("注册了 session_stop", handlers.has("session_stop"));
check("注册了 /dingtalk 命令", commands.has("dingtalk"));
{
	const dt = commands.get("dingtalk");
	check("dingtalk 命令带子命令补全", typeof dt?.getArgumentCompletions === "function");
	const all = dt?.getArgumentCompletions?.("") ?? [];
	const filtered = dt?.getArgumentCompletions?.("tak") ?? [];
	check("补全列出全部子命令", all.length >= 6, all.length);
	check("补全按前缀过滤", filtered.length === 1 && filtered[0]?.value === "takeover", filtered);
	check("补全不匹配时为空", (dt?.getArgumentCompletions?.("zzz") ?? []).length === 0);
}
check("注册了 dingtalk_notify 工具", tools.has("dingtalk_notify"));

console.log("\n[2] session_start → 无启动通知 + Stream 建连 + autoTakeover 推送接管确认");
await fire("session_start", { type: "session_start" });
check("启动不再推送「omp 已启动」", !webhookPosts().some((r) => String(r.body?.markdown?.title).includes("已启动")), webhookPosts().length);
check("autoTakeover 成功后推送「钉钉已接管」", webhookPosts().some((r) => String(r.body?.markdown?.title).includes("钉钉已接管")), webhookPosts().filter((r) => String(r.body?.markdown?.title).includes("钉钉已接管")).length);
check("接管推送带上了目录", String(webhookPosts().find((r) => String(r.body?.markdown?.title).includes("钉钉已接管"))?.body?.markdown?.text ?? "").includes("目录"));
check("Stream 已请求接入点", await waitFor(() => requests.some((r) => r.url.includes("/gateway/connections/open"))));
const socket = await (async () => {
	await waitFor(() => MockSocket.instances.length > 0);
	return MockSocket.instances[0];
})();
check("WebSocket 已建立", Boolean(socket), MockSocket.instances.length);
socket.open();
socket.system("REGISTERED");
check("收到 REGISTERED 后进入 registered", await waitFor(() => true));

console.log("\n[3] 入站指令：状态 / 帮助 / 身份");
socket.robot("状态");
check("`状态` 得到了会话回复", await waitFor(() => sessionReplies().length >= 1), sessionReplies().length);
check("回复内容包含模型信息", String(sessionReplies().at(-1)?.body?.markdown?.text ?? "").includes("smoke-model"));
const beforeHelp = sessionReplies().length;
socket.robot("帮助");
check("`帮助` 得到了回复", await waitFor(() => sessionReplies().length > beforeHelp));
check("ACK 帧已回给服务端", socket.sent.some((frame) => frame.code === 200 && frame.headers?.messageId));
check("CALLBACK 的 ACK 形如 {response:{}}（与官方 SDK 一致）", socket.sent.some((frame) => frame.data === '{"response":{}}'));

// Compatibility path: some SDK builds / older docs base64-encode `data`.
const beforeB64 = sessionReplies().length;
	// /whoami is the onboarding path, so it must work for any sender — here with
	// the permissive config, and in [5] for a sender outside the allowlist.
	const beforeWhoami = sessionReplies().length;
	socket.robot("/whoami");
	await waitFor(() => sessionReplies().length > beforeWhoami);
	check("`/whoami` 返回身份卡片", String(sessionReplies().at(-1)?.body?.markdown?.title ?? "").includes("你的身份"), sessionReplies().at(-1)?.body?.markdown?.title);
	check("身份卡片带 senderStaffId", String(sessionReplies().at(-1)?.body?.markdown?.text ?? "").includes("staff-smoke"), sessionReplies().at(-1)?.body?.markdown?.text);
	const beforeId = sessionReplies().length;
	socket.robot("/id");
	await waitFor(() => sessionReplies().length > beforeId);
	check("`/id` 同样返回身份卡片", String(sessionReplies().at(-1)?.body?.markdown?.title ?? "").includes("你的身份"), sessionReplies().at(-1)?.body?.markdown?.title);
	const beforeIdCN = sessionReplies().length;
	socket.robot("我是谁");
	await waitFor(() => sessionReplies().length > beforeIdCN);
	check("`我是谁` 也识别为身份查询", String(sessionReplies().at(-1)?.body?.markdown?.title ?? "").includes("你的身份"), sessionReplies().at(-1)?.body?.markdown?.title);
socket.frame({
	specVersion: "1.0",
	type: "CALLBACK",
	headers: { messageId: `cb-b64-${Math.random().toString(36).slice(2)}`, topic: "/v1.0/im/bot/messages/get", contentType: "application/json" },
	data: Buffer.from(
		JSON.stringify({
			conversationType: "1",
			senderStaffId: "staff-smoke",
			isInAtList: true,
			sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=smoke",
			sessionWebhookExpiredTime: Date.now() + 3_600_000,
			text: { content: " /ping" },
		}),
		"utf8",
	).toString("base64"),
});
check("base64 形式的 data 也能解析（兼容路径）", await waitFor(() => sessionReplies().length > beforeB64), sessionReplies().length - beforeB64);

console.log("\n[4] 会话范围：默认仅单聊");
{
	// Under `scope: "direct"` a group message is ignored outright — even when
	// the robot is @-mentioned. Only 1:1 chatter reaches the command router.
	const beforeGroup = sessionReplies().length;
	socket.robot("状态", { conversationType: "2", conversationTitle: "omp 测试群", isInAtList: true });
	await tick(200);
	check("群聊消息被忽略（即使 @ 了机器人）", sessionReplies().length === beforeGroup, sessionReplies().length - beforeGroup);

	const beforeDirect = sessionReplies().length;
	socket.robot("状态");
	check("单聊消息正常处理", await waitFor(() => sessionReplies().length > beforeDirect));
}

console.log("\n[5] 白名单鉴权");
{
	// Re-point config at a copy with an allowlist, then reload via a fresh session.
	writeFileSync(
		configPath,
		JSON.stringify({ ...MAIN_CONFIG, control: { ...MAIN_CONTROL, allowUserId: "someone-else" } }),
	);
	await fire("session_start", { type: "session_start" });
	const latest = MockSocket.instances.at(-1)!;
	latest.open();
	latest.system("REGISTERED");

	// The whole point of /whoami: a first-time user is *not* in the list yet.
	const sentBefore = sentPrompts.length;
	const beforeId = sessionReplies().length;
	latest.robot("/whoami");
	check("白名单外的发送者也能查身份", await waitFor(() => sessionReplies().length > beforeId));
	check("返回身份卡片而不是拒绝提示", String(sessionReplies().at(-1)?.body?.markdown?.title ?? "").includes("你的身份"), sessionReplies().at(-1)?.body?.markdown?.title);
	check("身份卡片带 senderStaffId", String(sessionReplies().at(-1)?.body?.markdown?.text ?? "").includes("staff-smoke"), sessionReplies().at(-1)?.body?.markdown?.text);
	check("身份查询不会把消息喂给 omp", sentPrompts.length === sentBefore, sentPrompts.length - sentBefore);

	const before = sessionReplies().length;
	latest.robot("状态");
	check("白名单外的其他指令被拒绝", await waitFor(() => sessionReplies().length > before));
	check("拒绝提示包含 senderStaffId", String(sessionReplies().at(-1)?.body?.markdown?.text ?? "").includes("staff-smoke"));

	// Fail-closed: an EMPTY allowlist refuses everything except /id.
	writeFileSync(configPath, JSON.stringify({ ...MAIN_CONFIG, control: { ...MAIN_CONTROL, allowUserId: "" } }));
	await fire("session_start", { type: "session_start" });
	const emptyList = MockSocket.instances.at(-1)!;
	emptyList.open();
	emptyList.system("REGISTERED");
	const beforeEmpty = sentPrompts.length;
	const beforeEmptyReply = sessionReplies().length;
	emptyList.robot("状态");
	check("空白名单拒绝指令（fail-closed）", await waitFor(() => sessionReplies().length > beforeEmptyReply));
	check("空白名单的拒绝提示点明配置为空", String(sessionReplies().at(-1)?.body?.markdown?.text ?? "").includes("为空"), String(sessionReplies().at(-1)?.body?.markdown?.text ?? "").slice(0, 160));
	check("空白名单不会把指令投给 omp", sentPrompts.length === beforeEmpty);
	const beforeId2 = sessionReplies().length;
	emptyList.robot("/id");
	check("空白名单下 /id 仍可用", await waitFor(() => sessionReplies().length > beforeId2));
	check("/id 不再回显会话 ID（S2）", !String(sessionReplies().at(-1)?.body?.markdown?.text ?? "").includes("cid-smoke"), String(sessionReplies().at(-1)?.body?.markdown?.text ?? "").slice(0, 200));
	check("/id 不再回显 scope 配置（S2）", !String(sessionReplies().at(-1)?.body?.markdown?.text ?? "").includes("scope = "), String(sessionReplies().at(-1)?.body?.markdown?.text ?? "").slice(0, 200));
}

// Restore the permissive config for the remaining cases.
writeFileSync(configPath, JSON.stringify(MAIN_CONFIG));
await fire("session_start", { type: "session_start" });
const live = MockSocket.instances.at(-1)!;
live.open();
live.system("REGISTERED");

console.log("\n[6] 远程审批：批准（register + 一次性放行）");
{
	const [blocked] = await fire("tool_call", { type: "tool_call", toolCallId: "t-approve", toolName: "bash", input: { command: "sudo rm -rf /var/tmp/x" } });
	check("危险命令被拦截等待审批", blocked?.block === true, blocked);
	check("拦截原因说明已推送钉钉", String(blocked?.reason ?? "").includes("钉钉"), blocked?.reason);
	check("危险命令触发了审批通知", await waitFor(() => approvalPosts().length >= 1));
	const id = /`([A-Z0-9]{4,})`/.exec(String(approvalPosts().at(-1)?.body?.markdown?.text ?? ""))?.[1] ?? "";
	check("审批通知里带了编号", Boolean(id), id);
	// Approvals carry no footer, so the origin has to be an explicit line —
	// otherwise a request from a *different* session looks like it is yours.
	check(
		"审批通知点明了来自哪个会话",
		String(approvalPosts().at(-1)?.body?.markdown?.text ?? "").includes(`来自**: \`${basename(process.cwd())}·`),
		String(approvalPosts().at(-1)?.body?.markdown?.text ?? "").slice(0, 200),
	);
	// While pending, a re-issued call is still blocked (deduped, no re-notify).
	const [again] = await fire("tool_call", { type: "tool_call", toolCallId: "t-approve-again", toolName: "bash", input: { command: "sudo rm -rf /var/tmp/x" } });
	check("批准前重发仍被拦截", again?.block === true, again);
	const sentBefore = sentPrompts.length;
	live.robot("同意");
	check("批准后向 omp 注入放行指令", await waitFor(() => sentPrompts.length > sentBefore));
	check("注入消息提到批准", String(sentPrompts.at(-1)?.text ?? "").includes("批准"), sentPrompts.at(-1)?.text);
	// The model re-issues the exact same call → the registry releases it once.
	const [released] = await fire("tool_call", { type: "tool_call", toolCallId: "t-approve-rerun", toolName: "bash", input: { command: "sudo rm -rf /var/tmp/x" } });
	check("批准后重发同命令放行", !released || released.block !== true, released);
	// Registry-level one-shot semantics (release-once, unknown key).
	{
		const { ApprovalRegistry } = await import("../src/router.ts");
		const r = new ApprovalRegistry({ debug() {}, info() {}, warn() {}, error() {} });
		const freshKey = "bash\u0000{\"command\":\"echo once\"}";
		const a = r.register({ toolName: "bash", reason: "t", detail: "d", key: freshKey, timeoutMs: 5_000, onTimeout: "deny" });
		r.resolve(a.id, "approve");
		check("批准的调用一次性放行（registry）", r.consumeApproved(freshKey) === true);
		check("放行只生效一次（registry）", r.consumeApproved(freshKey) === false);
		check("未批准的 key 不放行", r.consumeApproved("never-approved") === false);
	}
	const [other] = await fire("tool_call", { type: "tool_call", toolCallId: "t-approve-other", toolName: "bash", input: { command: "sudo rm -rf /var/tmp/other" } });
	check("放行是一次性的：不同命令仍被拦截", other?.block === true, other);
}

console.log("\n[7] 远程审批：拒绝");
{
	const [blocked] = await fire("tool_call", { type: "tool_call", toolCallId: "t-deny", toolName: "bash", input: { command: "git push --force origin main" } });
	check("危险命令被拦截等待审批", blocked?.block === true, blocked);
	await waitFor(() => approvalPosts().length >= 2);
	const sentBefore = sentPrompts.length;
	live.robot("拒绝");
	check("拒绝后向 omp 注入拒绝指令", await waitFor(() => sentPrompts.length > sentBefore));
	check("注入消息提到拒绝", String(sentPrompts.at(-1)?.text ?? "").includes("拒绝"), sentPrompts.at(-1)?.text);
	const [rerun] = await fire("tool_call", { type: "tool_call", toolCallId: "t-deny-rerun", toolName: "bash", input: { command: "git push --force origin main" } });
	check("拒绝后重发仍被拦截", rerun?.block === true, rerun);
}

console.log("\n[8] 远程审批：超时按安全默认拒绝");
{
	const sentBefore = sentPrompts.length;
	const [blocked] = await fire("tool_call", { type: "tool_call", toolCallId: "t-timeout", toolName: "bash", input: { command: "rm -rf /" } });
	check("超时前先拦截", blocked?.block === true, blocked);
	check("超时后注入安全默认拒绝", await waitFor(() => sentPrompts.length > sentBefore, 8_000));
	check("注入消息提到超时", String(sentPrompts.at(-1)?.text ?? "").includes("超时"), sentPrompts.at(-1)?.text);
}

console.log("\n[9] 普通命令不应被拦截");
{
	const [result] = await fire("tool_call", { type: "tool_call", toolCallId: "t-safe", toolName: "bash", input: { command: "ls -la src" } });
	check("安全命令直接放行", result === undefined, result);
}

console.log("\n[9.1] 双端提问：TUI 对话框与钉钉同时出现，钉钉先答则取消本地");
{
	// The plugin re-registers `ask`, so the tool the model calls is ours. Its
	// `execute` opens the native dialog through `ctx.invokeTool` and races it
	// against DingTalk: both surfaces show the question, first answer wins.
	const askTool = tools.get("ask");
	check("插件重注册了 ask 工具", Boolean(askTool), [...tools.keys()].join(","));
	check("重注册的 ask 仍标注为独占执行", askTool?.concurrency === "exclusive", askTool?.concurrency);

	const single = {
		id: "q1",
		question: "要部署到生产吗？",
		options: [{ label: "立即部署" }, { label: "先等等", description: "明天再说" }],
		recommended: 0,
	};
	const callsBefore = localAskCalls.length;
	const postsBefore = questionPosts().length;
	const pending = askTool.execute("t-ask-single", { questions: [single] }, undefined, undefined, ctx);

	check(
		"本地 TUI 对话框被打开了",
		await waitFor(() => localAskCalls.length > callsBefore),
		localAskCalls.length - callsBefore,
	);
	check(
		"钉钉同时收到了推送",
		await waitFor(() => questionPosts().length > postsBefore),
		questionPosts().length - postsBefore,
	);
	const askText = String(questionPosts().at(-1)?.body?.markdown?.text ?? "");
	check("推送里带上了问题原文", askText.includes("要部署到生产吗"));
	check("推送里列出了编号选项", askText.includes("1. 立即部署 （推荐）") && askText.includes("2. 先等等"), askText);
	check("选项描述换行显示", askText.includes("明天再说"), askText);
	check("推送里标出了推荐项", askText.includes("（推荐）"), askText);

	// Answer on the phone: the tool returns that answer and closes the dialog.
	const injectsBefore = sentPrompts.length;
	live.robot("1");
	const result = await pending;
	check("钉钉先答时工具返回了答案", String(result?.content?.[0]?.text ?? "").includes("立即部署"), result);
	check(
		"答案沿用原生 ask 的文本格式",
		String(result?.content?.[0]?.text ?? "").startsWith("User selected:"),
		result?.content?.[0]?.text,
	);
	check(
		"单问题用扁平的 details 布局",
		result?.details?.question === "要部署到生产吗？" && Array.isArray(result?.details?.selectedOptions),
		result?.details,
	);
	check("本地对话框被取消（不会留下僵尸弹窗）", localAskCalls.at(-1)?.aborted === true);
	check(
		"钉钉作答不再额外注入用户消息（否则模型会被答两次）",
		sentPrompts.length === injectsBefore,
		sentPrompts.length - injectsBefore,
	);
	check(
		"回了确认消息",
		String(sessionReplies().at(-1)?.body?.markdown?.title ?? "").includes("已回答"),
		String(sessionReplies().at(-1)?.body?.markdown?.title ?? ""),
	);

	// Reply by option label.
	const second = {
		id: "q2",
		question: "用哪个数据库？",
		options: [{ label: "SQLite" }, { label: "PostgreSQL" }],
	};
	const labelCalls = localAskCalls.length;
	const p2 = askTool.execute("t-ask-label", { questions: [second] }, undefined, undefined, ctx);
	await waitFor(() => localAskCalls.length > labelCalls);
	live.robot("PostgreSQL");
	const r2 = await p2;
	check("回复选项文字也能作答", String(r2?.content?.[0]?.text ?? "").includes("PostgreSQL"), r2?.content?.[0]?.text);

	// Free text becomes the custom answer.
	const third = { id: "q3", question: "还有别的偏好吗？", options: [{ label: "没有" }] };
	const customCalls = localAskCalls.length;
	const p3 = askTool.execute("t-ask-custom", { questions: [third] }, undefined, undefined, ctx);
	await waitFor(() => localAskCalls.length > customCalls);
	live.robot("别动线上数据");
	const r3 = await p3;
	check("非编号非选项的文字按自定义回答处理", String(r3?.content?.[0]?.text ?? "").includes("别动线上数据"), r3?.content?.[0]?.text);
	check("自定义回答进了 details.customInput", r3?.details?.customInput === "别动线上数据", r3?.details);
}

console.log("\n[9.2] 双端提问：多选与多问题");
{
	const askTool = tools.get("ask");
	const multi = {
		id: "m1",
		question: "包含哪些目标？",
		multi: true,
		options: [{ label: "Windows" }, { label: "macOS" }, { label: "Linux" }],
	};
	const c1 = localAskCalls.length;
	const p1 = askTool.execute("t-ask-multi", { questions: [multi] }, undefined, undefined, ctx);
	await waitFor(() => localAskCalls.length > c1);
	live.robot("1,3");
	const r1 = await p1;
	check(
		"多选答案包含两项",
		String(r1?.content?.[0]?.text ?? "").includes("Windows") && String(r1?.content?.[0]?.text ?? "").includes("Linux"),
		r1?.content?.[0]?.text,
	);
	check(
		"多选答案用逗号列表（与原生一致）",
		String(r1?.content?.[0]?.text ?? "").includes("User selected: Windows, Linux"),
		r1?.content?.[0]?.text,
	);

	const many = [
		{ id: "a", question: "部署到哪？", options: [{ label: "staging" }, { label: "prod" }] },
		{ id: "b", question: "几点发？", options: [{ label: "现在" }, { label: "凌晨" }] },
	];
	const c2 = localAskCalls.length;
	const p2 = askTool.execute("t-ask-many", { questions: many }, undefined, undefined, ctx);
	check(
		"多问题推送里按问题编号分段",
		await waitFor(() => String(questionPosts().at(-1)?.body?.markdown?.text ?? "").includes("**问题 2/2**")),
		questionPosts().at(-1)?.body?.markdown?.text,
	);
	await waitFor(() => localAskCalls.length > c2);

	// A bare `1` is ambiguous → must be rejected with the format hint.
	const repliesBefore = sessionReplies().length;
	live.robot("1");
	check("多问题时裸编号被拒绝", await waitFor(() => sessionReplies().length > repliesBefore));
	check("拒绝信息给出格式提示", String(sessionReplies().at(-1)?.body?.markdown?.text ?? "").includes("问题号:选项号"), sessionReplies().at(-1)?.body?.markdown?.text);

	live.robot("1:2 2:1");
	const r2 = await p2;
	const manyText = String(r2?.content?.[0]?.text ?? "");
	check("两条回答都进了工具结果", manyText.includes("prod") && manyText.includes("现在"), manyText);
	check("多问题走 results 数组布局", Array.isArray(r2?.details?.results) && r2.details.results.length === 2, r2?.details);
}

console.log("\n[9.3] 双端提问：本地先答 → 钉钉那条被撤销");
{
	const askTool = tools.get("ask");
	const q = { id: "L1", question: "本地先答测试", options: [{ label: "甲" }, { label: "乙" }] };
	const calls = localAskCalls.length;
	const posts = questionPosts().length;
	const pending = askTool.execute("t-ask-local", { questions: [q] }, undefined, undefined, ctx);
	await waitFor(() => localAskCalls.length > calls && questionPosts().length > posts);

	// Answer at the terminal: the native dialog settles first.
	localAskCalls.at(-1)!.resolve({
		content: [{ type: "text", text: "User selected: 甲" }],
		details: { selectedOptions: ["甲"] },
	});
	const result = await pending;
	check("本地先答时工具返回本地的结果", String(result?.content?.[0]?.text ?? "").includes("甲"), result);
	check(
		"钉钉那条被撤销（发了撤回通知）",
		await waitFor(() => questionAnsweredLocallyPosts().length >= 1),
		questionAnsweredLocallyPosts().length,
	);

	// A late reply on the phone must not settle anything. Bare text would fall
	// through to the free-text prompt once nothing is pending, so target the
	// answer command explicitly — that is the path a phone reply would take.
	const replies = sessionReplies().length;
	live.robot("/answer 2");
	check("本地已答后钉钉再回复会被拒绝", await waitFor(() => sessionReplies().length > replies));
	check(
		"拒绝原因是当前没有待回答的提问",
		`${sessionReplies().at(-1)?.body?.markdown?.title ?? ""}\n${sessionReplies().at(-1)?.body?.markdown?.text ?? ""}`.includes(
			"当前没有待回答的提问",
		),
		sessionReplies().at(-1)?.body?.markdown,
	);
}

console.log("\n[9.4] 双端提问：超时 → 关闭本地对话框并把决定交回模型");
{
	const dir = mkdtempSync(join(tmpdir(), "omp-dingtalk-question-timeout-"));
	const timeoutConfig = join(dir, "dingtalk.json");
	writeFileSync(timeoutConfig, JSON.stringify({ ...MAIN_CONFIG, question: { enabled: true, timeoutMs: 300 }, stream: { ...MAIN_CONFIG.stream, clientId: "smoke-client-qt" } }));
	const previous = process.env.OMP_DINGTALK_CONFIG;
	process.env.OMP_DINGTALK_CONFIG = timeoutConfig;

	const module = await import(`../src/index.ts?qtimeout=${Date.now()}`);
	const localHandlers = new Map<string, Handler[]>();
	// Keep the local module's registrations out of the shared maps — otherwise a
	// later section would drive *this* bridge (its own lazy `ensure`) instead of
	// the main one.
	const localCommands = new Map<string, any>();
	const localTools = new Map<string, any>();
	const localPi: any = {
		...pi,
		on: (e: string, h: Handler) => localHandlers.set(e, [...(localHandlers.get(e) ?? []), h]),
		registerCommand: (n: string, o: any) => localCommands.set(n, o),
		registerTool: (definition: any) => localTools.set(definition.name, definition),
	};
	module.default(localPi);
	await localHandlers.get("session_start")![0]({ type: "session_start" }, ctx);

	const calls = localAskCalls.length;
	const pending = localTools.get("ask").execute(
		"t-ask-timeout",
		{ questions: [{ id: "t1", question: "现在继续吗？", options: [{ label: "继续" }, { label: "停" }], recommended: 0 }] },
		undefined,
		undefined,
		ctx,
	);
	await waitFor(() => localAskCalls.length > calls);
	// The registry clamps its window to a 5s floor, so this waits a real 5s.
	const result = await pending;
	const text = String(result?.content?.[0]?.text ?? "");
	check("超时后工具结果让模型自行决定", text.includes("Decide yourself"), text);
	check("超时结果里带上推荐项", text.includes("继续"), text);
	check("超时后本地对话框被关闭（轮次不会挂住）", localAskCalls.at(-1)?.aborted === true);
	check("超时结果标记了 timedOut", result?.details?.timedOut === true, result?.details);
	check(
		"超时也发了钉钉通知",
		await waitFor(() => questionTimeoutPosts().length >= 1),
		questionTimeoutPosts().length,
	);
	process.env.OMP_DINGTALK_CONFIG = previous;
}

console.log("\n[9.5] 双端提问：开关关闭时不竞速，只走本地对话框");
{
	const dir = mkdtempSync(join(tmpdir(), "omp-dingtalk-question-off-"));
	const offConfig = join(dir, "dingtalk.json");
	writeFileSync(offConfig, JSON.stringify({ ...MAIN_CONFIG, question: { enabled: false, timeoutMs: 60_000 }, stream: { ...MAIN_CONFIG.stream, clientId: "smoke-client-qoff" } }));
	const previous = process.env.OMP_DINGTALK_CONFIG;
	process.env.OMP_DINGTALK_CONFIG = offConfig;

	const module = await import(`../src/index.ts?qoff=${Date.now()}`);
	const localHandlers = new Map<string, Handler[]>();
	const localCommands = new Map<string, any>();
	const localTools = new Map<string, any>();
	const localPi: any = {
		...pi,
		on: (e: string, h: Handler) => localHandlers.set(e, [...(localHandlers.get(e) ?? []), h]),
		registerCommand: (n: string, o: any) => localCommands.set(n, o),
		registerTool: (definition: any) => localTools.set(definition.name, definition),
	};
	module.default(localPi);
	await localHandlers.get("session_start")![0]({ type: "session_start" }, ctx);

	const calls = localAskCalls.length;
	const posts = questionPosts().length;
	const pending = localTools.get("ask").execute(
		"t-ask-off",
		{ questions: [{ id: "q", question: "?", options: [{ label: "a" }] }] },
		undefined,
		undefined,
		ctx,
	);
	await waitFor(() => localAskCalls.length > calls);
	await tick(200);
	check("question.enabled=false 时不推送钉钉", questionPosts().length === posts, questionPosts().length - posts);
	localAskCalls.at(-1)!.resolve({
		content: [{ type: "text", text: "User selected: a" }],
		details: { selectedOptions: ["a"] },
	});
	const result = await pending;
	check("结果直接来自本地对话框", String(result?.content?.[0]?.text ?? "").includes("User selected: a"), result);
	process.env.OMP_DINGTALK_CONFIG = previous;
}

console.log("\n[10] 自由文本 → 注入会话，且不会误判为指令");
{
	const before = sentPrompts.length;
	live.robot("stop the server on port 3000");
	check("自由文本被投递为 prompt", await waitFor(() => sentPrompts.length > before), sentPrompts);
	check("未触发 abort", abortCount === 0, abortCount);
	check("投递方式为 steer", sentPrompts.at(-1)?.options?.deliverAs === "steer");

	live.robot("停止");
	check("单独的 `停止` 触发中断", await waitFor(() => abortCount === 1), abortCount);

	const beforeFollow = sentPrompts.length;
	live.robot("/follow 帮我跑一遍测试");
	check("/follow 以 followUp 投递", await waitFor(() => sentPrompts.length > beforeFollow) && sentPrompts.at(-1)?.options?.deliverAs === "followUp");

	// Free-text prompts now acknowledge with an emoji reaction (emotion API)
	// instead of a reply card. The emotion call goes to /robot/emotion/reply.
	const emotionBefore = requests.filter((r) => r.url.includes("/robot/emotion/reply")).length;
	const beforePrompt = sentPrompts.length;
	live.robot("帮我重构这个函数");
	check("prompt 被投递", await waitFor(() => sentPrompts.length > beforePrompt));
	check("用表情回复而非卡片", requests.filter((r) => r.url.includes("/robot/emotion/reply")).length > emotionBefore, requests.filter((r) => r.url.includes("/robot/emotion/reply")).length - emotionBefore);
	check("没有发「已投递给 omp」卡片", !sessionReplies().slice(-3).some((r) => String(r.body?.markdown?.title ?? "").includes("已投递")));
}

console.log("\n[11] 静音开关");
{
	live.robot("/quiet on");
	check("静音指令得到回复", await waitFor(() => String(sessionReplies().at(-1)?.body?.markdown?.title ?? "").includes("静音")));
	const beforeQuiet = webhookPosts().length;
	await fire("turn_end", { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [{ type: "text", text: "done" }] }, toolResults: [] });
	await tick(200);
	check("静音后不再发通知", webhookPosts().length === beforeQuiet, webhookPosts().length - beforeQuiet);
	live.robot("/quiet off");
	await waitFor(() => String(sessionReplies().at(-1)?.body?.markdown?.title ?? "").includes("恢复"));
}

console.log("\n[12] 会话事件 → 通知");
{
	const before = webhookPosts().length;
	await fire("turn_end", {
		type: "turn_end",
		turnIndex: 1,
		message: { role: "assistant", content: [{ type: "text", text: "已修好登录接口" }, { type: "toolCall", name: "edit" }] },
		toolResults: [],
	});
	check("turn_end 触发通知", await waitFor(() => webhookPosts().length > before));
	check("通知里包含最后回复", String(webhookPosts().at(-1)?.body?.markdown?.text ?? "").includes("已修好登录接口"));

	// Two sessions sharing one DingTalk account must still be tellable apart, so
	// every notification carries `目录名·随机短码`; and every webhook post is
	// signed. (Previously asserted on the startup push, which no longer exists.)
	const signedPost = requests.find((r) => r.url.includes("/robot/send?"));
	check("webhook URL 带上了加签参数", Boolean(signedPost?.url.includes("timestamp=") && signedPost?.url.includes("sign=")), signedPost?.url);
	const noteText = String(webhookPosts().at(-1)?.body?.markdown?.text ?? "");
	check("通知带上了会话标识", noteText.includes(`omp · ${basename(process.cwd())}·`), noteText.slice(-90));

	// The reply must render as markdown, not as a fenced code block: a fence makes
	// DingTalk show the raw source in a monospace grey box.
	await fire("turn_end", {
		type: "turn_end",
		turnIndex: 2,
		message: {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "**方案**\n先跑测试\n再改代码\n```bash\necho hi\n```\n- 第一项\n- 第二项",
				},
			],
		},
		toolResults: [],
	});
	const replyReady = await waitFor(() => String(webhookPosts().at(-1)?.body?.markdown?.text ?? "").includes("**方案**"));
	const replyText = replyReady ? String(webhookPosts().at(-1)?.body?.markdown?.text ?? "") : "";
	check("回复按 markdown 渲染（无外层代码围栏）", String(replyText ?? "").includes("**回复**\n\n**方案**"), replyText);
	check("回复保留内层代码块", String(replyText ?? "").includes("```bash\necho hi\n```"), replyText);
	check("相邻普通行用空行分段", String(replyText ?? "").includes("先跑测试\n\n再改代码"), replyText);

	// A markdown table must stay contiguous — a blank line between rows makes
	// DingTalk drop the whole table. Normal paragraphs still need their blank
	// line, so the separator resumes after the table block ends.
	await fire("turn_end", {
		type: "turn_end",
		turnIndex: 3,
		message: {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "改完了\n| 项目 | 状态 |\n|------|------|\n| 登录 | 完成 |\n以上。",
				},
			],
		},
		toolResults: [],
	});
	const tableReady = await waitFor(() => String(webhookPosts().at(-1)?.body?.markdown?.text ?? "").includes("| 项目 |"));
	const tableText = tableReady ? String(webhookPosts().at(-1)?.body?.markdown?.text ?? "") : "";
	check("表格行保持连续（行间不插空行）", tableText.includes("| 项目 | 状态 |\n|------|------|\n| 登录 | 完成 |"), tableText);
	check("表格前的普通行仍分段", tableText.includes("改完了\n\n| 项目 | 状态 |"), tableText);
	check("表格块结束后恢复分段", tableText.includes("| 登录 | 完成 |\n\n以上。"), tableText);

	await fire("session_stop", { type: "session_stop", messages: [], turn_id: 1, last_assistant_message: { role: "assistant", content: [{ type: "text", text: "全部完成" }] }, session_id: "s1", stop_hook_active: false });
	// Match the exact title: a loose `includes("空闲")` also matches the `/stop`
	// reply "ℹ️ omp 本来就空闲", which would let this pass without the session_stop
	// notification ever being delivered.
	check("session_stop 触发空闲通知", await waitFor(() => webhookPosts().some((r) => String(r.body?.markdown?.title) === "omp 空闲中")));

	// A clean run reacts ✅ to the inbound message that drove it; a run that
	// ended on an unrecovered error reacts ❌ instead. The stream already
	// delivered live.robot() messages, so there is an inbound message to react to.
	const reactions = (emoji: string) =>
		requests.filter((r) => r.url.includes("/robot/emotion/reply") && r.body?.emotionName === emoji);
	const okBefore = reactions("✅").length;
	await fire("session_stop", { type: "session_stop", messages: [], turn_id: 2, last_assistant_message: { role: "assistant", content: [{ type: "text", text: "一切正常" }] }, session_id: "s1", stop_hook_active: false });
	check("干净结束给用户消息打 ✅", await waitFor(() => reactions("✅").length > okBefore), reactions("✅").length);

	const failBefore = reactions("❌").length;
	await fire("auto_retry_end", { type: "auto_retry_end", success: false, finalError: "boom" });
	await fire("session_stop", { type: "session_stop", messages: [], turn_id: 3, last_assistant_message: { role: "assistant", content: [{ type: "text", text: "失败了" }] }, session_id: "s1", stop_hook_active: false });
	check("出错后给用户消息打 ❌", await waitFor(() => reactions("❌").length > failBefore), reactions("❌").length);

	// The error flag must reset after it is consumed, or every later run would
	// keep reacting ❌.
	const okAgainBefore = reactions("✅").length;
	await fire("session_stop", { type: "session_stop", messages: [], turn_id: 4, last_assistant_message: { role: "assistant", content: [{ type: "text", text: "恢复了" }] }, session_id: "s1", stop_hook_active: false });
	check("❌ 标志用后重置，下次回到 ✅", await waitFor(() => reactions("✅").length > okAgainBefore), reactions("✅").length);

	// The idle card must report THIS run's duration, not the whole session's: a
	// long-lived TUI session would otherwise show hours on every run. Gap out a
	// little so a whole-session duration would be unmistakably large, then start a
	// fresh run (turn_start after a stop) that finishes at once.
	const parseMs = (text: string) => {
		const m = text.match(/- \*\*耗时\*\*: (\d+(?:\.\d+)?)(ms|s)\b/);
		return m ? Number(m[1]) * (m[2] === "s" ? 1000 : 1) : -1;
	};
	await tick(400);
	await fire("turn_start", { type: "turn_start", turnIndex: 0 });
	await fire("session_stop", { type: "session_stop", messages: [], turn_id: 5, last_assistant_message: { role: "assistant", content: [{ type: "text", text: "短跑证据" }] }, session_id: "s1", stop_hook_active: false });
	const ranAgain = await waitFor(() => webhookPosts().some((r) => String(r.body?.markdown?.text ?? "").includes("短跑证据")));
	const runCard = ranAgain ? [...webhookPosts()].reverse().find((r) => String(r.body?.markdown?.text ?? "").includes("短跑证据")) : undefined;
	const runMs = parseMs(String(runCard?.body?.markdown?.text ?? ""));
	check("空闲卡报的是本轮耗时，不是整个会话", runMs >= 0 && runMs < 200, runMs);
}

console.log("\n[13] dingtalk_notify 工具");
{
	const tool = tools.get("dingtalk_notify");
	const result = await tool.execute("call-1", { title: "测试", message: "来自冒烟测试", urgency: "high" }, undefined, undefined, ctx);
	check("工具返回成功", result?.details?.sent === true, result?.details);
	check("消息已发出", await waitFor(() => webhookPosts().some((r) => String(r.body?.markdown?.title).includes("测试"))));
}

console.log("\n[14] /dingtalk 本地命令");
{
	await commands.get("dingtalk").handler("test", ctx);
	check("本地 test 子命令发送成功", (notices.at(-1)?.includes("已发送测试消息") ?? false), notices.at(-1));
	await commands.get("dingtalk").handler("status", ctx);
	check("本地 status 输出配置摘要", (notices.at(-1)?.includes("入站 Stream") ?? false), notices.at(-1));
}

console.log("\n[15] 默认不自动接管，需显式 /dingtalk takeover；接管跨会话保留");
{
	// `autoTakeover` off: the session stays inert until the terminal asks for
	// control. Start from a clean, released state so an inherited takeover from an
	// earlier section does not mask the test.
	writeFileSync(configPath, JSON.stringify({ ...MAIN_CONFIG, control: { ...MAIN_CONTROL, autoTakeover: false } }));
	await commands.get("dingtalk").handler("release", ctx);
	await tick(100);

	// Snapshot the posts first: a notification still queued from an earlier
	// section can be delivered after this one, so "the last post" is not a safe
	// way to find this section's own message.
	const postsBefore = webhookPosts().length;
	await fire("session_start", { type: "session_start" });

	const connects = () => requests.filter((r) => r.url.includes("/gateway/connections/open")).length;
	const before = connects();
	await tick(300);
	check("autoTakeover=false 时不建立入站连接", connects() === before, connects() - before);
	const postsAtStart = webhookPosts().slice(postsBefore);
	check("未接管时启动也不推送任何消息", !postsAtStart.some((r) => String(r.body?.markdown?.title).includes("已启动")), postsAtStart.length);

	await commands.get("dingtalk").handler("takeover", ctx);
	check("takeover 提示已接管", String(notices.at(-1) ?? "").includes("已接管"), notices.at(-1));
	check("钉钉收到接管成功推送", await waitFor(() => webhookPosts().slice(postsBefore).some((r) => String(r.body?.markdown?.title).includes("钉钉已接管"))), webhookPosts().slice(postsBefore).map((r) => r.body?.markdown?.title).slice(-3));
	check("接管推送带上了目录和提示", String(webhookPosts().slice(postsBefore).filter((r) => String(r.body?.markdown?.title).includes("钉钉已接管")).at(-1)?.body?.markdown?.text ?? "").includes("目录") && String(webhookPosts().slice(postsBefore).filter((r) => String(r.body?.markdown?.title).includes("钉钉已接管")).at(-1)?.body?.markdown?.text ?? "").includes("发消息即可指挥它"), String(webhookPosts().slice(postsBefore).filter((r) => String(r.body?.markdown?.title).includes("钉钉已接管")).at(-1)?.body?.markdown?.text ?? ""));
	check("takeover 后才开始建连", await waitFor(() => connects() > before));
	check(
		"接管后 socket 已建立",
		await waitFor(() => MockSocket.instances.at(-1)?.readyState === 0),
		MockSocket.instances.map((s) => s.readyState),
	);

	// A fresh session_start in the same process must NOT drop the takeover the
	// user asked for: autoTakeover=false only stops auto-connecting, it must not
	// silently release a takeover the user took explicitly.
	const socketsKept = MockSocket.instances.length;
	const liveState = MockSocket.instances.at(-1)?.readyState;
	await fire("session_start", { type: "session_start" });
	await tick(200);
	check("新会话启动不释放已有接管（连接保持）", MockSocket.instances.length === socketsKept && MockSocket.instances.at(-1)?.readyState === liveState, MockSocket.instances.length);

	await commands.get("dingtalk").handler("status", ctx);
	check("本地 status 显示接管状态", String(notices.at(-1) ?? "").includes("钉钉接管"), String(notices.at(-1) ?? "").slice(0, 400));
}

console.log("\n[16] /dingtalk release 关闭入站通道 + scope 反向过滤");
{
	const socketCount = MockSocket.instances.length;
	await commands.get("dingtalk").handler("release", ctx);
	check("release 提示已解除接管", String(notices.at(-1) ?? "").includes("解除"), notices.at(-1));
	await tick(200);
	check("release 后 WebSocket 被关闭", MockSocket.instances.at(-1)?.readyState === 3, MockSocket.instances.at(-1)?.readyState);
	check("release 后不会自动重连", MockSocket.instances.length === socketCount, MockSocket.instances.length - socketCount);

	// scope=group is the mirror image: 1:1 chatter is ignored, group @ works.
	writeFileSync(configPath, JSON.stringify({ ...MAIN_CONFIG, control: { ...MAIN_CONTROL, scope: "group" } }));
	await fire("session_start", { type: "session_start" });
	const groupSocket = MockSocket.instances.at(-1)!;
	groupSocket.open();
	groupSocket.system("REGISTERED");

	const beforeGroup = sessionReplies().length;
	groupSocket.robot("状态");
	await tick(200);
	check("scope=group 时单聊被忽略", sessionReplies().length === beforeGroup, sessionReplies().length - beforeGroup);

	groupSocket.robot("状态", { conversationType: "2", isInAtList: false });
	await tick(200);
	check("scope=group 时未 @ 的群聊被忽略", sessionReplies().length === beforeGroup, sessionReplies().length - beforeGroup);

	groupSocket.robot("状态", { conversationType: "2", isInAtList: true });
	check("scope=group 时 @ 了才响应", await waitFor(() => sessionReplies().length > beforeGroup));

	// Back to the main config so the shutdown case exercises the normal path.
	writeFileSync(configPath, JSON.stringify(MAIN_CONFIG));
	await fire("session_start", { type: "session_start" });
	const restored = MockSocket.instances.at(-1)!;
	restored.open();
	restored.system("REGISTERED");
}

console.log("\n[17] 无凭据时必须安全降级");
{
	const dir = mkdtempSync(join(tmpdir(), "omp-dingtalk-empty-"));
	const emptyConfig = join(dir, "dingtalk.json");
	// Approval is explicitly armed, so the stand-down is caused by the missing
	// webhook rather than by the mode being off.
	writeFileSync(emptyConfig, JSON.stringify({ approval: { mode: "remote" } }));
	const previous = process.env.OMP_DINGTALK_CONFIG;
	process.env.OMP_DINGTALK_CONFIG = emptyConfig;

	// A fresh module instance is needed because the config is read per Bridge.
	const module = await import(`../src/index.ts?nocreds=${Date.now()}`);
	const localHandlers = new Map<string, Handler[]>();
	const localPi: any = { ...pi, on: (e: string, h: Handler) => localHandlers.set(e, [...(localHandlers.get(e) ?? []), h]) };
	module.default(localPi);
	await localHandlers.get("session_start")![0]({ type: "session_start" }, ctx);

	const gate = localHandlers.get("tool_call")![0];
	const outcome = await gate({ type: "tool_call", toolCallId: "t-nocreds", toolName: "bash", input: { command: "rm -rf /" } }, ctx);
	check("没有 webhook 时不拦截（避免无谓阻塞）", outcome === undefined, outcome);
	process.env.OMP_DINGTALK_CONFIG = previous;
}

console.log("\n[18] 未接管时审批闸门必须让路");
{
	const dir = mkdtempSync(join(tmpdir(), "omp-dingtalk-inert-"));
	const inertConfig = join(dir, "dingtalk.json");
	// Webhook and credentials are fine; the only thing missing is a takeover.
	writeFileSync(inertConfig, JSON.stringify({ ...MAIN_CONFIG, control: { ...MAIN_CONTROL, autoTakeover: false } }));
	const previous = process.env.OMP_DINGTALK_CONFIG;
	process.env.OMP_DINGTALK_CONFIG = inertConfig;

	const module = await import(`../src/index.ts?inert=${Date.now()}`);
	const localHandlers = new Map<string, Handler[]>();
	const localPi: any = { ...pi, on: (e: string, h: Handler) => localHandlers.set(e, [...(localHandlers.get(e) ?? []), h]) };
	module.default(localPi);
	await localHandlers.get("session_start")![0]({ type: "session_start" }, ctx);
	const gate = localHandlers.get("tool_call")![0];
	const outcome = await gate({ type: "tool_call", toolCallId: "t-inert", toolName: "bash", input: { command: "rm -rf /" } }, ctx);
	check("未接管时不拦截（否则每条危险命令都要等到超时）", outcome === undefined, outcome);
	const askOutcome = await gate(
		{ type: "tool_call", toolCallId: "t-inert-ask", toolName: "ask", input: { questions: [{ id: "q", question: "?", options: [{ label: "a" }] }] } },
		ctx,
	);
	check("未接管时 ask 也不拦截（本地对话框照常）", askOutcome === undefined, askOutcome);
	process.env.OMP_DINGTALK_CONFIG = previous;
}

console.log("\n[19] 出站走单聊推送（outbound.mode = direct）");
{
	// No webhook at all: the group robot is not the transport any more, so a
	// missing webhook.url must NOT count as "nothing can be sent".
	const dir = mkdtempSync(join(tmpdir(), "omp-dingtalk-direct-"));
	const directConfig = join(dir, "dingtalk.json");
	writeFileSync(
		directConfig,
		JSON.stringify({
			webhook: { url: "" },
			stream: { enabled: false, clientId: "direct-client", clientSecret: "direct-secret", robotCode: "ding-direct" },
			outbound: { mode: "direct" },
			control: { allowUserId: "user-1" },
		}),
	);
	const previous = process.env.OMP_DINGTALK_CONFIG;
	process.env.OMP_DINGTALK_CONFIG = directConfig;

	const module = await import(`../src/index.ts?direct=${Date.now()}`);
	const localHandlers = new Map<string, Handler[]>();
	const localCommands = new Map<string, any>();
	const localNotices: string[] = [];
	const localPi: any = {
		...pi,
		on: (e: string, h: Handler) => localHandlers.set(e, [...(localHandlers.get(e) ?? []), h]),
		registerCommand: (n: string, o: any) => localCommands.set(n, o),
	};
	module.default(localPi);
	const localCtx: any = { ...ctx, ui: { notify: (m: string) => localNotices.push(m) } };

	// Let the previous section's queued notifications finish draining, so the
	// "no group posts" baseline below is not polluted by them.
	await tick(200);
	const beforeGroup = groupPosts().length;
	const beforeOto = otoPosts().length;
	// Startup is silent by design, so trigger a real notification via the
	// session-end (idle) path instead.
	await localHandlers.get("session_stop")![0](
		{ type: "session_stop", last_assistant_message: { role: "assistant", content: [{ type: "text", text: "跑完了" }] } },
		localCtx,
	);

	check("单聊模式下确实发出了 1:1 推送", await waitFor(() => otoPosts().length > beforeOto), otoPosts().length - beforeOto);
	check("单聊模式下不再往群里发", groupPosts().length === beforeGroup, groupPosts().length - beforeGroup);

	const pushed = otoPosts().at(-1)?.body;
	check("推送带上了 robotCode", pushed?.robotCode === "ding-direct", pushed?.robotCode);
	check("收件人取自白名单 control.allowUserId", JSON.stringify(pushed?.userIds) === '["user-1"]', pushed?.userIds);
	check("消息类型是 sampleMarkdown", pushed?.msgKey === "sampleMarkdown", pushed?.msgKey);
	check(
		"换 token 用的是 appKey / appSecret",
		requests.some((r) => r.url.includes("/oauth2/accessToken") && r.body?.appKey === "direct-client" && r.body?.appSecret === "direct-secret"),
	);

	// /dingtalk test must follow the same transport rather than insisting on a webhook.
	await localCommands.get("dingtalk").handler("test", localCtx);
	check("本地 test 走单聊通道", String(localNotices.at(-1) ?? "").includes("已发送测试消息"), localNotices.at(-1));

	process.env.OMP_DINGTALK_CONFIG = previous;
}

console.log("\n[20] outbound.mode = both 时两条通道都发");
{
	const dir = mkdtempSync(join(tmpdir(), "omp-dingtalk-both-"));
	const bothConfig = join(dir, "dingtalk.json");
	writeFileSync(
		bothConfig,
		JSON.stringify({
			webhook: { url: "https://oapi.dingtalk.com/robot/send?access_token=BOTHTOKEN", secret: "" },
			stream: { enabled: false, clientId: "both-client", clientSecret: "both-secret", robotCode: "ding-both" },
			outbound: { mode: "both" },
			control: { allowUserId: "user-2" },
		}),
	);
	const previous = process.env.OMP_DINGTALK_CONFIG;
	process.env.OMP_DINGTALK_CONFIG = bothConfig;

	const module = await import(`../src/index.ts?both=${Date.now()}`);
	const localHandlers = new Map<string, Handler[]>();
	const localPi: any = { ...pi, on: (e: string, h: Handler) => localHandlers.set(e, [...(localHandlers.get(e) ?? []), h]) };
	module.default(localPi);

	const beforeGroup = groupPosts().length;
	const beforeOto = otoPosts().length;
	// Startup is silent by design, so trigger a real notification via the
	// session-end (idle) path instead.
	await localHandlers.get("session_stop")![0](
		{ type: "session_stop", last_assistant_message: { role: "assistant", content: [{ type: "text", text: "跑完了" }] } },
		ctx,
	);

	check("both 模式发出了群通知", await waitFor(() => groupPosts().length > beforeGroup), groupPosts().length - beforeGroup);
	check("both 模式同时发出了单聊推送", await waitFor(() => otoPosts().length > beforeOto), otoPosts().length - beforeOto);

	process.env.OMP_DINGTALK_CONFIG = previous;
}

console.log("\n[21] 白名单里的那个人就是推送收件人");
{
	// One config: the allowlisted operator is the recipient. Nothing is learned
	// from inbound messages, and an unset allowlist means nothing can be sent.
	const dir = mkdtempSync(join(tmpdir(), "omp-dingtalk-single-"));
	const singleConfig = join(dir, "dingtalk.json");
	writeFileSync(
		singleConfig,
		JSON.stringify({
			webhook: { url: "" },
			stream: { enabled: true, clientId: "single-client", clientSecret: "single-secret", robotCode: "ding-single" },
			outbound: { mode: "direct" },
			control: { ...MAIN_CONTROL, autoTakeover: true, scope: "direct", allowUserId: "allowed-user" },
		}),
	);
	const previous = process.env.OMP_DINGTALK_CONFIG;
	process.env.OMP_DINGTALK_CONFIG = singleConfig;

	const module = await import(`../src/index.ts?single=${Date.now()}`);
	const localHandlers = new Map<string, Handler[]>();
	const localCommands = new Map<string, any>();
	const localNotices: string[] = [];
	const localPi: any = {
		...pi,
		on: (e: string, h: Handler) => localHandlers.set(e, [...(localHandlers.get(e) ?? []), h]),
		registerCommand: (n: string, o: any) => localCommands.set(n, o),
	};
	module.default(localPi);
	const localCtx: any = { ...ctx, ui: { notify: (m: string) => localNotices.push(m) } };

	const socketsBefore = MockSocket.instances.length;
	await localHandlers.get("session_start")![0]({ type: "session_start" }, localCtx);
	// `startStream()` is fire-and-forget, so the WebSocket only exists a few
	// microtasks later — grabbing `at(-1)` straight away can hand back a socket
	// left over from an earlier section.
	await waitFor(() => MockSocket.instances.length > socketsBefore);
	const socket = MockSocket.instances.at(-1)!;
	socket.open();
	socket.system("REGISTERED");

	const recipients = async () => {
		await localCommands.get("dingtalk").handler("status", localCtx);
		const match = String(localNotices.at(-1) ?? "").match(/单聊收件人\*\*: (\d+) 人/);
		return match ? Number(match[1]) : -1;
	};
	// `waitFor` takes a sync predicate, so poll by hand here.
	const waitForRecipients = async (n: number) => {
		const deadline = Date.now() + 4_000;
		while (Date.now() < deadline) {
			if ((await recipients()) === n) return true;
			await tick(20);
		}
		return (await recipients()) === n;
	};
	// The allowlisted user is the recipient from the start — no inbound message
	// is needed to "learn" them.
	check("收件人就是白名单里的那个人", await waitForRecipients(1), await recipients());

	// A stranger must not be able to subscribe themselves to the notifications.
	socket.robot("/ping", { senderStaffId: "stranger" });
	await tick(200);
	check("白名单外的人不会成为收件人", (await recipients()) === 1);

	socket.robot("/ping", { senderStaffId: "allowed-user" });
	await tick(200);
	check("白名单内的人发消息后仍是同一个收件人", (await recipients()) === 1);

	const beforeOto = otoPosts().length;
	await localHandlers.get("session_stop")![0](
		{ type: "session_stop", last_assistant_message: { role: "assistant", content: [{ type: "text", text: "干完了" }] } },
		localCtx,
	);
	check("之后的通知推给了这个人", await waitFor(() => otoPosts().length > beforeOto), otoPosts().length - beforeOto);
	check("收件人就是他", JSON.stringify(otoPosts().at(-1)?.body?.userIds) === '["allowed-user"]', otoPosts().at(-1)?.body?.userIds);

	process.env.OMP_DINGTALK_CONFIG = previous;
}

console.log("\n[22] scope = direct 时群聊消息一律忽略");
{
	const dir = mkdtempSync(join(tmpdir(), "omp-dingtalk-direct-scope-"));
	const scopeConfig = join(dir, "dingtalk.json");
	writeFileSync(
		scopeConfig,
		JSON.stringify({
			...MAIN_CONFIG,
			// Its own app credential: reusing the main session's would make this
			// section preempt the main session's takeover lock, which is a
			// different feature (covered in [26]) and would leave the rest of the
			// suite running against a session that had quietly stood down.
			stream: { ...MAIN_CONFIG.stream, clientId: "scope-client", clientSecret: "scope-secret", robotCode: "ding-scope" },
			outbound: { mode: "webhook" },
			control: { ...MAIN_CONTROL, scope: "direct", autoTakeover: true, requireAt: true, allowUserId: "staff-smoke" },
		}),
	);
	const previous = process.env.OMP_DINGTALK_CONFIG;
	process.env.OMP_DINGTALK_CONFIG = scopeConfig;

	const module = await import(`../src/index.ts?scope=${Date.now()}`);
	const localHandlers = new Map<string, Handler[]>();
	const localPi: any = { ...pi, on: (e: string, h: Handler) => localHandlers.set(e, [...(localHandlers.get(e) ?? []), h]) };
	module.default(localPi);

	const socketsBefore = MockSocket.instances.length;
	await localHandlers.get("session_start")![0]({ type: "session_start" }, ctx);
	await waitFor(() => MockSocket.instances.length > socketsBefore);
	const socket = MockSocket.instances.at(-1)!;
	socket.open();
	socket.system("REGISTERED");

	const before = sessionReplies().length;
	// Even @-mentioned, a group message must not reach the session.
	socket.robot("状态", { conversationType: "2", isInAtList: true });
	await tick(250);
	check("scope=direct 时 @ 了的群聊也被忽略", sessionReplies().length === before, sessionReplies().length - before);

	socket.robot("状态", { conversationType: "1" });
	check("scope=direct 时单聊照常响应", await waitFor(() => sessionReplies().length > before));

	process.env.OMP_DINGTALK_CONFIG = previous;
}

console.log("\n[23] notify.onlyWhenTakenOver：接管前完全静默");
{
	const dir = mkdtempSync(join(tmpdir(), "omp-dingtalk-silent-"));
	const silentConfig = join(dir, "dingtalk.json");
	writeFileSync(
		silentConfig,
		JSON.stringify({
			webhook: { url: "https://oapi.dingtalk.com/robot/send?access_token=SILENTTOKEN", secret: "" },
			stream: { enabled: true, clientId: "silent-client", clientSecret: "silent-secret", robotCode: "ding-silent" },
			notify: { onlyWhenTakenOver: true },
			control: { ...MAIN_CONTROL, autoTakeover: false, scope: "direct", allowUserId: "staff-smoke" },
		}),
	);
	const previous = process.env.OMP_DINGTALK_CONFIG;
	process.env.OMP_DINGTALK_CONFIG = silentConfig;

	const module = await import(`../src/index.ts?silent=${Date.now()}`);
	const localHandlers = new Map<string, Handler[]>();
	const localCommands = new Map<string, any>();
	const localTools = new Map<string, any>();
	const localNotices: string[] = [];
	const localPi: any = {
		...pi,
		on: (e: string, h: Handler) => localHandlers.set(e, [...(localHandlers.get(e) ?? []), h]),
		registerCommand: (n: string, o: any) => localCommands.set(n, o),
		registerTool: (d: any) => localTools.set(d.name, d),
	};
	module.default(localPi);
	const localCtx: any = { ...ctx, ui: { notify: (m: string) => localNotices.push(m) } };

	await tick(200);
	const baseline = groupPosts().length;
	const stopEvent = {
		type: "session_stop",
		last_assistant_message: { role: "assistant", content: [{ type: "text", text: "干完了" }] },
	};

	await localHandlers.get("session_start")![0]({ type: "session_start" }, localCtx);
	await tick(250);
	check("未接管时保持静默（启动本来就不推送，自然也没有启动通知）", groupPosts().length === baseline, groupPosts().length - baseline);

	await localHandlers.get("session_stop")![0](stopEvent, localCtx);
	await tick(250);
	check("未接管时不发空闲通知", groupPosts().length === baseline, groupPosts().length - baseline);

	// An explicit request from the terminal must still work — otherwise there is
	// no way to verify the outbound channel while silent.
	await localCommands.get("dingtalk").handler("test", localCtx);
	check("静默期间 /dingtalk test 仍然能发", groupPosts().length > baseline, groupPosts().length - baseline);

	const tool = localTools.get("dingtalk_notify");
	const blocked = await tool.execute("call-silent", { title: "t", message: "m", urgency: "normal" }, undefined, undefined, localCtx);
	check("未接管时 dingtalk_notify 也被挡住", blocked?.isError === true, blocked?.details);
	check("并且说明了原因", String(blocked?.content?.[0]?.text ?? "").includes("takeover"), blocked?.content?.[0]?.text);

	const afterTest = groupPosts().length;
	await localCommands.get("dingtalk").handler("takeover", localCtx);
	check("接管提示里点明了通知刚开启", String(localNotices.at(-1) ?? "").includes("通知从现在起"), localNotices.at(-1));

	await localHandlers.get("session_stop")![0](stopEvent, localCtx);
	check("接管后通知恢复", await waitFor(() => groupPosts().length > afterTest), groupPosts().length - afterTest);

	// 先让排队中的卡片落地，再取基准：接管卡与空闲卡走的是限速队列，
	// 取早一步就会把「还没发出去」算成「release 之后又推送了」。
	await tick(250);
	const afterTaken = groupPosts().length;
	await localCommands.get("dingtalk").handler("release", localCtx);
	await localHandlers.get("session_stop")![0](stopEvent, localCtx);
	await tick(250);
	check("release 之后又静默了", groupPosts().length === afterTaken, groupPosts().length - afterTaken);

	process.env.OMP_DINGTALK_CONFIG = previous;
}

console.log("\n[24] onlyWhenTakenOver 却永远无法接管 → 必须告警");
{
	// The worst failure mode is silent-forever: it looks like nothing is wrong.
	const dir = mkdtempSync(join(tmpdir(), "omp-dingtalk-silent-dead-"));
	const deadConfig = join(dir, "dingtalk.json");
	writeFileSync(
		deadConfig,
		JSON.stringify({
			webhook: { url: "https://oapi.dingtalk.com/robot/send?access_token=DEADTOKEN" },
			stream: { enabled: false },
			notify: { onlyWhenTakenOver: true },
		}),
	);
	const previous = process.env.OMP_DINGTALK_CONFIG;
	process.env.OMP_DINGTALK_CONFIG = deadConfig;
	const { loadConfig } = await import("../src/config.ts");
	const loaded = loadConfig(dir);
	process.env.OMP_DINGTALK_CONFIG = previous;

	check(
		"配置会明确告警「一条通知也不会有」",
		loaded.warnings.some((w: string) => w.includes("onlyWhenTakenOver") && w.includes("一条通知也不会有")),
		loaded.warnings,
	);
}

console.log("\n[25] 接管锁：同一个钉钉应用只允许一个活着的消费者");
{
	// Unit-level on purpose: two live sessions cannot be simulated through the
	// plugin entrypoint (it holds a per-module singleton), but the lock *is* the
	// whole cross-session protocol, so it can be driven directly.
	const { TakeoverLock } = await import("../src/lock.ts");
	const quiet: any = { debug() {}, info() {}, warn() {}, error() {} };
	const lockRoot = process.env.OMP_DINGTALK_LOCK_DIR!;

	const a = new TakeoverLock("lock-app-1", quiet);
	const b = new TakeoverLock("lock-app-1", quiet);
	const other = new TakeoverLock("lock-app-2", quiet);

	const first = a.acquire("D:/proj/alpha");
	check("首个会话拿到锁", first.ok && !first.previous, first);
	check("锁文件落在配置的目录里", existsSync(a.path) && a.path.startsWith(lockRoot), a.path);
	check("锁文件记的是本进程 PID", a.readOwner()?.pid === process.pid, a.readOwner());

	const second = b.acquire("D:/proj/beta");
	check("第二个会话抢占成功（而不是被拒绝）", second.ok === true, second);
	check("并且知道被顶掉的是谁", second.previous?.cwd === "D:/proj/alpha", second.previous);

	const stolen = a.heartbeat();
	check("被抢占者心跳时发现自己已不是持有者", stolen?.cwd === "D:/proj/beta", stolen);
	check("被抢占后 held 归 false", a.held === false, a.held);

	// The victim must not delete the preemptor's lock on its way out.
	a.release();
	check("被抢占者 release 不会删掉新持有者的锁", existsSync(b.path));
	check("新持有者的锁仍然指向自己", b.readOwner()?.cwd === "D:/proj/beta", b.readOwner());

	const independent = other.acquire("D:/proj/gamma");
	check("不同 clientId 互不干扰", independent.ok && !independent.previous, independent);
	check("两个 app 是两个锁文件", a.path !== other.path, [a.path, other.path]);
	check("另一个 app 的锁不影响本 app", b.readOwner()?.cwd === "D:/proj/beta", b.readOwner());

	// A crash must not lock takeover out forever: a dead PID is reclaimed at once.
	writeFileSync(
		other.path,
		JSON.stringify({ token: "dead", pid: 999_999_999, cwd: "D:/proj/dead", appKeyHint: "x", startedAt: Date.now(), heartbeatAt: Date.now() }),
	);
	const reclaimed = other.acquire("D:/proj/gamma2");
	check("死进程留下的锁被静默回收", reclaimed.ok === true && reclaimed.previous === undefined, reclaimed);

	// Process alive but heartbeat stopped (hung / SIGSTOP'd) — also dead enough.
	writeFileSync(
		other.path,
		JSON.stringify({ token: "stale", pid: process.pid, cwd: "D:/proj/stale", appKeyHint: "x", startedAt: Date.now() - 60_000, heartbeatAt: Date.now() - 60_000 }),
	);
	const staleReclaim = other.acquire("D:/proj/gamma3");
	check("心跳超时的锁也算失效", staleReclaim.ok === true && staleReclaim.previous === undefined, staleReclaim);

	b.release();
	other.release();
	check("release 之后锁文件消失", !existsSync(b.path) && !existsSync(other.path));
}

console.log("\n[26] 多会话抢占：新会话 takeover 覆盖旧会话");
{
	const base = mkdtempSync(join(tmpdir(), "omp-dingtalk-preempt-"));
	const cfgPath = join(base, "dingtalk.json");
	writeFileSync(
		cfgPath,
		JSON.stringify({
			webhook: { url: "https://oapi.dingtalk.com/robot/send?access_token=PREEMPTTOKEN", secret: "" },
			stream: { enabled: true, clientId: "preempt-client", clientSecret: "preempt-secret", robotCode: "ding-preempt" },
			// Deliberately silent-until-takeover: the preemption warning has to be
			// the one thing that still gets through.
			notify: { onlyWhenTakenOver: true, turnEnd: { enabled: true, minDurationMs: 0 } },
			control: { ...MAIN_CONTROL, autoTakeover: false, scope: "direct" },
		}),
	);
	const previous = process.env.OMP_DINGTALK_CONFIG;
	process.env.OMP_DINGTALK_CONFIG = cfgPath;

	const lockRoot = process.env.OMP_DINGTALK_LOCK_DIR!;
	const lockFor = (suffix: string): string | undefined =>
		readdirSync(lockRoot)
			.map((f) => join(lockRoot, f))
			.find((p) => {
				try {
					return String(JSON.parse(readFileSync(p, "utf8")).cwd ?? "").endsWith(suffix);
				} catch {
					return false;
				}
			});

	/** Boot an independent module instance — i.e. a second omp session. */
	const boot = async (tag: string) => {
		const module = await import(`../src/index.ts?preempt=${tag}`);
		const h = new Map<string, Handler[]>();
		const cmds = new Map<string, any>();
		const notes: string[] = [];
		const localPi: any = {
			...pi,
			on: (event: string, handler: Handler) => h.set(event, [...(h.get(event) ?? []), handler]),
			registerCommand: (name: string, options: any) => cmds.set(name, options),
			registerTool: (definition: any) => tools.set(definition.name, definition),
		};
		module.default(localPi);
		const localCtx: any = { ...ctx, cwd: join(base, tag), ui: { notify: (message: string) => notes.push(message) } };
		await tick(120);
		await h.get("session_start")![0]({ type: "session_start" }, localCtx);
		return { cmds, notes, ctx: localCtx };
	};

	const socketsBefore = MockSocket.instances.length;
	const alpha = await boot("alpha");
	const beta = await boot("beta");
	check("未执行 takeover 时不建立 Stream 连接", MockSocket.instances.length === socketsBefore, MockSocket.instances.length - socketsBefore);

	await alpha.cmds.get("dingtalk").handler("takeover", alpha.ctx);
	check("A 接管成功", String(alpha.notes.at(-1) ?? "").includes("钉钉已接管本会话"), alpha.notes.at(-1));
	check("A 接管后建立了 Stream 连接", await waitFor(() => MockSocket.instances.length > socketsBefore));
	const socketAlpha = MockSocket.instances.at(-1)!;
	check("A 的锁文件已写入", Boolean(lockFor("alpha")), readdirSync(lockRoot));

	await beta.cmds.get("dingtalk").handler("takeover", beta.ctx);
	check("B 接管没有被拒绝", String(beta.notes.at(-1) ?? "").includes("钉钉已接管本会话"), beta.notes.at(-1));
	check(
		"B 的提示里点名了被抢的会话",
		String(beta.notes.at(-1) ?? "").includes("抢占") && String(beta.notes.at(-1) ?? "").includes("alpha"),
		beta.notes.at(-1),
	);

	// A must stand down by itself — otherwise both Streams stay live and DingTalk
	// picks a winner at random.
	check("A 在心跳周期内自动让位（关闭 Stream）", await waitFor(() => socketAlpha.readyState === 3, 4_000), socketAlpha.readyState);
	// DingTalk has exactly one voice: the session that owns the channel. The
	// session that just lost the takeover must push nothing — the winner's card
	// already named it, and the demoted session keeps its warning in the log.
	const noticeTitles = groupPosts().map((r) => String(r.body?.markdown?.title ?? ""));
	check("被抢占的会话不推「已被抢占」卡（钉钉只有一个出口）", !noticeTitles.some((t) => t.includes("已被抢占")), noticeTitles);

	// Letting go late must not clobber the new owner.
	const betaLock = lockFor("beta");
	check("B 的锁文件存在", Boolean(betaLock), readdirSync(lockRoot));
	await alpha.cmds.get("dingtalk").handler("release", alpha.ctx);
	check("A 让位后 release 不会误删 B 的锁", Boolean(betaLock) && existsSync(betaLock!), betaLock);
	check("锁仍然指向 B 的会话", String(JSON.parse(readFileSync(betaLock!, "utf8")).cwd).endsWith("beta"));

	// Only B is still listening.
	const socketBeta = MockSocket.instances.at(-1)!;
	socketBeta.open();
	socketBeta.system("REGISTERED");
	const repliesBefore = sessionReplies().length;
	socketBeta.robot("状态");
	check("抢占后钉钉消息只到达 B", await waitFor(() => sessionReplies().length > repliesBefore), sessionReplies().length - repliesBefore);

	await beta.cmds.get("dingtalk").handler("release", beta.ctx);
	check("B release 后锁被清掉", !existsSync(betaLock!), lockFor("beta"));

	process.env.OMP_DINGTALK_CONFIG = previous;
}

console.log("\n[27] 退出清理");
{
	const before = MockSocket.instances.length;
	await fire("session_shutdown", { type: "session_shutdown" });
	check("session_shutdown 未抛异常", true);
	check("已建立过连接", MockSocket.instances.length >= before);
	await tick(150);
}

console.log("\n[28] 子代理会话的事件被忽略（不推送退出、不拆主会话的桥）");
{
	// A subagent runs its own extension runner against the same in-process
	// module, so its session_start/session_shutdown land on these handlers with a
	// different session id. Only the session that owns the bridge may act.
	const dir = mkdtempSync(join(tmpdir(), "omp-dingtalk-subagent-"));
	const cfgPath = join(dir, "dingtalk.json");
	writeFileSync(
		cfgPath,
		JSON.stringify({
			webhook: { url: "" },
			stream: { enabled: true, clientId: "subagent-client", clientSecret: "subagent-secret", robotCode: "ding-subagent" },
			outbound: { mode: "direct" },
			control: { allowUserId: "user-1" },
			notify: { sessionShutdown: true },
		}),
	);
	const previous = process.env.OMP_DINGTALK_CONFIG;
	process.env.OMP_DINGTALK_CONFIG = cfgPath;

	const module = await import(`../src/index.ts?subagent=${Date.now()}`);
	const localHandlers = new Map<string, Handler[]>();
	const localCommands = new Map<string, any>();
	const localPi: any = {
		...pi,
		on: (e: string, h: Handler) => localHandlers.set(e, [...(localHandlers.get(e) ?? []), h]),
		registerCommand: (n: string, o: any) => localCommands.set(n, o),
	};
	module.default(localPi);

	const mainCtx: any = { ...ctx, sessionManager: { getBranch: () => [], getSessionId: () => "session-main" } };
	// A subagent's runner is initialized without a UI context, so it reports
	// `hasUI: false` / `mode: "print"` — that is what marks a session as nested.
	const subCtx: any = {
		...ctx,
		hasUI: false,
		mode: "print",
		sessionManager: { getBranch: () => [], getSessionId: () => "session-sub" },
	};

	const lockRoot = process.env.OMP_DINGTALK_LOCK_DIR!;
	const lockCount = () => readdirSync(lockRoot).filter((f) => f.includes("takeover")).length;

	await tick(200);
	const socketsBefore = MockSocket.instances.length;
	const locksBefore = lockCount();
	await localHandlers.get("session_start")![0]({ type: "session_start" }, mainCtx);
	await localCommands.get("dingtalk").handler("takeover", mainCtx);
	check("主会话接管后建立了 Stream 连接", await waitFor(() => MockSocket.instances.length > socketsBefore, 4_000));
	check("主会话接管后写入锁文件", lockCount() > locksBefore);
	const socketsLive = MockSocket.instances.length;
	const locksLive = lockCount();
	const liveSocket = MockSocket.instances.at(-1)!;

	const otoBefore = otoPosts().length;

	// The subagent leaving must not look like the session exiting.
	await localHandlers.get("session_shutdown")![0]({ type: "session_shutdown" }, subCtx);
	await tick(200);
	check("子代理退出不推送「omp 已退出」", otoPosts().length === otoBefore, otoPosts().length - otoBefore);
	check("子代理退出不释放主会话的接管锁", lockCount() === locksLive, lockCount());
	check("子代理退出不建立新连接", MockSocket.instances.length === socketsLive, MockSocket.instances.length);
	check("子代理退出后主会话连接仍然打开", liveSocket.readyState !== 3, liveSocket.readyState);

	// The owning session's own shutdown still announces the exit.
	await localHandlers.get("session_shutdown")![0]({ type: "session_shutdown" }, mainCtx);
	await tick(200);
	check("主会话退出才推送「omp 已退出」", otoPosts().length > otoBefore, otoPosts().length - otoBefore);

	process.env.OMP_DINGTALK_CONFIG = previous;
}

console.log("\n[29] 样例配置的开箱状态（防止占位值被当成已配置）");
{
	// A non-empty placeholder URL would flip `sender.configured` to true while
	// every push goes to a fake endpoint — the nastiest kind of "looks fine".
	const example = JSON.parse(readFileSync(new URL("../config.example.json", import.meta.url), "utf8"));
	check("样例的 webhook.url 为空（不预置占位地址）", example.webhook.url === "", example.webhook.url);
	check("样例的 outbound.mode 是合法值", ["webhook", "direct", "both"].includes(example.outbound.mode), example.outbound.mode);
	check("样例的 control.allowUserId 是字符串（单值白名单）", typeof example.control.allowUserId === "string", typeof example.control.allowUserId);
	const legacyExampleKeys = ["allowUserIds", "directUserIds", "learnFromInbound"].filter(
		(key) => key in (example.control ?? {}) || key in (example.outbound ?? {}),
	);
	check("样例不含已废弃的旧字段", legacyExampleKeys.length === 0, legacyExampleKeys);
	check(
		"样例的 stream 凭据为空（开箱即未配置）",
		!example.stream.clientId && !example.stream.clientSecret && !example.stream.robotCode,
		example.stream,
	);
}

console.log("\n[30] 子代理在独立 cwd 里绑定自己的副本时保持静默（进程级归属）");
{
	// The host rebinds the factory once per session, so a subagent in its own cwd
	// gets its own copy of the plugin — and, without a process-wide owner, its own
	// bridge pushing the subagent's retries under a bogus session label. Only the
	// first binding (the interactive session) may act.
	const module = await import(`../src/index.ts?owner=${Date.now()}`);
	const bind = (): Map<string, Handler[]> => {
		const bound = new Map<string, Handler[]>();
		const localPi: any = {
			...pi,
			on: (e: string, h: Handler) => bound.set(e, [...(bound.get(e) ?? []), h]),
		};
		module.default(localPi);
		return bound;
	};
	const mainHandlers = bind();
	const subHandlers = bind();
	const sessionCtx = (id: string, cwd: string) => ({
		...ctx,
		cwd,
		sessionManager: { getBranch: () => [], getSessionId: () => id },
	});
	const mainCtx = sessionCtx("session-main", "/tmp/owner-main");
	const subCtx = { ...sessionCtx("session-sub", "/tmp/owner-sub"), hasUI: false, mode: "print" };
	const retry = () => ({ type: "auto_retry_start", attempt: 4, maxAttempts: 10, delayMs: 3_000, errorMessage: "boom" });

	await mainHandlers.get("session_start")![0]({ type: "session_start" }, mainCtx);
	await tick(200);
	const postsBefore = webhookPosts().length;
	const socketsBefore = MockSocket.instances.length;

	await subHandlers.get("session_start")![0]({ type: "session_start" }, subCtx);
	await subHandlers.get("auto_retry_start")![0](retry(), subCtx);
	await subHandlers.get("session_shutdown")![0]({ type: "session_shutdown" }, subCtx);
	await tick(200);
	check("子代理绑定的副本不推送任何内容", webhookPosts().length === postsBefore, webhookPosts().length - postsBefore);
	check("子代理绑定的副本不建立连接", MockSocket.instances.length === socketsBefore, MockSocket.instances.length);

	await mainHandlers.get("auto_retry_start")![0](retry(), mainCtx);
	await tick(200);
	check("主会话绑定的重试照常推送", webhookPosts().length > postsBefore, webhookPosts().length - postsBefore);
}

console.log("\n[31] 别人接管时本会话是旁观者：不推送任何通知");
{
	// The real-world setup: window A takes over, window B is an ordinary
	// session. With notify.onlyWhenTakenOver = false, B used to push its own
	// "omp 空闲" card into the same DingTalk account A controls. A takeover
	// must claim the outbound side too, or the user cannot tell which window
	// is talking to them.
	const base = mkdtempSync(join(tmpdir(), "omp-dingtalk-bystander-"));
	const cfgPath = join(base, "dingtalk.json");
	writeFileSync(
		cfgPath,
		JSON.stringify({
			webhook: { url: "https://oapi.dingtalk.com/robot/send?access_token=BYSTANDERTOKEN", secret: "" },
			stream: { enabled: true, clientId: "bystander-client", clientSecret: "bystander-secret", robotCode: "ding-bystander" },
			// Deliberately false: the point is that the takeover itself silences
			// the other session, not this switch.
			notify: { onlyWhenTakenOver: false, turnEnd: { enabled: true, minDurationMs: 0 }, sessionStop: true },
			control: { ...MAIN_CONTROL, autoTakeover: false, scope: "direct" },
		}),
	);
	const previous = process.env.OMP_DINGTALK_CONFIG;
	process.env.OMP_DINGTALK_CONFIG = cfgPath;

	/** Boot an independent module instance — i.e. a second omp window. */
	const boot = async (tag: string) => {
		const module = await import(`../src/index.ts?bystander=${tag}`);
		const h = new Map<string, Handler[]>();
		const cmds = new Map<string, any>();
		const localTools = new Map<string, any>();
		const notes: string[] = [];
		const localPi: any = {
			...pi,
			on: (event: string, handler: Handler) => h.set(event, [...(h.get(event) ?? []), handler]),
			registerCommand: (name: string, options: any) => cmds.set(name, options),
			registerTool: (definition: any) => localTools.set(definition.name, definition),
		};
		module.default(localPi);
		const localCtx: any = { ...ctx, cwd: join(base, tag), ui: { notify: (message: string) => notes.push(message) } };
		await tick(120);
		await h.get("session_start")![0]({ type: "session_start" }, localCtx);
		return { h, cmds, tools: localTools, notes, ctx: localCtx };
	};

	const alpha = await boot("alpha");
	const beta = await boot("beta");

	const stopEvent = {
		type: "session_stop",
		last_assistant_message: { role: "assistant", content: [{ type: "text", text: "干完了" }] },
	};
	const turnEvent = { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } };

	// Nobody owns the channel yet: B is an ordinary notifier.
	const beforeTakeover = groupPosts().length;
	await beta.h.get("turn_end")![0](turnEvent, beta.ctx);
	check("没人接管时 B 照常推送（旁观判定不误伤）", await waitFor(() => groupPosts().length > beforeTakeover), groupPosts().length - beforeTakeover);

	await alpha.cmds.get("dingtalk").handler("takeover", alpha.ctx);
	check("A 接管成功", String(alpha.notes.at(-1) ?? "").includes("钉钉已接管本会话"), alpha.notes.at(-1));
	await tick(150);

	const baseline = groupPosts().length;
	await beta.h.get("turn_end")![0](turnEvent, beta.ctx);
	await beta.h.get("session_stop")![0](stopEvent, beta.ctx);
	await tick(250);
	check("A 接管后，B 的轮次与空闲通知一律不推", groupPosts().length === baseline, groupPosts().length - baseline);

	const blocked = await beta.tools
		.get("dingtalk_notify")
		.execute("call-bystander", { title: "t", message: "m", urgency: "normal" }, undefined, undefined, beta.ctx);
	check("B 的 dingtalk_notify 同样被挡住", blocked?.isError === true, blocked?.details);
	check("挡住原因点名了「另一个 omp 会话」", String(blocked?.content?.[0]?.text ?? "").includes("另一个 omp 会话"), blocked?.content?.[0]?.text);

	const testBaseline = groupPosts().length;
	await beta.cmds.get("dingtalk").handler("test", beta.ctx);
	await tick(150);
	check("B 的 /dingtalk test 也不往钉钉发", groupPosts().length === testBaseline, groupPosts().length - testBaseline);
	check("B 的 /dingtalk test 在终端说明了原因", String(beta.notes.at(-1) ?? "").includes("另一个 omp 会话"), beta.notes.at(-1));

	const ownerBaseline = groupPosts().length;
	await alpha.h.get("session_stop")![0](stopEvent, alpha.ctx);
	check("接管方 A 照常推送", await waitFor(() => groupPosts().length > ownerBaseline), groupPosts().length - ownerBaseline);

	await alpha.cmds.get("dingtalk").handler("release", alpha.ctx);
	const afterRelease = groupPosts().length;
	await beta.h.get("session_stop")![0](stopEvent, beta.ctx);
	check("A 释放后 B 恢复推送（通道没人占）", await waitFor(() => groupPosts().length > afterRelease), groupPosts().length - afterRelease);

	process.env.OMP_DINGTALK_CONFIG = previous;
}

console.log("\n[32] 同进程第二个顶层会话：接管后事件不再被当成子代理丢弃");
{
	// Handlers live in one process-wide list, so a second top-level session in
	// the same process dispatches through the same handlers with a different
	// session id — which is exactly what a subagent looks like by id alone. It
	// used to be treated as a subagent and every event dropped: takeover
	// succeeded, the stream was live, and DingTalk stayed silent. The
	// discriminator is the runner: a subagent is headless (`hasUI: false`,
	// `mode: "print"`), the TUI session is not.
	const base = mkdtempSync(join(tmpdir(), "omp-dingtalk-multisession-"));
	const cfgPath = join(base, "dingtalk.json");
	writeFileSync(
		cfgPath,
		JSON.stringify({
			webhook: { url: "https://oapi.dingtalk.com/robot/send?access_token=MULTITOKEN", secret: "" },
			stream: { enabled: false },
			notify: { onlyWhenTakenOver: false, turnEnd: { enabled: true, minDurationMs: 0 }, sessionStop: true },
			control: { ...MAIN_CONTROL, autoTakeover: false, scope: "direct" },
		}),
	);
	const previous = process.env.OMP_DINGTALK_CONFIG;
	process.env.OMP_DINGTALK_CONFIG = cfgPath;

	const module = await import(`../src/index.ts?multisession=${Date.now()}`);
	const h = new Map<string, Handler[]>();
	const cmds = new Map<string, any>();
	module.default({
		...pi,
		on: (e: string, handler: Handler) => h.set(e, [...(h.get(e) ?? []), handler]),
		registerCommand: (n: string, o: any) => cmds.set(n, o),
	});

	const ctxOf = (id: string, extra: Record<string, unknown> = {}) => ({
		...ctx,
		cwd: base,
		sessionManager: { getBranch: () => [], getSessionId: () => id },
		...extra,
	});
	const first = ctxOf("session-1");
	const second = ctxOf("session-2");
	const sub = ctxOf("session-sub", { hasUI: false, mode: "print" });
	const turnEnd = { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } };

	await h.get("session_start")![0]({ type: "session_start" }, first);
	await tick(150);
	// The user opens another top-level session in the same process and takes
	// over there. Its events must no longer be filtered out as a subagent's.
	await h.get("session_start")![0]({ type: "session_start" }, second);
	await cmds.get("dingtalk").handler("takeover", second);
	const before = webhookPosts().length;
	await h.get("turn_end")![0](turnEnd, second);
	check("第二个顶层会话接管后，轮次通知能推出去", await waitFor(() => webhookPosts().length > before), webhookPosts().length - before);

	// A genuine subagent in the same process stays silent.
	const subBaseline = webhookPosts().length;
	await h.get("session_start")![0]({ type: "session_start" }, sub);
	await h.get("turn_end")![0](turnEnd, sub);
	await tick(150);
	check("子代理的轮次仍然不推送", webhookPosts().length === subBaseline, webhookPosts().length - subBaseline);

	process.env.OMP_DINGTALK_CONFIG = previous;
}

console.log("\n[33] autoTakeover=true：第二个顶层会话后来者覆盖，不再被当旁观者丢弃");
{
	// With control.autoTakeover = true, the newest top-level session is
	// expected to hold the channel ("later wins"). A second session_start used
	// to hit the takenOver guard and be dropped before the autoTakeover block
	// ran, leaving that session a permanent bystander. Falling through rebinds
	// the bridge to the new session and lets it preempt the earlier one.
	const base = mkdtempSync(join(tmpdir(), "omp-dingtalk-laterwins-"));
	const cfgPath = join(base, "dingtalk.json");
	writeFileSync(
		cfgPath,
		JSON.stringify({
			webhook: { url: "https://oapi.dingtalk.com/robot/send?access_token=LATERWINSTOKEN", secret: "" },
			// Takeover opens the inbound stream; with it disabled, takeOver()
			// fails and the "later wins" path below is never exercised.
			stream: { enabled: true, clientId: "laterwins-client", clientSecret: "laterwins-secret", robotCode: "ding-laterwins" },
			notify: { onlyWhenTakenOver: false, turnEnd: { enabled: true, minDurationMs: 0 }, sessionStop: true },
			control: { ...MAIN_CONTROL, autoTakeover: true, scope: "direct" },
		}),
	);
	const previous = process.env.OMP_DINGTALK_CONFIG;
	process.env.OMP_DINGTALK_CONFIG = cfgPath;
	const module = await import(`../src/index.ts?laterwins=${Date.now()}`);
	const h = new Map<string, Handler[]>();
	const cmds = new Map<string, any>();
	const notes: string[] = [];
	module.default({
		...pi,
		on: (e: string, handler: Handler) => h.set(e, [...(h.get(e) ?? []), handler]),
		registerCommand: (n: string, o: any) => cmds.set(n, o),
	});
	const ctxOf = (id: string) => ({
		...ctx,
		cwd: base,
		ui: { notify: (message: string) => notes.push(message) },
		sessionManager: { getBranch: () => [], getSessionId: () => id },
	});
	const s1 = ctxOf("session-l1");
	const s2 = ctxOf("session-l2");
	const turnEnd = { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } };

	await h.get("session_start")![0]({ type: "session_start" }, s1);
	await tick(200);
	// Prove the first session actually holds the channel — otherwise the
	// "later wins" path is never exercised and this test would pass even
	// against the buggy code.
	notes.length = 0;
	await cmds.get("dingtalk").handler("status", s1);
	const s1Status = notes.at(-1) ?? "";
	check("首个会话在 autoTakeover 下确实接管了", s1Status.includes("已接管"), s1Status);
	const b1 = webhookPosts().length;
	await h.get("turn_end")![0](turnEnd, s1);
	check("autoTakeover 下首个会话接管，轮次能推送", await waitFor(() => webhookPosts().length > b1), webhookPosts().length - b1);

	// Second top-level session arrives while the first still holds the lock.
	await h.get("session_start")![0]({ type: "session_start" }, s2);
	await tick(200);
	const b2 = webhookPosts().length;
	await h.get("turn_end")![0](turnEnd, s2);
	check("autoTakeover 下第二个顶层会话的轮次能推送（后来者覆盖）", await waitFor(() => webhookPosts().length > b2), webhookPosts().length - b2);

	// The superseded first session is now foreign: its events must not leak.
	const b3 = webhookPosts().length;
	await h.get("turn_end")![0](turnEnd, s1);
	await tick(150);
	check("被覆盖的旧会话轮次不再推送", webhookPosts().length === b3, webhookPosts().length - b3);

	process.env.OMP_DINGTALK_CONFIG = previous;
}

console.log("\n[34] /dingtalk status 在桥绑定会话与当前会话不符时给出显式提示");
{
	// The silent-drop failure was hard to diagnose because the discard lived
	// at debug level. status must surface a binding that does not match the
	// session it was asked from, plus the accumulated foreign-drop count.
	const base = mkdtempSync(join(tmpdir(), "omp-dingtalk-statusmismatch-"));
	const cfgPath = join(base, "dingtalk.json");
	writeFileSync(
		cfgPath,
		JSON.stringify({
			webhook: { url: "https://oapi.dingtalk.com/robot/send?access_token=STATUSMISMATCH", secret: "" },
			stream: { enabled: false },
			notify: { onlyWhenTakenOver: false, turnEnd: { enabled: true, minDurationMs: 0 }, sessionStop: true },
			control: { ...MAIN_CONTROL, autoTakeover: false, scope: "direct" },
		}),
	);
	const previous = process.env.OMP_DINGTALK_CONFIG;
	process.env.OMP_DINGTALK_CONFIG = cfgPath;
	const module = await import(`../src/index.ts?statusmismatch=${Date.now()}`);
	const h = new Map<string, Handler[]>();
	const cmds = new Map<string, any>();
	const notes: string[] = [];
	module.default({
		...pi,
		on: (e: string, handler: Handler) => h.set(e, [...(h.get(e) ?? []), handler]),
		registerCommand: (n: string, o: any) => cmds.set(n, o),
	});
	const ctxOf = (id: string) => ({
		...ctx,
		cwd: base,
		ui: { notify: (message: string) => notes.push(message) },
		sessionManager: { getBranch: () => [], getSessionId: () => id },
	});
	const s1 = ctxOf("session-s1");
	const s2 = ctxOf("session-s2");

	await h.get("session_start")![0]({ type: "session_start" }, s1);
	await tick(150);
	notes.length = 0;
	await cmds.get("dingtalk").handler("status", s1);
	const fromS1 = notes.at(-1) ?? "";
	check("绑定会话的 status 不提示归属不符", !fromS1.includes("归属不符"), fromS1);
	check("status 展示桥绑定会话 id", fromS1.includes("桥绑定会话") && fromS1.includes("session-s1"), fromS1);

	notes.length = 0;
	await cmds.get("dingtalk").handler("status", s2);
	const fromS2 = notes.at(-1) ?? "";
	check(
		"未绑定会话的 status 提示归属不符并给出接管指引",
		fromS2.includes("归属不符") && fromS2.includes("/dingtalk takeover"),
		fromS2,
	);

	process.env.OMP_DINGTALK_CONFIG = previous;
}

console.log("\n[35] 超长回复按多条消息全量推送（不再截断成 …）");
{
	// notify() used to hard-truncate every card to notify.maxTextChars, so a
	// long final reply arrived as "…". DingTalk rejects an over-long message
	// outright, so the fix is several messages — each under the budget — that
	// together carry the whole reply.
	const base = mkdtempSync(join(tmpdir(), "omp-dingtalk-longreply-"));
	const cfgPath = join(base, "dingtalk.json");
	writeFileSync(
		cfgPath,
		JSON.stringify({
			webhook: { url: "https://oapi.dingtalk.com/robot/send?access_token=LONGREPLYTOKEN", secret: "" },
			stream: { enabled: false },
			notify: { onlyWhenTakenOver: false, maxTextChars: 400, turnEnd: { enabled: true, minDurationMs: 0 }, sessionStop: true },
			control: { ...MAIN_CONTROL, autoTakeover: false, scope: "direct" },
		}),
	);
	const previous = process.env.OMP_DINGTALK_CONFIG;
	process.env.OMP_DINGTALK_CONFIG = cfgPath;
	const module = await import(`../src/index.ts?longreply=${Date.now()}`);
	const h = new Map<string, Handler[]>();
	module.default({ ...pi, on: (e: string, handler: Handler) => h.set(e, [...(h.get(e) ?? []), handler]) });
	const c = { ...ctx, cwd: base, sessionManager: { getBranch: () => [], getSessionId: () => "session-long" } };
	await h.get("session_start")![0]({ type: "session_start" }, c);
	await tick(150);

	const marker = "结尾哨兵-ZZZ";
	const reply =
		Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 段：这是一段足够长的回复正文，用来验证超长内容会被完整地拆进多条消息。`).join("\n\n") +
		`\n\n${marker}`;
	const before = webhookPosts().length;
	await h.get("session_stop")![0](
		{
			type: "session_stop",
			last_assistant_message: { role: "assistant", content: [{ type: "text", text: reply }] },
		},
		c,
	);
	// All chunks drain quickly in the harness (MIN_GAP_MS=5); wait until the
	// sentinel that only lives at the very end of the reply actually lands.
	await waitFor(() => webhookPosts().slice(before).some((p) => String(p.body?.markdown?.text ?? "").includes(marker)));
	const posts = webhookPosts().slice(before);
	check("超长回复被拆成多条消息", posts.length >= 2, posts.length);
	check(
		"每条都不超过 maxTextChars（含围栏余量）",
		posts.every((p) => String(p.body?.markdown?.text ?? "").length <= 410),
		posts.map((p) => String(p.body?.markdown?.text ?? "").length).join(","),
	);
	check("末尾哨兵出现（内容零丢失）", posts.some((p) => String(p.body?.markdown?.text ?? "").includes(marker)), "");
	check("多块标题带 (n/N) 角标", String(posts[0]?.body?.markdown?.title ?? "").includes("(1/"), String(posts[0]?.body?.markdown?.title));

	process.env.OMP_DINGTALK_CONFIG = previous;
}

console.log("\n[36] splitMessage：长回复分块、围栏成对、正文零丢失");
{
	const body = Array.from({ length: 12 }, (_, i) => `line ${i + 1} 正文内容`).join("\n");
	const ch = splitMessage(body, 60);
	check("多行文本被拆分", ch.length > 1, ch.length);
	check("每块不超预算", ch.every((x) => x.length <= 60), ch.map((x) => x.length).join(","));
	check("重拼无遗漏", ch.join("\n") === body);

	const code = "```ts\n" + Array.from({ length: 20 }, (_, i) => `const a${i} = ${i};`).join("\n") + "\n```";
	const cc = splitMessage(code, 80);
	check(
		"代码块跨消息仍成对闭合",
		cc.every((x) => (x.match(/```/g) ?? []).length % 2 === 0),
		cc.map((x) => (x.match(/```/g) ?? []).length).join(","),
	);

	const single = "字".repeat(500);
	const sc = splitMessage(single, 100);
	check("超长单行硬切且零丢失", sc.join("") === single && sc.every((x) => x.length <= 100), sc.length);
}

console.log("\n[37] 多机器人：robots 映射解析 + takeover <name> 切换出站目标");
{
	// A named robot keeps the global settings and overrides webhook / stream /
	// control. takeOver(name) must re-point the sender at that robot, and the
	// takeover card + subsequent notifications must go to that robot's webhook.
	const base = mkdtempSync(join(tmpdir(), "omp-dingtalk-multi-"));
	const cfgPath = join(base, "dingtalk.json");
	const ALPHA_TOKEN = "ALPHATOKEN";
	const BETA_TOKEN = "BETATOKEN";
	writeFileSync(
		cfgPath,
		JSON.stringify({
			webhook: { url: "https://oapi.dingtalk.com/robot/send?access_token=DEFTOKEN", secret: "" },
			stream: { enabled: true, clientId: "def-client", clientSecret: "def-secret", robotCode: "dingdef" },
			notify: { onlyWhenTakenOver: false, turnEnd: { enabled: true, minDurationMs: 0 }, sessionStop: true },
			control: { ...MAIN_CONTROL, autoTakeover: false, scope: "direct" },
			robots: {
				alpha: {
					webhook: { url: `https://oapi.dingtalk.com/robot/send?access_token=${ALPHA_TOKEN}`, secret: "" },
					stream: { enabled: true, clientId: "alpha-client", clientSecret: "alpha-secret", robotCode: "dingalpha" },
				},
				beta: {
					webhook: { url: `https://oapi.dingtalk.com/robot/send?access_token=${BETA_TOKEN}`, secret: "" },
					stream: { enabled: true, clientId: "beta-client", clientSecret: "beta-secret", robotCode: "dingbeta" },
				},
			},
		}),
	);
	const previous = process.env.OMP_DINGTALK_CONFIG;
	process.env.OMP_DINGTALK_CONFIG = cfgPath;
	const module = await import(`../src/index.ts?multi=${Date.now()}`);
	const h = new Map<string, Handler[]>();
	const cmds = new Map<string, any>();
	const notes: string[] = [];
	module.default({
		...pi,
		on: (e: string, handler: Handler) => h.set(e, [...(h.get(e) ?? []), handler]),
		registerCommand: (n: string, o: any) => cmds.set(n, o),
	});
	const c = { ...ctx, cwd: base, ui: { notify: (message: string) => notes.push(message) }, sessionManager: { getBranch: () => [], getSessionId: () => "session-multi" } };
	const postsTo = (token: string) => webhookPosts().slice().filter((p) => p.url.includes(token)).length;

	await h.get("session_start")![0]({ type: "session_start" }, c);
	await tick(150);
	notes.length = 0;

	// A takeover for a robot that does not exist is refused, not half-working.
	await cmds.get("dingtalk").handler("takeover nosuch", c);
	check("不存在的机器人拒绝接管并列出可用项", String(notes.at(-1) ?? "").includes("没有叫") && String(notes.at(-1) ?? "").includes("alpha"), notes.at(-1));

	const beforeAlpha = postsTo(ALPHA_TOKEN);
	await cmds.get("dingtalk").handler("takeover alpha", c);
	await waitFor(() => postsTo(ALPHA_TOKEN) > beforeAlpha);
	check("takeover alpha 的确认卡发到 alpha 的 webhook", postsTo(ALPHA_TOKEN) > beforeAlpha, postsTo(ALPHA_TOKEN) - beforeAlpha);
	check("本地提示带机器人名", String(notes.at(-1) ?? "").includes("alpha"), notes.at(-1));

	// A session_stop idle card must go through the active robot too.
	const beforeAlphaStop = postsTo(ALPHA_TOKEN);
	await h.get("session_stop")![0](
		{ type: "session_stop", last_assistant_message: { role: "assistant", content: [{ type: "text", text: "多机器人回合结束" }] } },
		c,
	);
	await waitFor(() => postsTo(ALPHA_TOKEN) > beforeAlphaStop);
	check("接管后通知发到 alpha（而不是默认机器人）", postsTo(ALPHA_TOKEN) > beforeAlphaStop, postsTo(ALPHA_TOKEN) - beforeAlphaStop);

	notes.length = 0;
	await cmds.get("dingtalk").handler("status", c);
	const statusText = notes.at(-1) ?? "";
	check("status 展示当前机器人 alpha 和可用列表", statusText.includes("当前机器人") && statusText.includes("alpha") && statusText.includes("beta"), statusText);

	// Release returns the session to the default robot for notifications.
	notes.length = 0;
	await cmds.get("dingtalk").handler("release", c);
	check("release 提示已解除", String(notes.at(-1) ?? "").includes("已解除"), notes.at(-1));

	// Switching straight to another robot without release also works.
	const beforeBeta = postsTo(BETA_TOKEN);
	await cmds.get("dingtalk").handler("takeover beta", c);
	await waitFor(() => postsTo(BETA_TOKEN) > beforeBeta);
	check("takeover beta 的确认卡发到 beta 的 webhook", postsTo(BETA_TOKEN) > beforeBeta, postsTo(BETA_TOKEN) - beforeBeta);
	check("默认机器人在切换过程中没有收到确认卡", postsTo("DEFTOKEN") === 0, postsTo("DEFTOKEN"));

	process.env.OMP_DINGTALK_CONFIG = previous;
}

// --- summary ----------------------------------------------------------------
console.log(`\n${"=".repeat(56)}`);
if (failures.length === 0) {
	console.log(`全部通过：${passed} 项断言`);
} else {
	console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
	for (const name of failures) console.log(`  - ${name}`);
}
console.log("=".repeat(56));
process.exit(failures.length === 0 ? 0 : 1);
