/**
 * Convert Mermaid flowcharts into compact text trees DingTalk can display.
 *
 * DingTalk does not execute Mermaid fences. A narrow tree layout preserves
 * group nesting and edge direction without the clipping and whitespace of
 * large ASCII boxes. Other code fences and normal prose stay untouched.
 */
type Direction = "LR" | "RL" | "TB" | "TD" | "BT";
type Relation = "forward" | "backward" | "both" | "undirected";

interface FlowNode {
	id: string;
	label: string;
	groupId?: string;
}

interface FlowGroup {
	id: string;
	title: string;
}

interface FlowEdge {
	from: string;
	to: string;
	label?: string;
	relation: Relation;
}

interface NodeToken {
	id: string;
	label: string;
	start: number;
	end: number;
}

const FLOW_HEADER = /^\s*(?:flowchart|graph)\s+(LR|RL|TB|TD|BT)\b/i;
const EDGE_TOKEN = /<-->|<--|-->|---|-.->|==>|--o|--x/;
const NODE_TOKEN = /([A-Za-z_][A-Za-z0-9_.-]*)(?:\s*(\[\[[^\]\n]*\]\]|\[[^\]\n]*\]|\(\([^)\n]*\)\)|\([^)\n]*\)|\{\{[^}\n]*\}\}|\{[^}\n]*\}))?/g;

function plainText(value: string): string {
	return value
		.replace(/<br\s*\/?>/gi, " / ")
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/gi, " ")
		.replace(/&quot;/gi, "\"")
		.replace(/&#39;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&amp;/gi, "&")
		.replace(/\s+/g, " ")
		.trim();
}

function unwrapLabel(value: string): string {
	let label = value.trim();
	if ((label.startsWith("[[") && label.endsWith("]]")) || (label.startsWith("{{") && label.endsWith("}}"))) {
		label = label.slice(2, -2);
	} else if (
		(label.startsWith("[") && label.endsWith("]")) ||
		(label.startsWith("(") && label.endsWith(")")) ||
		(label.startsWith("{") && label.endsWith("}"))
	) {
		label = label.slice(1, -1);
	}
	label = label.trim();
	const tick = String.fromCharCode(96);
	if (
		label.length >= 2 &&
		((label.startsWith("\"") && label.endsWith("\"")) ||
			(label.startsWith("'") && label.endsWith("'")) ||
			(label.startsWith(tick) && label.endsWith(tick)))
	) {
		label = label.slice(1, -1);
	}
	return plainText(label);
}

function nodeTokens(line: string): NodeToken[] {
	const tokens: NodeToken[] = [];
	NODE_TOKEN.lastIndex = 0;
	for (let match = NODE_TOKEN.exec(line); match; match = NODE_TOKEN.exec(line)) {
		tokens.push({
			id: match[1],
			label: match[2] ? unwrapLabel(match[2]) || match[1] : match[1],
			start: match.index,
			end: match.index + match[0].length,
		});
	}
	return tokens;
}

function extractEdgeLabels(line: string): { line: string; labels: Map<number, string> } {
	const labels = new Map<number, string>();
	let nextLabel = 0;
	const marker = (raw: string): string => {
		const id = nextLabel++;
		labels.set(id, plainText(raw));
		return " ⟦" + id + "⟧";
	};
	const withPipeLabels = line.replace(
		/(<-->|<--|-->|---|-.->|==>|--o|--x)\s*\|([^|]+)\|/g,
		(_match, arrow: string, label: string) => arrow + marker(label),
	);
	const normalized = withPipeLabels.replace(/--\s+(.+?)\s+-->/g, (_match, label: string) => "-->" + marker(label));
	return { line: normalized, labels };
}

function relationIn(gap: string): { relation: Relation; reversed: boolean; labelId?: number } | undefined {
	const arrow = EDGE_TOKEN.exec(gap)?.[0];
	if (!arrow) return undefined;
	const marker = /⟦(\d+)⟧/.exec(gap);
	switch (arrow) {
		case "<--":
			return { relation: "backward", reversed: true, labelId: marker ? Number(marker[1]) : undefined };
		case "<-->":
			return { relation: "both", reversed: false, labelId: marker ? Number(marker[1]) : undefined };
		case "---":
			return { relation: "undirected", reversed: false, labelId: marker ? Number(marker[1]) : undefined };
		default:
			return { relation: "forward", reversed: false, labelId: marker ? Number(marker[1]) : undefined };
	}
}


