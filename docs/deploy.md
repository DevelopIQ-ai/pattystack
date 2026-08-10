# Deploying Patty for an app

Patty is deliberately one machine. Each Codex sub is a long-lived `codex app-server` child process with its own logged-in `CODEX_HOME` on local disk, and the store is a single SQLite file — so Patty needs **one always-on box with a persistent disk**, and your app talks to it over the network as an OpenAI-compatible client.

That rules out Vercel, Trigger.dev tasks, Lambda, or anything scale-to-zero *for Patty itself*: an ephemeral worker starts with no logged-in subs and no way to complete the OAuth callback. Those platforms are fine — better, even — as **clients**. The split you want:

```
Vercel functions ─┐
Trigger.dev tasks ─┼── OPENAI_BASE_URL ──▶  Patty (one small box, holds the subs)  ──▶ Codex subs + API fallback
your laptop ──────┘        + cp_live_… key
```

Anything with a disk works: a $5–10 VM (Hetzner, EC2, DigitalOcean), Fly.io with a volume, Railway, Render, or a container with a persistent volume mounted at Patty's `PATTY_DB_PATH` and account homes. Patty barely uses CPU — 1 vCPU is plenty; you are paying for process and disk persistence, not compute.

## 1. The box

```sh
# Node 22+ is required (node:sqlite)
node -v
npm i -g @puffle/pattystack
mkdir -p ~/.patty && chmod 700 ~/.patty
```

## 2. Log the subs in

This is the one step that needs a browser, because Codex's OAuth redirect lands on `localhost:1455` **on the daemon's machine**. Two ways:

- **SSH port-forward** — `ssh -L 1455:localhost:1455 you@box`, start the login, then open the printed URL in your local browser. The callback travels back down the tunnel.
- **Device code** — `patty accounts add <alias> device_code` prints a code to enter on another device, with nothing to forward.

The box needs the Codex CLI installed at a version Patty speaks (`>=0.145.0 <0.148.0`; `PATTY_CODEX_VERSION=<version>` accepts one exact release beyond that once you have verified it). Set `PATTY_CODEX_COMMAND` if it is not on the service user's PATH, and check with `patty doctor` — it fails the `codex_cli` check when the installed version is one Patty cannot drive, which is the state an unattended `codex upgrade` leaves behind. Logins survive restarts — the daemon re-attaches an app-server to each persisted sub at boot and prints `restoredSubs`.

Add metered API credit as the safety net, so you keep answering when every sub is inside its reset window:

```sh
export OPENAI_API_KEY=sk-…            # Patty stores the variable NAME, never the value
curl -XPOST $PATTY/v1/accounts/openai-compatible -H "authorization: Bearer $PATTY_KEY" \
  -d '{"alias":"api-credit","baseUrl":"https://api.openai.com/v1","apiKeyEnv":"OPENAI_API_KEY","tier":"fallback"}'
```

## 3. Keep it running

```ini
# /etc/systemd/system/pattystack.service   →  systemctl enable --now pattystack
[Unit]
Description=Pattystack
After=network-online.target

[Service]
User=patty
ExecStart=/usr/bin/pattystack
Environment=PATTY_DB_PATH=/home/patty/.patty/patty.sqlite
Environment=PATTY_HOST=127.0.0.1
# only needed when the Codex CLI is not on the service user's PATH
Environment=PATTY_CODEX_COMMAND=/usr/bin/codex
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

A user unit (`~/.config/systemd/user/pattystack.service`) works too, but pair it with `loginctl enable-linger $USER` or it dies when you log out. Restarts are safe: the store reconciles in-flight runs transactionally at boot, so an abrupt kill can't leave a sub with phantom active runs.

## 4. Let your app reach it

Patty binds loopback and speaks plain HTTP; the API key is a bearer token, so it must not cross the public internet in the clear. Pick one:

**Tailnet (simplest, recommended).** `tailscale up` on the box, then bind to the tailnet address — your app's machines join the same tailnet and connect directly:

```ini
Environment=PATTY_ALLOW_NON_LOOPBACK=1
Environment=PATTY_HOST=100.64.0.7
```

Wildcards (`0.0.0.0`, `::`, empty) are refused even with the opt-in — you name the interface, so exposure is a decision rather than a default.

**TLS reverse proxy** (when the client can't join a tailnet — serverless platforms, mostly). Keep Patty on loopback and terminate TLS in front of it:

```caddyfile
patty.example.com {
  reverse_proxy 127.0.0.1:3210
}
```

Restrict it further if you can — Caddy/nginx IP allowlists, Cloudflare Access, or Tailscale Funnel. A hostname anyone can reach is a hostname anyone can brute-force keys against.

## 5. Wire the app

```sh
patty keys create prod-app          # secret is shown once
patty keys limit <id> 120 8         # 120 req/min, 8 runs in flight; a burst queues instead of failing
```

```sh
OPENAI_BASE_URL=https://patty.example.com/v1
OPENAI_API_KEY=cp_live_…
```

Use a separate key per consumer (`prod-app`, `staging`, `laptop`) so you can revoke or throttle one without touching the others, and usage stays attributed per key. Scrape `https://patty.example.com/metrics` into whatever you already run.

## Things that will bite you

- **Single node, single SQLite file.** No HA. If the box dies, your app's inference dies — keep a fallback provider configured in the app itself, not just in Patty.
- **Back up the SQLite file and the account homes.** Losing the homes means logging every sub in again.
- **Capacity is finite.** Patty spreads what your subscriptions already grant; it cannot create headroom. When everything is exhausted the honest answer is a `503 no_eligible_account` with `Retry-After`, so your client needs a retry/backoff path.
- **Nothing is metered on the wire but keys.** A leaked `cp_live_…` key is unmetered access to every sub Patty holds until you revoke it.
- **Whose seats.** Running your own subscriptions as your team's dev capacity is what Patty is for. Using per-seat subscriptions to serve *other people's* traffic is a plan-type question with your provider, not something Patty can make safe.
