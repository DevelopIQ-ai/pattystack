import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CodexAppServerAdapter } from '../src/codex.js';
import { ToolBridge } from '../src/tool-bridge.js';
import { PattyDaemon } from '../src/server.js';

type Request = { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: { code?: number } };
const officialThread = { id: 'thread-1', sessionId: 'session-1', preview: '', ephemeral: true, modelProvider: 'openai', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, cwd: '/tmp', cliVersion: '0.145.0', source: 'unknown', turns: [] };
const officialTurn = (status: 'inProgress' | 'completed') => ({ id: 'turn-1', items: [], itemsView: 'full', status, error: null, startedAt: 1, completedAt: status === 'completed' ? 2 : null, durationMs: status === 'completed' ? 1_000 : null });
const officialThreadStartResponse = { thread: officialThread, model: 'gpt-5-codex', modelProvider: 'openai', serviceTier: null, cwd: '/tmp', instructionSources: [], approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false }, reasoningEffort: null };
const officialTurnStartResponse = { turn: officialTurn('inProgress') };
const officialTurnStarted = { threadId: 'thread-1', turn: officialTurn('inProgress') };
const officialTurnCompleted = { threadId: 'thread-1', turn: officialTurn('completed') };
const officialDelta = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'x' };
const officialInitializeResponse = { userAgent: 'codex-test', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' };
const officialLoginResponse = { type: 'chatgptDeviceCode', loginId: 'login-1', verificationUrl: 'https://example.invalid', userCode: 'CODE' };
const officialCancelResponse = { status: 'canceled' };
const officialAccountResponse = { account: { type: 'chatgpt', email: null, planType: 'plus' }, requiresOpenaiAuth: false };
const officialRateLimitsResponse = { rateLimits: { limitId: null, limitName: null, primary: { usedPercent: 10, windowDurationMins: null, resetsAt: 100 }, secondary: { usedPercent: 125, windowDurationMins: null, resetsAt: 200 }, credits: null, individualLimit: null, spendControlReached: null, planType: null, rateLimitReachedType: null }, rateLimitsByLimitId: null, rateLimitResetCredits: null };
const officialModelListResponse = { data: [{ id: 'model-id', model: 'gpt-5-codex', displayName: 'GPT-5 Codex', description: 'fixture', hidden: false, supportedReasoningEfforts: [], defaultReasoningEffort: 'medium', isDefault: true }], nextCursor: null };
const fixtureSource = `#!/usr/bin/env node
if(process.argv.includes('--version')){console.log('codex-cli 0.145.0');process.exit(0)}
const fs=require('node:fs'),path=require('node:path'),log=path.join(__dirname,'requests.jsonl');fs.writeFileSync(path.join(__dirname,'pid'),String(process.pid));
const threadStart=${JSON.stringify(officialThreadStartResponse)},turnStart=${JSON.stringify(officialTurnStartResponse)},turnStarted=${JSON.stringify(officialTurnStarted)},turnCompleted=${JSON.stringify(officialTurnCompleted)},delta=${JSON.stringify(officialDelta)},modelList=${JSON.stringify(officialModelListResponse)};
const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{fs.appendFileSync(log,line+'\\n');const r=JSON.parse(line),out=x=>process.stdout.write(JSON.stringify(x)+'\\n');if(r.method==='initialize'){out({jsonrpc:'2.0',id:r.id,result:{...${JSON.stringify(officialInitializeResponse)},codexHome:process.env.CODEX_HOME}});return}if(r.method==='thread/start'){out({jsonrpc:'2.0',id:r.id,result:threadStart});return}if(r.method==='turn/start'){out({jsonrpc:'2.0',id:r.id,result:turnStart});out({jsonrpc:'2.0',method:'turn/started',params:turnStarted});out({jsonrpc:'2.0',method:'item/agentMessage/delta',params:delta});out({jsonrpc:'2.0',id:99,method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',turnId:'turn-1',itemId:'item-2',startedAtMs:0,environmentId:null}});return}if(r.id===99&&r.result){out({jsonrpc:'2.0',method:'turn/completed',params:turnCompleted});return}if(r.method==='account/login/start'){out({jsonrpc:'2.0',id:r.id,result:${JSON.stringify(officialLoginResponse)}});return}if(r.method==='account/login/cancel'){out({jsonrpc:'2.0',id:r.id,result:${JSON.stringify(officialCancelResponse)}});return}if(r.method==='turn/interrupt'){out({jsonrpc:'2.0',id:r.id,result:{}});return}if(r.method==='account/logout'){out({jsonrpc:'2.0',id:r.id,result:{}});return}if(r.method==='account/read'){out({jsonrpc:'2.0',id:r.id,result:${JSON.stringify(officialAccountResponse)}});return}if(r.method==='model/list'){out({jsonrpc:'2.0',id:r.id,result:modelList});return}if(r.method==='account/rateLimits/read'){out({jsonrpc:'2.0',id:r.id,result:${JSON.stringify(officialRateLimitsResponse)}});return}out({jsonrpc:'2.0',id:r.id,result:{}})})`;
async function fixture(source = fixtureSource) { const dir = await mkdtemp(join(tmpdir(), 'patty-rpc-')); const command = join(dir, 'codex'); await writeFile(command, source); await chmod(command, 0o700); return { dir, command }; }
async function requests(dir: string): Promise<Request[]> { const data = await readFile(join(dir, 'requests.jsonl'), 'utf8'); return data.trim() ? data.trim().split('\n').map(line => JSON.parse(line) as Request) : []; }
async function waitForRequest(dir: string, predicate: (request: Request) => boolean) { for (let attempt = 0; attempt < 50; attempt++) { const match = (await requests(dir)).find(predicate); if (match) return match; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('fixture request was not observed'); }

async function schema(name: string) { return JSON.parse(await readFile(resolve(import.meta.dirname, `../../../packages/codex-protocol/generated/schemas/${name}.json`), 'utf8')) as object; }

/** The fixture announces its pid as its first action, but a 20ms rpc timeout can kill it during node's own startup, so a missing pid file is itself proof nothing was left running. Otherwise wait for the announced child to be reaped. */
const reapedChild = async (dir: string, timeoutMs = 5_000) => { let pid = 0;
  try { pid = Number(await readFile(join(dir, 'pid'), 'utf8')); } catch { return; }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { try { process.kill(pid, 0); } catch { return; } await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(`child ${pid} still alive`); };
describe('official 0.145.0 app-server contract', () => {
  it('schema-validates and emits exact model-bearing thread and turn payloads', async () => { const { dir, command } = await fixture(); const adapter = new CodexAppServerAdapter(command, [], dir, '0.145.0'); await adapter.start(); const events: string[] = []; await adapter.run(undefined, 'gpt-5-codex', 'x', event => events.push(event.type)); await new Promise(resolve => setTimeout(resolve, 10)); await adapter.approve('99', false); const sent = await requests(dir); const thread = sent.find(request => request.method === 'thread/start')!; const turn = sent.find(request => request.method === 'turn/start')!; const Ajv = (await import('ajv')).default as unknown as new (options: { strict: boolean; validateFormats: boolean }) => { compile: (schema: object) => (data: unknown) => boolean }; const ajv = new Ajv({ strict: false, validateFormats: false }); for (const [name, value] of [['ThreadStartParams', thread.params], ['TurnStartParams', turn.params], ['ThreadStartResponse', officialThreadStartResponse], ['TurnStartResponse', officialTurnStartResponse], ['TurnStartedNotification', officialTurnStarted], ['AgentMessageDeltaNotification', officialDelta], ['TurnCompletedNotification', officialTurnCompleted], ['ModelListResponse', officialModelListResponse]] as const) expect(ajv.compile(await schema(name))(value), name).toBe(true); expect(thread.params).toEqual({ model: 'gpt-5-codex', ephemeral: true }); expect(turn.params).toEqual({ threadId: 'thread-1', model: 'gpt-5-codex', input: [{ type: 'text', text: 'x', text_elements: [] }] }); expect(events).toEqual(['started', 'delta', 'approval_required', 'completed']); await adapter.shutdown(); });
  it('sends a caller schema as the turn output schema, in the shape the official params allow', async () => { const { dir, command } = await fixture(); const adapter = new CodexAppServerAdapter(command, [], dir, '0.145.0'); await adapter.start(); const outputSchema = { type: 'object', properties: { company_name: { type: 'string' } }, required: ['company_name'], additionalProperties: false }; await adapter.run(undefined, 'gpt-5-codex', 'x', () => undefined, undefined, { responseFormat: { type: 'json_schema', json_schema: { name: 'company', strict: true, schema: outputSchema } } }); const turn = (await requests(dir)).find(request => request.method === 'turn/start')!; const Ajv = (await import('ajv')).default as unknown as new (options: { strict: boolean; validateFormats: boolean }) => { compile: (schema: object) => (data: unknown) => boolean }; expect(new Ajv({ strict: false, validateFormats: false }).compile(await schema('TurnStartParams'))(turn.params)).toBe(true); expect(turn.params).toEqual({ threadId: 'thread-1', model: 'gpt-5-codex', input: [{ type: 'text', text: 'x', text_elements: [] }], outputSchema }); await adapter.shutdown(); });
  /** A subscription cannot be handed the caller's functions directly, so the turn's thread names an MCP server that publishes them and Codex is told not to stop for approval on its own tools. */
  it('publishes the caller’s tools to the turn as an MCP server the app-server can start', async () => {
    const { dir, command } = await fixture();
    const bridge = new ToolBridge(() => 'http://127.0.0.1:1');
    const adapter = new CodexAppServerAdapter(command, [], dir, '0.145.0', undefined, bridge);
    await adapter.start();
    await adapter.run(undefined, 'gpt-5-codex', 'weather?', () => undefined, { messages: [], tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: {} } } }] });
    const thread = (await requests(dir)).find(request => request.method === 'thread/start')!;
    const Ajv = (await import('ajv')).default as unknown as new (options: { strict: boolean; validateFormats: boolean }) => { compile: (schema: object) => (data: unknown) => boolean };
    expect(new Ajv({ strict: false, validateFormats: false }).compile(await schema('ThreadStartParams'))(thread.params)).toBe(true);
    const params = thread.params as { approvalPolicy?: string; developerInstructions?: string; config?: { features?: Record<string, boolean>; mcp_servers?: { patty?: { command?: string; args?: string[]; env?: Record<string, string>; default_tools_approval_mode?: string } } } };
    expect(params.approvalPolicy).toBe('never');
    /** Without approve the app-server cancels the model's call to the caller's own function; without the preamble the model never learns the function exists. */
    expect(params.config?.mcp_servers?.patty?.default_tools_approval_mode).toBe('approve');
    expect(params.config?.features).toMatchObject({ non_prefixed_mcp_tool_names: true });
    expect(params.developerInstructions).toContain('get_weather');
    expect(params.developerInstructions).toContain('tool_search');
    expect(params.config?.mcp_servers?.patty?.command).toBe(process.execPath);
    expect(params.config?.mcp_servers?.patty?.args?.[0]).toMatch(/mcp-bridge\.js$/);
    /** The one-turn session token is the bridge's whole authority: it is never a Patty API key. */
    expect(params.config?.mcp_servers?.patty?.env?.PATTY_BRIDGE_TOKEN).toMatch(/^[\w-]{20,}$/);
    expect(params.config?.mcp_servers?.patty?.env?.PATTY_BRIDGE_URL).toBe('http://127.0.0.1:1');
    await adapter.shutdown();
  });

  it('sends the caller’s system prompt as developer instructions and the effort on the turn', async () => { const { dir, command } = await fixture(); const adapter = new CodexAppServerAdapter(command, [], dir, '0.145.0'); await adapter.start(); await adapter.run(undefined, 'gpt-5-codex', 'x', () => undefined, undefined, { instructions: 'be terse', reasoningEffort: 'high' }); const sent = await requests(dir); const thread = sent.find(request => request.method === 'thread/start')!; const turn = sent.find(request => request.method === 'turn/start')!; const Ajv = (await import('ajv')).default as unknown as new (options: { strict: boolean; validateFormats: boolean }) => { compile: (schema: object) => (data: unknown) => boolean }; const ajv = new Ajv({ strict: false, validateFormats: false }); for (const [name, value] of [['ThreadStartParams', thread.params], ['TurnStartParams', turn.params]] as const) expect(ajv.compile(await schema(name))(value), name).toBe(true); expect(thread.params).toEqual({ model: 'gpt-5-codex', ephemeral: true, developerInstructions: 'be terse' }); expect(turn.params).toEqual({ threadId: 'thread-1', model: 'gpt-5-codex', input: [{ type: 'text', text: 'x', text_elements: [] }], effort: 'high' }); await adapter.shutdown(); });
  it('carries this turn’s rules in the prompt when the caller opened the thread earlier', async () => { const { dir, command } = await fixture(); const adapter = new CodexAppServerAdapter(command, [], dir, '0.145.0'); await adapter.start(); await adapter.run('thread-1', 'gpt-5-codex', 'x', () => undefined, undefined, { instructions: 'be terse' }); const sent = await requests(dir); expect(sent.find(request => request.method === 'thread/start')).toBeUndefined(); expect(sent.find(request => request.method === 'turn/start')!.params).toEqual({ threadId: 'thread-1', model: 'gpt-5-codex', input: [{ type: 'text', text: 'be terse\n\nx', text_elements: [] }] }); await adapter.shutdown(); });
  it('schema-validates exercised login, cancel, account, quota, interrupt, approval, and logout request envelopes', async () => { const { dir, command } = await fixture(); const adapter = new CodexAppServerAdapter(command, [], dir, '0.145.0'); await adapter.start(); await adapter.login('device_code'); await adapter.cancelLogin(); await adapter.snapshot(); await adapter.run(undefined, 'gpt-5-codex', 'x', () => undefined); await adapter.interrupt('turn-1'); await new Promise(resolve => setTimeout(resolve, 10)); await adapter.approve('99', false); await adapter.logout(); const Ajv = (await import('ajv')).default as unknown as new (options: { strict: boolean; validateFormats: boolean }) => { compile: (schema: object) => (data: unknown) => boolean }; const ajv = new Ajv({ strict: false, validateFormats: false }); const sent = await requests(dir); for (const [method, name] of [['initialize','InitializeParams'], ['account/login/start','LoginAccountParams'], ['account/login/cancel','CancelLoginAccountParams'], ['account/read','GetAccountParams'], ['turn/interrupt','TurnInterruptParams']] as const) { const request = sent.find(item => item.method === method); expect(request, `missing ${method}`).toBeTruthy(); expect(ajv.compile(await schema(name))(request!.params), `${method} params`).toBe(true); } for (const method of ['account/rateLimits/read', 'account/logout']) expect(sent.find(item => item.method === method), `missing ${method}`).toMatchObject({ method }); expect(sent.find(item => item.method === 'account/rateLimits/read')).not.toHaveProperty('params'); expect(sent.find(item => item.method === 'account/logout')).not.toHaveProperty('params'); expect(sent.find(item => item.id === 99)?.result).toEqual({ decision: 'decline' }); await adapter.shutdown(); });
  it('schema-validates exact exercised response and approval fixtures', async () => { const Ajv = (await import('ajv')).default as unknown as new (options: { strict: boolean; validateFormats: boolean }) => { compile: (schema: object) => (data: unknown) => boolean }; const ajv = new Ajv({ strict: false, validateFormats: false }); for (const [name, value] of [['InitializeResponse', officialInitializeResponse], ['LoginAccountResponse', officialLoginResponse], ['CancelLoginAccountResponse', officialCancelResponse], ['GetAccountResponse', officialAccountResponse], ['GetAccountRateLimitsResponse', officialRateLimitsResponse], ['TurnInterruptResponse', {}], ['CommandExecutionRequestApprovalResponse', { decision: 'decline' }]] as const) expect(ajv.compile(await schema(name))(value), name).toBe(true); });
  it('uses the most restrictive primary or secondary rate-limit window and its reset', async () => { const secondary = await fixture(); const secondaryAdapter = new CodexAppServerAdapter(secondary.command, [], secondary.dir, '0.145.0'); await secondaryAdapter.start(); const secondarySnapshot = await secondaryAdapter.snapshot(); expect(secondarySnapshot.quota.remaining).toBe(0); expect(secondarySnapshot.quota.resetAt).toBe(new Date(200_000).toISOString()); await secondaryAdapter.shutdown(); const primary = await fixture(fixtureSource.replace('\"usedPercent\":10,\"windowDurationMins\":null,\"resetsAt\":100', '\"usedPercent\":80,\"windowDurationMins\":null,\"resetsAt\":300').replace('\"usedPercent\":125,\"windowDurationMins\":null,\"resetsAt\":200', '\"usedPercent\":20,\"windowDurationMins\":null,\"resetsAt\":400')); const primaryAdapter = new CodexAppServerAdapter(primary.command, [], primary.dir, '0.145.0'); await primaryAdapter.start(); const primarySnapshot = await primaryAdapter.snapshot(); expect(primarySnapshot.quota.remaining).toBeCloseTo(.2); expect(primarySnapshot.quota.resetAt).toBe(new Date(300_000).toISOString()); await primaryAdapter.shutdown(); });
  it('uses the latest reset when restrictive windows tie', async () => { const tied = await fixture(fixtureSource.replace('\"usedPercent\":10,\"windowDurationMins\":null,\"resetsAt\":100', '\"usedPercent\":80,\"windowDurationMins\":null,\"resetsAt\":300').replace('\"usedPercent\":125,\"windowDurationMins\":null,\"resetsAt\":200', '\"usedPercent\":80,\"windowDurationMins\":null,\"resetsAt\":400')); const adapter = new CodexAppServerAdapter(tied.command, [], tied.dir, '0.145.0'); await adapter.start(); expect((await adapter.snapshot()).quota.resetAt).toBe(new Date(400_000).toISOString()); await adapter.shutdown(); });
  it('reproduces the documented canonical schema digest', () => { const source = resolve(import.meta.dirname, '../../../packages/codex-protocol/generated/schemas/codex_app_server_protocol.v2.schemas.json'); const digest = execFileSync(process.execPath, ['scripts/canonical-schema-digest.mjs', source], { cwd: resolve(import.meta.dirname, '../../..'), encoding: 'utf8' }).trim(); const repeat = execFileSync(process.execPath, ['scripts/canonical-schema-digest.mjs', source], { cwd: resolve(import.meta.dirname, '../../..'), encoding: 'utf8' }).trim(); expect(digest).toBe(repeat); expect(digest).toBe('02d8bf6651cd504bff0335f566c011e51ba77c5cc0538cb64ca7ac57739a1597'); });
  it('returns a response for mapped approvals and JSON-RPC method errors for every unsupported id request', async () => { const source = fixtureSource.replace("out({jsonrpc:'2.0',id:99,method:'item/commandExecution/requestApproval'", "out({jsonrpc:'2.0',id:100,method:'item/permissions/requestApproval',params:{threadId:'thread-1',turnId:'turn-1'}});out({jsonrpc:'2.0',id:99,method:'item/commandExecution/requestApproval'"); const { dir, command } = await fixture(source); const adapter = new CodexAppServerAdapter(command, [], dir, '0.145.0'); await adapter.start(); await adapter.run(undefined, 'gpt-5-codex', 'x', () => undefined); await new Promise(resolve => setTimeout(resolve, 10)); await adapter.approve('99', true); expect((await waitForRequest(dir, request => request.id === 99 && request.result !== undefined)).result).toEqual({ decision: 'accept' }); expect((await waitForRequest(dir, request => request.id === 100 && request.error?.code === -32601)).error?.code).toBe(-32601); await adapter.shutdown(); });
  it('associates legacy approval requests queued by conversation before turn/start responds', async () => { const source = fixtureSource.replace("if(r.method==='turn/start'){out({jsonrpc:'2.0',id:r.id,result:turnStart});", "if(r.method==='turn/start'){out({jsonrpc:'2.0',id:77,method:'applyPatchApproval',params:{conversationId:'thread-1',callId:'call-1',fileChanges:{},reason:null,grantRoot:null}});out({jsonrpc:'2.0',id:r.id,result:turnStart});"); const { dir, command } = await fixture(source); const adapter = new CodexAppServerAdapter(command, [], dir, '0.145.0'); await adapter.start(); const events: string[] = []; await adapter.run(undefined, 'gpt-5-codex', 'x', event => events.push(event.type)); expect(events).toContain('approval_required'); await adapter.approve('77', false); expect((await waitForRequest(dir, item => item.id === 77 && item.result !== undefined)).result).toEqual({ decision: 'abort' }); await adapter.shutdown(); });
  it('rejects initialize home mismatch and cleans up the child', async () => { const source = fixtureSource.replace('codexHome:process.env.CODEX_HOME', "codexHome:'/tmp'"); const { dir, command } = await fixture(source); const adapter = new CodexAppServerAdapter(command, [], dir, '0.145.0'); await expect(adapter.start()).rejects.toThrow('protocol_incompatible'); await reapedChild(dir); });
  it('classifies a nonexistent initialize home as protocol incompatible and cleans up', async () => { const source = fixtureSource.replace('codexHome:process.env.CODEX_HOME', "codexHome:'/definitely/missing-codex-home'"); const { dir, command } = await fixture(source); const adapter = new CodexAppServerAdapter(command, [], dir, '0.145.0'); await expect(adapter.start()).rejects.toThrow('protocol_incompatible'); await reapedChild(dir); });
  it('cleans up the child after initialize timeout', async () => { const source = fixtureSource.replace("if(r.method==='initialize'){out(", "if(r.method==='initialize'){return}if(false){out("); const { dir, command } = await fixture(source); const adapter = new CodexAppServerAdapter(command, [], dir, '0.145.0', 20); await expect(adapter.start()).rejects.toThrow('rpc timeout'); await reapedChild(dir); });
  it('rejects a command older than the supported baseline', async () => { const { dir, command } = await fixture(); await writeFile(command, '#!/bin/sh\necho codex-cli 0.144.0\n'); await chmod(command, 0o700); await expect(new CodexAppServerAdapter(command, [], dir, '0.145.0').start()).rejects.toThrow('protocol_incompatible'); });
  /** The outage this range exists to prevent: a routine `codex upgrade` inside the range must not strand every logged-in sub in reconnect_required. */
  it('starts on a newer release inside the supported range and refuses one beyond it', async () => {
    const inside = await fixture(fixtureSource.replace('codex-cli 0.145.0', 'codex-cli 0.147.0'));
    const adapter = new CodexAppServerAdapter(inside.command, [], inside.dir, '0.145.0');
    await adapter.start();
    await adapter.shutdown();
    const beyond = await fixture(fixtureSource.replace('codex-cli 0.145.0', 'codex-cli 0.148.0'));
    await expect(new CodexAppServerAdapter(beyond.command, [], beyond.dir, '0.145.0').start()).rejects.toThrow('protocol_incompatible');
  });
  it('starts on a version the operator vouched for beyond the range', async () => {
    const { dir, command } = await fixture(fixtureSource.replace('codex-cli 0.145.0', 'codex-cli 0.148.0'));
    const saved = process.env.PATTY_CODEX_VERSION;
    process.env.PATTY_CODEX_VERSION = '0.148.0';
    const adapter = new CodexAppServerAdapter(command, [], dir, '0.145.0');
    try { await adapter.start(); await adapter.shutdown(); } finally { saved === undefined ? delete process.env.PATTY_CODEX_VERSION : process.env.PATTY_CODEX_VERSION = saved; }
  });
});

