/**
 * Message formatting: turns OMP events into DingTalk markdown.
 *
 * Kept deliberately conservative — DingTalk markdown supports headings, bold,
 * quotes, lists, links and fenced code, but nothing exotic.
 */
import type { ApprovalRule } from "./config";
import { fenceSafe, humanDuration, truncate, truncatePath } from "./util";

export interface Message {
	title: string;
	text: string;
}

function stamp(): string {
	return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

/**
 * Short label identifying *which* session a message came from.
 *
 * Set once per session by the bridge. Without it, notifications from two
 * sessions (or two machines) are indistinguishable — you get "本轮结束" with no
 * idea which project it refers to, and with preemptive takeover you will
 * genuinely be switching between sessions.
 *
 * Process-wide on purpose: an omp process hosts exactly one live bridge at a
 * time (`ensure()` disposes the previous one before building the next), so a
 * single slot is enough. Two *concurrent* sessions are two processes, each with
 * its own copy of this module.
 */
let sessionTag = "";

export function setSessionTag(tag: string): void {
	sessionTag = tag;
}

/** `目录名·a1b2`, or "" before a session has been labelled. */
export function getSessionTag(): string {
	return sessionTag;
}

function footer(): string {
	const label = sessionTag ? `omp · ${sessionTag} · ${stamp()}` : `omp · ${stamp()}`;
	return `\n\n---\n<font color="#999999" size="1">${label}</font>`;
}

/** One-line "where did this come from", for messages that carry no footer. */
function originLine(): string {
	return sessionTag ? `- **来自**: \`${sessionTag}\`` : "";
}

function codeBlock(body: string): string {
	return `\`\`\`\n${fenceSafe(truncate(body, 1400))}\n\`\`\``;
}

/**
 * An OMP reply, rendered as native DingTalk markdown.
 *
 * Must NOT go through `codeBlock`: DingTalk turns a fence into a monospace grey
 * box that parses nothing, so a normal model reply (headings, bold labels,
 * lists) arrives as raw markdown source. DingTalk also glues two adjacent
 * non-empty lines into one paragraph (a single newline is a soft break), so
 * every line gets a blank line after it — except inside a fenced code block
 * (kept verbatim) and before an indented continuation line (which belongs to
 * the list item above it).
 */
function replyBlock(body: string): string {
	const lines = truncate(body, 1400).split("\n");
	const out: string[] = [];
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^`{3,}/.test(line.trim())) inFence = !inFence;
		out.push(line);
		if (inFence) continue;
		// A table row (`| a | b |`) must stay contiguous with its neighbours or
		// DingTalk's parser drops the whole table. No blank line *between* rows;
		// add one only after the table block ends and normal text resumes.
		const next = lines[i + 1];
		if (/^\s*\|.*\|\s*$/.test(line.trim())) {
			if (next !== undefined && next.trim() !== "" && !/^\s*\|.*\|\s*$/.test(next.trim())) out.push("");
			continue;
		}
		if (line.trim() === "" || next === undefined || next.trim() === "" || /^\s/.test(next)) continue;
		out.push("");
	}
	return out.join("\n");
}

/** Where inbound control stands, in one line the user can act on. */
function controlHint(control: "active" | "inert" | "off", scope: "direct" | "group" | "all"): string {
	if (control === "off") return "本会话只推送通知，入站控制已关闭（`control.enabled: false`）。";
	const where = scope === "direct" ? "钉钉单聊" : scope === "group" ? "钉钉群聊（需 @ 机器人）" : "钉钉";
	if (control === "inert") {
		return [
			`钉钉**尚未接管**本会话 —— 现在发消息不会有任何反应。`,
			``,
			`在 omp 里执行 \`/dingtalk takeover\` 之后，才能在${where}里指挥它。`,
		].join("\n");
	}
	return `已接管：直接在${where}发消息即可指挥它；发 **帮助** 看指令表。`;
}

/**
 * Push confirmation for a takeover that was asked for at the terminal.
 *
 * Deliberately *not* sent on `session_start`: an omp launch is ordinary, and a
 * DingTalk ping for every new session is noise. Handing control over is the
 * event worth announcing — especially when it preempted another session, which
 * otherwise looks like DingTalk silently stopped working over there.
 */
export function fmtTakeoverSuccess(info: {
	cwd: string;
	scope: "direct" | "group" | "all";
	preempted?: { cwd: string; pid: number };
	releaseSeconds?: number;
}): Message {
	const lines = [`## 🎧 钉钉已接管本会话`, ``, `- **目录**: \`${truncatePath(info.cwd, 120)}\``];
	if (info.preempted) {
		lines.push(
			``,
			`> 已从另一个会话手里抢占（\`${truncatePath(info.preempted.cwd || "?", 80)}\` · PID ${info.preempted.pid}）${
				info.releaseSeconds ? `，它会在 ${info.releaseSeconds} 秒内自动释放` : ""
			}。`,
		);
	}
	lines.push(``, controlHint("active", info.scope), footer());
	return { title: "钉钉已接管", text: lines.join("\n") };
}

