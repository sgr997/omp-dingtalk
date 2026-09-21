/**
 * Small shared helpers.
 *
 * This plugin is intentionally zero-dependency: it only uses Node/Bun builtins
 * (`node:crypto`, global `fetch`, global `WebSocket`, `Buffer`) so that
 * `omp plugin link` works without a `bun install` step.
 */
import { createHmac } from "node:crypto";

/**
 * Decode a base64 payload into UTF-8 text.
 *
 * Only used as a compatibility fallback for Stream frames: the live gateway
 * sends `data` as a plain JSON string, but some SDK builds base64-encode it.
 */
export function b64Decode(input: string): string {
	return Buffer.from(String(input ?? ""), "base64").toString("utf8");
}

/** Truncate with an ellipsis, never returning a longer string than `max`. */
export function truncate(text: unknown, max: number): string {
	const value = typeof text === "string" ? text : text == null ? "" : String(text);
	if (value.length <= max) return value;
	if (max <= 1) return value.slice(0, Math.max(0, max));
	return `${value.slice(0, max - 1)}…`;
}

/**
 * Split a message body into chunks no longer than `max` characters.
 *
 * DingTalk rejects an over-long message outright instead of delivering the
 * head, so the only way to show a long reply in full is several messages.
 * Boundaries fall on blank lines first (paragraph stays whole), then on line
 * breaks, then on a hard cut. A fenced code block is never left open across a
 * boundary: the chunk closes with the fence and the next one reopens it, so
 * both halves still render as code instead of garbage.
 */
export function splitMessage(text: string, max: number): string[] {
	if (max <= 0 || text.length <= max) return [text];
	const lines = text.split("\n");
	const chunks: string[] = [];
	let buf: string[] = [];
	let len = 0;
	let inFence = false;
	let reopen = false; // current buffer must start by reopening a fence

	// Fencing is applied here, when the chunk is sealed, so a reopen marker
	// is never counted against the next chunk's budget.
	const flush = (): void => {
		if (buf.length === 0) return;
		let body = buf.join("\n");
		if (reopen) body = `\`\`\`\n${body}`;
		if (inFence) body = `${body}\n\`\`\``;
		chunks.push(body);
		buf = [];
		len = 0;
		reopen = inFence;
	};

	for (const raw of lines) {
		if (buf.length > 0 && len + 1 + raw.length > max) flush();
		if (buf.length === 0 && raw.length >= max - (inFence ? 8 : 0)) {
			// A single line that cannot fit even on its own: hard cut it. The
			// fence (reopen + close) costs a few chars, so give it room.
			const pieceMax = Math.max(1, max - (inFence ? 8 : 0));
			for (let at = 0; at < raw.length; at += pieceMax) {
				buf = [raw.slice(at, at + pieceMax)];
				len = buf[0]?.length ?? 0;
				flush();
			}
			continue;
		}
		buf.push(raw);
		len += 1 + raw.length;
		if (/^`{3,}/.test(raw.trim())) inFence = !inFence;
	}
	flush();
	return chunks.length > 0 ? chunks : [text];
}

/**
 * Truncate a filesystem path while keeping its last segment visible.
 *
 * Plain `truncate` keeps the head, so a long path loses the project/session
 * name — exactly the part that tells the user *which* directory is speaking.
 */
export function truncatePath(path: unknown, max: number): string {
	const value = typeof path === "string" ? path : path == null ? "" : String(path);
	if (value.length <= max) return value;
	if (max <= 1) return value.slice(0, Math.max(0, max));
	const segments = value.split(/[\\/]/).filter(Boolean);
	const tail = segments.length > 1 ? (segments.at(-1) ?? "") : "";
	if (!tail || tail.length + 2 >= max) return truncate(value, max);
	const head = value.slice(0, max - tail.length - 2);
	return `${head}…${tail}`.slice(0, max);
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Short human-readable id used to label pending approvals. */
export function shortId(): string {
	return Math.random().toString(36).slice(2, 6).toUpperCase();
}

/** `1h 02m 03s` / `12.4s` / `830ms` */
export function humanDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "?";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const totalSeconds = ms / 1000;
	if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
	const seconds = Math.floor(totalSeconds % 60);
	const minutes = Math.floor(totalSeconds / 60) % 60;
	const hours = Math.floor(totalSeconds / 3600);
	if (hours > 0) {
		return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
	}
	return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** HMAC-SHA256 → base64. Matches DingTalk's custom-robot signing spec. */
export function hmacSha256Base64(secret: string, data: string): string {
	return createHmac("sha256", secret).update(data, "utf8").digest("base64");
}

/**
 * Extract readable text from an OMP agent message.
 *
 * `AgentMessage` is a union (user / assistant / tool result / custom), and the
 * assistant's `content` is an array of typed parts, so this walks the shapes
 * defensively instead of assuming one layout.
 */
export function extractText(message: unknown): string {
	if (!message) return "";
	if (typeof message === "string") return message;
	const msg = message as Record<string, any>;

	if (typeof msg.text === "string" && msg.text.length > 0) return msg.text;

	const content = msg.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part) => part && part.type === "text" && typeof part.text === "string")
			.map((part) => part.text as string)
			.join("\n");
	}
	return "";
}

/** Names of the tools an assistant message asked for, in order. */
export function extractToolNames(message: unknown): string[] {
	const msg = message as Record<string, any> | undefined;
	if (!msg || !Array.isArray(msg.content)) return [];
	return msg.content
		.filter((part) => part && (part.type === "toolCall" || part.type === "tool_call"))
		.map((part) => String(part.name ?? part.toolName ?? "?"))
		.filter(Boolean);
}

/** Pretty-print a value for a chat message, capped at `max` characters. */
export function safeJson(value: unknown, max = 900): string {
	let text: string;
	try {
		text = JSON.stringify(value, null, 2);
	} catch {
		text = String(value);
	}
	if (text === undefined) text = String(value);
	return truncate(text, max);
}

/**
 * Escape text that goes inside a fenced code block in DingTalk markdown, so a
 * payload containing ``` cannot break out of the fence.
 */
export function fenceSafe(text: string): string {
	return text.replace(/```/g, "``\u200b`");
}

/** `~` expansion for config paths (Windows-aware). */
export function expandHome(input: string): string {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	if (!home) return input;
	if (input === "~") return home;
	if (input.startsWith("~/") || input.startsWith("~\\")) {
		return `${home}${input.slice(1)}`;
	}
	return input;
}

/** Home directory of the current user, or "" when unknown. */
export function homeDir(): string {
	return process.env.HOME || process.env.USERPROFILE || "";
}
