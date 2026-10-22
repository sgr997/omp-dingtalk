import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function run(name: string): string {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("DINGTALK_") || key.startsWith("OMP_DINGTALK_")) delete env[key];
	}
	const file = fileURLToPath(new URL(`./regressions/${name}.ts`, import.meta.url));
	const result = spawnSync(process.execPath, [file], { env, encoding: "utf8", timeout: 10_000 });
	expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
	return result.stdout;
}

test("release cancels queued inbound callbacks and compact waiting on a reply", () => {
	const out = run("omp-release-review");
	expect(out).toContain('"takenOver":false,"sent":[]');
	expect(out).toContain('"takenOver":false,"compacts":0');
});

test("foreign status preserves the owner ctx, and release cancels queued model notifications", () => {
	const out = run("omp-state-review");
	expect(out).toContain('"aborts":["session-A"]');
	expect(out).toContain('"stillBoundToA":true');
	expect(out).toContain('"robot":"robot-B","token":"TOKEN:app-B"');
	expect(out).toContain('MODEL_TOOL_AFTER_RELEASE {"result":{"sent":false');
	expect(out).not.toContain('"messages":["queued model tool"]');
});

test("release cancels a control reply still in the outbound queue", () => {
	expect(run("omp-send-release-review")).not.toContain('"released":true');
});

test("a heartbeat cannot overwrite a later successful takeover", () => {
	const out = run("omp-lock-race-review");
	expect(out).toContain("final owner: B");
	expect(out).not.toContain("B next heartbeat preempted by: A");
});

test("a new owner cannot approve the previous session's tool call", () => {
	const out = run("omp-review-pending");
	expect(out).toContain('"oldSessionBlocked":true');
	expect(out).toContain('"newSessionSameCallBlocked":true');
	expect(out).not.toContain('待审批**: 1');
});

test("host abort cancels both sides of ask and removes pending remote questions", () => {
	const out = run("omp-review-ask-abort");
	expect(out).toContain('"localAborted":true');
	expect(out).toContain('"pendingRemote":0');
	expect(out).toContain('"toolSettled":true');
});

test("a named robot missing its secret refuses takeover without a lock", () => {
	const out = run("omp-review-named-creds");
	expect(out).toContain('"ok":false');
	expect(out).toContain('"takenOver":false');
	expect(out).not.toContain('"held":true');
});

test("a misspelled named scope falls back to direct and rejects group prompts", () => {
	expect(run("omp-review-named-scope")).toContain('"namedScope":"direct","groupPromptDelivered":0');
});

test("explicit release silences future notifications with the default config on independent machines", () => {
	expect(run("omp-explicit-release")).toContain("explicit release:");
});

test("release confirmation keeps its original robot without resuming automatic pushes", () => {
	expect(run("omp-release-receipt")).toContain("release receipts:");
});
