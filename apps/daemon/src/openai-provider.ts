import type { ChatToolCall, ChatTurn, PattyEvent, ProviderAdapter, Quota, TokenUsage, TurnOptions } from '@patty/contracts';

/**
 * Any OpenAI-compatible endpoint — an OpenAI or OpenRouter key, a Together/Fireworks
 * account, a local Ollama or vLLM — stacked next to Codex subscriptions behind the same router.
 *
 * The secret is referenced by environment variable name and read at call time, never persisted:
 * Patty stores which variable to read, so a stolen `patty.sqlite` still contains no provider key.
 */
export class OpenAiCompatibleAdapter implements ProviderAdapter {
  private controllers = new Map<string, AbortController>();
  private turnSeq = 0;
  private quota: Quota = { observedAt: new Date().toISOString() };

  constructor(private config: { baseUrl: string; apiKeyEnv: string; models?: string[]; fetch?: typeof fetch }) {
    if (!/^https?:\/\//.test(config.baseUrl)) throw new Error('baseUrl must be an http(s) URL');
    if (!/^[A-Z0-9_]{1,64}$/.test(config.apiKeyEnv)) throw new Error('apiKeyEnv must name an environment variable');
  }

  private key() {
    const key = process.env[this.config.apiKeyEnv];
    if (!key) throw new Error(`${this.config.apiKeyEnv} is not set; export it before routing to this sub`);
    return key;
  }

  private async call(path: string, init: RequestInit = {}) {
    const send = this.config.fetch ?? fetch;
    const response = await send(`${this.config.baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.key()}`, 'content-type': 'application/json', ...init.headers },
    });
    this.readQuota(response.headers);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    return response;
  }

  /** Providers publish remaining budget in the standard rate-limit headers; unknown stays unknown rather than optimistic. */
  private readQuota(headers: Headers) {
    const remaining = Number(headers.get('x-ratelimit-remaining-requests'));
    const limit = Number(headers.get('x-ratelimit-limit-requests'));
    const resetSeconds = Number(String(headers.get('x-ratelimit-reset-requests') ?? '').replace(/s$/, ''));
    this.quota = {
      observedAt: new Date().toISOString(),
      ...(Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0 ? { remaining: Math.max(0, Math.min(1, remaining / limit)) } : {}),
      ...(Number.isFinite(resetSeconds) && resetSeconds > 0 ? { resetAt: new Date(Date.now() + resetSeconds * 1000).toISOString() } : {}),
    };
  }

  async login(): Promise<{ url?: string; code?: string }> {
    throw new Error(`this sub authenticates with ${this.config.apiKeyEnv}; there is no login flow`);
  }

  async cancelLogin() {}

  async snapshot() {
    if (this.config.models?.length) { await this.call('/models').catch(() => undefined); return { models: this.config.models, quota: this.quota, capabilities }; }
    const body = await (await this.call('/models')).json() as { data?: { id?: string }[] };
    return { models: (body.data ?? []).map(model => model.id).filter((id): id is string => typeof id === 'string'), quota: this.quota, capabilities };
  }

  /** Stateless provider: the thread is Patty's, and history is replayed by the caller. */
  async createThread() { return `oai_${++this.turnSeq}`; }

  async run(_threadId: string | undefined, model: string, input: string, onEvent: (event: PattyEvent) => void, turn?: ChatTurn, options?: TurnOptions) {
    const turnId = `oai_turn_${++this.turnSeq}`;
    const controller = new AbortController();
    this.controllers.set(turnId, controller);
    /** Tool calling needs the real roles, so a turn that carries them replaces the flattened prompt with the caller's own messages. */
    const response = await this.call('/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      body: JSON.stringify({
        model, stream: true, stream_options: { include_usage: true },
        messages: turn?.messages?.length ? turn.messages : [...(options?.instructions ? [{ role: 'system', content: options.instructions }] : []), { role: 'user', content: input }],
        ...(turn?.tools?.length ? { tools: turn.tools } : {}),
        ...(turn?.toolChoice !== undefined ? { tool_choice: turn.toolChoice } : {}),
        ...(options?.responseFormat ? { response_format: options.responseFormat } : {}),
        ...(options?.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
        ...(options?.sampling?.temperature !== undefined ? { temperature: options.sampling.temperature } : {}),
        ...(options?.sampling?.topP !== undefined ? { top_p: options.sampling.topP } : {}),
        ...(options?.sampling?.maxOutputTokens !== undefined ? { max_tokens: options.sampling.maxOutputTokens } : {}),
        ...(options?.sampling?.stop?.length ? { stop: options.sampling.stop } : {}),
        ...(options?.sampling?.seed !== undefined ? { seed: options.sampling.seed } : {}),
      }),
    });
    void this.pump(response, turnId, onEvent).finally(() => this.controllers.delete(turnId));
    return { turnId };
  }

  private async pump(response: Response, turnId: string, onEvent: (event: PattyEvent) => void) {
    let buffered = '';
    /** Tool calls arrive as fragments indexed per call, with the name once and the JSON arguments split across chunks, so they are assembled and emitted whole. */
    const calls = new Map<number, ChatToolCall>();
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffered += Buffer.from(chunk).toString();
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          const event = JSON.parse(payload) as { choices?: { delta?: { content?: string; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: ToolCallDelta[] } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } } };
          const text = event.choices?.[0]?.delta?.content;
          if (text) onEvent({ version: 1, type: 'delta', runId: turnId, data: { text } });
          /** `reasoning_content` is what DeepSeek, vLLM and most gateways send; OpenRouter calls the same thing `reasoning`, and a provider that sends a structured value rather than text has nothing to forward. */
          const thinking = event.choices?.[0]?.delta?.reasoning_content ?? event.choices?.[0]?.delta?.reasoning;
          if (typeof thinking === 'string' && thinking) onEvent({ version: 1, type: 'reasoning', runId: turnId, data: { text: thinking } });
          for (const fragment of event.choices?.[0]?.delta?.tool_calls ?? []) {
            const index = fragment.index ?? 0;
            const call = calls.get(index) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } };
            if (fragment.id) call.id = fragment.id;
            if (fragment.function?.name) call.function.name = fragment.function.name;
            if (fragment.function?.arguments) call.function.arguments += fragment.function.arguments;
            calls.set(index, call);
          }
          if (event.usage) onEvent({ version: 1, type: 'usage', runId: turnId, data: {
            inputTokens: event.usage.prompt_tokens ?? 0,
            /** Cached input is billed at a discount everywhere it is reported, so dropping these details would price a cached-heavy turn as if none of it were cached. */
            cachedInputTokens: event.usage.prompt_tokens_details?.cached_tokens ?? 0,
            outputTokens: event.usage.completion_tokens ?? 0,
            reasoningOutputTokens: event.usage.completion_tokens_details?.reasoning_tokens ?? 0,
            totalTokens: event.usage.total_tokens ?? (event.usage.prompt_tokens ?? 0) + (event.usage.completion_tokens ?? 0),
          } satisfies TokenUsage });
        }
      }
      if (calls.size) onEvent({ version: 1, type: 'tool_calls', runId: turnId, data: { toolCalls: [...calls.keys()].sort((a, b) => a - b).map(index => calls.get(index)!) } });
      onEvent({ version: 1, type: 'completed', runId: turnId });
    } catch (error) {
      if (controllerAborted(error)) onEvent({ version: 1, type: 'cancelled', runId: turnId });
      else onEvent({ version: 1, type: 'failed', runId: turnId, data: { providerStatus: error instanceof Error ? error.message : 'upstream_failed' } });
    }
  }

  async interrupt(providerTurnId: string) { this.controllers.get(providerTurnId)?.abort(); }
  async approve() {}
  async logout() {}
  async health() { try { await this.call('/models'); return true; } catch { return false; } }
  async shutdown() { for (const controller of this.controllers.values()) controller.abort(); this.controllers.clear(); }
}

type ToolCallDelta = { index?: number; id?: string; function?: { name?: string; arguments?: string } };
/** Every OpenAI-compatible endpoint speaks the tool-calling shape, so these subs advertise it and requests carrying tools route to them. */
const capabilities = ['tools'];

function controllerAborted(error: unknown) {
  return error instanceof Error && (error.name === 'AbortError' || error.message.includes('aborted'));
}
