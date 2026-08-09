# Local API

## OpenAI-compatible surface

`POST /v1/chat/completions` accepts OpenAI's request body and returns `chat.completion` (or a `chat.completion.chunk` SSE stream with `stream: true`), so an unmodified OpenAI client works against `OPENAI_BASE_URL=http://127.0.0.1:3210/v1` with a `cp_live_…` key. It is a translation over the same coordinator `/v1/runs` uses, so routing, leases, pre-output failover and metering behave identically:

- the verbatim messages travel with the turn, so a provider that speaks roles gets them unchanged; only a single-input provider (a Codex app-server sub) falls back to the flattened transcript (`role: content`, blank-line separated; a lone user message is passed verbatim);
- `usage` is the provider's own counts mapped to OpenAI's names — `prompt_tokens`/`completion_tokens`/`total_tokens`, with `prompt_tokens_details.cached_tokens` and `completion_tokens_details.reasoning_tokens`. Reasoning output is counted inside `completion_tokens`, as OpenAI reports it;
- `x-patty-sub` and `x-patty-run` name the sub that served the request and the underlying run, so a caller can attribute or debug a response without a second call;
- a failed or cancelled run answers `502` (non-streaming) or an `error` frame before `[DONE]` (streaming);
- unsupported today: `n>1`, logprobs, images.

### Structured output

`response_format` is honoured rather than dropped, because an agentic caller asking for a filled-in schema and getting a paragraph back fails at its own parser, with nothing in the request to explain why.

- `{type:'json_schema', json_schema:{name?, description?, strict?, schema}}` is handed to the provider as the turn's output schema — for a Codex sub, `turn/start.outputSchema`, which the app-server uses to constrain the final assistant message; for an OpenAI-compatible sub, the `response_format` is forwarded verbatim. The answer arrives as JSON text in the usual `content`, so an OpenAI client parses it unchanged.
- `{type:'json_object'}` names no schema, so it becomes the loosest object schema (`{type:'object'}`) on providers that need one. `{type:'text'}` is the default and constrains nothing.
- A malformed `response_format` — `json_schema` with no `schema` object, or an unknown `type` — is `400 invalid_request`. Silently dropping it is the one failure a structured caller cannot detect, so it is refused up front.
- Structured output needs no capability: every stacked provider can constrain a turn, so routing, failover and metering are unchanged. A failover replays the schema onto the next sub along with the prompt.

The same schema can be sent to Patty's own `POST /v1/runs` and `POST /v1/threads/{id}/turns` as `responseFormat`, in the identical shape.

### Roles and per-turn knobs

The rest of the request is carried too, in provider-neutral form, instead of being flattened away with the prompt:

- **System and developer messages are the turn's rules**, not more prompt text. They are split out and sent to a Codex sub as the thread's `developerInstructions`, and to an OpenAI-compatible sub as the original messages. A turn on a thread the caller opened earlier cannot restate the thread's standing rules, so that turn's instructions ride along with its prompt rather than silently replacing them.
- **`reasoning_effort`** becomes the Codex turn's `effort` and is forwarded as `reasoning_effort` to an OpenAI-compatible sub. It is a free-form string in the app-server protocol — whatever the model advertises — so it is length-checked rather than enumerated against a fixed list.
- **`temperature`, `top_p`, `max_tokens`/`max_completion_tokens`, `stop`, `seed`** are forwarded to a sub whose provider accepts them. A Codex subscription turn has no decoding knobs, so it ignores them; that is a property of the sub serving the run, not a rejected request.
- An out-of-range value (`temperature: 5`, `max_tokens: 0`, a fifth `stop` sequence) is `400 invalid_request`, on the same reasoning as a malformed schema.
- `POST /v1/runs` and `POST /v1/threads/{id}/turns` take the same knobs as `instructions`, `reasoningEffort` and `sampling: {temperature, topP, maxOutputTokens, stop, seed}`. `POST /v1/threads` takes `instructions` as the thread's standing rules. All of them are replayed onto the next sub on failover.

### Tool calling

`tools` and `tool_choice` are passed through to the provider, and a turn that calls one answers with `finish_reason: "tool_calls"`, `content: null` and an assembled `tool_calls` array; streaming emits the calls as one `delta.tool_calls` chunk before the finishing chunk, since Patty assembles the provider's fragments rather than forwarding them piecemeal.

