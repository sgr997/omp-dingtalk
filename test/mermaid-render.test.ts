import { expect, test } from "bun:test";
import { renderMermaidFlowcharts } from "../src/platforms/dingtalk/mermaid";

const fence = String.fromCharCode(96).repeat(3);

test("Mermaid subgraphs render as compact directed trees with cross-module links", () => {
	const source = [
		"flowchart LR",
		'subgraph P["平台互联（连接器中心）"]',
		'M["ant-ding manifest"] --> I["npm 装 dws"]',
		'I --> A["dws auth status / login"]',
		'A --> S["装并启用 Skill(dws)"]',
		"end",
		'S --> AG["Agent 会话（Claude/CFuse 引擎）"]',
		'AG -->|子进程| DWSCLI["dws CLI"]',
		'subgraph OB["ONE Box 收件箱"]',
		'P1["Extension 5min 轮询"] --> N["归一化 SourceEvent"]',
		'N --> ST["state.v1.json (24h)"]',
		'ST --> UI["Glass 快照/通知 30s"]',
		'UI --> H["prepareHandling → Session"]',
		"end",
		'P1 -->|dws chat/minutes/calendar| DWSCLI',
		"H --> AG",
		'T["Glass 定时任务完成"] -->|POST /v1/card/deliver| BE["CodeFuse 后端"] --> DING["钉钉 AI 卡片"]',
	].join("\n");

	const rendered = renderMermaidFlowcharts(fence + "mermaid\n" + source + "\n" + fence);

	expect(rendered).toContain("【平台互联（连接器中心）】");
	expect(rendered).toContain("└─→ npm 装 dws");
	expect(rendered).toContain("装并启用 Skill(dws)");
	expect(rendered).toContain("【ONE Box 收件箱】");
	expect(rendered).toContain("【跨模块连接】");
	expect(rendered).toContain("[子进程]→");
	expect(rendered).toContain("└─[dws chat/minutes/calendar]");
	expect(rendered).toContain("[POST /v1/card/deliver]");
	expect(rendered).toContain("CodeFuse 后端");
	expect(rendered).toContain("    └─→ 钉钉 AI 卡片");
	expect(rendered).toContain("后端");
	expect(rendered).not.toContain("- ant-ding manifest →");
});

test("branching flowcharts keep branches visible and preserve edge labels", () => {
	const source = [
		"flowchart TD",
		'subgraph G["入口"]',
		'A["开始"] -->|继续| B["执行"]',
		'A --> C["取消"]',
		"end",
	].join("\n");

	const rendered = renderMermaidFlowcharts(fence + "mermaid\n" + source + "\n" + fence);

	expect(rendered).toContain("├─[继续]→ 执行");
	expect(rendered).toContain("└─→ 取消");
});

test("ordinary prose and non-Mermaid code fences remain unchanged", () => {
	const input = ["说明文字", "", fence + "ts", "const x = 1;", fence, ""].join("\n");
	expect(renderMermaidFlowcharts(input)).toBe(input);
});


test("cycles and joins use distinct references to existing Mermaid nodes", () => {
	const source = [
		"flowchart TD",
		'subgraph G["复用"]',
		'A["入口"] --> B["判断"]',
		'B --> C["回到入口"]',
		'B --> D["快速路径"]',
		'D --> C',
		'C --> A',
		"end",
	].join("\n");

	const rendered = renderMermaidFlowcharts(fence + "mermaid\n" + source + "\n" + fence);

	expect(rendered).toContain("[A] 入口");
	expect(rendered).toContain("↪ [C] 回到入口");
	expect(rendered).toContain("↻ 回到 [A] 入口");
});


test("cycles spanning subgraphs are marked as returns, not joins", () => {
	const source = [
		"flowchart LR",
		'subgraph CLIENT["客户端"]',
		'A["入口"] --> B["鉴权"]',
		"end",
		'subgraph ENGINE["引擎"]',
		'B --> C["请求路由"]',
		'C --> D["执行"]',
		"end",
		'D --> A',
	].join("\n");

	const rendered = renderMermaidFlowcharts(fence + "mermaid\n" + source + "\n" + fence);

	expect(rendered).toContain("↻ 回到 [A] 入口");
});

test("ampersand node groups preserve multi-source, multi-target, and chained edges", () => {
	const render = (source: string): string =>
		renderMermaidFlowcharts(fence + "mermaid\n" + source + "\n" + fence);

	const multiSource = render([
		"flowchart LR",
		'A["来源 A"] & B["来源 B"] --> C["共同终点"]',
	].join("\n"));
	expect(multiSource).toContain("来源 A");
	expect(multiSource).toContain("来源 B");
	expect(multiSource).toContain("共同终点");

	const multiTarget = render([
		"flowchart LR",
		'A["共同来源"] --> B["路径 B"] & C["路径 C"]',
	].join("\n"));
	expect(multiTarget).toContain("路径 B");
	expect(multiTarget).toContain("路径 C");

	const chainedGroups = render([
		"flowchart LR",
		'A["开始"] --> B["分支 B"] & C["分支 C"] --> D["共同终点"]',
	].join("\n"));
	expect(chainedGroups).toContain("[D] 共同终点");
});
