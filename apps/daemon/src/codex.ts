import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ChatResponseFormat, ChatTool, ChatToolCall, ChatTurn, LeasedCredential, PattyEvent, ProviderAdapter, Quota, TokenUsage, TurnOptions } from '@patty/contracts';
import type { ToolBridge, ToolBridgeSession } from './tool-bridge.js';

type Rpc = { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { message?: unknown } };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type TurnRef = { threadId: string; emit: (event: PattyEvent) => void };
type Approval = { method: string; requestId: string | number; turnId?: string };
type QueuedTurnMessage = PattyEvent | { approval: Approval };
type RateWindow = { usedPercent?: number; resetsAt?: number | null };
type UsageBreakdown = { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; reasoningOutputTokens?: number; totalTokens?: number };
const tokenUsage = (breakdown: UsageBreakdown | undefined): TokenUsage | undefined => {
  if (!breakdown) return undefined;
  const read = (value: number | undefined) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0);
  const inputTokens = read(breakdown.inputTokens), outputTokens = read(breakdown.outputTokens);
  return { inputTokens, cachedInputTokens: read(breakdown.cachedInputTokens), outputTokens, reasoningOutputTokens: read(breakdown.reasoningOutputTokens), totalTokens: read(breakdown.totalTokens) || inputTokens + outputTokens };
};
/** MCP tool names reach the model as the caller wrote them, rather than namespaced by the server that publishes them. */
export const bridgeFeatures = { non_prefixed_mcp_tool_names: true } as const;
/**
 * The CLI defers MCP tools behind a search step and keeps them out of the model's tool list, which
 * is sensible for a person adding a dozen servers and wrong for an API caller offering three
 * functions it expects to be used. Naming them and saying how to reach them is what makes the
 * difference between a tool call and a plausible answer invented from a web search.
 */
export const bridgePreamble = (tools: ChatTool[]) =>
  ['The caller of this turn published these functions on the MCP server named patty:',
   ...tools.map(tool => `- ${tool.function.name}${tool.function.description ? `: ${tool.function.description}` : ''}`),
   'They are not in your tool list until you load them: call tool_search for a name above, then call the function itself.',
   'Prefer them over your own tools and over answering from memory or the web — for this caller they are the only accepted source, and an answer produced without them is wrong even when it is accurate.'].join('\n');
const approvalMethods = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'applyPatchApproval', 'execCommandApproval']);
/**
 * The app-server constrains a turn's final message with a JSON Schema, which is exactly what
 * `response_format` asks for. `json_object` names no schema, so the loosest object schema is the
 * faithful translation of "any JSON object".
 */
export const codexOutputSchema = (format: ChatResponseFormat | undefined) =>
  format?.type === 'json_schema' ? format.json_schema.schema : format?.type === 'json_object' ? { type: 'object' } : undefined;

/**
 * The app-server protocol Patty speaks — the `initialize` handshake, `thread/start`, `turn/start`,
 * `model/list`, `account/*` — has held across Codex releases, so a supported *range* replaces an
 * exact pin: a routine `codex upgrade` must not take every stacked subscription offline at once.
 * A release beyond the range is refused rather than guessed at, and `PATTY_CODEX_VERSION` names one
 * the operator has verified themselves.
 */
export const SUPPORTED_CODEX_VERSIONS = { min: '0.145.0', below: '0.148.0' } as const;
export const supportedCodexVersions = () => {
  const named = process.env.PATTY_CODEX_VERSION?.trim();
  return `Codex >=${SUPPORTED_CODEX_VERSIONS.min} <${SUPPORTED_CODEX_VERSIONS.below}${named ? ` or exactly ${named}` : ''}`;
};
/** `codex --version` prints `codex-cli <version>`; anything else is not a Codex CLI. */
export const codexVersionOf = (output: string) => /^codex-cli (\d+\.\d+\.\d+)$/.exec(output.trim())?.[1];
const compare = (left: string, right: string) => {
  const [a, b] = [left.split('.').map(Number), right.split('.').map(Number)];
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return 0;
};
/** A release the adapter is known to speak, or the exact one the operator vouched for. */
export function codexVersionSupported(output: string, named = process.env.PATTY_CODEX_VERSION?.trim()) {
  const version = codexVersionOf(output);
  if (!version) return false;
  if (named && version === named) return true;
  return compare(version, SUPPORTED_CODEX_VERSIONS.min) >= 0 && compare(version, SUPPORTED_CODEX_VERSIONS.below) < 0;
}