const MAX_TREE_LINE_WIDTH = 36;
const WIDE_CHARACTER = /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u;

function displayWidth(value: string): number {
	return [...value].reduce((width, character) => width + (WIDE_CHARACTER.test(character) ? 2 : 1), 0);
}

function wrapText(value: string, maxWidth: number): string[] {
	const lines: string[] = [];
	let line = "";
	for (const character of value) {
		if (line && displayWidth(line + character) > maxWidth) {
			const space = line.lastIndexOf(" ");
			const slash = line.lastIndexOf("/");
			const splitAt = Math.max(space, slash);
			if (splitAt > 0) {
				const keepDelimiter = splitAt === slash;
				lines.push(line.slice(0, splitAt + (keepDelimiter ? 1 : 0)).trimEnd());
				line = line.slice(splitAt + (keepDelimiter ? 1 : 0)).trimStart() + character;
			} else {
				lines.push(line);
				line = character;
			}
		} else {
			line += character;
		}
	}
	if (line) lines.push(line);
	return lines;
}

function edgeArrow(edge: FlowEdge): string {
	switch (edge.relation) {
		case "backward":
			return "←";
		case "both":
			return "↔";
		case "undirected":
			return "—";
		default:
			return "→";
	}
}

function renderTreeEdge(
	prefix: string,
	branch: "├─" | "└─",
	edge: FlowEdge,
	displayTarget: (id: string) => string,
	cycleReturn = false,
): string[] {
	const relation = cycleReturn ? "↻ 回到 " : edgeArrow(edge) + " ";
	const target = displayTarget(edge.to);
	const label = edge.label ? "[" + edge.label + "]" : "";
	const fullPrefix = prefix + branch + label + relation;
	if (label && displayWidth(fullPrefix + target) > MAX_TREE_LINE_WIDTH) {
		const labelLines = wrapText(label, Math.max(8, MAX_TREE_LINE_WIDTH - displayWidth(prefix + branch)));
		const nextPrefix = prefix + (branch === "└─" ? "  " : "│ ");
		return [
			...labelLines.map((part, index) =>
				index === 0 ? prefix + branch + part : nextPrefix + "  " + part,
			),
			...renderTreeEdge(nextPrefix, "└─", { ...edge, label: undefined }, displayTarget, cycleReturn),
		];
	}

	const targetLines = wrapText(target, Math.max(1, MAX_TREE_LINE_WIDTH - displayWidth(fullPrefix)));
	return [
		fullPrefix + (targetLines[0] ?? ""),
		...targetLines.slice(1).map((part) => prefix + (branch === "└─" ? "    " : "│   ") + part),
	];
}

