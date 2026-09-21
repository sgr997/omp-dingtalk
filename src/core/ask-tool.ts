/**
 * Dual-surface `ask`: the TUI dialog and DingTalk, raced.
 *
 * OMP's `ask` tool opens a local dialog and blocks the turn until someone at
 * the terminal answers. That is the wrong shape when DingTalk has taken over
 * but the human is *still typing in the TUI*: neither "reroute to DingTalk"
 * (what this plugin used to do — it blocked the call, so the dialog never
 * appeared) nor "local only" (what the native tool does — the phone never sees
 * the question) matches. Both surfaces should show the question and the first
 * answer should win.
 *
 * The host already implements exactly that race internally, in
 * `extension-ui-controller.ts#showAskDialog`: it races the local dialog against
 * a *remote* answer and aborts the loser. But its remote side is
 * `ctx.collabHost` — the built-in `/collab` relay, whose guest can answer the
 * host's dialogs — and that slot is set only by
 * `slash-commands/builtin-collaboration.ts`. There is no extension registration
 * point for it (`registerCollab` / `registerUiProvider` do not exist), so this
 * plugin cannot borrow it.
 *
 * What an extension *can* do is re-register a tool under an existing native
 * name. The host replaces the registry entry by name, and `ctx.invokeTool`
 * reaches the *unwrapped* native built-in captured before the override. That
 * gives this module the two things it needs and nothing else can provide:
 *
 *  - the native dialog runs untouched (via `invokeTool`), and
 *  - `execute` receives the call's real `AbortSignal`, so the losing side can
 *    actually be cancelled.
 *
 * Re-registering is therefore the only way to get "both surfaces, first answer
 * wins". When the plugin is not in a position to race (no takeover, no outbound
 * channel, feature disabled, a foreign session, headless) `runAskRace` returns
 * `undefined` and the native dialog runs exactly as before.
 */
import type { ExtensionAPI } from "./pi-types";
import { extractAskQuestions, type QuestionAnswerItem, type QuestionAnswerPayload, type RemoteQuestion } from "./questions";

/** Same shape as the host's `AgentToolResult<AskToolDetails>`. */
export interface AskToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

export interface AskRaceRequest {
	questions: RemoteQuestion[];
	/**
	 * Run the native TUI dialog. Rejects (with an abort-shaped error) when the
	 * signal fires, which is how the loser of the race is cancelled.
	 */
	runLocal: (signal?: AbortSignal) => Promise<AskToolResult>;
}

export interface AskRaceBridge {
	/** `undefined` = do not race; the caller runs the native dialog alone. */
	runAskRace(request: AskRaceRequest): Promise<AskToolResult | undefined>;
}

/**
 * Verbatim from the host's `src/prompts/tools/ask.md`, which is what
 * `AskTool.description` renders to. The description is what teaches the model
 * *when* to ask, so a re-registration that lost it would quietly change how
 * often the model stops to clarify.
 */
const ASK_DESCRIPTION = `Ask user for clarification/input during task execution.

<conditions>
- Multiple approaches with significantly different tradeoffs user should weigh.
</conditions>

<instruction>
- \`recommended: <index>\` marks default (0-indexed); " (Recommended)" added automatically.
- Use \`questions\` for related questions, not one at a time.
- Set \`multi: true\` on a question to allow multiple selections.
- Short option labels; explanatory tradeoffs in \`description\`, not labels.
</instruction>

<caution>
- Provide 2-5 concise, distinct options.
</caution>

<critical>
- Default to action. Resolve ambiguity via repo conventions, existing patterns, reasonable defaults. Exhaust existing sources (code, configs, docs, history) before asking. Ask only when options have materially different tradeoffs the user must decide.
- If multiple choices acceptable: pick most conservative/standard option; proceed; state choice.
- Do NOT include "Other"; UI automatically adds "Other (type your own)" to every question.
</critical>`;

/**
 * `execute`'s trailing arguments have shipped in two different orders
 * (`signal, onUpdate, ctx` and `onUpdate, ctx, signal`), so find them by shape
 * rather than position — the same guard `dingtalk_notify` uses.
 */
function isAbortSignal(value: unknown): value is AbortSignal {
	if (!value || typeof value !== "object") return false;
	const signal = value as AbortSignal;
	return typeof signal.aborted === "boolean" && typeof signal.addEventListener === "function";
}

function isExtensionContext(value: unknown): boolean {
	return Boolean(value) && typeof value === "object" && ("cwd" in (value as object) || "ui" in (value as object));
}

/** Mirror of the host's `formatSingleQuestionResponse`. */
function formatSingle(item: QuestionAnswerItem): string {
	const parts: string[] = [];
	if (item.selectedOptions.length > 0) {
		parts.push(
			item.multi ? `User selected: ${item.selectedOptions.join(", ")}` : `User selected: ${item.selectedOptions[0]}`,
		);
	}
	if (item.customInput !== undefined) {
		parts.push(
			item.customInput.includes("\n")
				? `User provided custom input:\n${item.customInput
						.split("\n")
						.map((line) => `  ${line}`)
						.join("\n")}`
				: `User provided custom input: ${item.customInput}`,
		);
	}
	return parts.length > 0 ? parts.join("\n") : "User selected: (cancelled)";
}

/** Mirror of the host's `formatQuestionResult`. */
function formatItem(item: QuestionAnswerItem): string {
	if (item.customInput !== undefined) return `${item.id}: "${item.customInput}"`;
	if (item.selectedOptions.length > 0) {
		return item.multi ? `${item.id}: [${item.selectedOptions.join(", ")}]` : `${item.id}: ${item.selectedOptions[0]}`;
	}
	return item.multi ? `${item.id}: []` : `${item.id}: (cancelled)`;
}

