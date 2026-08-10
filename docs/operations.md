# Operations

Install with `corepack pnpm install`. Run `corepack pnpm lint`, `typecheck`, `test:unit`, `test:contract`, `test:integration`, and `test:e2e:fake` before use. `test:live` runs only with `PATTY_LIVE_TESTS=1`, the exact 0.145.0 Codex command and a live account root, because it spends real quota.

For a safe demo, build and run `node apps/daemon/dist/src/main.js --fake=sub-a --fake=sub-b:0.4` and open the console at <http://127.0.0.1:3210/>; repeat `--fake=<alias>[:<quotaRemaining>]` per demo sub. It prints a `cp_live` key only when its database has no active key; save that one-time value with `patty init <key>`, which writes an owner-only local config fallback. The daemon binds only to loopback. Its default `.patty/` directory is created mode 0700. An explicit `PATTY_DB_PATH` is owned by the operator and Patty never changes permissions on its parent.

Adding a Codex account needs the Codex CLI on PATH or in `PATTY_CODEX_COMMAND`, and the adapter verifies it reports a version inside the supported range (`>=0.145.0 <0.148.0`, or the exact release named by `PATTY_CODEX_VERSION`) before starting. When a CLI upgrade outruns that range every Codex sub fails to start and lands in `reconnect_required`, logging `sub_restore_failed`; `patty doctor` reports it as unhealthy rather than as a healthy stack. Account add starts one app-server per opaque alias in an isolated home and uses documented stdio login, snapshot, logout, and shutdown operations. The live harness resumes two existing isolated homes when possible; it only performs an interactive device-code login for homes that are not already authenticated. It then reads account/model/rate-limit state and runs two account-pinned turns plus one unpinned Patty-routed turn without logging prompts, tokens, or account emails. Live test evidence is currently pending.

## Live account homes

Codex itself may persist its managed credentials in each isolated `CODEX_HOME` so an explicitly authorized operator can resume a device-code login. Patty never reads, exports, or parses those credentials or `auth.json`. Patty creates or accepts only owner-owned, non-symlink account roots and homes, then enforces mode `0700`. The live harness preserves those homes on success or failure for explicit operator resumption; it does not create evidence artifacts. If a persistent home is not already logged in, it will only begin device-code login with `PATTY_LIVE_INTERACTIVE=1` in a TTY and writes the challenge directly to `/dev/tty`, never captured stdout or stderr.

## Packaging and services

`corepack pnpm pack:npm` builds the single publishable `@puffle/pattystack` package into `dist-npm/`: the compiled daemon, the CLI, the console and the `pattystack` launcher, with no runtime dependencies (`@patty/contracts` is imported for types only, so nothing survives compilation). `corepack pnpm test:pack` then exercises that artifact the way a user meets it — `npx @puffle/pattystack` must boot, answer `/healthz`, serve a real `/v1/chat/completions` from a fake sub, and `pattystack usage` must reach the running daemon — so a packaging regression fails CI rather than reaching npm.

The launcher dispatches on its first argument: absent, `start`, `up` or a `--flag` starts the daemon; anything else is a CLI command. `pattyd` and `patty` remain available as direct bins.

Under a service manager, the daemon needs only `PATTY_DB_PATH`, plus `PATTY_CODEX_COMMAND` when the Codex CLI is not on the service user's PATH. Use `Restart=on-failure`; the store reconciles in-flight runs transactionally at boot, so an abrupt restart cannot leave a sub with phantom active runs.

## Binding beyond loopback

The daemon binds `127.0.0.1` by default and that is the only unguarded option, because a stacked Patty is an unmetered gateway to every subscription it holds. `PATTY_HOST` chooses the interface, and a non-loopback value additionally requires `PATTY_ALLOW_NON_LOOPBACK=1`:

```sh
PATTY_ALLOW_NON_LOOPBACK=1 PATTY_HOST=100.64.0.7 pattystack   # a tailnet address, for example
```

Wildcard addresses (`0.0.0.0`, `::`, empty) are refused even with the opt-in — name the exact interface, so exposure is a decision rather than a default. Keys are the only authentication on the wire and Patty speaks plain HTTP, so anything beyond loopback belongs on a private network (a tailnet, a WireGuard interface) or behind a TLS-terminating reverse proxy, with a separate named key per consumer so a leak is revocable on its own.