Two consequences worth knowing:

- **A request carrying tools requires the `tools` capability**, so it can only be routed to a sub whose provider honours them: an OpenAI-compatible sub forwards `tools` as-is, and a Codex subscription serves them through the tool bridge described below. When no stacked sub can serve the model *with* tools the answer is `400 model_unavailable` naming that, rather than a silently toolless completion or a routing failure the caller would retry.
- **The verbatim messages are forwarded** instead of the flattened prompt, because a tool round trip includes an assistant turn whose content is `null` and a `tool` message answering a specific `tool_call_id` — neither survives flattening. Tool calls are provider content, so they are never persisted: `run_events` records that a `tool_calls` event happened and nothing about it, and a caller reading a run back after its in-process buffer has expired sees text and token counts only.

The same tools can be offered on Patty's own `POST /v1/runs` by sending a `chat` turn (`{messages, tools, toolChoice}`) alongside `model`/`input` — the capability gate and the `400 model_unavailable` answer are identical. The calls arrive on the run's event stream as a `tool_calls` event, which is what the console's **offer tools** box in the Inference panel uses. A run parked on a call is resumed with `POST /v1/runs/{id}/tool-results` (`{results:[{toolCallId, output}]}`), after which the run's event stream simply carries on; only a call that run actually made can be answered, and an unknown id is `400 invalid_request`.

#### How a Codex subscription serves the caller's tools

The app-server protocol has no way to hand a subscription turn the caller's functions, but a thread may name MCP servers, and Codex will call their tools. So Patty publishes the caller's `tools` through a small stdio MCP server that the app-server starts for that turn:

1. The turn's thread is created with `config.mcp_servers.patty` pointing at that server and `approvalPolicy: "never"`, so Codex does not stop to ask permission to call tools the caller offered in the first place. A tool-bearing turn always gets its own ephemeral thread, since the MCP configuration is part of thread creation.
2. Three details decide whether the model actually calls those tools, and each was found against a live subscription rather than a fixture. `default_tools_approval_mode: "approve"` on the server: without it the app-server cancels the model's call — the caller offered the function, so approving it is the caller's decision, already made. `features.non_prefixed_mcp_tool_names`: the tool reaches the model under the name the caller gave it, not namespaced by the server publishing it. And a preamble on the turn's developer instructions naming the tools: the CLI keeps MCP tools out of the model's tool list until it searches for them, which suits a person who has added a dozen servers and defeats an API caller offering three functions — left unsaid, the model answers from the web instead, plausibly and wrongly.
3. The server publishes exactly the caller's tools and nothing else. Its only authority is a random per-turn session token, passed to it in its environment; with it, it can reach `/internal/tool-bridge/*` on loopback and nothing else in Patty. It is never given a Patty API key, and the token dies with the turn.
4. When the model calls a tool, the invocation becomes an ordinary OpenAI `tool_calls` answer (`finish_reason: "tool_calls"`), and the Codex turn stays open, parked mid-flight.
5. The caller runs the function and sends the result back the way an OpenAI client already does — a `tool` message carrying the `tool_call_id`, in the next `POST /v1/chat/completions`. Patty matches that id to the parked turn and resumes it rather than starting a new one, so the sub keeps everything it had already worked out. The response reports the same run id as the first half of the round trip. The transcript in the follow-up request is ignored for a resumed turn: the sub is still holding the conversation.
6. A caller that never comes back is not held forever — the parked call times out (`PATTY_TOOL_RESULT_TIMEOUT_MS`, five minutes by default) and the turn fails rather than pinning the sub. An id Patty no longer holds is not resumable, and the request is served as a fresh turn instead.

### Reasoning traces

A reasoning model's thinking is forwarded as its own kind of event rather than folded into the answer or reduced to the `reasoningOutputTokens` counter, so a client that renders a thinking block has something to render:

- **The native contract** gains `PattyEvent` `type: "reasoning"` with `data: {text}`, carried exactly as `delta` is. It is additive: a consumer that switches on the older types ignores it and behaves as before.
- **`POST /v1/chat/completions`** streams it as `choices[0].delta.reasoning_content` chunks — the shape DeepSeek, vLLM and OpenRouter already emit — in their own chunks, never mixed into a chunk carrying `content`. A non-streaming answer carries the whole trace on the message as `reasoning_content`, present only when the sub produced one.
- **`POST /v1/responses`** streams it as `response.reasoning_summary_text.delta` (`item_id`, `output_index`, `summary_index`, `delta`).
- **Where it comes from.** A Codex subscription's `item/reasoning/textDelta` and `item/reasoning/summaryTextDelta` notifications become reasoning events, and `item/reasoning/summaryPartAdded` becomes the blank line between summary sections. An OpenAI-compatible sub's `delta.reasoning_content` or `delta.reasoning` does the same, whichever the provider sends.
- **What is stored is nothing.** Reasoning is provider content, so `run_events` records that a `reasoning` event happened and nothing about it, exactly as for `delta`. It never reaches the request log, the run receipt or the console. Late replay reads the turn's live in-process buffer (64 KiB, dropped 60s after the run is terminal) and falls back to the redacted marker once that is gone.
- **`PATTY_FORWARD_REASONING=0`** drops reasoning at the coordinator: no event is emitted, buffered or persisted, and no surface mentions it. Forwarding is on by default because a trace the operator's own model produced for the operator's own client is what makes a thinking block possible, and the default costs nothing that was not already streamed.

### Responses API

`POST /v1/responses` is the same engine as `/v1/chat/completions` with the Responses request and answer shapes, because a current OpenAI SDK or Vercel AI SDK client reaches for that path by default and a stack that only speaks chat completions is unreachable to it.

- `input` takes a string or a list of items; `instructions` become the turn's rules exactly as a `system` message does. A `function_call` item is read as the assistant turn holding that call and a `function_call_output` item as the `tool` message answering it, so a Responses caller resumes a parked turn on the same machinery a chat caller uses — and gets the same response `id` back.
- `text.format` is the Responses spelling of `response_format` (`{type:'json_schema', name, schema, strict}`), `reasoning.effort` of `reasoning_effort`, and `max_output_tokens` of `max_completion_tokens`. `temperature`, `top_p` and `seed` are unchanged.
- Only `type: 'function'` tools are accepted. A hosted tool (`web_search_preview` and friends) is `400 invalid_request`: no stacked sub can run it, and dropping it would answer a question the caller did not ask.
- The answer is a `response` object whose `output` is a list of items — an `output_text` message, plus a `function_call` item per call the model made — with `usage` in Responses names (`input_tokens`/`output_tokens`/`total_tokens`). A response carrying calls is `completed`: the call is an output item, and the next move is the caller's.
- `stream: true` emits the named SSE events a Responses client expects, in order and numbered: `response.created`, `response.in_progress`, `response.output_item.added`, `response.content_part.added`, `response.output_text.delta`…, `response.output_text.done`, `response.content_part.done`, `response.output_item.done` (once per item), then `response.completed` — or `response.failed` carrying the error.

### Model aliases

An application asks for the model it was written against, and a stack of Codex subscriptions serves none of those names. `PATTY_MODEL_ALIASES` is the operator's answer, a JSON object of `{"asked-for":"actually-served"}`:

```sh
PATTY_MODEL_ALIASES='{"gpt-5-nano":"gpt-5-codex","*":"gpt-5-codex"}'
```

- A name the stack actually serves always wins, so stacking a sub that serves the asked-for model quietly stops the aliasing without a config change.
- `*` is the catch-all for anything unmapped. Without one, an unmapped name is left alone and fails as the honest `503 no_eligible_account` it is, rather than being answered by a model the caller did not ask for.
- Resolution happens once, at the edge, on `/v1/chat/completions`, `/v1/responses`, `/v1/runs` and thread turns, so routing, metering, run history and the `model` field of the answer all name the model that actually ran.
- A broken map fails at boot rather than routing somewhere surprising.

`GET /v1/models` returns OpenAI's list shape (`{object:'list',data:[{id,object:'model',owned_by}]}`) with a Patty-specific `subs` array naming which stacked subs can serve each model. An aliased name is listed as a model in its own right — to the client asking for it, that is what it is — with `aliasOf` naming who actually answers.

