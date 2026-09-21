/**
 * Approval-related types shared across the plugin.
 *
 * `ApprovalRule` describes a dangerous-operation gate (tool names, command
 * patterns, file-path globs). It is platform-neutral: every channel that
 * supports remote approval consumes the same rule shape.
 */

export interface ApprovalRule {
	/** Tool names this rule applies to. */
	tools?: string[];
	/** Regexes matched against `bash` command strings. */
	patterns?: string[];
	/** Glob-ish patterns matched against `write`/`edit` target paths. */
	paths?: string[];
	/** Shown in the approval request so you know why you are being asked. */
	label?: string;
}

export type ApprovalDecision = "approve" | "deny" | "timeout";

export interface PendingApproval {
	id: string;
	toolName: string;
	reason: string;
	detail: string;
	createdAt: number;
}
