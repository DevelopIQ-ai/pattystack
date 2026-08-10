#!/usr/bin/env node
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const configPath = process.env.PATTY_CONFIG_PATH ?? join(homedir(), '.config', 'pattystack', 'config.json');
const base = process.env.PATTY_URL ?? 'http://127.0.0.1:3210';
const parsed = new URL(base); if (!['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname)) throw new Error('Patty CLI refuses non-loopback URLs');
const storedKey = (() => { try { return JSON.parse(readFileSync(configPath, 'utf8')).key as string; } catch { return undefined; } })();
const key = process.env.PATTY_API_KEY ?? storedKey;
async function request(path: string, init: RequestInit = {}) { const response = await fetch(base + path, { ...init, headers: { authorization: `Bearer ${key ?? ''}`, 'content-type': 'application/json', ...init.headers } }); const text = await response.text(); console.log(text); if (!response.ok) process.exitCode = 1; return { response, text }; }
function saveKey(value: string) { mkdirSync(join(configPath, '..'), { recursive: true, mode: 0o700 }); writeFileSync(configPath, JSON.stringify({ key: value }), { mode: 0o600 }); chmodSync(configPath, 0o600); }
const [command, ...args] = process.argv.slice(2);
if (command === 'init') { const supplied = args[0] ?? process.env.PATTY_API_KEY; if (!supplied) throw new Error('pass the one-time cp_live key as `patty init <key>`'); saveKey(supplied); console.log(`saved key to ${configPath}`); }
else if (command === 'accounts' && args[0] === 'list') await request('/v1/accounts');
else if (command === 'accounts' && args[0] === 'add') await request('/v1/accounts/codex/login', { method: 'POST', body: JSON.stringify({ alias: args[1], mode: args[2] ?? 'browser' }) });
else if (command === 'accounts' && args[0] === 'relogin') await request(`/v1/accounts/${args[1]}/relogin`, { method: 'POST', body: JSON.stringify({ mode: args[2] ?? 'device_code' }) });
else if (command === 'accounts' && args[0] === 'refresh') await request(`/v1/accounts/${args[1]}/refresh`, { method: 'POST' });
else if (command === 'accounts' && args[0] === 'remove') await request(`/v1/accounts/${args[1]}`, { method: 'DELETE' });
else if (command === 'keys' && args[0] === 'list') await request('/v1/api-keys');
else if (command === 'keys' && args[0] === 'create') await request('/v1/api-keys', { method: 'POST', body: JSON.stringify({ name: args.slice(1).join(' ') }) });
else if (command === 'keys' && args[0] === 'limit') { const limit = (value?: string) => value === undefined || value === 'none' ? null : Number(value); await request(`/v1/api-keys/${args[1]}/limits`, { method: 'PUT', body: JSON.stringify({ rpm: limit(args[2]), concurrency: limit(args[3]) }) }); }
else if (command === 'keys' && args[0] === 'revoke') await request(`/v1/api-keys/${args[1]}`, { method: 'DELETE' });
else if (command === 'models') await request('/v1/models');
else if (command === 'usage') await request('/v1/usage');
else if (command === 'status') await request('/v1/router/status');
else if (command === 'doctor') await request('/v1/doctor');
else if (command === 'runs') await request('/v1/runs' + (args.length ? '?' + args.join('&') : ''));
else if (command === 'thread') await request('/v1/threads', { method: 'POST', body: JSON.stringify({ model: args[0], accountId: args[1] }) });
else if (command === 'turn') await request(`/v1/threads/${args[0]}/turns`, { method: 'POST', body: JSON.stringify({ model: args[1], input: args.slice(2).join(' ') }) });
else if (command === 'approve') await request(`/v1/runs/${args[0]}/approvals/${args[1]}`, { method: 'POST', body: JSON.stringify({ approved: args[2] === 'yes' }) });
else if (command === 'events') { const response=await fetch(`${base}/v1/runs/${args[0]}/events`,{headers:{authorization:`Bearer ${key??''}`}}); if(!response.body) throw new Error('SSE unavailable'); for await(const chunk of response.body) process.stdout.write(Buffer.from(chunk).toString()); }
else if (command === 'cancel') await request(`/v1/runs/${args[0]}/cancel`, { method: 'POST' });
else if (command === 'run') await request('/v1/runs', { method: 'POST', body: JSON.stringify({ model: args[0], input: args.slice(1).join(' ') }) });
else { process.exitCode=1; console.error('usage: patty init <key> | accounts add|list|relogin <alias> [browser|device_code]|refresh|remove | keys create <name>|list|limit <id> <rpm|none> <concurrency|none>|revoke <id> | models | usage | status | doctor | runs [sub=..] [model=..] [status=..] [limit=..] | thread <model> [account] | turn <thread> <model> <input> | events <run> | approve <run> <approval> yes|no | run <model> <input> | cancel <run>'); }