export function fmtSessionStop(info: {
	durationMs: number;
	turns: number;
	text?: string;
	todos?: { content: string; status: string }[];
}): Message {
	const lines = [`## ✅ 本轮结束，omp 空闲中`, ``, `- **耗时**: ${humanDuration(info.durationMs)}`, `- **轮次**: ${info.turns}`];

	const open = (info.todos ?? []).filter((todo) => todo.status !== "completed" && todo.status !== "cancelled");
	if (open.length > 0) {
		lines.push(``, `**待办**`);
		for (const todo of open.slice(0, 8)) lines.push(`- [ ] ${truncate(todo.content, 100)}`);
		if (open.length > 8) lines.push(`- …另有 ${open.length - 8} 项`);
	}

	const text = (info.text ?? "").trim();
	if (text) {
		lines.push(``, `**最后一条回复**`, ``, replyBlock(text));
	}
	lines.push(``, `> 若已执行 \`/dingtalk takeover\`，在钉钉里回复即可继续指挥它。`);
	return { title: "omp 空闲中", text: lines.join("\n") + footer() };
}

export function fmtTurnEnd(info: { turnIndex: number; durationMs: number; text?: string; tools?: string[] }): Message {
	const lines = [`## ⏱ 第 ${info.turnIndex + 1} 轮完成`, ``, `- **耗时**: ${humanDuration(info.durationMs)}`];
	if (info.tools?.length) lines.push(`- **调用工具**: ${info.tools.map((t) => `\`${t}\``).join(", ")}`);
	const text = (info.text ?? "").trim();
	if (text) lines.push(``, `**回复**`, ``, replyBlock(text));
	return { title: `第 ${info.turnIndex + 1} 轮完成`, text: lines.join("\n") + footer() };
}

export function fmtApprovalRequest(info: {
	id: string;
	toolName: string;
	reason: string;
	detail: string;
	timeoutMs: number;
}): Message {
	const lines = [
		`## 🔐 需要你批准`,
		``,
		`- **编号**: \`${info.id}\``,
		`- **工具**: \`${info.toolName}\``,
		`- **触发原因**: ${truncate(info.reason, 160)}`,
	];
	// Approvals carry no footer, so the origin has to be an explicit line.
	if (sessionTag) lines.push(originLine());
	lines.push(
		``,
		`**具体操作**`,
		codeBlock(info.detail),
		``,
		`回复 **同意** 或 **拒绝**（也可用 \`/approve ${info.id}\` 或 \`/deny ${info.id}\`）。`,
		`> ${Math.round(info.timeoutMs / 1000)}s 内没有回复则按配置的默认策略处理。`,
	);
	return { title: `需要批准：${info.toolName}`, text: lines.join("\n") };
}

export function fmtApprovalResolved(info: { id: string; approved: boolean; by: string; note?: string }): Message {
	const mark = info.approved ? "✅ 已批准" : "⛔ 已拒绝";
	return {
		title: `审批 ${info.id} ${info.approved ? "通过" : "驳回"}`,
		text: [`**${mark}**`, ``, `- **编号**: \`${info.id}\``, `- **操作人**: ${info.by}`, info.note ? `- **说明**: ${info.note}` : ""]
			.filter(Boolean)
			.join("\n"),
	};
}

type QuestionPack = {
	id: string;
	questions: Array<{
		id: string;
		question: string;
		header?: string;
		options: Array<{ label: string; description?: string }>;
		multi: boolean;
		recommended?: number;
	}>;
	timeoutMs: number;
};

/**
 * DingTalk markdown quirk: two adjacent plain-text lines are rendered as ONE
 * paragraph (a single newline is a soft break). Only list items, blockquotes
 * and blank-line paragraph breaks produce a visible line break, so every block
 * below is either a bullet / ordered-list item, a quote, or separated by an
 * empty line. Do not "simplify" this by joining plain lines with "\n".
 */
function optionLines(pack: QuestionPack): string[] {
	const lines: string[] = [];
	const multiple = pack.questions.length > 1;
	pack.questions.forEach((q, qIndex) => {
		const label = multiple ? `**问题 ${qIndex + 1}/${pack.questions.length}**` : `**问题**`;
		lines.push(label, ``, `${truncate(q.question, 400)}`, ``);
		if (q.header?.trim()) lines.push(`> ${truncate(q.header.trim(), 200)}`, ``);
		if (q.options.length > 0) {
			// A real markdown ordered list: DingTalk renders the numbers itself and
			// keeps every option on its own line.
			q.options.forEach((o, oIndex) => {
				const recommended = q.recommended === oIndex ? " （推荐）" : "";
				lines.push(
					`${oIndex + 1}. ${truncate(o.label, 200)}${recommended}${
						o.description ? `\n   ${truncate(o.description, 200)}` : ""
					}`,
				);
			});
			lines.push(``);
		}
	});
	return lines;
}

