/** Stable provider-neutral data exposed by the Patty API. */
export type AccountState = 'pending_login' | 'ready' | 'login_failed' | 'reconnect_required' | 'draining' | 'removed';
export type Quota = { remaining?: number; resetAt?: string; observedAt: string };
/** Subs are tried a tier at a time: every eligible `primary` sub is exhausted before any `fallback` sub is used, so metered API credit only pays for what the stacked subscriptions could not. */
export type AccountTier = 'primary' | 'fallback';
export type Account = { id: string; alias: string; state: AccountState; models: string[]; quota: Quota; health: number; activeRuns: number; cooldownUntil?: string; tier: AccountTier };
/** Per-key admission control. `rpm` caps requests started in a rolling minute, `concurrency` caps runs in flight at once; an unset limit is unlimited. Requests over a limit wait in the key's queue rather than failing immediately. */
export type KeyLimits = { rpm?: number; concurrency?: number };
export type KeyPressure = { keyId: string; name: string | null; inFlight: number; queued: number; throttled: number } & KeyLimits;
/** An OpenAI-shaped tool a caller offers the model, passed through to a provider that supports them. */
export type ChatTool = { type: 'function'; function: { name: string; description?: string; parameters?: unknown; strict?: boolean } };
export type ChatToolChoice = 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
export type ChatToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
/**
 * The verbatim conversation, carried alongside the flattened `input` for providers that
 * need real message roles: tool calling is a multi-turn protocol, and an assistant turn
 * holding `tool_calls` with no text cannot survive being flattened into a prompt string.
 * Requests carrying tools require the `tools` capability, so a sub that cannot honour them is never chosen.
 */
export type ChatTurn = { messages: unknown[]; tools?: ChatTool[]; toolChoice?: ChatToolChoice };
/**
 * OpenAI's `response_format`. An agentic caller asks for a filled-in schema far more often than
 * for prose, and a schema that is dropped on the way to the provider comes back as a paragraph the
 * caller cannot parse, so it travels with the turn rather than being flattened into the prompt.
 */
export type ChatResponseFormat =
 | { type: 'text' }
 | { type: 'json_object' }
 | { type: 'json_schema'; json_schema: { name?: string; description?: string; schema: Record<string, unknown>; strict?: boolean } };
/** Decoding knobs, in provider-neutral names. A provider that cannot honour one ignores it rather than failing the turn. */
export type TurnSampling = { temperature?: number; topP?: number; maxOutputTokens?: number; stop?: string[]; seed?: number };
/**
 * Per-turn constraints that are neither the prompt nor the conversation, honoured by whichever sub
 * serves the run. `instructions` is the system/developer half of the request, kept apart from the
 * user prompt because a provider that takes a single text input would otherwise be told the words
 * without being told they are the rules.
 */
export type TurnOptions = { responseFormat?: ChatResponseFormat; instructions?: string; reasoningEffort?: string; sampling?: TurnSampling };
export type RunRequest = { model: string; input: string; capabilities?: string[]; accountId?: string; idempotencyKey?: string; threadId?: string; chat?: ChatTurn } & TurnOptions;
/**
 * `reasoning` carries the model's thinking the way `delta` carries its answer (`{text}`), as a
 * separate type so a client that renders a thinking block gets it without it being mistaken for the
 * answer, and a client that only knows the older types ignores it. Like `delta` it is provider
 * content: forwarded live, never persisted.
 */
export type PattyEvent = { version: 1; type: 'started' | 'delta' | 'reasoning' | 'tool_calls' | 'usage' | 'approval_required' | 'completed' | 'failed' | 'cancelled'; runId: string; data?: unknown };
/** Provider-reported token counts for a single turn. Counts are metadata, never generated content. */
export type TokenUsage = { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number; totalTokens: number };
/**
 * Cached input as a share of the input tokens the provider reported, derived rather than stored so
 * it can never disagree with the counts it comes from. `null` when nothing has reported input
 * tokens yet, which is deliberately not `0`: a stack with no measured run has no hit rate, and
 * showing one would read as a cache that is missing every time.
 */
