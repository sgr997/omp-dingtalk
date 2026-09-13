/**
 * Remote question registry.
 *
 * OMP's `ask` tool is a TUI dialog: it blocks the turn until someone at the
 * terminal answers. When DingTalk has taken over, nobody is at the terminal, so
 * the turn would hang forever. The `tool_call` gate intercepts the call,
 * pushes the questions to DingTalk and blocks the call (its reason text tells
 * the model to wait). This registry holds the in-flight questions until a
 * DingTalk reply settles them; an answer is injected back into the session as
 * a user message by the router.
 *
 * The registry analogues ApprovalRegistry: replies are matched by a short id,
 * or by the "latest asked" rule, and a timeout tells the agent to move on.
 */
import type { Logger } from "./logger";
import { shortId } from "./util";

export interface RemoteQuestionOption {
	label: string;
	description?: string;
}

export interface RemoteQuestion {
	id: string;
	question: string;
	header?: string;
	options: RemoteQuestionOption[];
	multi: boolean;
	recommended?: number;
}

export interface PendingQuestion {
	id: string;
	questions: RemoteQuestion[];
	createdAt: number;
	hash: string;
	timeoutMs: number;
}

export interface QuestionAnswerItem {
	id: string;
	question: string;
	options: string[];
	multi: boolean;
	selectedOptions: string[];
	customInput?: string;
}

export interface QuestionAnswerPayload {
	id: string;
	items: QuestionAnswerItem[];
	answeredBy: string;
	raw: string;
}

export interface QuestionAnswerResult {
	ok: true;
	answer: QuestionAnswerPayload;
}

interface PendingEntry extends PendingQuestion {
	settle: (answer: QuestionAnswerPayload) => void;
	onTimeout: (question: PendingQuestion) => void;
}

/**
 * Parse a DingTalk reply into per-question answers.
 *
 * Formats (whitespace-insensitive, `/answer` prefix optional):
 *  - one question, options: `2`, `1,3`, `1 3`, an option label, or free text
 *    (custom answer). A multi question accepts a comma/space list.
 *  - multiple questions: `1:2 2:1,3` — question number, colon, option
 *    numbers. Numbers past the first question refer to the first unanswered
 *    question. Without an explicit `n:` and there are multiple questions, the
 *    reply must carry one `n:` entry per unanswered question or be a
 *    single `*:…` free-text answer to the first unanswered one.
 *
 * Returns the parsed items (with `selectedOptions` as option labels) so the
 * caller can echo them back and forward them to the agent.
 */
export function parseQuestionAnswer(
	raw: string,
	pending: PendingQuestion,
): { ok: true; items: QuestionAnswerItem[] } | { ok: false; error: string } {
	const text = String(raw ?? "")
		.trim()
		.replace(/^\/answer\s+/i, "")
		.trim();
	if (!text) return { ok: false, error: "回答不能为空。" };

	// Only the newest pending question is answerable by bare text. Older ones
	// must be addressed explicitly (`n:…`), which `resolve` filters for.
	const questions = pending.questions;

	if (questions.length === 1) {
		const question = questions[0]!;
		const parsed = parseOne(text, question);
		if (!parsed.ok) return parsed;
		return {
			ok: true,
			items: [
				{
					id: question.id,
					question: question.question,
					options: question.options.map((o) => o.label),
					multi: question.multi,
					selectedOptions: parsed.selectedOptions,
					customInput: parsed.customInput,
				},
			],
		};
	}

	// Multi-question replies must be explicit about which question is which.
	const tokens = text.split(/[\s;]+/).map((t) => t.trim()).filter(Boolean);
	if (tokens.length === 0) return { ok: false, error: "回答不能为空。" };

	const items: QuestionAnswerItem[] = [];
	const used = new Set<number>();
	for (const token of tokens) {
		const match = /^(\d+)\s*[:：]\s*(.*)$/.exec(token);
		if (!match) {
			return {
				ok: false,
				error:
					"有多个问题，请用「问题号:选项号」逐条回答，例如 `1:2 2:1`；选项写在冒号后用逗号分隔（多选）。",
			};
		}
		const qIndex = Number(match[1]) - 1;
		if (qIndex < 0 || qIndex >= questions.length) {
			return { ok: false, error: `问题号 ${match[1]} 不存在（共 ${questions.length} 个问题）。` };
		}
		if (used.has(qIndex)) return { ok: false, error: `问题 ${match[1]} 回答了两次。` };
		used.add(qIndex);
		const question = questions[qIndex]!;
		const parsed = parseOne(match[2], question);
		if (!parsed.ok) return parsed;
		items.push({
			id: question.id,
			question: question.question,
			options: question.options.map((o) => o.label),
			multi: question.multi,
			selectedOptions: parsed.selectedOptions,
			customInput: parsed.customInput,
		});
	}
	if (items.length === 0) return { ok: false, error: "没有解析到任何回答。" };
	return { ok: true, items };
}

