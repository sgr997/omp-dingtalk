/**
 * Cross-process exclusivity for the inbound Stream channel.
 *
 * DingTalk routes each message for an app to **one** of that app's live Stream
 * connections, and which one is not something the client can influence. So two
 * omp sessions sharing one app credential is not "two controllers" — it is a
 * coin flip:
 *
 *   - a `/stop` may abort a run in the *other* session;
 *   - an `同意` may be answered by a session that never asked, leaving the one
 *     that did ask to sit until its approval times out and denies.
 *
 * Note this is broken either way: if DingTalk load-balances, commands land in a
 * random session; if it broadcast, one `停止` would stop *every* session. Either
 * way the only safe model is **one live consumer per app credential**, which is
 * what this lock enforces.
 *
 * The lock is deliberately **preemptive**: running `/dingtalk takeover` in a new
 * session takes the channel over, because that is exactly what the user just
 * asked for. The previous holder notices within `HEARTBEAT_MS` and stands down
 * by itself, so the two connections never stay live for long.
 *
 * Keyed by `clientId`, not by machine: two different DingTalk apps are two
 * independent Stream subscriptions and must not block each other.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "./logger";
import { homeDir } from "./util";

export interface LockHolder {
	/** Unique per acquisition, so a stale holder can never delete the new one's lock. */
	token: string;
	pid: number;
	cwd: string;
	/** First 8 chars of the AppKey, so a human can tell which app this lock is for. */
	appKeyHint: string;
	startedAt: number;
	heartbeatAt: number;
}

export interface AcquireResult {
	ok: boolean;
	/** The holder that was displaced, when it was still alive at the time. */
	previous?: LockHolder;
	error?: string;
}

/**
 * Heartbeat period. Doubles as the preemption-detection latency: a preempted
 * session keeps its Stream open for at most this long after losing the lock.
 */
export const HEARTBEAT_MS = 5_000;
/** No heartbeat for this long ⇒ treat as dead. Backstop for PID reuse. */
const STALE_MS = 30_000;

/**
 * Effective heartbeat period.
 *
 * Read from the environment on every use rather than frozen at import time, so
 * a test (or a wrapper script) can shrink it without a rebuild. Anything below
 * 50ms is treated as a typo — a tight loop here would burn CPU in every session.
 */
export function heartbeatMs(): number {
	const raw = Number(process.env.OMP_DINGTALK_HEARTBEAT_MS);
	return Number.isFinite(raw) && raw >= 50 ? Math.floor(raw) : HEARTBEAT_MS;
}

function lockDir(): string {
	const override = process.env.OMP_DINGTALK_LOCK_DIR;
	if (override && override.trim()) return override.trim();
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	if (agentDir && agentDir.trim()) return agentDir.trim();
	return join(homeDir(), ".omp", "agent");
}

/**
 * Whether a process is still around.
 *
 * `process.kill(pid, 0)` sends no signal; on Windows it is documented as an
 * existence probe. EPERM means "exists, but owned by someone else" — still alive.
 */
function isAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export class TakeoverLock {
	#clientId: string;
	#log: Logger;
	#path: string;

	#token = "";
	#held = false;
	#cwd = "";
	#startedAt = 0;

	constructor(clientId: string, logger: Logger) {
		this.#clientId = clientId;
		this.#log = logger;
		const digest = createHash("sha1").update(clientId).digest("hex").slice(0, 12);
		this.#path = join(lockDir(), `dingtalk-takeover-${digest}.json`);
	}

	/** Where the lock lives — surfaced in diagnostics so it can be inspected by hand. */
	get path(): string {
		return this.#path;
	}

	get held(): boolean {
		return this.#held;
	}

	/** Who holds the lock right now, which may well be another process. */
	readOwner(): LockHolder | undefined {
		try {
			if (!existsSync(this.#path)) return undefined;
			const parsed = JSON.parse(readFileSync(this.#path, "utf8")) as LockHolder;
			return parsed && typeof parsed.pid === "number" ? parsed : undefined;
		} catch (error) {
			this.#log.debug("读取接管锁失败", error);
			return undefined;
		}
	}

	/**
	 * Whether a *different* live session currently holds the channel.
	 *
	 * A session that is not the holder is a bystander: pushing notifications
	 * into a conversation another session controls would give the user two
	 * interleaved streams of cards from one DingTalk account. A dead or stale
	 * holder does not count — with nobody heartbeating, the channel is free.
	 */
	heldByOther(): boolean {
		const owner = this.readOwner();
		if (!owner) return false;
		if (this.#held && owner.token === this.#token) return false;
		if (!isAlive(owner.pid)) return false;
		return Date.now() - (owner.heartbeatAt || 0) <= STALE_MS;
	}

	/**
	 * Take the lock, displacing any other holder. Never fails on contention —
	 * that is the point of the preemptive design.
	 */
	acquire(cwd: string): AcquireResult {
		const existing = this.readOwner();
		const now = Date.now();
		let previous: LockHolder | undefined;

		if (existing && !(this.#held && existing.token === this.#token)) {
			const stale = !isAlive(existing.pid) || now - (existing.heartbeatAt || 0) > STALE_MS;
			if (stale) {
				this.#log.info(`回收了失效的接管锁（PID ${existing.pid}，目录 ${existing.cwd || "?"}）`);
			} else {
				previous = existing;
			}
		}

		this.#token = randomBytes(8).toString("hex");
		this.#cwd = cwd;
		this.#startedAt = now;
		this.#held = true;
		this.#write();

		return { ok: true, previous };
	}

	/**
	 * Refresh our claim. Returns the new holder when someone else took the lock
	 * from us, in which case we are no longer the holder and must stand down.
	 */
	heartbeat(): LockHolder | undefined {
		if (!this.#held) return undefined;

		const owner = this.readOwner();
		if (!owner) {
			// The file was removed out from under us (manual delete, or a race with
			// someone else's release). Claim it again rather than silently dropping
			// control — nothing else is holding it.
			this.#log.debug("接管锁文件丢失，重新写入");
			this.#write();
			return undefined;
		}
		if (owner.token !== this.#token) {
			this.#held = false;
			return owner;
		}

		this.#write();
		return undefined;
	}

	/** Give up the lock. Only removes the file while it is still ours. */
	release(): void {
		if (!this.#held) return;
		this.#held = false;
		try {
			const owner = this.readOwner();
			// Never delete a lock a preemptor has already taken.
			if (owner && owner.token !== this.#token) return;
			rmSync(this.#path, { force: true });
		} catch (error) {
			this.#log.debug("释放接管锁失败", error);
		}
	}

	#write(): void {
		try {
			mkdirSync(lockDir(), { recursive: true });
			const holder: LockHolder = {
				token: this.#token,
				pid: process.pid,
				cwd: this.#cwd,
				appKeyHint: this.#clientId.slice(0, 8),
				startedAt: this.#startedAt,
				heartbeatAt: Date.now(),
			};
			writeFileSync(this.#path, `${JSON.stringify(holder, null, 2)}\n`);
		} catch (error) {
			// A lock we cannot persist must not crash the session; the stream is
			// still guarded by `takenOver` inside this process.
			this.#log.warn("写入接管锁失败", error);
		}
	}
}