/** Official Codex CLI app-server JSONL adapter. */
export class CodexAppServerAdapter extends EventEmitter implements ProviderAdapter {
  private child?: ChildProcessWithoutNullStreams; private next = 0; private stopping = false;
  private readonly pending = new Map<number, Pending>(); private readonly turns = new Map<string, TurnRef>(); private readonly bridged = new Map<string, ToolBridgeSession>(); private readonly earlyEvents = new Map<string, QueuedTurnMessage[]>(); private readonly earlyApprovalsByThread = new Map<string, Approval[]>(); private readonly approvals = new Map<string, Approval>(); private loginId?: string;
  constructor(private readonly command: string, private readonly args: string[], private readonly home: string, private readonly expectedVersion: string, private readonly rpcTimeoutMs = 30_000, private readonly bridge?: ToolBridge) { super(); if (expectedVersion !== SUPPORTED_CODEX_VERSIONS.min) throw new Error(`a supported Codex baseline of ${SUPPORTED_CODEX_VERSIONS.min} is required`); }
  async start() {
    if (this.child) return;
    let version: string; try { version = execFileSync(this.command, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { throw new Error('protocol_incompatible: Codex version could not be verified'); }
    if (!codexVersionSupported(version)) throw new Error(`protocol_incompatible: ${supportedCodexVersions()} required, found ${version}`);
    const expectedHome = realpathSync(this.home);
    const child = spawn(this.command, this.args, { env: { ...process.env, CODEX_HOME: expectedHome }, stdio: 'pipe' }); this.child = child;
    child.once('error', error => this.stop(error)); child.stdin.on('error', error => this.stop(error)); child.once('exit', () => this.stop(new Error('app-server exited')));
    createInterface({ input: child.stdout }).on('line', line => this.receive(line)); child.stderr.on('data', () => undefined);
    try {
      const initialized = await this.rpc('initialize', { clientInfo: { name: 'pattystack', version: '0.1.0' }, capabilities: null }) as { userAgent?: string; codexHome?: string };
      let initializedHome: string | undefined; try { if (typeof initialized.codexHome === 'string') initializedHome = realpathSync(initialized.codexHome); } catch { initializedHome = undefined; }
      if (typeof initialized.userAgent !== 'string' || initializedHome !== expectedHome) throw new Error('protocol_incompatible: invalid initialize response');
      this.notify('initialized');
    } catch (error) { await this.shutdown(); throw error; }
  }
  private receive(line: string) {
    let message: Rpc; try { message = JSON.parse(line) as Rpc; } catch { this.emit('protocolError', 'malformed_frame'); return; }
    if ((typeof message.id === 'string' || typeof message.id === 'number') && typeof message.method === 'string') { this.serverRequest(message.id, message.method, message.params); return; }
    if (typeof message.id === 'number') { const pending = this.pending.get(message.id); if (!pending) return; clearTimeout(pending.timer); this.pending.delete(message.id); message.error ? pending.reject(new Error(String(message.error.message ?? 'rpc error'))) : pending.resolve(message.result); return; }
    if (typeof message.method === 'string') this.notification(message.method, message.params);
  }
  private notification(method: string, params: unknown) {
    const value = params as { threadId?: string; turnId?: string; turn?: { id?: string; status?: string }; delta?: string; summaryIndex?: number; tokenUsage?: { last?: UsageBreakdown }; rateLimits?: { primary?: RateWindow | null; secondary?: RateWindow | null } } | undefined;
    const turnId = value?.turnId ?? value?.turn?.id;
    const usage = method === 'thread/tokenUsage/updated' ? tokenUsage(value?.tokenUsage?.last) : undefined;
    const event = usage ? { version: 1 as const, type: 'usage' as const, runId: turnId!, data: usage } : method === 'turn/started' ? { version: 1 as const, type: 'started' as const, runId: turnId! } : method === 'item/agentMessage/delta' ? { version: 1 as const, type: 'delta' as const, runId: turnId!, data: { text: value?.delta } } : method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta' ? { version: 1 as const, type: 'reasoning' as const, runId: turnId!, data: { text: value?.delta } }
      /** A new summary part is a section break in the same reasoning stream, and the break itself is the only text it carries; the first part opens the stream and needs none. */
      : method === 'item/reasoning/summaryPartAdded' && (value?.summaryIndex ?? 0) > 0 ? { version: 1 as const, type: 'reasoning' as const, runId: turnId!, data: { text: '\n\n' } } : method === 'turn/completed' ? { version: 1 as const, type: value?.turn?.status === 'completed' ? 'completed' as const : 'failed' as const, runId: turnId!, data: value?.turn?.status === 'completed' ? undefined : { providerStatus: value?.turn?.status } } : undefined;
    if (event && turnId) { const ref = this.turns.get(turnId); if (ref) { ref.emit(event); if (method === 'turn/completed') this.clearTurn(turnId); } else { const queued = this.earlyEvents.get(turnId) ?? []; queued.push(event); this.earlyEvents.set(turnId, queued); if (method === 'turn/completed' && value?.threadId) this.clearQueuedThread(value.threadId); } }
    else if (method === 'account/rateLimits/updated') this.emit('quota', this.quota(value?.rateLimits));
    else if (method === 'account/login/completed') this.emit('login', { method, params });
    else this.emit('notification', { method, params });
  }
  private serverRequest(id: string | number, method: string, params: unknown) {
    if (!approvalMethods.has(method)) { this.respondError(id, -32601, `unsupported server request: ${method}`); return; }
    const value = params as { turnId?: string; conversationId?: string } | undefined; const turnId = value?.turnId; const ref = turnId ? this.turns.get(turnId) : value?.conversationId ? [...this.turns.entries()].find(([, candidate]) => candidate.threadId === value.conversationId)?.[1] : undefined;
    const resolvedTurnId = turnId ?? [...this.turns.entries()].find(([, candidate]) => candidate === ref)?.[0]; const approval = { method, requestId: id, turnId: resolvedTurnId };
    if (!turnId && value?.conversationId && !ref) { const queued = this.earlyApprovalsByThread.get(value.conversationId) ?? []; queued.push(approval); this.earlyApprovalsByThread.set(value.conversationId, queued); return; }
    if (!resolvedTurnId) { this.respond(id, this.approvalResult(approval, false)); return; }
    if (!ref) { const queued = this.earlyEvents.get(turnId!) ?? []; queued.push({ approval }); this.earlyEvents.set(turnId!, queued); return; }
    this.approvals.set(String(id), approval); ref.emit({ version: 1, type: 'approval_required', runId: resolvedTurnId, data: { approvalId: String(id) } });
  }
  private approvalResult(approval: Approval, approved: boolean) { if (approval.method === 'applyPatchApproval' || approval.method === 'execCommandApproval') return { decision: approved ? 'approved' : 'abort' }; return { decision: approved ? 'accept' : 'decline' }; }
  private respond(id: string | number, result: unknown) { this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`); }
  private respondError(id: string | number, code: number, message: string) { this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`); }
  private notify(method: string) { this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`); }
  private quota(rateLimits: { primary?: RateWindow | null; secondary?: RateWindow | null } | undefined): Quota {
    const windows = [rateLimits?.primary, rateLimits?.secondary].filter((window): window is RateWindow => typeof window?.usedPercent === 'number' && Number.isFinite(window.usedPercent));
    if (!windows.length) return { observedAt: new Date().toISOString() };
    const restrictive = windows.reduce((worst, window) => { const usage = Math.max(0, Math.min(100, window.usedPercent!)); const worstUsage = Math.max(0, Math.min(100, worst.usedPercent!)); return usage > worstUsage || (usage === worstUsage && (window.resetsAt ?? -Infinity) > (worst.resetsAt ?? -Infinity)) ? window : worst; });
    return { remaining: Math.max(0, Math.min(1, 1 - restrictive.usedPercent! / 100)), resetAt: typeof restrictive.resetsAt === 'number' && Number.isFinite(restrictive.resetsAt) ? new Date(restrictive.resetsAt * 1000).toISOString() : undefined, observedAt: new Date().toISOString() };
  }
  private rpc(method: string, params?: unknown): Promise<unknown> { if (!this.child) return Promise.reject(new Error('worker not started')); if (this.pending.size >= 128) return Promise.reject(new Error('upstream_overloaded')); const requestId = ++this.next; this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, ...(params === undefined ? {} : { params }) })}\n`); return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('rpc timeout')); }, this.rpcTimeoutMs); this.pending.set(requestId, { resolve, reject, timer }); }); }
  private deny(approval: Approval) { this.respond(approval.requestId, this.approvalResult(approval, false)); }
  private clearQueuedThread(threadId: string) { for (const approval of this.earlyApprovalsByThread.get(threadId) ?? []) this.deny(approval); this.earlyApprovalsByThread.delete(threadId); }
  private clearTurn(turnId: string) { this.turns.delete(turnId); this.bridged.get(turnId)?.close(); this.bridged.delete(turnId); for (const message of this.earlyEvents.get(turnId) ?? []) if ('approval' in message) this.deny(message.approval); this.earlyEvents.delete(turnId); for (const [id, approval] of this.approvals) if (approval.turnId === turnId) { this.deny(approval); this.approvals.delete(id); } }
  private stop(reason: Error) { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(reason); } this.pending.clear(); for (const turnId of this.turns.keys()) this.clearTurn(turnId); for (const messages of this.earlyEvents.values()) for (const message of messages) if ('approval' in message) this.deny(message.approval); this.earlyEvents.clear(); for (const approvals of this.earlyApprovalsByThread.values()) for (const approval of approvals) this.deny(approval); this.earlyApprovalsByThread.clear(); for (const approval of this.approvals.values()) this.deny(approval); this.approvals.clear(); this.child = undefined; if (!this.stopping) this.emit('exit', reason); }
  async login(mode: 'browser' | 'device_code') { const result = await this.rpc('account/login/start', mode === 'device_code' ? { type: 'chatgptDeviceCode' } : { type: 'chatgpt' }) as { authUrl?: string; verificationUrl?: string; userCode?: string; loginId?: string }; this.loginId = result.loginId; return { url: result.authUrl ?? result.verificationUrl, code: result.userCode, loginId: result.loginId }; }
  async cancelLogin(loginId?: string) { if (loginId ?? this.loginId) await this.rpc('account/login/cancel', { loginId: loginId ?? this.loginId }); }
  private async account() { return this.rpc('account/read', {}) as Promise<{ account: { type?: string; email?: string | null } | null; requiresOpenaiAuth: boolean }>; }
  async identityFingerprint() { const account = await this.account(); if (!account.account) throw new Error('account_not_authenticated'); return createHash('sha256').update(`${account.account.type ?? ''}:${account.account.email ?? ''}`).digest('hex'); }
  async waitForAccount(timeoutMs = 30_000) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const result = await this.account(); if (result.account) return result; await new Promise(resolve => setTimeout(resolve, 500)); } throw new Error('account_login_not_ready'); }
  /** A subscription can serve the caller's functions only when a bridge is there to publish them, so the capability follows the bridge rather than the provider. */
  async snapshot() { await this.waitForAccount(); const models = await this.rpc('model/list', {}) as { data: { model?: string; id?: string }[] }; const limits = await this.rpc('account/rateLimits/read') as { rateLimits: { primary?: RateWindow | null; secondary?: RateWindow | null } }; return { models: models.data.map(model => model.model ?? model.id).filter((model): model is string => Boolean(model)), capabilities: this.bridge ? ['tools'] : [], quota: this.quota(limits.rateLimits) }; }
  async createThread(model: string, options?: TurnOptions, session?: ToolBridgeSession, tools?: ChatTool[]) {
    /** A bridged turn's rules are the caller's instructions plus how to reach the caller's functions; without the second part the model cannot see them, and without approve every call to them is cancelled unanswered. */
    const instructions = [options?.instructions, session && tools?.length ? bridgePreamble(tools) : undefined].filter(Boolean).join('\n\n');
    return (await this.rpc('thread/start', { model, ephemeral: true, ...(instructions ? { developerInstructions: instructions } : {}), ...(session ? { approvalPolicy: 'never', config: { features: bridgeFeatures, mcp_servers: { patty: { command: session.command, args: session.args, env: session.env, default_tools_approval_mode: 'approve' } } } } : {}) }) as { thread: { id: string } }).thread.id;
  }
  async run(threadId: string | undefined, model: string, input: string, emit: (event: PattyEvent) => void, turn?: ChatTurn, options?: TurnOptions) {
    /** Tools live on the thread's MCP config, so a tool-bearing turn opens its own ephemeral thread rather than borrowing one that was started without the bridge. */
    let turnIdSoFar: string | undefined; const queuedCalls: ChatToolCall[] = [];
    const announce = (call: ChatToolCall) => { if (turnIdSoFar) emit({ version: 1, type: 'tool_calls', runId: turnIdSoFar, data: { toolCalls: [call], awaiting: true } }); else queuedCalls.push(call); };
    const session = turn?.tools?.length && this.bridge ? this.bridge.open(turn.tools, announce) : undefined;
    if (session) { const own = await this.createThread(model, options, session, turn?.tools); const started = await this.startTurn(own, model, input, emit, options, undefined, session); turnIdSoFar = started.turnId; for (const call of queuedCalls.splice(0)) announce(call); return started; }
    return this.startTurn(threadId ?? await this.createThread(model, options), model, input, emit, options, threadId);
  }
  private async startTurn(activeThreadId: string, model: string, input: string, emit: (event: PattyEvent) => void, options?: TurnOptions, threadId?: string, session?: ToolBridgeSession) { const outputSchema = codexOutputSchema(options?.responseFormat); /** A thread the caller opened earlier already carries its own developer instructions, so this turn's rules ride along with the prompt rather than silently replacing them. */ const text = threadId && options?.instructions ? `${options.instructions}\n\n${input}` : input; const result = await this.rpc('turn/start', { threadId: activeThreadId, model, input: [{ type: 'text', text, text_elements: [] }], ...(outputSchema ? { outputSchema } : {}), ...(options?.reasoningEffort ? { effort: options.reasoningEffort } : {}) }) as { turn: { id: string } }; this.turns.set(result.turn.id, { threadId: activeThreadId, emit }); if (session) this.bridged.set(result.turn.id, session); const legacy = this.earlyApprovalsByThread.get(activeThreadId) ?? []; this.earlyApprovalsByThread.delete(activeThreadId); for (const approval of legacy) { approval.turnId = result.turn.id; this.approvals.set(String(approval.requestId), approval); emit({ version: 1, type: 'approval_required', runId: result.turn.id, data: { approvalId: String(approval.requestId) } }); } let terminal = false; for (const message of this.earlyEvents.get(result.turn.id) ?? []) { if ('approval' in message) { this.approvals.set(String(message.approval.requestId), message.approval); emit({ version: 1, type: 'approval_required', runId: result.turn.id, data: { approvalId: String(message.approval.requestId) } }); } else { emit(message); terminal ||= message.type === 'completed' || message.type === 'failed' || message.type === 'cancelled'; } } if (terminal) this.clearTurn(result.turn.id); else this.earlyEvents.delete(result.turn.id); return { turnId: result.turn.id }; }
  async interrupt(providerTurnId: string) { const ref = this.turns.get(providerTurnId); if (!ref) throw new Error('unknown_turn'); await this.rpc('turn/interrupt', { threadId: ref.threadId, turnId: providerTurnId }); }
  async approve(approvalId: string, approved: boolean) { const approval = this.approvals.get(approvalId); if (!approval) throw new Error('unknown_approval'); this.approvals.delete(approvalId); this.respond(approval.requestId, this.approvalResult(approval, approved)); }
  /**
   * The access token the CLI is using right now, refreshed first so a caller is never handed one
   * about to expire. Only the access token and the account it belongs to are read: the refresh
   * token stays in the sub's home, so a lent credential dies on its own schedule and cannot be
   * turned back into the account by whoever borrowed it.
   */
  async credential(): Promise<LeasedCredential> {
    const read = await this.rpc('account/read', { refreshToken: true }) as { account?: { planType?: unknown } | null };
    let stored: { auth_mode?: unknown; tokens?: { access_token?: unknown; account_id?: unknown } };
    try { stored = JSON.parse(readFileSync(join(this.home, 'auth.json'), 'utf8')) as typeof stored; } catch { throw new Error('credential_unavailable'); }
    const accessToken = stored.tokens?.access_token, chatgptAccountId = stored.tokens?.account_id;
    /** An API-key login has no subscription to lend, and a half-written credential is not one either. */
    if (stored.auth_mode !== 'chatgpt' || typeof accessToken !== 'string' || !accessToken || typeof chatgptAccountId !== 'string' || !chatgptAccountId) throw new Error('credential_unavailable');
    return { accessToken, chatgptAccountId, chatgptPlanType: typeof read.account?.planType === 'string' ? read.account.planType : null };
  }
  async logout() { await this.rpc('account/logout'); } async health() { return Boolean(this.child); }
  async shutdown() { const child = this.child; if (!child) return; this.stopping = true; this.stop(new Error('worker shut down')); child.kill('SIGTERM'); const exited = await new Promise<boolean>(resolve => { const timer = setTimeout(() => resolve(false), 1_000); child.once('exit', () => { clearTimeout(timer); resolve(true); }); }); if (!exited) { child.kill('SIGKILL'); await new Promise<void>(resolve => child.once('exit', () => resolve())); } this.stopping = false; }
}