function renderTreeLines(
	edges: FlowEdge[],
	nodeIds: string[],
	displayNode: (id: string) => string,
	rootLabel: (id: string) => string = displayNode,
	seenNodes: Set<string> = new Set<string>(),
	isCycleEdge: (edge: FlowEdge) => boolean = () => false,
): string[] {
	const nodeOrder = [...nodeIds];
	const adjacency = new Map<string, FlowEdge[]>();
	const incoming = new Set<string>();
	const addNode = (id: string): void => {
		if (!nodeOrder.includes(id)) nodeOrder.push(id);
	};
	for (const edge of edges) {
		addNode(edge.from);
		addNode(edge.to);
		incoming.add(edge.to);
		const outgoing = adjacency.get(edge.from) ?? [];
		outgoing.push(edge);
		adjacency.set(edge.from, outgoing);
	}

	const roots = nodeOrder.filter((id) => !incoming.has(id));
	if (roots.length === 0 && nodeOrder.length > 0) roots.push(nodeOrder[0]);
	const visited = new Set<string>();
	const active = new Set<string>();
	const lines: string[] = [];

	const visit = (id: string, prefix: string, isRoot: boolean): void => {
		if (visited.has(id)) return;
		visited.add(id);
		active.add(id);
		if (isRoot) lines.push(...rootLabel(id).split("\n"));
		const outgoing = adjacency.get(id) ?? [];
		outgoing.forEach((edge, index) => {
			const isLast = index === outgoing.length - 1;
			const branch = isLast ? "└─" : "├─";
			const cycleReturn = isCycleEdge(edge) || active.has(edge.to);
			const targetLabel = cycleReturn
				? displayNode(edge.to)
				: visited.has(edge.to) || seenNodes.has(edge.to)
					? "↪ " + displayNode(edge.to)
					: displayNode(edge.to);
			const displayTarget = (targetId: string): string =>
				targetId === edge.to ? targetLabel : displayNode(targetId);
			lines.push(...renderTreeEdge(prefix, branch, edge, displayTarget, cycleReturn));
			const relation = cycleReturn ? "↻ 回到 " : edgeArrow(edge) + " ";
			const splitLabeledEdge = Boolean(
				edge.label &&
					displayWidth(prefix + branch + "[" + edge.label + "]" + relation + targetLabel) >
						MAX_TREE_LINE_WIDTH,
			);
			if (!visited.has(edge.to)) {
				const childPrefix = prefix + (isLast ? "  " : "│ ") + (splitLabeledEdge ? "  " : "");
				visit(edge.to, childPrefix, false);
			}
		});
		active.delete(id);
	};

	for (const root of [...roots, ...nodeOrder]) {
		if (visited.has(root)) continue;
		if (lines.length > 0) lines.push("");
		visit(root, "", true);
	}
	for (const id of visited) seenNodes.add(id);
	return lines;
}

