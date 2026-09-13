/**
 * Minimal host API surface used by this plugin.
 *
 * omp ships as two builds (`pi-coding-agent` and `pi-coding-agent-zh`) and the
 * host's own `ExtensionAPI` types have drifted between them, so importing the
 * host package from here is fragile and machine-dependent. This file describes
 * only the members this plugin actually uses. The editor stays happy on any
 * machine, and `test/verify-load.ts` is the runtime check that the shapes
 * still line up with the real host.
 */

export type PiEventName =
	| "auto_retry_end"
	| "auto_retry_start"
	| "credential_disabled"
	| "goal_updated"
	| "session_shutdown"
	| "session_start"
	| "session_stop"
	| "tool_call"
	| "tool_execution_end"
	| "turn_end"
	| "turn_start";

export interface ExtensionCommandCompletion {
	value: string;
	description?: string;
}

export interface ExtensionCommandOptions {
	description?: string;
	getArgumentCompletions?: (prefix: string) => ExtensionCommandCompletion[];
	handler?: (...args: any[]) => unknown;
}

export interface ExtensionToolDefinition {
	name: string;
	label?: string;
	description: string;
	parameters?: any;
	execute: (...args: any[]) => unknown;
}

export interface ExtensionAPI {
	readonly logger?: unknown;
	readonly zod?: any;
	appendEntry?: (customType: string, data?: unknown) => void;
	getSessionName?: () => string | undefined;
	on(event: PiEventName | (string & {}), handler: (event: any, ctx: any) => unknown): void;
	registerCommand(name: string, options: ExtensionCommandOptions): void;
	registerTool(definition: ExtensionToolDefinition): void;
	sendUserMessage?(text: string, options?: Record<string, unknown>): void;
}