const officialTokenUsageBreakdown = { cachedInputTokens: 20, cacheWriteInputTokens: 0, inputTokens: 120, outputTokens: 45, reasoningOutputTokens: 5, totalTokens: 165 };
const officialTokenUsageNotification = { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: { last: officialTokenUsageBreakdown, total: officialTokenUsageBreakdown, modelContextWindow: 272_000 } };
/** Per-type files ship only for the endpoints Patty calls, so notification-only shapes come from the digest-verified source schema. */
async function canonicalSchema(name: string) { const source = JSON.parse(await readFile(resolve(import.meta.dirname, '../../../packages/codex-protocol/generated/schemas/codex_app_server_protocol.v2.schemas.json'), 'utf8')) as { definitions: Record<string, object> }; return { ...source.definitions[name], definitions: source.definitions }; }

describe('token usage telemetry', () => {
  it('maps official thread token usage notifications onto usage events', async () => { const source = fixtureSource.replace("out({jsonrpc:'2.0',id:99,method:'item/commandExecution/requestApproval'", `out({jsonrpc:'2.0',method:'thread/tokenUsage/updated',params:${JSON.stringify(officialTokenUsageNotification)}});out({jsonrpc:'2.0',id:99,method:'item/commandExecution/requestApproval'`); const { dir, command } = await fixture(source); const adapter = new CodexAppServerAdapter(command, [], dir, '0.145.0'); await adapter.start(); const events: { type: string; data?: unknown }[] = []; await adapter.run(undefined, 'gpt-5-codex', 'x', event => events.push({ type: event.type, data: event.data })); await new Promise(resolve => setTimeout(resolve, 10)); await adapter.approve('99', false); const Ajv = (await import('ajv')).default as unknown as new (options: { strict: boolean; validateFormats: boolean }) => { compile: (schema: object) => (data: unknown) => boolean }; expect(new Ajv({ strict: false, validateFormats: false }).compile(await canonicalSchema('ThreadTokenUsageUpdatedNotification'))(officialTokenUsageNotification)).toBe(true); expect(events.map(event => event.type)).toEqual(['started', 'delta', 'usage', 'approval_required', 'completed']); expect(events.find(event => event.type === 'usage')?.data).toEqual({ inputTokens: 120, cachedInputTokens: 20, outputTokens: 45, reasoningOutputTokens: 5, totalTokens: 165 }); await adapter.shutdown(); });
});

