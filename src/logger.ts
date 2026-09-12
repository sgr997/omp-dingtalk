/**
 * Logging.
 *
 * OMP injects `pi.logger`, but it may be missing or shaped differently across
 * versions, and the DingTalk channel needs to log from timers/callbacks that run
 * outside any handler. This wraps whatever we get into one predictable shape
 * with a `[dingtalk]` prefix, and degrades to `console` when nothing is injected.
 */
export interface Logger {
	debug(message: string, data?: unknown): void;
	info(message: string, data?: unknown): void;
	warn(message: string, data?: unknown): void;
	error(message: string, data?: unknown): void;
}

const PREFIX = "[dingtalk]";

function emit(level: "debug" | "info" | "warn" | "error", sink: unknown, message: string, data?: unknown) {
	const text = data === undefined ? `${PREFIX} ${message}` : `${PREFIX} ${message}`;
	try {
		if (sink && typeof (sink as any)[level] === "function") {
			(sink as any)[level](text, data);
			return;
		}
	} catch {
		// fall through to console
	}
	const fallback = level === "debug" ? console.debug : level === "info" ? console.info : level === "warn" ? console.warn : console.error;
	try {
		if (data === undefined) fallback.call(console, text);
		else fallback.call(console, text, data);
	} catch {
		/* nothing left to do */
	}
}

export function createLogger(injected?: unknown): Logger {
	// OMP's logger exposes debug/info/warn/error; accept it when it looks right.
	const usable = injected && typeof (injected as any).info === "function" ? injected : undefined;
	return {
		debug: (message, data) => emit("debug", usable, message, data),
		info: (message, data) => emit("info", usable, message, data),
		warn: (message, data) => emit("warn", usable, message, data),
		error: (message, data) => emit("error", usable, message, data),
	};
}
