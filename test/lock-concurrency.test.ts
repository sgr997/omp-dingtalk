import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TakeoverLock } from "../src/core/lock";

const log = { debug() {}, info() {}, warn() {}, error() {} };

test("a paused heartbeat in another process cannot overwrite or delete a later claim", async () => {
	const scratch = mkdtempSync(join(tmpdir(), "omp-lock-process-"));
	const ready = join(scratch, "ready");
	const resume = join(scratch, "resume");
	const oldDir = process.env.OMP_DINGTALK_LOCK_DIR;
	process.env.OMP_DINGTALK_LOCK_DIR = scratch;
	const modulePath = new URL("../src/core/lock.ts", import.meta.url).href;
	const script = `
		import { mock } from "bun:test";
		import * as fs from "node:fs";
		const original = { ...fs };
		let pause = false;
		mock.module("node:fs", () => ({ ...original, renameSync(from, to) {
			if (pause) {
				pause = false;
				original.writeFileSync(${JSON.stringify(ready)}, "ready");
				const deadline = Date.now() + 3000;
				while (!original.existsSync(${JSON.stringify(resume)})) {
					if (Date.now() > deadline) throw new Error("timed out waiting for second process");
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
				}
			}
			return original.renameSync(from, to);
		} }));
		const { TakeoverLock } = await import(${JSON.stringify(modulePath)});
		const log = { debug() {}, info() {}, warn() {}, error() {} };
		const a = new TakeoverLock("process-race", log);
		if (!a.acquire("A").ok) throw new Error("A could not acquire");
		pause = true;
		a.heartbeat();
		a.release();
	`;
	const worker = Bun.spawn([process.execPath, "-e", script], {
		env: { ...process.env, OMP_DINGTALK_LOCK_DIR: scratch },
		stdout: "pipe", stderr: "pipe",
	});
	const b = new TakeoverLock("process-race", log);
	try {
		const deadline = Date.now() + 3000;
		while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(5);
		expect(existsSync(ready)).toBe(true);
		expect(b.acquire("B").ok).toBe(true);
		writeFileSync(resume, "resume");
		expect(await worker.exited, await new Response(worker.stderr).text()).toBe(0);
		expect(b.readOwner()?.cwd).toBe("B");
		expect(b.isOwner()).toBe(true);
		expect(b.heartbeat()).toBeUndefined();
		b.release();
		expect(b.readOwner()).toBeUndefined();
	} finally {
		worker.kill();
		await worker.exited;
		b.release();
		if (oldDir === undefined) delete process.env.OMP_DINGTALK_LOCK_DIR;
		else process.env.OMP_DINGTALK_LOCK_DIR = oldDir;
		rmSync(scratch, { recursive: true, force: true });
	}
});
