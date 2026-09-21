/**
 * Verifies the plugin loads through OMP's *real* extension loader.
 *
 * `smoke.ts` drives the extension with a mock host, which cannot catch problems
 * that only exist in the loader itself — a broken `node_modules` link, a
 * manifest that resolves to nothing, or a factory that fails to initialize. This
 * script calls the same `discoverAndLoadExtensions()` OMP runs at startup and
 * asserts the plugin shows up with its handlers, tools and commands attached.
 *
 * Run with:  bun test/verify-load.ts
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { homeDir } from "../src/core/util";

const PLUGIN_NAME = "omp-dingtalk";
const EXPECTED_HANDLERS = ["session_start", "turn_start", "turn_end", "session_stop", "session_shutdown", "tool_call", "auto_retry_start", "auto_retry_end", "credential_disabled", "goal_updated", "tool_execution_end"];

let passed = 0;
const failures: string[] = [];
function check(name: string, condition: boolean, extra?: unknown): void {
	if (condition) {
		passed += 1;
		console.log(`  ok   ${name}`);
	} else {
		failures.push(name);
		console.log(`  FAIL ${name}${extra === undefined ? "" : ` :: ${JSON.stringify(extra)}`}`);
	}
}

/** Locate the installed OMP package so its loader can be imported directly. */
function findPackageDir(): string | undefined {
	// `OMP_PACKAGE_DIR` points straight at a package directory.
	const explicit = process.env.OMP_PACKAGE_DIR;
	if (explicit && existsSync(join(explicit, "package.json"))) return explicit;

	// `pi-coding-agent-zh` is the same loader shipped under the zh package name.
	const names = ["pi-coding-agent", "pi-coding-agent-zh"];
	const roots = [
		join(homeDir(), ".bun", "install", "global", "node_modules"),
		join(homeDir(), "node_modules"),
		join(process.cwd(), "node_modules"),
	];
	for (const root of roots) {
		for (const name of names) {
			const dir = join(root, "@oh-my-pi", name);
			if (existsSync(join(dir, "package.json"))) return dir;
		}
	}
	return undefined;
}

const packageDir = findPackageDir();
if (!packageDir) {
	console.error("找不到 @oh-my-pi/pi-coding-agent。设置 OMP_PACKAGE_DIR 指向它的安装目录后重试。");
	process.exit(2);
}
console.log(`使用 OMP 包: ${packageDir}\n`);

const loader = (await import(pathToFileURL(join(packageDir, "src", "extensibility", "extensions", "index.ts")).href)) as {
	discoverAndLoadExtensions: (
		configuredPaths: string[],
		cwd: string,
		eventBus?: unknown,
		disabledExtensionIds?: string[],
		options?: unknown,
	) => Promise<{
		extensions: Array<{
			path: string;
			label?: string;
			handlers: Map<string, unknown[]>;
			tools: Map<string, unknown>;
			commands: Map<string, unknown>;
		}>;
		errors: Array<{ path: string; error: string }>;
	}>;
};

const cwd = process.cwd();
console.log(`[1] discoverAndLoadExtensions(cwd=${cwd})`);
const result = await loader.discoverAndLoadExtensions([], cwd);

console.log(`  发现 ${result.extensions.length} 个扩展，${result.errors.length} 个错误`);
for (const error of result.errors) console.log(`  ! ${error.path}: ${error.error}`);

check("加载过程中没有错误", result.errors.length === 0, result.errors);

const ours = result.extensions.find((extension) => extension.path.replace(/\\/g, "/").includes(PLUGIN_NAME));
check(`插件 ${PLUGIN_NAME} 被 omp 发现并加载`, Boolean(ours), result.extensions.map((e) => e.path));

if (ours) {
	console.log("\n[2] 注册面检查");
	const handlerNames = [...ours.handlers.keys()];
	for (const name of EXPECTED_HANDLERS) {
		check(`订阅了 ${name}`, handlerNames.includes(name), handlerNames);
	}
	check("注册了 dingtalk_notify 工具", ours.tools.has("dingtalk_notify"), [...ours.tools.keys()]);
	check("注册了 /dingtalk 命令", ours.commands.has("dingtalk"), [...ours.commands.keys()]);
	// The dual-surface ask relies on re-registering the native tool by name: the
	// host replaces its registry entry and then hands the re-registration an
	// `ctx.invokeTool` that reaches the *unwrapped* native `ask`. If this
	// assertion ever fails, the plugin silently loses the ability to show the
	// dialog and ask DingTalk at the same time.
	check("重注册了原生 ask 工具（双端提问）", ours.tools.has("ask"), [...ours.tools.keys()]);
	const askTool = ours.tools.get("ask") as any;
	check(
		"重注册的 ask 保留了独占执行属性",
		(askTool?.concurrency ?? askTool?.definition?.concurrency) === "exclusive",
		{ top: askTool?.concurrency, def: askTool?.definition?.concurrency, keys: askTool ? Object.keys(askTool) : null },
	);
	check("每个事件都只有一个 handler", handlerNames.every((name) => ours.handlers.get(name)!.length === 1));
}

console.log(`\n${"=".repeat(56)}`);
if (failures.length === 0) {
	console.log(`全部通过：${passed} 项断言`);
} else {
	console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
	for (const name of failures) console.log(`  - ${name}`);
}
console.log("=".repeat(56));
process.exit(failures.length === 0 ? 0 : 1);