## Routing and quota windows

`GET /v1/router/status[?model=<model>]` returns the live ranking with the inputs behind it: `quotaRemaining` (last provider snapshot), `effectiveQuota`, `resetAt`/`resetsInMs`, `health`, `activeRuns`, `cooldownUntil` and the computed `score`, sorted best-first. Passing `model` evaluates real eligibility for that model instead of just readiness.

Quota is a rolling window, so Patty reads it as one:

- once `resetAt` has passed, a stored `remaining` describes a window that no longer exists, so the sub counts as full again and becomes eligible without waiting for a refresh;
- an unknown `remaining` counts as half — neither trusted nor excluded;
- headroom in a window that is about to roll over is use-it-or-lose-it, so a small `resetUrgency` term (weight .05) breaks ties toward the sooner-resetting sub without overriding real headroom (weight .55).

When a provider rejects a turn with a rate-limit/usage-limit/429 error before any output, Patty marks that sub's quota exhausted, parks it until its own `resetAt` (or 15 minutes if the provider never reported one), and retries the run once on another eligible sub. The attempt is recorded with reason `quota_failover`, so `run_attempts` shows where a request actually ran. If nothing else is eligible the run fails as `quota_exhausted`. Once output has started, Patty does not fail over — replaying a partially streamed answer on another sub would corrupt it.

## API keys and attribution

`POST /v1/api-keys {"name":"puffle-prod"}` issues a named key and returns the secret **once**; `GET /v1/api-keys` lists id, name, prefix, creation, last use and revocation state but never the secret; `DELETE /v1/api-keys/{id}` revokes one key without touching the others. Give every consumer its own key (`puffle-prod`, `puffle-dev`, a laptop, a CI job) and revocation stays surgical.

### Rate limits and queueing

`PUT /v1/api-keys/{id}/limits {"rpm":60,"concurrency":4}` caps a key; `patty keys limit <id> 60 4` does the same from the CLI, and `none` (or a null/omitted field) clears a limit. The body is the key's complete policy, so a PUT that omits `rpm` makes requests-per-minute unlimited again. `rpm` counts requests started in a rolling minute; `concurrency` counts runs in flight, and a slot is held until the run **settles**, not until the HTTP response is written — an async `POST /v1/runs` occupies its slot for the whole run.

A burst over a limit is queued rather than rejected: up to `PATTY_KEY_QUEUE_MAX` (default 64) requests wait per key for up to `PATTY_KEY_QUEUE_WAIT_MS` (default 20s), and only what still cannot be served is answered `429 rate_limited` with a `Retry-After` header and `error.retryAfterMs`. Queues are per key and in-process, so one noisy consumer can never starve another and nothing about a burst survives a restart. `GET /v1/api-keys` reports each key's limits plus live `inFlight`, `queued` and `throttled` counts, and `/metrics` exposes `patty_key_in_flight`, `patty_key_queued`, `patty_key_throttled_total`, `patty_key_limit_rpm` and `patty_key_limit_concurrency`.

Every run records the key that started it, and usage inherits that attribution from the run, so `GET /v1/usage` reports totals per key as well as per sub. Attribution survives revocation — history should not rewrite itself — and runs made before named keys existed report `keyId: null`, labelled `unattributed` rather than silently folded into a real key.

## When no sub can serve a request

If every eligible sub is busy, cooling down or out of quota, the request is answered `503` with `{"error":{"code":"no_eligible_account","retryable":true,"retryAfterMs":5000}}` and a `Retry-After: 5` header. This is a capacity condition, not a malformed request: a client should back off and retry rather than treat it as fatal.

## Usage metering

`GET /v1/usage` returns token totals, per-sub and per-key aggregates with their cache hit rates, and the most recent measured runs. Patty persists only provider-reported counts (input, cached input, output, reasoning output, total) keyed by run, sub, and model — never prompts or generated text. Counts come from the provider alone; a provider that reports none (an OpenAI-compatible endpoint that ignores `stream_options.include_usage`, for instance) leaves the run unmetered, and `GET /v1/runs` returns null token fields for it while still naming the model the run asked for. The console shows those as `not reported`, which is deliberately distinct from zero. A run's row is replaced by each newer provider snapshot, so totals stay exact when a turn reports usage more than once.

