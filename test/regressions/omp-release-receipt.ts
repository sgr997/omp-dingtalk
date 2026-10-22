import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "omp-release-receipt-"));
process.env.OMP_DINGTALK_CONFIG = join(scratch, "config.json");
process.env.OMP_DINGTALK_LOCK_DIR = join(scratch, "locks");
process.env.OMP_DINGTALK_MIN_GAP_MS = "1";
process.env.OMP_DINGTALK_MAX_PER_MIN = "1000";
writeFileSync(process.env.OMP_DINGTALK_CONFIG, JSON.stringify({
	webhook: { url: "https://mock.invalid/default" },
	stream: { enabled: true, clientId: "default-app", clientSecret: "fake", robotCode: "default-robot" },
	control: { allowUserId: "default-user" },
	robots: { home: { outbound: { mode: "direct" },
		stream: { clientId: "home-app", robotCode: "home-robot" }, control: { allowUserId: "home-user" } } },
}));
const requests: Array<{ url: string; body: any; token?: string; title: string }> = [];
let hold = false;
let failReceipt = false;
let unblock: (() => void) | undefined;
globalThis.fetch = (async (input, init) => {
	const url = String(input);
	const body = JSON.parse(String(init?.body));
	if (url.includes("/gateway/")) return new Response(JSON.stringify({ endpoint: "wss://mock.invalid", ticket: "fake" }));
	if (url.includes("/oauth2/")) return new Response(JSON.stringify({ accessToken: `token:${body.appKey}`, expireIn: 7200 }));
	const title = body.msgParam ? JSON.parse(body.msgParam).title : body.markdown.title;
	requests.push({ url, body, title, token: new Headers(init?.headers).get("x-acs-dingtalk-access-token") ?? undefined });
	if (title === "blocker" && hold) {
		hold = false;
		await new Promise<void>((resolve) => { unblock = resolve; });
	}
	return failReceipt && title.includes("解除接管") ? new Response("mock send failed", { status: 500 }) : new Response(JSON.stringify({ errcode: 0 }));
}) as typeof fetch;
class Socket {
	readyState = 1;
	onclose?: () => void;
	constructor(_url: string) {}
	send() {}
	close() { this.readyState = 3; this.onclose?.(); }
}
globalThis.WebSocket = Socket as any;
const { Bridge } = await import("../../src/core/bridge");
const { dingtalkAdapter } = await import("../../src/platforms/dingtalk/adapter");
const { TakeoverLock } = await import("../../src/core/lock");
const log = { debug() {}, info() {}, warn() {}, error() {} };
const bridge = new Bridge({ sendUserMessage() {}, logger: log } as any, scratch, dingtalkAdapter);
bridge.bindSession("owner", { cwd: scratch });
const receipts = () => requests.filter((request) => request.title.includes("解除接管"));
async function occupyQueue(): Promise<{ pending: Promise<unknown>; resume: () => void }> {
	unblock = undefined;
	hold = true;
	const pending = bridge.sender.send({ title: "blocker", text: "blocker" });
	const deadline = Date.now() + 1000;
	while (!unblock && Date.now() < deadline) await Bun.sleep(1);
	assert.ok(unblock, "blocking request should have started");
	return { pending, resume: unblock! };
}

assert.equal(bridge.takeOver("home").ok, true);
const busy = await occupyQueue();
const released = bridge.release({ stopNotifications: true, confirm: true });
assert.equal(bridge.takenOver, false, "release takes effect before the outbound queue is unblocked");
assert.equal(bridge.notificationsReleased, true);
assert.equal(bridge.activeRobotName, "default");
assert.equal(bridge.release({ stopNotifications: true, confirm: true }).confirmation, undefined, "repeat release does not enqueue a second receipt");
bridge.notify({ title: "must not send", text: "must not send" }, { bypassQuiet: true });
busy.resume();
await busy.pending;
assert.equal((await released.confirmation)?.ok, true, "queued receipt survives repeated release");
assert.equal(receipts().length, 1);
assert.equal(receipts()[0].body.robotCode, "home-robot");
assert.deepEqual(receipts()[0].body.userIds, ["home-user"]);
assert.equal(receipts()[0].token, "token:home-app");
assert.equal(requests.filter((request) => request.url.includes("/default")).length, 0, "receipt must not leak to the default robot");
assert.equal(requests.filter((request) => request.title === "must not send").length, 0);

assert.equal(bridge.takeOver("home").ok, true);
failReceipt = true;
const failed = bridge.release({ stopNotifications: true, confirm: true });
assert.equal((await failed.confirmation)?.ok, false);
assert.equal(bridge.notificationsReleased, true, "send failure must not undo release");
assert.equal(bridge.takenOver, false);
failReceipt = false;

assert.equal(bridge.takeOver("home").ok, true);
const blocked = await occupyQueue();
const before = receipts().length;
const stale = bridge.release({ stopNotifications: true, confirm: true });
const other = new TakeoverLock("home-app", log);
assert.equal(other.acquire("new-owner").ok, true);
blocked.resume();
await blocked.pending;
assert.equal((await stale.confirmation)?.dropped, true, "a newer local owner invalidates an unsent receipt");
assert.equal(receipts().length, before);
other.release();
bridge.dispose("test complete");
console.log("release receipts: original robot, shared queue, immediate stop, idempotency, send failure and preemption verified");
