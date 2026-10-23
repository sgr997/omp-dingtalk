import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), 'omp-state-review-'));
for (const key of Object.keys(process.env)) {
  if (key.startsWith('DINGTALK_') || key.startsWith('OMP_DINGTALK_')) delete process.env[key];
}
process.env.OMP_DINGTALK_CONFIG = join(scratch, 'config.json');
process.env.OMP_DINGTALK_LOCK_DIR = join(scratch, 'locks');
process.env.OMP_DINGTALK_MIN_GAP_MS = '1';
const cfg = {
  enabled: true,
  outbound: { mode: 'direct' },
  stream: { enabled: true, clientId: 'app-A', clientSecret: 'fake-A', robotCode: 'robot-A' },
  control: { enabled: true, autoTakeover: false, allowUserId: 'operator', scope: 'direct' },
  notify: { sessionShutdown: false },
  robots: { beta: { stream: { enabled: true, clientId: 'app-B', clientSecret: 'fake-B', robotCode: 'robot-B' } } },
};
writeFileSync(process.env.OMP_DINGTALK_CONFIG!, JSON.stringify(cfg));
const log = { debug() {}, info() {}, warn() {}, error() {} };
let calls: any[] = [];
let holdTitle = '';
let releaseHold: (() => void) | undefined;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(input);
  const body = init.body ? JSON.parse(init.body) : {};
  calls.push({ url, body, headers: init.headers });
  if (holdTitle && body.msgParam && String(JSON.parse(body.msgParam).title ?? '').endsWith(holdTitle)) {
    await new Promise<void>(resolve => releaseHold = resolve);
  }
  const data = url.includes('/gateway/') ? { endpoint: 'wss://fake.invalid', ticket: 'fake' }
    : url.includes('/oauth2/') ? { accessToken: `TOKEN:${body.appKey}`, expireIn: 7200 }
    : { errcode: 0 };
  return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) } as Response;
}) as any;
class Socket {
  static instances: Socket[] = [];
  static OPEN = 1;
  readyState = 1;
  onopen?: () => void;
  onmessage?: (event: any) => void;
  onclose?: () => void;
  constructor(public url: string) { Socket.instances.push(this); }
  close() { this.readyState = 3; this.onclose?.(); }
  send(_data: string) {}
  frame(text: string) {
    this.onmessage?.({ data: JSON.stringify({ type: 'CALLBACK', headers: { messageId: Math.random().toString() }, data: JSON.stringify({ conversationType: '1', senderStaffId: 'operator', text: { content: text } }) }) });
  }
}
globalThis.WebSocket = Socket as any;
const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const { loadConfig, resolveRobotConfig } = await import(`${root}/src/platforms/dingtalk/config.ts`);
const { DingTalkSender } = await import(`${root}/src/platforms/dingtalk/sender.ts`);
const loaded = loadConfig(scratch).config;
const sender = new DingTalkSender(loaded, log);
await sender.send({ title: 'first', text: 'first' });
sender.updateConfig(resolveRobotConfig(loaded, 'beta'));
await sender.send({ title: 'second', text: 'second' });
console.log('TOKEN_CACHE', JSON.stringify(calls.filter(c => c.url.includes('/oauth2/') || c.url.includes('/batchSend')).map(c => ({ kind: c.url.includes('/oauth2/') ? 'token' : 'send', app: c.body.appKey, robot: c.body.robotCode, token: c.headers?.['x-acs-dingtalk-access-token'] }))));

const { default: factory } = await import(`${root}/src/index.ts?ctx-review`);
const handlers = new Map<string, any>();
let command: any;
const tools = new Map<string, any>();
const schema = (): any => {
  const item: any = { describe: () => item, optional: () => item, min: () => item, default: () => item };
  return item;
};
const zod = Object.fromEntries(['object', 'array', 'string', 'number', 'boolean', 'enum'].map(key => [key, schema]));
let aborts: string[] = [];
let notices: string[] = [];
factory({ logger: log, zod, on: (name: string, fn: any) => handlers.set(name, fn), registerCommand: (_name: string, opts: any) => command = opts, registerTool: (tool: any) => tools.set(tool.name, tool), sendUserMessage() {} } as any);
const ctx = (id: string) => ({ cwd: scratch, hasUI: true, mode: 'tui', sessionManager: { getSessionId: () => id, getBranch: () => [] }, ui: { notify: (text: string) => notices.push(text) }, abort: () => aborts.push(id), isIdle: () => false });
const a = ctx('session-A');
const b = ctx('session-B');
await handlers.get('session_start')({}, a);
await command.handler('takeover', a);
await tick();
await handlers.get('session_start')({}, b);
await command.handler('status', b);
Socket.instances.at(-1)!.frame('/stop');
await tick();
console.log('FOREIGN_STATUS_CTX', JSON.stringify({ aborts, stillBoundToA: notices.at(-1)?.includes('桥绑定会话**: session-A'), warnedMismatch: notices.at(-1)?.includes('归属不符') }));
await command.handler('release', a);

// A direct awaited send bypasses Bridge.notify's notification generation.
const { Bridge } = await import(`${root}/src/core/bridge.ts`);
const { dingtalkAdapter } = await import(`${root}/src/platforms/dingtalk/adapter.ts`);
const bridge = new Bridge({ logger: log, sendUserMessage() {} } as any, scratch, dingtalkAdapter);
bridge.takeOver();
calls = [];
holdTitle = 'hold';
const held = bridge.sender.send({ title: 'hold', text: 'occupy queue' });
while (!releaseHold) await tick(1);
const queued = bridge.sender.send({ title: 'model notification queued before release', text: 'queued direct send' });
bridge.release();
(releaseHold as (() => void) | undefined)?.();
await held;
const result = await queued;
console.log('DIRECT_SEND_AFTER_RELEASE', JSON.stringify({ result, messages: calls.filter(c => c.body.msgParam).map(c => JSON.parse(c.body.msgParam).title) }));
bridge.dispose('test finished');

// Verify the real model-facing tool entry point has the same gap.
holdTitle = '';
await command.handler('takeover', a);
await tick();
holdTitle = 'omp 测试消息';
releaseHold = undefined;
const testSend = command.handler('test', a);
while (!releaseHold) await tick(1);
calls = [];
const toolResult = tools.get('dingtalk_notify').execute('review-call', { title: 'queued model tool', message: 'queued before release' }, undefined, undefined, a);
await command.handler('release', a);
(releaseHold as (() => void) | undefined)?.();
await testSend;
console.log('MODEL_TOOL_AFTER_RELEASE', JSON.stringify({ result: (await toolResult).details, messages: calls.filter(c => c.body.msgParam).map(c => JSON.parse(c.body.msgParam).title) }));