function parseFlowchart(source: string): string | undefined {
	const groups: FlowGroup[] = [];
	const groupStack: string[] = [];
	const nodes = new Map<string, FlowNode>();
	const edges: FlowEdge[] = [];
	const unparsed: string[] = [];
	let direction: Direction | undefined;

	const addNode = (token: NodeToken): void => {
		const activeGroup = groupStack[groupStack.length - 1];
		const existing = nodes.get(token.id);
		if (!existing) {
			nodes.set(token.id, { id: token.id, label: token.label, groupId: activeGroup });
			return;
		}
		if (existing.label === existing.id && token.label !== token.id) existing.label = token.label;
		if (!existing.groupId && activeGroup) existing.groupId = activeGroup;
	};

	for (const sourceLine of source.split(/\r?\n/)) {
		const line = sourceLine.split("%%", 1)[0].trim();
		if (!line) continue;

		const header = FLOW_HEADER.exec(line);
		if (header) {
			direction = header[1].toUpperCase() as Direction;
			continue;
		}
		const subgraph = /^subgraph\s+([A-Za-z_][A-Za-z0-9_.-]*)(?:\s*(.*))?$/i.exec(line);
		if (subgraph) {
			const id = subgraph[1];
			const title = subgraph[2] ? unwrapLabel(subgraph[2]) || id : id;
			if (!groups.some((group) => group.id === id)) groups.push({ id, title });
			groupStack.push(id);
			continue;
		}
		if (/^end\b/i.test(line)) {
			groupStack.pop();
			continue;
		}
		if (/^direction\s+(?:LR|RL|TB|TD|BT)\b/i.test(line)) continue;
		if (/^(?:style|classDef|class|linkStyle|click|accTitle|accDescr)\b/i.test(line)) continue;

		const normalized = extractEdgeLabels(line);
		const tokens = nodeTokens(normalized.line);
		for (const token of tokens) addNode(token);

		const nodeGroups: NodeToken[][] = tokens.length > 0 ? [[tokens[0]]] : [];
		const groupLinks: {
			from: number;
			to: number;
			relationship: NonNullable<ReturnType<typeof relationIn>>;
		}[] = [];
		let validSequence = true;
		for (let index = 0; index < tokens.length - 1; index++) {
			const left = tokens[index];
			const right = tokens[index + 1];
			const gap = normalized.line.slice(left.end, right.start);
			const relationship = relationIn(gap);
			if (relationship) {
				const from = nodeGroups.length - 1;
				nodeGroups.push([right]);
				groupLinks.push({ from, to: nodeGroups.length - 1, relationship });
			} else if (gap.includes("&")) {
				nodeGroups[nodeGroups.length - 1].push(right);
			} else {
				validSequence = false;
				break;
			}
		}
		if (!validSequence) {
			if (EDGE_TOKEN.test(normalized.line)) unparsed.push(sourceLine.trim());
			continue;
		}

		for (const link of groupLinks) {
			const label =
				link.relationship.labelId === undefined ? undefined : normalized.labels.get(link.relationship.labelId);
			for (const left of nodeGroups[link.from]) {
				for (const right of nodeGroups[link.to]) {
					edges.push({
						from: link.relationship.reversed ? right.id : left.id,
						to: link.relationship.reversed ? left.id : right.id,
						relation: link.relationship.relation,
						label,
					});
				}
			}
		}
		if (EDGE_TOKEN.test(normalized.line) && groupLinks.length === 0) unparsed.push(sourceLine.trim());
	}

	if (edges.length === 0) return undefined;

	const edgesByGroup = new Map<string, FlowEdge[]>();
	const crossGroup: FlowEdge[] = [];
	const outsideGroups: FlowEdge[] = [];
	for (const edge of edges) {
		const fromGroup = nodes.get(edge.from)?.groupId;
		const toGroup = nodes.get(edge.to)?.groupId;
		if (fromGroup && fromGroup === toGroup) {
			const grouped = edgesByGroup.get(fromGroup) ?? [];
			grouped.push(edge);
			edgesByGroup.set(fromGroup, grouped);
		} else if (fromGroup || toGroup) {
			crossGroup.push(edge);
		} else {
			outsideGroups.push(edge);
		}
	}

	const incomingCounts = new Map<string, number>();
	const adjacency = new Map<string, FlowEdge[]>();
	for (const edge of edges) {
		incomingCounts.set(edge.to, (incomingCounts.get(edge.to) ?? 0) + 1);
		const outgoing = adjacency.get(edge.from) ?? [];
		outgoing.push(edge);
		adjacency.set(edge.from, outgoing);
	}

	const edgeIdentity = (edge: FlowEdge): string =>
		edge.from + "\0" + edge.to + "\0" + edge.relation + "\0" + (edge.label ?? "");
	const referenceNodeIds = new Set(
		[...incomingCounts].filter(([, count]) => count > 1).map(([id]) => id),
	);
	const cycleEdgeIds = new Set<string>();
	const visitState = new Map<string, "visiting" | "done">();
	const path: string[] = [];
	const markCycleNodes = (id: string): void => {
		visitState.set(id, "visiting");
		path.push(id);
		for (const edge of adjacency.get(id) ?? []) {
			if (visitState.get(edge.to) === "visiting") {
				const cycleStart = path.lastIndexOf(edge.to);
				for (const cycleId of path.slice(cycleStart)) referenceNodeIds.add(cycleId);
				cycleEdgeIds.add(edgeIdentity(edge));
			} else if (!visitState.has(edge.to)) {
				markCycleNodes(edge.to);
			}
		}
		path.pop();
		visitState.set(id, "done");
	};
	for (const id of nodes.keys()) {
		if (!visitState.has(id)) markCycleNodes(id);
	}

	const displayNode = (id: string): string => {
		const label = nodes.get(id)?.label ?? id;
		return referenceNodeIds.has(id) ? "[" + id + "] " + label : label;
	};
	const treeLines: string[] = [];
	const seenNodes = new Set<string>();

	for (const group of groups) {
		const groupEdges = edgesByGroup.get(group.id) ?? [];
		const groupNodes = [...nodes.values()].filter((node) => node.groupId === group.id).map((node) => node.id);
		if (groupEdges.length === 0 && groupNodes.length === 0) continue;
		if (treeLines.length > 0) treeLines.push("");
		treeLines.push("【" + group.title + "】");
		treeLines.push(...renderTreeLines(groupEdges, groupNodes, displayNode, displayNode, seenNodes, (edge) => cycleEdgeIds.has(edgeIdentity(edge))));
	}

	const externalEdges = [...crossGroup, ...outsideGroups];
	if (externalEdges.length > 0) {
		if (treeLines.length > 0) treeLines.push("");
		treeLines.push("【跨模块连接】");
		const externalNodeIds = [...new Set(externalEdges.flatMap((edge) => [edge.from, edge.to]))];
		const externalRootLabel = (id: string): string => {
			const groupId = nodes.get(id)?.groupId;
			const group = groups.find((candidate) => candidate.id === groupId);
			return group ? "【" + group.title + "】\n" + displayNode(id) : displayNode(id);
		};
		treeLines.push(...renderTreeLines(externalEdges, externalNodeIds, displayNode, externalRootLabel, seenNodes, (edge) => cycleEdgeIds.has(edgeIdentity(edge))));
	}

	if (unparsed.length > 0) {
		if (treeLines.length > 0) treeLines.push("");
		treeLines.push("【未识别的连接语句】");
		treeLines.push(...unparsed.map((line) => "  " + plainText(line)));
	}

	const heading = direction ? "流程图（原方向：" + direction + "；窄屏结构）" : "流程图（窄屏结构）";
	const fence = String.fromCharCode(96).repeat(3);
	return "**" + heading + "**\n\n" + fence + "text\n" + treeLines.join("\n") + "\n" + fence;
}