export type CacheStats = { cacheHitRate: number | null };
export type UsageTotals = TokenUsage & CacheStats & { runs: number };
export type AccountUsage = UsageTotals & { accountId: string; alias: string };
export type RunUsage = TokenUsage & CacheStats & { runId: string; accountId: string; alias: string; model: string; observedAt: string; keyId: string | null; keyName: string | null };
export type KeyUsage = UsageTotals & { keyId: string | null; name: string | null; prefix: string | null };
/**
 * Dollars are always an estimate: the token counts are the provider's, but the prices come from a
 * local table, so a model with no price is counted as unpriced instead of as free.
 */
export type CostBreakdown = { estimatedCostUsd: number; unpricedRuns: number };
/**
 * What the stack is worth. `subscriptionUsd` is what the turns served by `primary` subs would have
 * cost at API list price — money the subscriptions absorbed — and `apiUsd` is what the `fallback`
 * subs actually spent because the stack could not serve the request.
 */
export type CostSummary = CostBreakdown & { subscriptionUsd: number; apiUsd: number; unpricedModels: string[] };
export type UsageReport = { totals: UsageTotals & { cost: CostBreakdown }; accounts: (AccountUsage & { tier: AccountTier; cost: CostBreakdown })[]; keys: (KeyUsage & { cost: CostBreakdown })[]; runs: (RunUsage & { estimatedCostUsd: number | null })[]; cost: CostSummary };
/**
 * The short-lived half of a subscription credential: enough for a caller to drive its own Codex
 * process as that subscription, and nothing more. The refresh token stays in Patty, so a lease can
 * be revoked and cannot be renewed by whoever holds it.
 */
export type LeasedCredential = { accessToken: string; chatgptAccountId: string; chatgptPlanType: string | null };
/**
 * A sub lent to a caller that runs Codex itself. An agent driving the CLI directly — for its own
 * threads, tools and streaming — cannot be served by an OpenAI-shaped endpoint, so it borrows the
 * subscription instead of the answer. Patty cannot meter those turns, so the lease holds one of the
 * sub's run slots for as long as it lives and disappears on its own when the holder stops renewing.
 */
export type CredentialLease = { id: string; accountId: string; alias: string; holder: string | null; issuedAt: string; expiresAt: string; models: string[] };
export type PattyErrorCode = 'invalid_request' | 'unauthorized' | 'idempotency_conflict' | 'no_eligible_account' | 'rate_limited' | 'model_unavailable' | 'account_reconnect_required' | 'account_cooldown' | 'approval_timeout' | 'upstream_overloaded' | 'upstream_failed' | 'protocol_incompatible';
export type PattyError = { error: { code: PattyErrorCode; message: string; requestId: string; retryable: boolean; retryAfterMs?: number } };

/** All real implementations must use documented app-server RPC only. */
export interface ProviderAdapter {
  login(mode: 'browser' | 'device_code'): Promise<{ url?: string; code?: string }>;
  cancelLogin(): Promise<void>;
  snapshot(): Promise<{ models: string[]; quota: Quota; capabilities?: string[] }>;
  createThread(model: string, options?: TurnOptions): Promise<string>;
  /** Resolves as soon as the provider accepts the turn, with its cancellation ID. */
  run(threadId: string | undefined, model: string, input: string, onEvent: (event: PattyEvent) => void, turn?: ChatTurn, options?: TurnOptions): Promise<{ turnId: string }>;
  interrupt(providerTurnId: string): Promise<void>;
  approve(approvalId: string, approved: boolean): Promise<void>;
  logout(): Promise<void>;
  /** Mints the sub's current access token, refreshing it first. Absent on providers with no subscription to lend, such as an API key. */
  credential?(): Promise<LeasedCredential>;
  health(): Promise<boolean>;
  /** Stops worker resources without reading or deleting Codex-managed credentials. */
  shutdown(): Promise<void>;
}
