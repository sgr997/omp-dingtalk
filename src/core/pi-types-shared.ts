/**
 * Host-facing structural types shared across the plugin.
 *
 * `ApiLike` is the slice of the injected extension API the plugin uses;
 * `CtxLike` is the handler context. Defined once here so core, the platform
 * adapters and the router agree on the same shapes.
 */

/** Minimal structural view of the injected extension API. */
export interface ApiLike {
	sendUserMessage: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => void;
	appendEntry?: (customType: string, data: unknown) => void;
	setModel?: (model: unknown) => Promise<boolean>;
	getActiveTools?: () => string[];
	getSessionName?: () => string | undefined;
}

/** Minimal structural view of the handler context. */
export interface CtxLike {
	abort?: () => void;
	compact?: (instructions?: string) => Promise<void>;
	isIdle?: () => boolean;
	hasPendingMessages?: () => boolean;
	models?: { resolve: (spec: string) => unknown; current: () => unknown };
	model?: { id?: string; provider?: string } | undefined;
	cwd?: string;
}
