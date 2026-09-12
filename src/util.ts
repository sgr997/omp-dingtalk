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