export function fmtQuestionRequest(pack: QuestionPack): Message {
	const multiple = pack.questions.length > 1;
	const howTo = multiple
		? `回复「问题号:选项号」，如 \`1:2 2:1\`；同一问题多选用 \`1:2,3\`。也可以直接回选项文字或自定义答案。`
		: `直接回复选项号即可，如 \`2\`；多选用 \`2,4\`；回选项文字或任意文字也可以。`;
	const lines = [
		`## ❓ 需要你的回答`,
		``,
		`- **编号**: \`${pack.id}\``,
		...(sessionTag ? [originLine()] : []),
		``,
		...optionLines(pack),
		howTo,
		``,
		`> ${Math.round(pack.timeoutMs / 1000)}s 内没有回复会告知 omp 自行决定。`,
	];
	return { title: `需要你的回答 ${pack.id}`, text: lines.join("\n") };
}

export function fmtQuestionAnswerEcho(info: {
	id: string;
	items: Array<{ id: string; question: string; options: string[]; multi: boolean; selectedOptions: string[]; customInput?: string }>;
	by: string;
}): Message {
	const renderItem = (item: { id: string; question: string; options: string[]; multi: boolean; selectedOptions: string[]; customInput?: string }): string[] => {
		// Blank line between the question and the answer: adjacent plain lines
		// would render as one paragraph.
		const head = [`**${truncate(item.question, 300)}**`, ``];
		if (item.customInput !== undefined) return [...head, `> 自定义回答：${truncate(item.customInput, 500)}`];
		if (item.selectedOptions.length === 0) return [...head, `> （未选择任何选项）`];
		return [...head, `> 已选：${item.selectedOptions.map((o) => `\`${truncate(o, 120)}\``).join("、")}`];
	};
	const body = info.items.flatMap((item, index) => (index === 0 ? renderItem(item) : ["", ...renderItem(item)]));
	return {
		title: `✅ 已回答 ${info.id}`,
		text: [`**回答已提交给 omp**`, ``, `- **编号**: \`${info.id}\``, `- **操作人**: ${info.by}`, ``, ...body].join("\n"),
	};
}

export function fmtQuestionTimeout(info: { id: string; questions: QuestionPack["questions"]; timeoutMs: number }): Message {
	return {
		title: `⏰ 提问超时 ${info.id}`,
		text: [
			`**${Math.round(info.timeoutMs / 1000)}s 内没有收到回答**`,
			``,
			`- **编号**: \`${info.id}\``,
			...(sessionTag ? [originLine()] : []),
			``,
			...info.questions.flatMap((q, qi) => [`${qi + 1}. ${truncate(q.question, 300)}`]),
			``,
			`已告知 omp 自行决定，任务不会卡住。`,
		].join("\n"),
	};
}

/**
 * The user message injected into the session when a remote question is
 * answered — the model never saw the original `ask` dialog, so the answer has
 * to carry the question text with it.
 */
export function formatQuestionInjection(info: {
	id: string;
	items: Array<{ id: string; question: string; options: string[]; multi: boolean; selectedOptions: string[]; customInput?: string }>;
	by?: string;
}): string {
	const lines = [
		`（钉钉远程回答，提问 #${info.id}${info.by ? `，来自 ${info.by}` : ""}）`,
	];
	for (const item of info.items) {
		lines.push(`- 问题「${item.question}」`);
		if (item.customInput !== undefined) {
			lines.push(`  自定义回答：${item.customInput}`);
		} else if (item.selectedOptions.length > 0) {
			lines.push(`  选择：${item.selectedOptions.join("、")}`);
		} else {
			lines.push(`  未选择任何选项`);
		}
	}
	return lines.join("\n");
}

/** Tells the model an ask it made was forwarded and that it should stop and wait. */
export function fmtQuestionBlocked(info: { id: string; questions: QuestionPack["questions"]; timeoutMs: number }): string {
	const lines = [
		`提问已推送到钉钉（编号 ${info.id}），用户现在不在本机，正在手机上回答。`,
		``,
	];
	info.questions.forEach((q, qi) => {
		lines.push(
			`${qi + 1}. ${q.question}${q.multi ? "（多选）" : ""}${q.recommended !== undefined ? `（推荐第 ${q.recommended + 1} 项）` : ""}`,
		);
	});
	lines.push(
		``,
		`请**立即结束本轮**，不要假装用户已作答，不要再次调用提问工具。`,
		`用户的回答会在 ${Math.round((info.timeoutMs ?? 600_000) / 1000)}s 内以一条新的用户消息发来；超时未收到会让你自行决定。`,
	);
	return lines.join("\n");
}