function toQuestionResult(item: QuestionAnswerItem): Record<string, unknown> {
	return {
		id: item.id,
		question: item.question,
		options: item.options,
		multi: item.multi,
		selectedOptions: item.selectedOptions,
		...(item.customInput !== undefined ? { customInput: item.customInput } : {}),
	};
}

/**
 * Turn a DingTalk answer into the exact result shape the native `ask` tool
 * returns, so the model and the TUI result renderer cannot tell the surfaces
 * apart. Single-question answers use the flat `details` layout, multi-question
 * answers the `results` array — see `AskToolDetails` in the host.
 */
export function buildRemoteAskResult(answer: QuestionAnswerPayload): AskToolResult {
	const items = answer.items;
	if (items.length === 1) {
		const item = items[0]!;
		return {
			content: [{ type: "text", text: formatSingle(item) }],
			details: {
				question: item.question,
				options: item.options,
				multi: item.multi,
				selectedOptions: item.selectedOptions,
				...(item.customInput !== undefined ? { customInput: item.customInput } : {}),
			},
		};
	}
	return {
		content: [{ type: "text", text: `User answers:\n${items.map(formatItem).join("\n")}` }],
		details: { results: items.map(toQuestionResult) },
	};
}

/**
 * Nobody answered on either surface in time. The local dialog has just been
 * closed, so the turn must not stay blocked: hand the decision back to the
 * model, which is what the pre-race implementation achieved by injecting a
 * follow-up message.
 */
export function buildAskTimeoutResult(options: {
	id: string;
	questions: RemoteQuestion[];
	timeoutMs: number;
}): AskToolResult {
	const seconds = Math.round(options.timeoutMs / 1000);
	const lines = options.questions.map((q) => {
		const recommended =
			q.recommended !== undefined && q.options[q.recommended] ? ` (recommended: ${q.options[q.recommended]!.label})` : "";
		return `- ${q.question}${recommended}`;
	});
	return {
		content: [
			{
				type: "text",
				text:
					`No answer was given within ${seconds}s — DingTalk remote question #${options.id} timed out and the local dialog was closed.\n\n` +
					`Questions asked:\n${lines.join("\n")}\n\n` +
					`Decide yourself: continue with the most reasonable default and state which choice you made.`,
			},
		],
		details: { timedOut: true },
	};
}

/**
 * Re-register `ask` so the plugin owns the call.
 *
 * Returns false when the host exposes no schema shim, in which case the native
 * tool is left alone and the plugin falls back to its older behavior.
 */
export function registerAskTool(pi: ExtensionAPI, getBridge: (ctx: any) => AskRaceBridge | undefined): boolean {
	const zod = (pi as any).zod;
	// The schema shim is injected by the host and has drifted between builds, so
	// check the pieces this definition needs before touching them: an extension
	// that throws while loading takes the whole session down with it.
	if (!zod || typeof zod.object !== "function" || typeof zod.array !== "function") return false;

	pi.registerTool({
		name: "ask",
		label: "Ask",
		description: ASK_DESCRIPTION,
		loadMode: "discoverable",
		// The native tool is `concurrency: "exclusive"`: its dialog is a single
		// shared UI surface, so two concurrent `ask` calls would clobber each
		// other and orphan the first. `ToolDefinition` has no field for this, but
		// the host proxies every own property of the definition onto its tool
		// adapter, so declaring it here keeps the native scheduling contract.
		concurrency: "exclusive",
		parameters: zod.object({
			questions: zod
				.array(
					zod.object({
						id: zod.string().describe("question id"),
						question: zod.string().describe("question text"),
						header: zod.string().optional().describe("optional short display chip for rich ask dialogs"),
						options: zod
							.array(
								zod.object({
									label: zod.string().describe("option label"),
									description: zod.string().optional().describe("optional explanatory tradeoff"),
									preview: zod.string().optional().describe("optional rich preview content for interactive ask dialogs"),
								}),
							)
							.describe("available options"),
						multi: zod.boolean().optional().describe("allow multiple selections"),
						recommended: zod.number().optional().describe("recommended option index"),
					}),
				)
				.min(1)
				.describe("questions to ask"),
		}),
		async execute(_toolCallId: string, params: any, ...rest: any[]): Promise<AskToolResult> {
			const signal = rest.find(isAbortSignal);
			const onUpdate = rest.find((value) => typeof value === "function");
			const ctx = rest.find(isExtensionContext);

			// `ctx.invokeTool` only exists for a tool that re-registers a native
			// built-in of the same name. Its absence means this host has no native
			// `ask` to delegate to — a headless session, where the native tool is
			// never registered at all — so match the native headless contract
			// rather than hanging on a dialog nobody can see.
			const invoke = (ctx as { invokeTool?: (...args: any[]) => Promise<AskToolResult> } | undefined)?.invokeTool;
			if (typeof invoke !== "function") {
				return {
					content: [{ type: "text", text: "Error: Ask tool requires interactive mode" }],
					details: {},
					isError: true,
				};
			}

			const runLocal = (localSignal?: AbortSignal): Promise<AskToolResult> =>
				invoke(params, { signal: localSignal, onUpdate });

			const bridge = getBridge(ctx);
			if (bridge) {
				const questions = extractAskQuestions(params);
				if (questions) {
					const raced = await bridge.runAskRace({ questions, runLocal });
					if (raced) return raced;
				}
			}
			// Not racing (or the input was malformed): let the native dialog own
			// the call, with the caller's own signal, exactly as if this tool had
			// never been re-registered.
			return runLocal(signal);
		},
	});
	return true;
}