function parseOne(
	text: string,
	question: RemoteQuestion,
): { ok: true; selectedOptions: string[]; customInput?: string } | { ok: false; error: string } {
	const trimmed = text.trim();
	if (!trimmed) return { ok: false, error: "回答不能为空。" };

	// Could still be `1:2` when there is a single question.
	if (question.options.length === 0) {
		return { ok: true, selectedOptions: [], customInput: trimmed };
	}

	// Option label match wins over everything (exact, case/space-insensitive).
	const labelHit = question.options.find(
		(o) => normalizeLabel(o.label) === normalizeLabel(trimmed),
	);
	if (labelHit) return { ok: true, selectedOptions: [labelHit.label] };

	// Numbered selection: `2`, `1,3`, `1 3`, `n:2`.
	const stripQ = /^\d+\s*[:：]\s*(.*)$/.exec(trimmed);
	const numPart = stripQ ? stripQ[1].trim() : trimmed;
	if (/^[\d,，\s]+$/.test(numPart)) {
		const indices = numPart.split(/[,，\s]+/).filter(Boolean).map((n) => Number(n) - 1);
		if (indices.some((i) => Number.isNaN(i) || i < 0 || i >= question.options.length)) {
			return { ok: false, error: `选项编号超出范围（可选 1-${question.options.length}）。` };
		}
		const unique = [...new Set(indices)];
		if (!question.multi && unique.length > 1) {
			return { ok: false, error: "这是单选问题，只能选一个选项。" };
		}
		return { ok: true, selectedOptions: unique.map((i) => question.options[i]!.label) };
	}

	// Anything else is a custom free-text answer.
	return { ok: true, selectedOptions: [], customInput: trimmed };
}

function normalizeLabel(label: string): string {
	return label.replace(/\s+/g, "").toLowerCase();
}

/** Stable identity of a question set, used to not push the same ask twice. */
export function hashQuestions(questions: RemoteQuestion[]): string {
	const flat = questions.map((q) => ({
		id: q.id,
		question: q.question,
		options: q.options.map((o) => o.label),
		multi: q.multi,
	}));
	return JSON.stringify(flat);
}

export class QuestionRegistry {
	#log: Logger;
	#pending = new Map<string, PendingEntry>();
	#latest: string | undefined;

	constructor(logger: Logger) {
		this.#log = logger;
	}

	get size(): number {
		return this.#pending.size;
	}

	list(): PendingQuestion[] {
		return [...this.#pending.values()].map(({ settle: _s, onTimeout: _t, ...rest }) => rest);
	}

	/**
	 * Register a question set and arm its timeout. Always resolves — on timeout
	 * `onTimeout` runs (the agent is told to move on, never left blocked).
	 */
	register(options: {
		questions: RemoteQuestion[];
		hash: string;
		timeoutMs: number;
		onTimeout: (question: PendingQuestion) => void;
		onRegistered?: (question: PendingQuestion) => void;
		duplicate?: (existing: PendingQuestion) => void;
	}): PendingQuestion {
		// Same question asked again while still pending: reuse the existing entry.
		for (const entry of this.#pending.values()) {
			if (entry.hash === options.hash) {
				options.duplicate?.(entry);
				return entry;
			}
		}

		const id = this.#uniqueId();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const question: PendingQuestion = {
			id,
			questions: options.questions,
			createdAt: Date.now(),
			hash: options.hash,
			timeoutMs: options.timeoutMs,
		};

		const entry: PendingEntry = {
			...question,
			settle: (answer) => {
				if (timer) clearTimeout(timer);
				this.#pending.delete(id);
				if (this.#latest === id) this.#latest = undefined;
			},
			onTimeout: options.onTimeout,
		};
		this.#pending.set(id, entry);
		this.#latest = id;

		timer = setTimeout(() => {
			this.#log.info(`远程提问 ${id} 超时（${options.timeoutMs}ms）`);
			entry.settle({
				id,
				items: [],
				answeredBy: "",
				raw: "",
			});
			options.onTimeout(entry);
		}, Math.max(5_000, options.timeoutMs));
		timer.unref?.();

		options.onRegistered?.(question);
		return question;
	}

	/**
	 * Settle a pending question with a parsed answer. `target` may be an id or
	 * undefined (latest). Returns the payload to echo and forward.
	 */
	resolve(
		target: string | undefined,
		raw: string,
		answeredBy: string,
	): QuestionAnswerResult | { ok: false; error: string } {
		const id = (target ?? "").trim().toUpperCase() || this.#latest;
		if (!id) return { ok: false, error: "当前没有待回答的提问。" };
		const entry = this.#pending.get(id);
		if (!entry) {
			const known = [...this.#pending.keys()];
			return {
				ok: false,
				error: known.length
					? `找不到编号 ${id}，当前待回答：${known.join(", ")}`
					: `找不到编号 ${id}（可能已回答或超时）。`,
			};
		}

		const parsed = parseQuestionAnswer(raw, entry);
		if (!parsed.ok) return parsed;

		const answer: QuestionAnswerPayload = { id, items: parsed.items, answeredBy, raw };
		entry.settle(answer);
		return { ok: true, answer };
	}

	/** Drop everything — used when the session goes away or takeover is released. */
	clear(reason: string): void {
		for (const entry of [...this.#pending.values()]) {
			this.#log.info(`远程提问 ${entry.id} 因 ${reason} 取消`);
			entry.settle({ id: entry.id, items: [], answeredBy: "", raw: "" });
			entry.onTimeout(entry);
		}
		this.#pending.clear();
		this.#latest = undefined;
	}

	#uniqueId(): string {
		for (let i = 0; i < 50; i += 1) {
			const id = shortId();
			if (!this.#pending.has(id)) return id;
		}
		return `${shortId()}${shortId()}`;
	}
}