const officialReasoningSummaryDelta = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-3', summaryIndex: 0, delta: 'weighing ' };
const officialReasoningSummaryPart = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-3', summaryIndex: 1 };
const officialReasoningTextDelta = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-3', contentIndex: 0, delta: 'the options' };

describe('reasoning traces', () => {
  it('maps official reasoning notifications onto reasoning events, section break included', async () => {
    const source = fixtureSource.replace("out({jsonrpc:'2.0',method:'item/agentMessage/delta',params:delta});", [
      `out({jsonrpc:'2.0',method:'item/reasoning/summaryTextDelta',params:${JSON.stringify(officialReasoningSummaryDelta)}});`,
      `out({jsonrpc:'2.0',method:'item/reasoning/summaryPartAdded',params:${JSON.stringify(officialReasoningSummaryPart)}});`,
      `out({jsonrpc:'2.0',method:'item/reasoning/textDelta',params:${JSON.stringify(officialReasoningTextDelta)}});`,
      "out({jsonrpc:'2.0',method:'item/agentMessage/delta',params:delta});",
    ].join(''));
    expect(source).not.toBe(fixtureSource);
    const { dir, command } = await fixture(source);
    const adapter = new CodexAppServerAdapter(command, [], dir, '0.145.0');
    await adapter.start();
    const events: { type: string; data?: unknown }[] = [];
    await adapter.run(undefined, 'gpt-5-codex', 'x', event => events.push({ type: event.type, data: event.data }));
    await new Promise(resolve => setTimeout(resolve, 10));
    await adapter.approve('99', false);
    const Ajv = (await import('ajv')).default as unknown as new (options: { strict: boolean; validateFormats: boolean }) => { compile: (schema: object) => (data: unknown) => boolean };
    const ajv = new Ajv({ strict: false, validateFormats: false });
    for (let attempt = 0; attempt < 50 && !events.some(event => event.type === 'completed'); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    for (const [name, value] of [['ReasoningSummaryTextDeltaNotification', officialReasoningSummaryDelta], ['ReasoningSummaryPartAddedNotification', officialReasoningSummaryPart], ['ReasoningTextDeltaNotification', officialReasoningTextDelta]] as const) expect(ajv.compile(await canonicalSchema(name))(value), name).toBe(true);
    expect(events.map(event => event.type)).toEqual(['started', 'reasoning', 'reasoning', 'reasoning', 'delta', 'approval_required', 'completed']);
    expect(events.filter(event => event.type === 'reasoning').map(event => (event.data as { text: string }).text).join('')).toBe('weighing \n\nthe options');
    await adapter.shutdown();
  });
  /** The part that opens the stream is not a break in it, so it carries nothing rather than an empty line before the first word. */
  it('says nothing for the reasoning summary part that opens the stream', async () => {
    const source = fixtureSource.replace("out({jsonrpc:'2.0',method:'item/agentMessage/delta',params:delta});", `out({jsonrpc:'2.0',method:'item/reasoning/summaryPartAdded',params:${JSON.stringify({ ...officialReasoningSummaryPart, summaryIndex: 0 })}});out({jsonrpc:'2.0',method:'item/agentMessage/delta',params:delta});`);
    const { dir, command } = await fixture(source);
    const adapter = new CodexAppServerAdapter(command, [], dir, '0.145.0');
    await adapter.start();
    const events: string[] = [];
    await adapter.run(undefined, 'gpt-5-codex', 'x', event => events.push(event.type));
    await new Promise(resolve => setTimeout(resolve, 10));
    await adapter.approve('99', false);
    for (let attempt = 0; attempt < 50 && !events.includes('completed'); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(events).toEqual(['started', 'delta', 'approval_required', 'completed']);
    await adapter.shutdown();
  });
});

describe('account readiness', () => {
  /** A real signed-in 0.145.0 ChatGPT account reports requiresOpenaiAuth:true, so readiness must key off the account object alone. */
  it('treats a populated account as ready even when requiresOpenaiAuth is set', async () => { const source = fixtureSource.replace('"requiresOpenaiAuth":false', '"requiresOpenaiAuth":true'); expect(source).not.toBe(fixtureSource); const { dir, command } = await fixture(source); const adapter = new CodexAppServerAdapter(command, [], dir, '0.145.0'); await adapter.start(); await expect(adapter.waitForAccount(1_000)).resolves.toMatchObject({ requiresOpenaiAuth: true }); expect((await adapter.snapshot()).models).toEqual(['gpt-5-codex']); await adapter.shutdown(); });
  it('rejects readiness while no account is present', async () => { const source = fixtureSource.replace(JSON.stringify(officialAccountResponse), JSON.stringify({ account: null, requiresOpenaiAuth: true })); expect(source).not.toBe(fixtureSource); const { dir, command } = await fixture(source); const adapter = new CodexAppServerAdapter(command, [], dir, '0.145.0'); await adapter.start(); await expect(adapter.waitForAccount(300)).rejects.toThrow('account_login_not_ready'); await adapter.shutdown(); });
});

describe('lending a subscription credential', () => {
  it('asks the app-server to refresh, then reads only the access token and its account', async () => { const { dir, command } = await fixture(); await writeFile(join(dir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, auth_mode: 'chatgpt', tokens: { id_token: 'id', access_token: 'access-token-value', refresh_token: 'refresh-token-value', account_id: 'chatgpt-account-1' }, last_refresh: new Date().toISOString() })); const adapter = new CodexAppServerAdapter(command, [], dir, '0.145.0'); await adapter.start();
    const credential = await adapter.credential();
    expect(credential).toEqual({ accessToken: 'access-token-value', chatgptAccountId: 'chatgpt-account-1', chatgptPlanType: 'plus' });
    /** The refresh token is what turns a short loan into permanent access to the account, so it stays in the sub's home. */
    expect(JSON.stringify(credential)).not.toContain('refresh-token-value');
    const Ajv = (await import('ajv')).default as unknown as new (options: { strict: boolean; validateFormats: boolean }) => { compile: (schema: object) => (data: unknown) => boolean };
    const read = (await requests(dir)).find(request => request.method === 'account/read')!;
    expect(read.params).toEqual({ refreshToken: true });
    expect(new Ajv({ strict: false, validateFormats: false }).compile(await schema('GetAccountParams'))(read.params)).toBe(true);
    await adapter.shutdown(); });
  it('refuses to lend a sub logged in with an API key', async () => { const { dir, command } = await fixture(); await writeFile(join(dir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-not-a-real-key', auth_mode: 'apikey', tokens: null })); const adapter = new CodexAppServerAdapter(command, [], dir, '0.145.0'); await adapter.start(); await expect(adapter.credential()).rejects.toThrow('credential_unavailable'); await adapter.shutdown(); });
});

describe('re-authenticating a stored sub', () => {
  /**
   * The state a revoked ChatGPT login leaves behind: the alias, its history and its isolated home
   * are intact and only the credential inside them is dead, so stacking the sub again is refused as
   * a duplicate and the operator has no way back in through Patty.
   */
  it('drives the existing home through login again instead of refusing the alias', async () => {
    const { dir, command } = await fixture();
    const savedCommand = process.env.PATTY_CODEX_COMMAND, savedRoot = process.env.PATTY_ACCOUNT_HOME_ROOT;
    process.env.PATTY_CODEX_COMMAND = command;
    process.env.PATTY_ACCOUNT_HOME_ROOT = await mkdtemp(join(tmpdir(), 'patty-homes-'));
    try {
      const daemon = new PattyDaemon();
      const added = await daemon.addCodexAccount('sub-a', 'device_code');
      await expect(daemon.addCodexAccount('sub-a', 'device_code')).rejects.toThrow('invalid_request');
      const relogin = await daemon.reloginCodexAccount('sub-a', 'device_code');
      expect(relogin).toMatchObject({ id: added.id, alias: 'sub-a', code: 'CODE' });
      expect(daemon.store.account(added.id)?.state).toBe('pending_login');
      /** Re-login is the same sub, so its home, id and run history all survive it. */
      expect(daemon.homes.get(added.id)).toBe(daemon.homes.get(relogin.id));
      await expect(daemon.reloginCodexAccount('sub-b', 'device_code')).rejects.toThrow('invalid_request');
      await daemon.coordinator.shutdown();
    } finally {
      savedCommand === undefined ? delete process.env.PATTY_CODEX_COMMAND : process.env.PATTY_CODEX_COMMAND = savedCommand;
      savedRoot === undefined ? delete process.env.PATTY_ACCOUNT_HOME_ROOT : process.env.PATTY_ACCOUNT_HOME_ROOT = savedRoot;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