function isFlowStatement(line: string): boolean {
	const trimmed = line.trim();
	return (
		FLOW_HEADER.test(trimmed) ||
		/^subgraph\b/i.test(trimmed) ||
		/^end\b/i.test(trimmed) ||
		/^direction\s+(?:LR|RL|TB|TD|BT)\b/i.test(trimmed) ||
		/^(?:style|classDef|class|linkStyle|click|accTitle|accDescr|%%)\b/i.test(trimmed) ||
		EDGE_TOKEN.test(trimmed) ||
		/^[A-Za-z_][A-Za-z0-9_.-]*\s*(?:\[\[[^\]]*\]\]|\[[^\]]*\]|\([^)]*\)|\{[^}]*\})$/.test(trimmed)
	);
}

function isFenceEnd(line: string, minimumLength: number): boolean {
	const trimmed = line.trim();
	return trimmed.length >= minimumLength && [...trimmed].every((char) => char === String.fromCharCode(96));
}

/**
 * Render Mermaid flowchart/graph blocks as compact text trees for DingTalk.
 * Fenced blocks with other languages and normal prose are kept unchanged.
 */
export function renderMermaidFlowcharts(text: string): string {
	const lines = text.split(/\r?\n/);
	const output: string[] = [];
	let index = 0;

	while (index < lines.length) {
		const fence = /^\s*(\x60{3,})\s*([^\s\x60]+)?(?:\s+.*)?$/.exec(lines[index]);
		if (fence) {
			const minimumLength = fence[1].length;
			let end = index + 1;
			while (end < lines.length && !isFenceEnd(lines[end], minimumLength)) end++;
			if (end >= lines.length) {
				output.push(...lines.slice(index));
				break;
			}
			const language = (fence[2] ?? "").toLowerCase();
			const original = lines.slice(index, end + 1);
			const body = lines.slice(index + 1, end).join("\n");
			const hasFlowHeader = body.split(/\r?\n/).some((line) => FLOW_HEADER.test(line));
			const mermaidFence = language === "mermaid" || ((!language || language === "text" || language === "plaintext") && hasFlowHeader);
			const rendered = mermaidFence ? parseFlowchart(body) : undefined;
			output.push(...(rendered ? rendered.split("\n") : original));
			index = end + 1;
			continue;
		}

		if (FLOW_HEADER.test(lines[index])) {
			let end = index + 1;
			while (end < lines.length) {
				if (lines[end].trim()) {
					if (!isFlowStatement(lines[end])) break;
					end++;
					continue;
				}
				let next = end + 1;
				while (next < lines.length && !lines[next].trim()) next++;
				if (next >= lines.length || !isFlowStatement(lines[next])) break;
				end = next;
			}
			const original = lines.slice(index, end);
			const rendered = parseFlowchart(original.join("\n"));
			output.push(...(rendered ? rendered.split("\n") : original));
			index = end;
			continue;
		}

		output.push(lines[index]);
		index++;
	}

	return output.join("\n");
}
