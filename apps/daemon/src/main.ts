#!/usr/bin/env node
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PattyDaemon } from './server.js';
const defaultDbPath = '.patty/patty.sqlite';
const dbPath = process.env.PATTY_DB_PATH ?? defaultDbPath;
// Only Patty's own default directory is permission-managed; an explicit path is operator-owned.
if (dbPath === defaultDbPath) { mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 }); chmodSync(dirname(dbPath), 0o700); }
const daemon = new PattyDaemon(dbPath);
// `--fake` stacks one demo sub; repeat `--fake=<alias>[:<quotaRemaining>[:<minutesUntilReset>[:<tier>]]]` to stack several and watch routing choose between them, including the use-it-or-lose-it preference for a window about to roll over.
for (const argument of process.argv.filter(value => value === '--fake' || value.startsWith('--fake='))) {
  const [alias = 'fake-primary', remaining, resetInMinutes, tier] = argument.slice('--fake'.length).replace(/^=/, '').split(':');
  const account = daemon.addFakeAccount(alias || 'fake-primary', ['gpt-5-codex'], remaining === undefined ? 1 : Number(remaining), tier === 'fallback' ? 'fallback' : 'primary');
  if (resetInMinutes !== undefined && Number.isFinite(Number(resetInMinutes))) {
    account.quota = { ...account.quota, resetAt: new Date(Date.now() + Number(resetInMinutes) * 60_000).toISOString() };
    daemon.store.updateAccount(account);
  }
}
const port = Number(process.env.PATTY_PORT ?? 3210);
const host = process.env.PATTY_HOST ?? '127.0.0.1';
const server = await daemon.listen(port, host);
console.log(JSON.stringify({ listening: server.address(), ...(daemon.key ? { apiKey: daemon.key, warning: 'API key shown once; store it securely' } : { warning: 'existing local Patty key required; no new key was issued' }) }));
const restored = (await Promise.all([daemon.restoreCodexAccounts(), daemon.restoreOpenAiCompatibleAccounts()])).flat();
if (restored.length) console.log(JSON.stringify({ event: 'subs_restored', restoredSubs: restored.map(account => account.alias) }));
const shutdown = () => void daemon.shutdown().finally(() => server.close(() => process.exit(0)));
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
