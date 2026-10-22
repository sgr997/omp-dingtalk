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
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
	/** v2 claims renew a per-token lease; the shared claim is acquisition-only. */
	lease?: boolean;
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

	/** Revalidate ownership at the boundary of an inbound/outbound side effect. */
	isOwner(): boolean {
		if (!this.#held) return false;
		try {
			return this.#readOwnerStrict()?.token === this.#token;
		} catch {
			return false;
		}
	}

	#leasePath(token = this.#token): string {
		return `${this.#path}.${token}.lease`;
	}

	/** Who holds the lock right now, which may well be another process. */
	readOwner(): LockHolder | undefined {
		try {
			return this.#readOwnerStrict();
		} catch (error) {
			this.#log.debug("读取接管锁失败", error);
			return undefined;
		}
	}

	/** Distinguish a missing lock from one that cannot be read safely. */
	#readOwnerStrict(): LockHolder | undefined {
		let contents: string;
		try {
			contents = readFileSync(this.#path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(contents);
		} catch {
			throw new Error("接管锁文件格式无效");
		}
		if (
			!parsed ||
			typeof parsed !== "object" ||
			typeof (parsed as LockHolder).token !== "string" ||
			typeof (parsed as LockHolder).pid !== "number" ||
			typeof (parsed as LockHolder).cwd !== "string" ||
			typeof (parsed as LockHolder).appKeyHint !== "string" ||
			typeof (parsed as LockHolder).startedAt !== "number" ||
			typeof (parsed as LockHolder).heartbeatAt !== "number"
		) {
			throw new Error("接管锁文件格式无效");
		}
		const holder = parsed as LockHolder;
		if (!holder.lease) return holder; // Legacy lock files remain readable.
		if (!/^[a-f0-9]{16}$/.test(holder.token)) throw new Error("接管锁 token 无效");
		let lease: LockHolder;
		try {
			lease = JSON.parse(readFileSync(this.#leasePath(holder.token), "utf8")) as LockHolder;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		if (lease.token !== holder.token || lease.pid !== holder.pid || !Number.isFinite(lease.heartbeatAt)) {
			throw new Error("接管续期文件格式无效");
		}
		return { ...holder, heartbeatAt: lease.heartbeatAt };
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
		let owner: LockHolder | undefined;
		try {
			owner = this.#readOwnerStrict();
		} catch (error) {
			this.#log.debug("读取接管锁失败，按已占用处理", error);
			return true;
		}
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
		let existing: LockHolder | undefined;
		try {
			existing = this.#readOwnerStrict();
		} catch (error) {
			this.#log.warn("无法安全读取接管锁，拒绝接管", error);
			return { ok: false, error: "无法安全读取接管锁文件；为避免多个会话同时连接，已拒绝接管" };
		}
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

		const oldToken = this.#token;
		this.#token = randomBytes(8).toString("hex");
		this.#cwd = cwd;
		this.#startedAt = now;
		this.#held = true;
		if (!this.#write(this.#leasePath()) || !this.#write(this.#path, true)) {
			this.#removeLease();
			if (oldToken) this.#removeLease(oldToken);
			this.#held = false;
			this.#token = "";
			return { ok: false, error: "无法写入接管锁文件；请检查锁目录权限" };
		}
		if (oldToken) this.#removeLease(oldToken);

		return { ok: true, previous };
	}

	/**
	 * Refresh our claim. Returns the new holder when someone else took the lock
	 * from us, in which case we are no longer the holder and must stand down.
	 */
	heartbeat(): LockHolder | undefined {
		if (!this.#held) return undefined;

		const owner = this.#readOwnerStrict();
		if (!owner) {
			throw new Error("接管锁已丢失，必须重新显式接管");
		}
		if (owner.token !== this.#token) {
			this.#held = false;
			this.#removeLease();
			return owner;
		}

		// A preemptor may replace the shared claim after the read above. Updating
		// only our unique lease can never overwrite that preemptor's claim.
		if (!this.#write(this.#leasePath())) throw new Error("无法续期接管锁");
		return undefined;
	}

	/** Revocation removes only this acquisition's lease, never the shared claim. */
	release(): void {
		this.#held = false;
		this.#removeLease();
	}

	#removeLease(token = this.#token): void {
		if (!token) return;
		try {
			rmSync(this.#leasePath(token), { force: true });
		} catch (error) {
			this.#log.warn("释放接管续期文件失败", error);
		}
	}

	#write(path: string, lease = false): boolean {
		let tempPath: string | undefined;
		try {
			mkdirSync(lockDir(), { recursive: true });
			const holder: LockHolder = {
				token: this.#token,
				pid: process.pid,
				cwd: this.#cwd,
				appKeyHint: this.#clientId.slice(0, 8),
				startedAt: this.#startedAt,
				heartbeatAt: Date.now(),
				...(lease ? { lease: true } : {}),
			};
			tempPath = `${path}.${process.pid}.${this.#token}.tmp`;
			writeFileSync(tempPath, `${JSON.stringify(holder, null, 2)}\n`, { flag: "wx" });
			renameSync(tempPath, path);
			return true;
		} catch (error) {
			if (tempPath) {
				try {
					rmSync(tempPath, { force: true });
				} catch {
					// Preserve the original persistence error.
				}
			}
			this.#log.warn("写入接管锁失败", error);
			return false;
		}
	}
}