### Cache hit rate

Cached input is the part of a prompt the provider recognised from an earlier turn and billed at a discount, so how much of it is cached is the difference between a cheap conversation and an expensive one. `GET /v1/usage` carries `cacheHitRate` — `cachedInputTokens / inputTokens` — on the totals, on every sub and key, and on each recent run, and `GET /v1/runs` carries it per run:

```json
{ "totals": { "inputTokens": 412000, "cachedInputTokens": 297000, "cacheHitRate": 0.7209 } }
```

It is derived from the stored counts rather than stored, so it can never disagree with them. `cacheHitRate` is `null` — the console prints `not reported` — whenever no input tokens were measured: a sub that has served nothing, or a provider that reports no usage at all, has *no* hit rate, and a `0` there would read as a cache missing every single time. `/metrics` exposes `patty_cached_input_tokens_total{sub}` and `patty_cache_hit_ratio{sub}`; cached tokens are a subset of `patty_tokens_total{direction="input"}` rather than a third direction, so summing the directions still gives total tokens, and the ratio gauge is absent for a sub with nothing measured instead of reporting zero.

The stack's own lever on that rate is thread affinity: a thread stays pinned to the sub that started it, so the provider-side prompt cache stays warm across turns. Pre-output failover to another sub deliberately gives that up — an answer on a cold cache beats no answer — and shows up as a dip in the rate alongside `patty_run_attempts_total{reason="quota_failover"}`.

### Estimated cost

Token counts are measured; dollars are not. `GET /v1/usage` adds a `cost` block and a `cost` field on each sub, key and run, computed locally from a price table (USD per million tokens, with cached input priced separately because every provider discounts it):

```json
{ "cost": { "subscriptionUsd": 12.4, "apiUsd": 0.31, "estimatedCostUsd": 12.71,
            "unpricedRuns": 3, "unpricedModels": ["local-llama"] } }
```

- `subscriptionUsd` is what the turns served by `primary` subs *would* have cost at API list price — the money the subscriptions absorbed. `apiUsd` is real spend, because a `fallback` sub is a metered API key. That split is the point of the number.
- A model with no price is **unpriced, not free**: it is excluded from the estimate and counted in `unpricedRuns`/`unpricedModels`, and its run reports `estimatedCostUsd: null`. Prices go stale, so under-reporting loudly beats reporting `$0`.
- `PATTY_PRICES=/path/prices.json` merges over the built-in table, which is how you price a self-hosted model or correct a rate without waiting for a release:

```json
{ "local-llama": { "input": 0, "output": 0 },
  "gpt-5.5": { "input": 1.25, "cachedInput": 0.125, "output": 10 } }
```

The longest matching model prefix wins, so `gpt-5-codex-2026-01-01` inherits `gpt-5-codex`. A malformed price file fails at startup rather than mispricing every later report. `/metrics` exposes `patty_estimated_cost_usd_total{sub,tier}` and `patty_unpriced_runs`.

## Streaming privacy

Live SSE subscribers receive normalized provider deltas while connected. Patty persists only event ordering/type metadata for `delta`, `reasoning` and approval events; it does not persist provider output content. Late SSE replay therefore provides redacted delta markers and terminal semantics, not prior generated text — except while the turn's live in-process buffers survive, which is what lets a subscriber that joins mid-turn read the text and reasoning so far.

## Observability

`GET /metrics` returns Prometheus text exposition (authenticated like every other endpoint, since it names your subs): `patty_subs{state}`, `patty_sub_quota_remaining{sub}`, `patty_sub_quota_reset_seconds{sub}`, `patty_sub_health{sub}`, `patty_sub_active_runs{sub}`, `patty_runs_total{status}`, `patty_run_attempts_total{reason}` — which is where failover shows up as `reason="quota_failover"` — plus `patty_tokens_total{sub,direction}` and `patty_key_tokens_total{key}`. No prompt, output or credential is ever a label or a value.

