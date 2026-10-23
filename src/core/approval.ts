/**
 * ApprovalRegistry: holds in-flight remote-approval requests until a channel
 * reply settles them. Platform-neutral — the channel merely feeds decisions
 * in via `resolve` / `clear`.
 *
 * The tricky contract: OMP aborts a `tool_call` handler after a short timeout
 * and blocks the call, so a reply arriving later can no longer release it.
 * Registering and returning `{ block: true }` right away keeps the approval
 * window equal to `timeoutMs`; once the user approves, the model re-issues the
 * call and `consumeApproved` releases it exactly once.
 */
import type { Logger } from "./logger";
import { shortId } from "./util";
import type { ApprovalDecision, PendingApproval } from "./approval-types";

interface PendingEntry extends PendingApproval {
	/** Matches a re-issued call against the approval that released it. */
	key: string;
	/** How long the one-shot release stays valid after approval. */
	timeoutMs: number;
}

/** Drop the internal bookkeeping fields before handing an entry to callers. */
function publicApproval(entry: PendingEntry): PendingApproval {
	const { key: _key, timeoutMs: _timeoutMs, ...rest } = entry;
	return rest;
}

export class ApprovalRegistry {
	#log: Logger;
	#pending = new Map<string, PendingEntry>();
	#latest: string | undefined;
	/**
	 * Called whenever a pending request is settled by an explicit reply, so the
	 * bridge can close the competing local dialog. `by` names the surface that
	 * answered ("remote" for the channel router, "local" for the TUI dialog).
	 */
	#onSettled: ((approval: PendingApproval, decision: "approve" | "deny", by: string) => void) | undefined;
	/**
	 * Payload keys the user approved; released once on the next matching call.
	 * Values are expiry timestamps — a release the model never picked up must
	 * not stay valid indefinitely, or a much later call with identical
	 * arguments would run without a fresh approval.
	 */
	#approved = new Map<string, number>();
	/**
	 * Requests whose `tool_call` handler is still awaiting a dual-surface race.
	 * A channel reply settles that handler directly, so the router must not also
	 * inject a follow-up message for it.
	 */
	#racing = new Set<string>();

	constructor(logger: Logger, onSettled?: (approval: PendingApproval, decision: "approve" | "deny", by: string) => void) {
		this.#log = logger;
		this.#onSettled = onSettled;
	}

	/** Mark a request as having a live handler awaiting the race. */
	markRacing(id: string): void {
		this.#racing.add(id);
	}

	unmarkRacing(id: string): void {
		this.#racing.delete(id);
	}

	get size(): number {
		return this.#pending.size;
	}

	has(id: string): boolean {
		return this.#pending.has(id);
	}

	list(): PendingApproval[] {
		return [...this.#pending.values()].map((entry) => publicApproval(entry));
	}

	register(options: {
		toolName: string;
		reason: string;
		detail: string;
		key: string;
		timeoutMs: number;
		onTimeout: "deny" | "allow";
		onRequested?: (approval: PendingApproval) => void;
		onExpired?: (approval: PendingApproval, decision: ApprovalDecision) => void;
		duplicate?: (approval: PendingApproval) => void;
	}): PendingApproval {
		const existing = this.#findByKey(options.key);
		if (existing) {
			options.duplicate?.(publicApproval(existing));
			return publicApproval(existing);
		}
		const id = this.#uniqueId();
		const entry: PendingEntry = {
			id,
			key: options.key,
			timeoutMs: Math.max(5_000, options.timeoutMs),
			toolName: options.toolName,
			reason: options.reason,
			detail: options.detail,
			createdAt: Date.now(),
		};
		this.#pending.set(id, entry);
		this.#latest = id;

		const timer = setTimeout(() => {
			if (!this.#pending.delete(id)) return;
			if (this.#latest === id) this.#latest = undefined;
			const decision: ApprovalDecision = options.onTimeout === "allow" ? "approve" : "timeout";
			this.#log.info(`审批 ${id} 超时，按 ${options.onTimeout} 处理`);
			if (decision === "approve") this.#approved.set(entry.key, Date.now() + entry.timeoutMs);
			options.onExpired?.(publicApproval(entry), decision);
		}, entry.timeoutMs);
		timer.unref?.();

		options.onRequested?.(publicApproval(entry));
		return publicApproval(entry);
	}

	/** Release a previously approved call exactly once, before its expiry. */
	consumeApproved(key: string): boolean {
		const expiresAt = this.#approved.get(key);
		if (expiresAt === undefined) return false;
		this.#approved.delete(key);
		return Date.now() <= expiresAt;
	}

	/** Settle a request by explicit id, or the most recent one when id is omitted. */
	resolve(target: string | undefined, decision: "approve" | "deny", by = "remote"): { ok: boolean; approval?: PendingApproval; error?: string; racing?: boolean } {
		const id = (target ?? "").trim().toUpperCase() || this.#latest;
		if (!id) return { ok: false, error: "当前没有待审批的请求" };
		const entry = this.#pending.get(id);
		if (!entry) {
			const known = [...this.#pending.keys()];
			return { ok: false, error: known.length ? `找不到编号 ${id}，当前待审批：${known.join(", ")}` : `找不到编号 ${id}` };
		}
		const racing = this.#racing.has(id);
		this.#pending.delete(id);
		if (this.#latest === id) this.#latest = undefined;
		if (decision === "approve") this.#approved.set(entry.key, Date.now() + entry.timeoutMs);
		const approval = publicApproval(entry);
		this.#onSettled?.(approval, decision, by);
		return { ok: true, approval, racing };
	}

	/** Drop every pending request — used when the session goes away. */
	clear(reason: string): void {
		for (const entry of this.#pending.values()) {
			this.#log.info(`审批 ${entry.id} 因 ${reason} 自动拒绝`);
		}
		this.#pending.clear();
		this.#latest = undefined;
		this.#approved.clear();
	}

	#findByKey(key: string): PendingEntry | undefined {
		for (const entry of this.#pending.values()) if (entry.key === key) return entry;
		return undefined;
	}

	#uniqueId(): string {
		for (let i = 0; i < 50; i += 1) {
			const id = shortId();
			if (!this.#pending.has(id)) return id;
		}
		return `${shortId()}${shortId()}`;
	}
}

export type { ApprovalDecision, PendingApproval };
