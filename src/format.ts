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

export function fmtSessionStart(info: {
	cwd: string;
	model?: string;
	sessionName?: string;
	sources?: string[];
	warnings?: string[];
	/** `active` = DingTalk already drives this session; `inert` = waiting for a takeover; `off` = inbound disabled. */
	control?: "active" | "inert" | "off";
	scope?: "direct" | "group" | "all";
}): Message {
	const lines = [
		`## 🚀 omp 已启动`,
		``,
		`- **目录**: \`${truncatePath(info.cwd, 120)}\``,
		`- **模型**: ${info.model ? `\`${info.model}\`` : "(未知)"}`,
	];
	if (info.sessionName) lines.push(`- **会话**: ${truncate(info.sessionName, 80)}`);
	if (info.warnings?.length) {
		lines.push(``, `> ⚠️ ${info.warnings.map((w) => truncate(w, 160)).join("\n> ")}`);
	}
	lines.push(``, controlHint(info.control ?? "inert", info.scope ?? "direct"));
	return { title: "omp 已启动", text: lines.join("\n") + footer() };
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
		lines.push(``, `**最后一条回复**`, codeBlock(text));
	}
	lines.push(``, `> 若已执行 \`/dingtalk takeover\`，在钉钉里回复即可继续指挥它。`);
	return { title: "omp 空闲中", text: lines.join("\n") + footer() };
}

export function fmtTurnEnd(info: { turnIndex: number; durationMs: number; text?: string; tools?: string[] }): Message {
	const lines = [`## ⏱ 第 ${info.turnIndex + 1} 轮完成`, ``, `- **耗时**: ${humanDuration(info.durationMs)}`];
	if (info.tools?.length) lines.push(`- **调用工具**: ${info.tools.map((t) => `\`${t}\``).join(", ")}`);
	const text = (info.text ?? "").trim();
	if (text) lines.push(``, codeBlock(text));
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
		`回复 **同意** 或 **拒绝**（也可用 \`/approve ${info.id}\` / \`/deny ${info.id}\`）。`,
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
		`- \`状态\` / \`/status\` — 会话、模型、待审批、队列`,
		`- \`/tools\` — 当前启用的工具`,
		`- \`/help\` / \`帮助\` — 这张表`,
		``,
		`**控制执行**`,
		`- 直接发任意文字 — 作为新指令喂给 omp（流式中会打断当前轮次）`,
		`- \`/follow <文字>\` — 等当前轮次跑完再执行`,
		`- \`/stop\` / \`停止\` — 中断当前执行`,
		`- \`/compact [说明]\` — 压缩上下文`,
		`- \`/model <模型名>\` — 切换模型，如 \`/model opus\``,
		``,
		`**审批**`,
		`- \`同意\` / \`/approve [编号]\` — 批准（不写编号则批准最新一条）`,
		`- \`拒绝\` / \`/deny [编号]\` — 拒绝`,
		``,
		`**通知开关**`,
		`- \`/quiet on\` / \`/quiet off\` — 静音 / 恢复通知`,
		`- \`/ping\` — 测试连通性`,
		`- \`/id\` — 查看自己的 senderStaffId（用于配置白名单）`,
	].join("\n");
	return { title: "omp 机器人指令", text };
}

export function fmtStatus(info: {
	lines: string[];
	pending: { id: string; toolName: string; ageMs: number }[];
}): Message {
	const out = [`## 📊 omp 状态`, ``, ...info.lines];
	if (info.pending.length > 0) {
		out.push(``, `**待审批**`);
		for (const item of info.pending) {
			out.push(`- \`${item.id}\` \`${item.toolName}\` (等待 ${humanDuration(item.ageMs)})`);
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