export function fmtError(info: { kind: string; detail: string; hint?: string }): Message {
	const lines = [`## ⚠️ ${info.kind}`, ``];
	if (sessionTag) lines.push(originLine(), ``);
	lines.push(codeBlock(info.detail));
	if (info.hint) lines.push(``, `> ${info.hint}`);
	return { title: info.kind, text: lines.join("\n") };
}

export function fmtToolUse(info: { toolName: string; args: string }): Message {
	return {
		title: `调用 ${info.toolName}`,
		text: [`**\`${info.toolName}\`**`, codeBlock(info.args)].join("\n"),
	};
}

export function fmtApprovalRules(rules: ApprovalRule[]): string {
	if (rules.length === 0) return "(未配置规则)";
	return rules
		.map((rule) => {
			const bits: string[] = [];
			if (rule.tools?.length) bits.push(`工具 ${rule.tools.join("/")}`);
			if (rule.patterns?.length) bits.push(`${rule.patterns.length} 条命令正则`);
			if (rule.paths?.length) bits.push(`路径 ${rule.paths.join(", ")}`);
			return `- ${rule.label ?? "(未命名)"}: ${bits.join("，") || "匹配全部"}`;
		})
		.join("\n");
}

export function fmtHelp(): Message {
	const text = [
		`## 📖 omp 机器人指令`,
		``,
		`> 默认只响应**单聊**消息，群聊消息一律忽略。`,
		`> 且需要先在 omp 里执行 \`/dingtalk takeover\`，否则不会有任何反应。`,
		``,
		`**查看状态**`,
		`- \`状态\` 或 \`/status\` — 会话、模型、待审批、队列`,
		`- \`/tools\` — 当前启用的工具`,
		`- \`/help\` 或 \`帮助\` — 这张表`,
		``,
		`**控制执行**`,
		`- 直接发任意文字 — 作为新指令喂给 omp（流式中会打断当前轮次）`,
		`- \`/follow <文字>\` — 等当前轮次跑完再执行`,
		`- \`/stop\` 或 \`停止\` — 中断当前执行`,
		`- \`/compact [说明]\` — 压缩上下文`,
		`- \`/model <模型名>\` — 切换模型，如 \`/model opus\``,
		``,
		`**审批**`,
		`- \`同意\` 或 \`/approve [编号]\` — 批准（不写编号则批准最新一条）`,
		`- \`拒绝\` 或 \`/deny [编号]\` — 拒绝`,
		``,
		`**远程提问**`,
		`- 收到“❓ 需要你的回答”后直接回复选项号（如 \`2\`），多选 \`2,4\`，也可回文字`,
		`- 多问题用 \`1:2 2:1\` 逐条回答；数字在钉钉里必须单独发送`,
		``,
		`**通知开关**`,
		`- \`/quiet on\` 或 \`/quiet off\` — 静音或恢复通知`,
		`- \`/ping\` — 测试连通性`,
		`- \`/whoami\` 或 \`/id\` — 查看自己的 senderStaffId（配白名单/首次接入用，未授权也能查）`,
	].join("\n");
	return { title: "omp 机器人指令", text };
}

export function fmtStatus(info: {
	lines: string[];
	pending: { id: string; toolName: string; ageMs: number }[];
	pendingQuestions: { id: string; text: string; ageMs: number }[];
}): Message {
	const out = [`## 📊 omp 状态`, ``, ...info.lines];
	if (info.pending.length > 0) {
		out.push(``, `**待审批**`);
		for (const item of info.pending) {
			out.push(`- \`${item.id}\` \`${item.toolName}\` (等待 ${humanDuration(item.ageMs)})`);
		}
	}
	if (info.pendingQuestions.length > 0) {
		out.push(``, `**待回答提问**`);
		for (const item of info.pendingQuestions) {
			out.push(`- \`${item.id}\` ${truncate(item.text, 120)} (等待 ${humanDuration(item.ageMs)})`);
		}
	}
	return { title: "omp 状态", text: out.join("\n") + footer() };
}

export function fmtQuiet(on: boolean): Message {
	return {
		title: on ? "已静音" : "已恢复通知",
		text: on ? "🔕 通知已静音。控制指令仍然可用。" : "🔔 通知已恢复。",
	};
}

export function fmtText(title: string, text: string): Message {
	return { title, text: text + footer() };
}