`GET /v1/runs?sub=&model=&status=&keyId=&since=&limit=` is the run history, newest first, capped at 500 per request, with each run's sub, key, status, attempt count and tokens. `attempts > 1` is the visible fingerprint of a failover.

`GET /v1/doctor` (`patty doctor`) answers the only question a stuck operator has — can anything serve a request, and if not why — as named checks with a `detail` and, when a check fails, a `hint` naming the fix. `patty status` remains the raw router dump.

The daemon writes one JSON line per request to stdout: timestamp, request id, method, path (without the query string), status, duration, and the routed sub and run when there was one. Prompts, outputs, key secrets and query values are never logged. Set `PATTY_LOG_LEVEL=silent` to turn it off.

## Lending a sub to an agent that drives Codex itself

Some agents cannot be served by an endpoint at all: they run the Codex CLI or app-server themselves because they need their own threads, their own MCP servers, steering and interrupts. For those, Patty lends the subscription instead of the answer.

```sh
curl -sX POST localhost:3210/v1/subscriptions/lease -H "authorization: Bearer $PATTY_KEY" \
  -d '{"model":"gpt-5.4","ttlSeconds":600,"holder":"my-agent"}'
# {"id":"lease_...","alias":"work-sub","expiresAt":"...","models":["gpt-5.4",...],
#  "credential":{"accessToken":"...","chatgptAccountId":"...","chatgptPlanType":"plus"}}
```

The caller feeds that credential to its own Codex process — `codex app-server` takes exactly this triple via `account/login/start` with `chatgptAuthTokens` — and runs whatever turns it likes as that subscription. Patty picks which sub to lend the same way it picks one to call: primaries before fallbacks, healthiest and least-exhausted first, and only subs that serve the model you asked for.

What a lease deliberately is not:

- **Not the account.** Only the access token crosses the wire. The refresh token stays in the sub's Codex home, so the loan ends on Patty's schedule and cannot be extended by whoever holds it. `POST /v1/subscriptions/leases/{id}/renew` mints a fresh token and extends the window; `DELETE` hands the sub back early.
- **Not free capacity.** A live lease holds one of the sub's run slots, so the router already knows that sub is busier than its own run count suggests. A holder that dies stops renewing and the sub comes back on its own within the window, and a daemon restart drops every lease, because a borrower cannot outlive the daemon it borrowed from.
- **Not metered.** Patty never sees those turns, so they appear in no usage report — `patty_sub_credential_leases` in `/metrics` is the only place they show up. Quota still moves, so `/v1/router/status` reflects the spend at the next snapshot.
- **Not for API-key subs.** A stacked OpenAI-compatible key is not a subscription and has nothing to lend; a lease request never hands out the operator's provider key.

Default TTL is 300s, minimum 30s, capped by `PATTY_LEASE_MAX_SECONDS` (default 3600).

## Stacking non-Codex providers

`POST /v1/accounts/openai-compatible {"alias":"together","baseUrl":"https://api.together.xyz/v1","apiKeyEnv":"TOGETHER_API_KEY"}` stacks any OpenAI-compatible endpoint — an OpenAI or OpenRouter key, Together/Fireworks, a local Ollama or vLLM — next to your Codex subs behind the same router, metering, failover and OpenAI-compatible surface.

These subs default to `tier: "fallback"`, so they only serve a request once every `primary` sub is exhausted, cooling down or out of quota — paid credit is the spillover for your stack rather than a competitor for it. Pass `"tier":"primary"` to have a provider compete with your subs on score instead. `GET /v1/router/status` reports each sub's `tier` and sorts primaries first, and `patty_sub_servable{sub,tier}` in `/metrics` shows exactly when spillover starts.

Tiers are never mixed within one routing decision, and failover respects them: a 429 on the last primary sub retries on a fallback sub, and once the primary window rolls over the traffic returns to it without any operator action.

Patty stores the **name of the environment variable**, never the key: the secret is read from the daemon's environment at call time, so a stolen `patty.sqlite` still contains no provider credential. If the variable is unset when a request routes there, the run fails as `upstream_failed` rather than falling back to an unauthenticated call. Models come from the provider's own `/models`, and remaining quota is derived from the standard `x-ratelimit-*` headers — a provider that reports nothing stays "unknown" (counted as half) rather than being assumed full.
