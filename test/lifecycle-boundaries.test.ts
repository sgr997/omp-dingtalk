import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge } from "../src/core/bridge";
import type { ChannelSender, SendOptions } from "../src/core/channel";
import { dingtalkAdapter } from "../src/platforms/dingtalk/adapter";
import { loadConfig } from "../src/platforms/dingtalk/config";
import { DingTalkSender } from "../src/platforms/dingtalk/sender";
import { TakeoverLock } from "../src/core/lock";

const log = { debug() {}, info() {}, warn() {}, error() {} };
function fixture() {
	const scratch = mkdtempSync(join(tmpdir(), "omp-boundary-"));
	const previous = { config: process.env.OMP_DINGTALK_CONFIG, locks: process.env.OMP_DINGTALK_LOCK_DIR };
	process.env.OMP_DINGTALK_CONFIG = join(scratch, "config.json");
	process.env.OMP_DINGTALK_LOCK_DIR = join(scratch, "locks");
	const config = {
		outbound: { mode: "direct" },
		stream: { enabled: true, clientId: "boundary-A", clientSecret: "fake", robotCode: "robot-A" },
		control: { enabled: true, allowUserId: "staff" },
	};
	const write = (value: unknown) => writeFileSync(process.env.OMP_DINGTALK_CONFIG!, JSON.stringify(value));
	write(config);
	return { scratch, config, write, cleanup() {
		for (const [key, value] of [["OMP_DINGTALK_CONFIG", previous.config], ["OMP_DINGTALK_LOCK_DIR", previous.locks]]) {
			if (value === undefined) delete process.env[key!];
			else process.env[key!] = value;
		}
		rmSync(scratch, { recursive: true, force: true });
	} };
}

test("a late token response from A cannot poison B's cache", async () => {
	const f = fixture();
	const originalFetch = globalThis.fetch;
	let resolveA!: (value: Response) => void;
	const tokens: string[] = [];
	const tokenApps: string[] = [];
	const response = (data: unknown) => new Response(JSON.stringify(data));
	globalThis.fetch = (async (url, init) => {
		const body = JSON.parse(String(init?.body));
		if (String(url).includes("/oauth2/")) {
			tokenApps.push(body.appKey);
			if (body.appKey === "boundary-A") return await new Promise<Response>((resolve) => { resolveA = resolve; });
			return response({ accessToken: "token-B", expireIn: 7200 });
		}
		tokens.push(new Headers(init?.headers).get("x-acs-dingtalk-access-token")!);
		return response({});
	}) as typeof fetch;
	try {
		const a = loadConfig(f.scratch).config;
		const b = { ...a, stream: { ...a.stream, clientId: "boundary-B", robotCode: "robot-B" } };
		const sender = new DingTalkSender(a, log);
		const oldRequest = sender.sendEmotion({ msgId: "m", conversationId: "c" }, "👀");
		sender.updateConfig(b);
		expect((await sender.sendEmotion({ msgId: "m", conversationId: "c" }, "👀")).ok).toBe(true);
		resolveA(response({ accessToken: "token-A", expireIn: 7200 }));
		expect((await oldRequest).dropped).toBe(true);
		expect((await sender.send({ title: "B", text: "B" })).ok).toBe(true);
		expect(tokenApps).toEqual(["boundary-A", "boundary-B"]);
		expect(tokens).toEqual(["token-B", "token-B"]);
	} finally {
		globalThis.fetch = originalFetch;
		f.cleanup();
	}
});

test("host cancellation invalidates the question card still waiting in the queue", async () => {
	const f = fixture();
	const queued: SendOptions[] = [];
	const sender: ChannelSender = {
		configured: true, recipientCount: 1,
		stats: { queued: 0, delivered: 0, dropped: 0, failed: 0 },
		updateConfig() {}, enqueue(message) { queued.push(message); },
		async send() { return { ok: true }; },
	};
	const adapter = { ...dingtalkAdapter, createSender: () => sender,
		createStream: () => ({ start() {}, stop() {}, status: () => ({ state: "registered" as const, reconnects: 0 }) }),
	};
	const bridge = new Bridge({ sendUserMessage() {}, logger: log } as any, f.scratch, adapter);
	try {
		expect(bridge.takeOver().ok).toBe(true);
		const controller = new AbortController();
		const pending = bridge.runAskRace({ signal: controller.signal,
			questions: [{ id: "q", question: "Choose", options: [{ label: "A" }, { label: "B" }], multi: false }],
			runLocal: (signal) => new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
		}).catch(() => undefined);
		await Bun.sleep(1);
		expect(queued.length).toBe(1);
		expect(queued[0].isStillValid?.()).toBe(true);
		controller.abort();
		await pending;
		expect(bridge.questions.size).toBe(0);
		expect(queued[0].isStillValid?.()).toBe(false);
	} finally {
		bridge.dispose("test complete");
		f.cleanup();
	}
});

test("disabling control on reload releases the current claim and pending work", () => {
	const f = fixture();
	const adapter = { ...dingtalkAdapter,
		createStream: () => ({ start() {}, stop() {}, status: () => ({ state: "registered" as const, reconnects: 0 }) }),
	};
	const bridge = new Bridge({ sendUserMessage() {}, logger: log } as any, f.scratch, adapter);
	try {
		expect(bridge.takeOver().ok).toBe(true);
		bridge.approvals.register({ toolName: "bash", key: "old", reason: "test", detail: "test", timeoutMs: 10_000, onTimeout: "deny" });
		f.write({ ...f.config, control: { ...f.config.control, enabled: false } });
		expect(bridge.refreshConfig()).toBe(true);
		expect(bridge.takenOver).toBe(false);
		expect(bridge.lock?.readOwner()).toBeUndefined();
		expect(bridge.approvals.size).toBe(0);
	} finally {
		bridge.dispose("test complete");
		f.cleanup();
	}
});

test("ask started after preemption falls back locally before the next heartbeat", async () => {
	const f = fixture();
	const adapter = { ...dingtalkAdapter,
		createStream: () => ({ start() {}, stop() {}, status: () => ({ state: "registered" as const, reconnects: 0 }) }),
	};
	const bridge = new Bridge({ sendUserMessage() {}, logger: log } as any, f.scratch, adapter);
	const other = new TakeoverLock("boundary-A", log);
	try {
		expect(bridge.takeOver().ok).toBe(true);
		expect(other.acquire("B").ok).toBe(true);
		let localStarted = false;
		const result = await Promise.race([
			bridge.runAskRace({ questions: [{ id: "q", question: "Choose", options: [], multi: false }],
				runLocal: () => { localStarted = true; return new Promise(() => {}); } }),
			Bun.sleep(20).then(() => "pending"),
		]);
		expect(result).toBeUndefined();
		expect(localStarted).toBe(false);
		expect(bridge.questions.size).toBe(0);
	} finally {
		bridge.dispose("test complete");
		other.release();
		f.cleanup();
	}
});
