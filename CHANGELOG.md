# Changelog

Notable changes to Pattystack. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses [semantic versioning](https://semver.org/).

## Unreleased

### Added

- **Reasoning traces.** A reasoning model's thinking is forwarded instead of being reduced to a token count: a new additive `PattyEvent` `type: "reasoning"` (`data: {text}`), fed by a Codex sub's `item/reasoning/textDelta`, `item/reasoning/summaryTextDelta` and `item/reasoning/summaryPartAdded` notifications and by an OpenAI-compatible sub's `delta.reasoning_content`/`delta.reasoning`. It arrives on `/v1/chat/completions` as `delta.reasoning_content` chunks while streaming and as `message.reasoning_content` when not, on `/v1/responses` as `response.reasoning_summary_text.delta`, and on the native run stream as its own event, replayed mid-turn from a bounded live buffer. Like the answer it is never persisted, logged or shown in the console: `run_events` keeps the redacted marker. `PATTY_FORWARD_REASONING=0` drops it entirely.
- **Cache hit rate.** `cacheHitRate` (cached share of provider-reported input tokens) on `/v1/usage` totals, subs, keys and runs, on `/v1/runs`, and in the console next to the token counts; `/metrics` gains `patty_cached_input_tokens_total{sub}` and `patty_cache_hit_ratio{sub}`. Derived from the stored counts, and `null`/absent rather than `0` when nothing has been measured. A `--fake` sub now reports a warm prompt prefix as cached on a thread's later turns, so the rate is visible without a real subscription.
- `docs/deploy.md`: running Patty on one always-on box and pointing an app at it over a tailnet or TLS proxy.
- Issue and pull request templates, and this changelog.

## 0.1.0

First working version: everything below landed before the project had a changelog.

### Added

- **Stacked subs.** Any number of Codex subscriptions, each isolated in its own `CODEX_HOME` and supervised as a `codex app-server` child process, added and removed at runtime and re-attached at boot. Real subs need only the Codex CLI, whose version is verified before Patty speaks to it.
- **Any OpenAI-compatible endpoint** as a sub (`POST /v1/accounts/openai-compatible`), with the provider secret referenced by environment-variable name and never persisted.
- **Tiered routing.** Subs are `primary` or `fallback`; every eligible primary is exhausted before metered API credit serves anything, and traffic returns to the stack as soon as a quota window rolls over.
- **Routing on real state** — remaining quota as a rolling window, health, in-flight runs, model eligibility — under a transactional lease, with the console explaining the choice in words.
- **429/quota failover** across subs and across the tier boundary, before any output has streamed.
- **OpenAI-compatible API.** `POST /v1/chat/completions` (streaming and not) and `GET /v1/models`, so `OPENAI_BASE_URL=http://127.0.0.1:3210/v1` works with the OpenAI SDKs, Cursor, aider and LiteLLM. `x-patty-sub` names the sub that answered.
- **Named API keys** with per-key usage attribution that survives revocation.
- **Per-key limits** (`patty keys limit <id> <rpm> <concurrency>`): a burst over a cap queues per key instead of failing, and only what still can't be served is answered `429` with `Retry-After`.
- **Token metering** from the provider's own counters, per run, sub, model and key, exposed via `GET /v1/usage` and `patty usage`.
- **Operator console** on loopback: subs, quota windows, router scores and reasons, streaming inference, usage, keys, run history and `doctor`.
- **Observability**: Prometheus `/metrics`, filterable run history, `patty doctor`, JSON request logs that contain no prompts, output or secrets.
- **Opt-in non-loopback binding** (`PATTY_ALLOW_NON_LOOPBACK=1` plus a named `PATTY_HOST`; wildcards always refused).
- **Distribution**: one dependency-free `@puffle/pattystack` package holding daemon, CLI and console, smoke-tested in CI, plus `corepack pnpm demo` for three fake subs.

### Fixed

- A signed-in Codex 0.145.0 account reports `requiresOpenaiAuth: true`, which was read as "not logged in" and stranded real subs in `pending_login`.
- Subs were not re-attached to app-server workers after a daemon restart, leaving them `reconnect_required` and unrecoverable.
- `x-patty-sub` named the sub picked first rather than the one that answered, misreporting every failed-over request.
- A saturated stack answered `400 invalid_request`; it is now a retryable `503` with `Retry-After`.
- Runs from providers that report no token counts showed `0` tokens and no model, which read as free rather than unmetered.
