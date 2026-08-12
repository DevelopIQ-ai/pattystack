import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Account, ChatToolCall, PattyEvent, ProviderAdapter } from '@patty/contracts';
import { ToolBridge } from '../src/tool-bridge.js';
import { loadAliases, resolveModel } from '../src/aliases.js';
import { responsesBody, responsesToChat } from '../src/responses.js';
import { Coordinator, FakeAdapter, KeyLimiter, RateLimited, Router, Store, cacheHitRate, effectiveQuota, eligible, id, now, quotaExhausted, resetUrgency, score } from '../src/core.js';
import { estimateCost, loadPrices } from '../src/pricing.js';
import { SUPPORTED_CODEX_VERSIONS, bridgePreamble, codexOutputSchema, codexVersionSupported } from '../src/codex.js';
import { validateStrictSchema } from '../src/schema-strict.js';
import { writeFileSync } from 'node:fs';
import { PattyDaemon, leaseTtlMs, parseReasoningEffort, parseResponseFormat, parseSampling, splitConversation } from '../src/server.js';
const account = (id: string, remaining = 1, tier: Account['tier'] = 'primary'): Account => ({ id, alias: id, tier, state: 'ready', models: ['gpt-5-codex'], quota: { remaining, observedAt: now() }, health: 1, activeRuns: 0 });
const wait = () => new Promise(resolve => setTimeout(resolve, 0));
class ControlledAdapter implements ProviderAdapter {
  turnId = 'provider-turn-42'; interrupt = vi.fn(async (_id: string) => {}); private onEvent?: (event: PattyEvent) => void;
  async login() { return {}; } async cancelLogin() {} async snapshot() { return { models: ['gpt-5-codex'], quota: { observedAt: now() } }; } async createThread(_model: string) { return 'provider-thread'; }
  async run(_thread: string | undefined, _model: string, _input: string, onEvent: (event: PattyEvent) => void) { this.onEvent = onEvent; onEvent({ version: 1, type: 'delta', runId: this.turnId }); return { turnId: this.turnId }; }
  complete() { this.onEvent?.({ version: 1, type: 'completed', runId: this.turnId }); } async approve() {} async logout() {} async health() { return true; } async shutdown() {}
}
describe('state and deterministic routing', () => {
  it('stores only a derived key hash and revocation disables a key', () => { const store = new Store(); const issued = store.issueKey(); const key = issued.key; expect(store.verifyKey(key)?.id).toBe(issued.id); const row = store.db.prepare('SELECT id,hash FROM api_keys').get() as { id: string; hash: string }; expect(row.hash).not.toBe(key); expect(row.hash).toMatch(/^[a-f0-9]{64}$/); store.revokeKey(row.id); expect(store.verifyKey(key)).toBeUndefined(); });
  it('filters exact models, cooldowns, exhausted quota, and capacity', () => { const a = account('a'); expect(eligible(a, { model: 'gpt-5-codex', input: '' })).toBe(true); expect(eligible(a, { model: 'other', input: '' })).toBe(false); a.quota.remaining = 0; expect(eligible(a, { model: 'gpt-5-codex', input: '' })).toBe(false); a.quota.remaining = 1; a.cooldownUntil = '2099-01-01T00:00:00Z'; expect(eligible(a, { model: 'gpt-5-codex', input: '' })).toBe(false); });
  it('selects quota headroom deterministically and leases once', () => { const store = new Store(); const low = account('low', .1); const high = account('high', .9); store.addAccount(low); store.addAccount(high); const router = new Router(store); expect(score(high, 'seed')).toBeGreaterThan(score(low, 'seed')); const selected = router.choose({ model: 'gpt-5-codex', input: '' }, 'seed'); expect(selected.id).toBe('high'); expect(store.acquireLease('high', 'other')).toBe(false); });
  it('releases the selection lease after active-run accounting, allowing configured concurrency', async () => { const store = new Store(); const a = account('a'); store.addAccount(a); const c = new Coordinator(store, new Router(store), new Map([[a.id, new ControlledAdapter()]])); await c.start({ model: 'gpt-5-codex', input: 'one' }); await c.start({ model: 'gpt-5-codex', input: 'two' }); expect(store.account(a.id)?.activeRuns).toBe(2); expect(store.acquireLease(a.id, 'probe')).toBe(true); await expect(c.start({ model: 'gpt-5-codex', input: 'three' })).rejects.toThrow('no_eligible_account'); });
  it('honors thread pin even when another account has more quota', async () => { const store = new Store(); const first = account('first', .1); const second = account('second', .9); store.addAccount(first); store.addAccount(second); const c = new Coordinator(store, new Router(store), new Map([[first.id, new FakeAdapter()], [second.id, new FakeAdapter()]])); const thread = await c.createThread('gpt-5-codex', first.id); const run = await c.start({ model: 'gpt-5-codex', input: 'x', threadId: thread.threadId }); expect(store.run(run)?.account_id).toBe(first.id); });
  it('emits exactly one terminal event and interrupts with the provider turn ID', async () => { const store = new Store(); const a = account('a'); store.addAccount(a); const adapter = new ControlledAdapter(); const c = new Coordinator(store, new Router(store), new Map([[a.id, adapter]])); const seen: PattyEvent[] = []; const runId = await c.start({ model: 'gpt-5-codex', input: 'x' }); c.on(runId, event => seen.push(event)); await wait(); adapter.complete(); await wait(); expect(() => c.cancel(runId)).toThrow('invalid_request'); expect(seen.filter(event => ['completed', 'failed', 'cancelled'].includes(event.type))).toHaveLength(1); expect(seen.at(-1)?.type).toBe('completed');
    const second = await c.start({ model: 'gpt-5-codex', input: 'cancel' }); await wait(); c.cancel(second); expect(adapter.interrupt).toHaveBeenCalledWith('provider-turn-42'); expect(c.events(second).filter(event => event.type === 'cancelled')).toHaveLength(1); });
});

describe('persistent bootstrap state', () => {
  it('issues a bootstrap key once for an existing database', () => { const path = `/tmp/patty-${Date.now()}-${Math.random()}.sqlite`; const first = new Store(path); const key = first.issueKey().key; const second = new Store(path); expect(second.hasActiveKey()).toBe(true); expect(second.verifyKey(key)).toBeTruthy(); });
});

it('reconciles persisted in-flight work transactionally at startup', () => { const store = new Store(); const a = account('recover'); store.addAccount({ ...a, activeRuns: 1, state: 'ready' }); store.createRun({ id: 'run_recover', accountId: a.id, model: 'gpt-5-codex', fingerprint: 'f', status: 'running', outputStarted: false, cancelRequested: false }); store.reconcileWorkers(); expect(store.account(a.id)?.activeRuns).toBe(0); expect(store.account(a.id)?.state).toBe('reconnect_required'); expect(store.publicRun('run_recover')?.status).toBe('cancelled'); });

it('leases every eligible primary sub before any fallback sub, whatever the scores say', () => {
  const store=new Store();const weak=account('codex-a',.02);const strong=account('api-credit',1,'fallback');store.addAccount(weak);store.addAccount(strong);
  const router=new Router(store);
  expect(router.choose({model:'gpt-5-codex',input:'x'},'run-1').alias).toBe('codex-a');
  // With the only primary sub leased, the request has nowhere left to go but paid credit.
  expect(router.choose({model:'gpt-5-codex',input:'x'},'run-2').alias).toBe('api-credit');
});
it('reports no eligible account rather than a fallback sub when the caller pins an exhausted primary sub', () => {
  const store=new Store();const pinned=account('codex-a',0);store.addAccount(pinned);store.addAccount(account('api-credit',1,'fallback'));
  expect(()=>new Router(store).choose({model:'gpt-5-codex',input:'x',accountId:pinned.id},'run-1')).toThrow('no_eligible_account');
});
it('does not publish or cool down after a provider reports completion then throws', async () => { const store=new Store(); const a=account('late'); store.addAccount(a); const adapter: ProviderAdapter={login:async()=>({}),cancelLogin:async()=>{},snapshot:async()=>({models:[],quota:{observedAt:now()}}),createThread:async(_model:string)=>'',run:async(_t,_model,_i,emit)=>{emit({version:1,type:'completed',runId:'p'});throw new Error('late');},interrupt:async()=>{},approve:async()=>{},logout:async()=>{},health:async()=>true,shutdown:async()=>{}}; const c=new Coordinator(store,new Router(store),new Map([[a.id,adapter]]));const r=await c.start({model:'gpt-5-codex',input:'x'});await new Promise(resolve=>setTimeout(resolve,0));expect(c.events(r).filter(e=>e.type==='failed')).toHaveLength(0);expect(store.account(a.id)?.cooldownUntil).toBeUndefined(); });

it('applies cooldown and health accounting for a provider failed terminal event', async () => { const store=new Store();const a=account('provider-failed');store.addAccount(a);const adapter:ProviderAdapter={login:async()=>({}),cancelLogin:async()=>{},snapshot:async()=>({models:[],quota:{observedAt:now()}}),createThread:async(_model:string)=>'',run:async(_t,_model,_i,emit)=>{emit({version:1,type:'failed',runId:'provider'});return{turnId:'provider'}},interrupt:async()=>{},approve:async()=>{},logout:async()=>{},health:async()=>true,shutdown:async()=>{}};const c=new Coordinator(store,new Router(store),new Map([[a.id,adapter]]));await c.start({model:'gpt-5-codex',input:'x'});await wait();expect(store.account(a.id)?.cooldownUntil).toBeTruthy();expect(store.account(a.id)!.health).toBeLessThan(1);});

it('enforces persisted exact capabilities', () => { const store=new Store(); const a=account('caps');store.addAccount(a);store.setCapabilities(a.id,['shell']);const router=new Router(store);expect(() => router.choose({model:'gpt-5-codex',input:'x',capabilities:['filesystem']},'caps')).toThrow('no_eligible_account');expect(router.choose({model:'gpt-5-codex',input:'x',capabilities:['shell']},'caps').id).toBe(a.id); });

it('persists normalized started and delta events for late replay', async () => { const store=new Store();const a=account('events');store.addAccount(a);const c=new Coordinator(store,new Router(store),new Map([[a.id,new FakeAdapter()]]));const run=await c.start({model:'gpt-5-codex',input:'x'});await wait();expect(c.eventItems(run).map(item=>item.event.type)).toEqual(['started','delta','usage','completed']); });
it('deletes dependent account metadata before account rollback', () => { const store=new Store();const a=account('rollback');store.addAccount(a);store.createRun({id:'r',accountId:a.id,model:'gpt-5-codex',fingerprint:'x',status:'running',outputStarted:false,cancelRequested:false});store.setCapabilities(a.id,['shell']);store.deleteAccountCascade(a.id);expect(store.account(a.id)).toBeUndefined();expect(store.run('r')).toBeUndefined(); });
it('upgrades an unversioned accounts schema before migration versions are recorded', () => { const path=`/tmp/patty-legacy-${Date.now()}.sqlite`; const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(path);db.exec("CREATE TABLE accounts(id TEXT PRIMARY KEY,alias TEXT,state TEXT,models TEXT,quota TEXT,health REAL,active_runs INTEGER,cooldown_until TEXT); CREATE TABLE api_keys(id TEXT PRIMARY KEY,prefix TEXT,hash TEXT,revoked_at TEXT,last_used_at TEXT,created_at TEXT); CREATE TABLE runs(id TEXT PRIMARY KEY,account_id TEXT,thread_id TEXT,fingerprint TEXT,idempotency_key TEXT,status TEXT,created_at TEXT); CREATE TABLE routing_leases(account_id TEXT PRIMARY KEY,run_id TEXT,expires_at TEXT);");db.close();const upgraded=new Store(path);const columns=upgraded.db.prepare('PRAGMA table_info(accounts)').all() as {name:string}[];expect(columns.some(c=>c.name==='home_ref')).toBe(true);expect(upgraded.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toMatchObject({n:10}); });

it('fails over once before output and records an alternate attempt', async () => { const store=new Store();const first=account('first');const second=account('second');store.addAccount(first);store.addAccount(second);const failing:ProviderAdapter={login:async()=>({}),cancelLogin:async()=>{},snapshot:async()=>({models:[],quota:{observedAt:now()}}),createThread:async(_model:string)=>'',run:async()=>{throw new Error('early')},interrupt:async()=>{},approve:async()=>{},logout:async()=>{},health:async()=>true,shutdown:async()=>{}};const c=new Coordinator(store,new Router(store),new Map([[first.id,failing],[second.id,new FakeAdapter()]]));const run=await c.start({model:'gpt-5-codex',input:'x',accountId:first.id});await new Promise(resolve=>setTimeout(resolve,10));expect(store.publicRun(run)?.status).toBe('completed');expect((store.db.prepare('SELECT COUNT(*) AS n FROM run_attempts WHERE run_id=?').get(run) as {n:number}).n).toBe(2); });

it('cools a bad pre-output account, consumes alternate lease, and routes the next request cleanly', async () => { const store=new Store();const bad=account('bad');const good=account('good');store.addAccount(bad);store.addAccount(good);const badAdapter:ProviderAdapter={login:async()=>({}),cancelLogin:async()=>{},snapshot:async()=>({models:[],quota:{observedAt:now()}}),createThread:async(_model:string)=>'',run:async()=>{throw new Error('bad')},interrupt:async()=>{},approve:async()=>{},logout:async()=>{},health:async()=>true,shutdown:async()=>{}};const c=new Coordinator(store,new Router(store),new Map([[bad.id,badAdapter],[good.id,new FakeAdapter()]]));const first=await c.start({model:'gpt-5-codex',input:'one',accountId:bad.id});await new Promise(resolve=>setTimeout(resolve,15));expect(store.publicRun(first)?.status).toBe('completed');expect(store.account(bad.id)?.cooldownUntil).toBeTruthy();expect(store.account(bad.id)!.health).toBeLessThan(1);expect((store.db.prepare('SELECT COUNT(*) AS n FROM routing_leases WHERE account_id=?').get(good.id) as {n:number}).n).toBe(0);const second=await c.start({model:'gpt-5-codex',input:'two'});await new Promise(resolve=>setTimeout(resolve,10));expect(store.publicRun(second)?.accountId).toBe(good.id);expect(store.publicRun(second)?.status).toBe('completed'); });

it('never stores seeded provider output in persisted replay events', async () => { const seed='TOP_SECRET_PROVIDER_OUTPUT';const store=new Store();const a=account('redaction');store.addAccount(a);const adapter:ProviderAdapter={login:async()=>({}),cancelLogin:async()=>{},snapshot:async()=>({models:[],quota:{observedAt:now()}}),createThread:async(_model:string)=>'',run:async(_t,_model,_i,emit)=>{emit({version:1,type:'delta',runId:'p',data:{text:seed}});emit({version:1,type:'completed',runId:'p'});return{turnId:'p'}},interrupt:async()=>{},approve:async()=>{},logout:async()=>{},health:async()=>true,shutdown:async()=>{}};const c=new Coordinator(store,new Router(store),new Map([[a.id,adapter]]));const run=await c.start({model:'gpt-5-codex',input:'x'});await wait();const stored=store.db.prepare('SELECT COALESCE(group_concat(data),\'\') AS data FROM run_events WHERE run_id=?').get(run) as {data:string};expect(stored.data).not.toContain(seed);expect(c.events(run).find(event=>event.type==='delta')?.data).toEqual({redacted:true}); });

it('publishes exactly one local started event when a real adapter also emits provider started', async () => { const store = new Store(); const a = account('single-start'); store.addAccount(a); const adapter: ProviderAdapter = { login: async () => ({}), cancelLogin: async () => {}, snapshot: async () => ({ models: [], quota: { observedAt: now() } }), createThread: async (_model: string) => 'thread', run: async (_thread, _model, _input, emit) => { emit({ version: 1, type: 'started', runId: 'provider' }); emit({ version: 1, type: 'completed', runId: 'provider' }); return { turnId: 'provider' }; }, interrupt: async () => {}, approve: async () => {}, logout: async () => {}, health: async () => true, shutdown: async () => {} }; const coordinator = new Coordinator(store, new Router(store), new Map([[a.id, adapter]])); const run = await coordinator.start({ model: 'gpt-5-codex', input: 'x' }); await wait(); expect(coordinator.events(run).filter(event => event.type === 'started')).toHaveLength(1); });

it('aggregates token usage per sub and keeps only the latest snapshot for a run', async () => { const store=new Store();const first=account('metered-a');const second=account('metered-b');store.addAccount(first);store.addAccount(second);const coordinator=new Coordinator(store,new Router(store),new Map([[first.id,new FakeAdapter()],[second.id,new FakeAdapter()]]));const runs=[await coordinator.start({model:'gpt-5-codex',input:'one two three',accountId:first.id}),await coordinator.start({model:'gpt-5-codex',input:'four',accountId:second.id})];await wait();const report=store.usageReport();expect(report.totals.runs).toBe(2);expect(report.totals.totalTokens).toBe(report.accounts.reduce((sum,item)=>sum+item.totalTokens,0));expect(report.accounts.map(item=>item.alias).sort()).toEqual(['metered-a','metered-b']);expect(report.runs.map(item=>item.runId).sort()).toEqual([...runs].sort());store.recordUsage(runs[0]!,first.id,'gpt-5-codex',{inputTokens:10,cachedInputTokens:1,outputTokens:2,reasoningOutputTokens:3,totalTokens:12});const rerecorded=store.usageReport();expect(rerecorded.totals.runs).toBe(2);expect(rerecorded.runs.find(item=>item.runId===runs[0])?.totalTokens).toBe(12); });

it('reports zeroed usage totals before any run is measured', () => { const report=new Store().usageReport();expect(report).toEqual({totals:{inputTokens:0,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0,totalTokens:0,runs:0,cacheHitRate:null,cost:{estimatedCostUsd:0,unpricedRuns:0}},accounts:[],keys:[],runs:[],cost:{estimatedCostUsd:0,unpricedRuns:0,subscriptionUsd:0,apiUsd:0,unpricedModels:[]}}); });

it('persists token counts but never output text for usage events', async () => { const store=new Store();const a=account('usage-events');store.addAccount(a);const coordinator=new Coordinator(store,new Router(store),new Map([[a.id,new FakeAdapter()]]));const run=await coordinator.start({model:'gpt-5-codex',input:'measure me'});await wait();const usage=coordinator.events(run).find(event=>event.type==='usage');expect(usage?.data).toMatchObject({inputTokens:expect.any(Number),outputTokens:expect.any(Number)});expect(JSON.stringify(usage?.data)).not.toContain('measure me'); });

describe('quota windows', () => {
  const at = Date.parse('2026-01-01T12:00:00Z');
  const windowed = (id: string, remaining: number, resetAt?: string) => ({ ...account(id, remaining), quota: { remaining, resetAt, observedAt: now() } });

  it('treats an exhausted sub as full again once its window has rolled over', () => {
    const rolledOver = windowed('past', 0, new Date(at - 1_000).toISOString());
    expect(effectiveQuota(rolledOver, at)).toBe(1);
    expect(eligible(rolledOver, { model: 'gpt-5-codex', input: 'x' }, undefined, at)).toBe(true);
    const stillBurned = windowed('future', 0, new Date(at + 3_600_000).toISOString());
    expect(effectiveQuota(stillBurned, at)).toBe(0);
    expect(eligible(stillBurned, { model: 'gpt-5-codex', input: 'x' }, undefined, at)).toBe(false);
  });

  it('reads an unknown quota as half rather than empty or full', () => expect(effectiveQuota({ ...account('unknown'), quota: { observedAt: now() } }, at)).toBe(.5));

  it('scores urgency by how close the window is to resetting', () => {
    expect(resetUrgency(windowed('none', .5), at)).toBe(0);
    expect(resetUrgency(windowed('far', .5, new Date(at + 5 * 3_600_000).toISOString()), at)).toBe(0);
    expect(resetUrgency(windowed('soon', .5, new Date(at + 3_600_000).toISOString()), at)).toBeCloseTo(.8);
    expect(resetUrgency(windowed('done', .5, new Date(at - 1).toISOString()), at)).toBe(0);
  });

  it('prefers the equally-loaded sub whose use-it-or-lose-it window resets sooner', () => {
    const soon = windowed('soon', .5, new Date(at + 30 * 60_000).toISOString());
    const later = windowed('later', .5, new Date(at + 5 * 3_600_000).toISOString());
    expect(score(soon, 'seed', at)).toBeGreaterThan(score(later, 'seed', at));
    // Reset urgency is a tiebreak, not an override: real headroom still wins.
    expect(score(windowed('roomy', 1, new Date(at + 5 * 3_600_000).toISOString()), 'seed', at)).toBeGreaterThan(score(soon, 'seed', at));
  });

  it('classifies provider limit errors as quota exhaustion, not generic failure', () => {
    for (const message of ['HTTP 429 Too Many Requests', 'rate limit reached for gpt-5-codex', 'You have hit your usage limit', 'insufficient_quota'])
      expect(quotaExhausted(new Error(message))).toBe(true);
    for (const message of ['socket hang up', 'protocol_incompatible', 'worker_missing', ''])
      expect(quotaExhausted(new Error(message))).toBe(false);
  });

  it('parks a limit-reporting sub until its own reset instead of the generic cooldown', () => {
    const store = new Store();
    const resetAt = new Date(Date.now() + 3_600_000).toISOString();
    store.addAccount({ ...account('burned', .2), quota: { remaining: .2, resetAt, observedAt: now() } });
    expect(store.exhaustQuota('burned')).toBe(resetAt);
    const stored = store.account('burned')!;
    expect(stored.quota.remaining).toBe(0);
    expect(stored.cooldownUntil).toBe(resetAt);
    expect(eligible(stored, { model: 'gpt-5-codex', input: 'x' })).toBe(false);
  });

  it('falls back to a bounded park when the provider never told us when the window resets', () => {
    const store = new Store();
    store.addAccount(account('burned', .2));
    const parked = Date.parse(store.exhaustQuota('burned')!);
    expect(parked - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(parked - Date.now()).toBeLessThanOrEqual(15 * 60_000);
  });
});

describe('named keys and per-key attribution', () => {
  it('names keys, keeps the secret shown once, and revokes independently', () => {
    const store = new Store();
    const prod = store.issueKey('puffle-prod');
    const dev = store.issueKey('puffle-dev');
    expect(store.verifyKey(prod.key)).toMatchObject({ id: prod.id, name: 'puffle-prod' });
    store.revokeKey(prod.id);
    expect(store.verifyKey(prod.key)).toBeUndefined();
    expect(store.verifyKey(dev.key)).toMatchObject({ name: 'puffle-dev' });
    const listed = store.keys();
    expect(listed.map(entry => entry.name)).toEqual(['puffle-prod', 'puffle-dev']);
    expect(listed.every(entry => !JSON.stringify(entry).includes(prod.key.slice(-12)))).toBe(true);
  });

  it('attributes a run usage to the key that started it, and leaves keyless runs honest', async () => {
    const store = new Store();
    const a = account('attributed');
    store.addAccount(a);
    const coordinator = new Coordinator(store, new Router(store), new Map([[a.id, new FakeAdapter()]]));
    const prod = store.issueKey('puffle-prod');
    await coordinator.start({ model: 'gpt-5-codex', input: 'billed to prod' }, prod.id);
    await coordinator.start({ model: 'gpt-5-codex', input: 'billed to nobody' });
    await new Promise(resolve => setTimeout(resolve, 30));
    const report = store.usageReport();
    expect(report.keys).toHaveLength(2);
    expect(report.keys.find(entry => entry.keyId === prod.id)).toMatchObject({ name: 'puffle-prod', runs: 1 });
    expect(report.keys.find(entry => entry.keyId === null)).toMatchObject({ name: null, runs: 1 });
    expect(report.totals.runs).toBe(2);
    expect(report.runs.filter(run => run.keyName === 'puffle-prod')).toHaveLength(1);
  });

  it('keeps usage attributed after the key is revoked, since history should not rewrite itself', async () => {
    const store = new Store();
    const a = account('after-revoke');
    store.addAccount(a);
    const coordinator = new Coordinator(store, new Router(store), new Map([[a.id, new FakeAdapter()]]));
    const key = store.issueKey('short-lived');
    await coordinator.start({ model: 'gpt-5-codex', input: 'one run' }, key.id);
    await new Promise(resolve => setTimeout(resolve, 30));
    store.revokeKey(key.id);
    expect(store.usageReport().keys).toMatchObject([{ keyId: key.id, name: 'short-lived', runs: 1 }]);
  });
});

describe('bind guard', () => {
  it('allows loopback, refuses anything else without an explicit opt-in, and never allows a wildcard', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost']) expect(() => PattyDaemon.assertBindable(host)).not.toThrow();
    expect(() => PattyDaemon.assertBindable('100.64.0.7')).toThrow(/PATTY_ALLOW_NON_LOOPBACK=1/);
    expect(() => PattyDaemon.assertBindable('100.64.0.7', true)).not.toThrow();
    for (const wildcard of ['0.0.0.0', '::', '']) expect(() => PattyDaemon.assertBindable(wildcard, true)).toThrow(/wildcard/);
  });
});

describe('provider configs survive a restart without holding a secret', () => {
  it('remembers the endpoint and env var name, and re-attaches the sub at boot', async () => {
    const file = join(tmpdir(), `patty-provider-${randomUUID()}.sqlite`);
    process.env.PATTY_TEST_RESTORE_KEY = 'sk-not-a-real-key';
    const fetchImpl = (async () => new Response(JSON.stringify({ data: [{ id: 'llama-3.3-70b' }] }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const first = new PattyDaemon(file);
    const account = await first.addOpenAiCompatibleAccount('together', 'https://api.example.invalid/v1', 'PATTY_TEST_RESTORE_KEY', fetchImpl);
    first.store.close();

    const rebooted = new PattyDaemon(file);
    expect(rebooted.store.account(account.id)!.state).toBe('reconnect_required');
    const restored = await rebooted.restoreOpenAiCompatibleAccounts();
    expect(restored.map(entry => entry.alias)).toEqual(['together']);
    expect(rebooted.store.account(account.id)!.state).toBe('ready');
    expect(rebooted.store.providerConfigs()).toEqual([{ accountId: account.id, kind: 'openai_compatible', config: { baseUrl: 'https://api.example.invalid/v1', apiKeyEnv: 'PATTY_TEST_RESTORE_KEY', tier: 'fallback' } }]);
    expect(JSON.stringify(rebooted.store.providerConfigs())).not.toContain('sk-not-a-real-key');
    rebooted.store.close();
    delete process.env.PATTY_TEST_RESTORE_KEY;
  });
});

describe('per-key admission control', () => {
  it('lets an unlimited key straight through without allocating a gate', async () => {
    const limiter = new KeyLimiter(() => ({}));
    await (await limiter.acquire('free'))();
    expect(limiter.pressure('free')).toEqual({ inFlight: 0, queued: 0, throttled: 0 });
  });

  it('queues past a concurrency limit and admits the waiter when a run settles, rather than failing it', async () => {
    const limiter = new KeyLimiter(() => ({ concurrency: 1 }));
    const first = await limiter.acquire('k');
    let admitted = false;
    const second = limiter.acquire('k').then(release => { admitted = true; return release; });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(admitted).toBe(false);
    expect(limiter.pressure('k')).toMatchObject({ inFlight: 1, queued: 1 });
    first();
    await second;
    expect(admitted).toBe(true);
    expect(limiter.pressure('k')).toMatchObject({ inFlight: 1, queued: 0, throttled: 0 });
  });

  it('holds one key\'s burst without touching another key', async () => {
    const limiter = new KeyLimiter(() => ({ concurrency: 1 }));
    await limiter.acquire('noisy');
    void limiter.acquire('noisy');
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(limiter.pressure('noisy').queued).toBe(1);
    await expect(limiter.acquire('quiet')).resolves.toBeTypeOf('function');
  });

  it('answers rate_limited with the wait to the next slot once queueing cannot beat the deadline', async () => {
    const limiter = new KeyLimiter(() => ({ rpm: 1 }), 64, 50);
    await limiter.acquire('k');
    const denied = await limiter.acquire('k').catch(error => error as RateLimited);
    expect(denied).toBeInstanceOf(RateLimited);
    expect((denied as RateLimited).retryAfterMs).toBeGreaterThan(50_000);
    expect(limiter.pressure('k').throttled).toBe(1);
  });

  it('refuses immediately when the queue is already full instead of growing it without bound', async () => {
    const limiter = new KeyLimiter(() => ({ concurrency: 1 }), 1, 60_000);
    await limiter.acquire('k');
    void limiter.acquire('k').catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 5));
    await expect(limiter.acquire('k')).rejects.toBeInstanceOf(RateLimited);
  });

  it('keeps the rolling minute across finished requests, so a fast key cannot reset its own rpm budget', async () => {
    const limiter = new KeyLimiter(() => ({ rpm: 2 }), 64, 10);
    (await limiter.acquire('k'))();
    (await limiter.acquire('k'))();
    await expect(limiter.acquire('k')).rejects.toBeInstanceOf(RateLimited);
  });

  it('persists limits per key and treats a cleared limit as unlimited', () => {
    const store = new Store();
    const issued = store.issueKey('puffle-prod');
    expect(store.keyLimits(issued.id)).toEqual({ rpm: undefined, concurrency: undefined });
    store.setKeyLimits(issued.id, { rpm: 30, concurrency: 2 });
    expect(store.keyLimits(issued.id)).toEqual({ rpm: 30, concurrency: 2 });
    expect(store.keys()[0]).toMatchObject({ rpm: 30, concurrency: 2 });
    store.setKeyLimits(issued.id, {});
    expect(store.keyLimits(issued.id)).toEqual({ rpm: undefined, concurrency: undefined });
    expect(() => store.setKeyLimits('key_missing', { rpm: 1 })).toThrow('invalid_request');
  });
});

describe('cost estimates', () => {
  const prices = { 'gpt-5': { input: 1.25, cachedInput: 0.125, output: 10 } };

  it('prices cached input separately and matches the longest model prefix', () => {
    const cost = estimateCost('gpt-5-2026-01-01', { inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 100_000 }, prices);
    // 500k uncached @ $1.25/M + 500k cached @ $0.125/M + 100k out @ $10/M
    expect(cost).toBeCloseTo(0.625 + 0.0625 + 1, 6);
  });

  it('leaves an unknown model unpriced rather than free', () => {
    expect(estimateCost('local-llama', { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 1_000 }, prices)).toBeUndefined();
  });

  it('rejects a price file that is missing a rate instead of silently ignoring it', () => {
    const path = join(tmpdir(), `prices-${randomUUID()}.json`);
    writeFileSync(path, JSON.stringify({ 'my-model': { input: 1 } }));
    expect(() => loadPrices(path)).toThrow('numeric input and output');
    writeFileSync(path, JSON.stringify({ 'my-model': { input: 1, output: 2 } }));
    expect(loadPrices(path)['my-model']).toEqual({ input: 1, output: 2 });
    expect(loadPrices(path)['gpt-5']).toBeDefined();
  });

  it('separates what the subs absorbed from what the API fallback actually spent', () => {
    const store = new Store();
    const sub = { id: 'acct_sub', alias: 'codex-work', tier: 'primary' as const, state: 'ready' as const, models: ['gpt-5'], quota: { remaining: 1, observedAt: now() }, health: 1, activeRuns: 0 };
    const api = { ...sub, id: 'acct_api', alias: 'api-credit', tier: 'fallback' as const };
    store.addAccount(sub); store.addAccount(api);
    const usage = { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 1_000_000 };
    for (const [account, model] of [[sub, 'gpt-5'], [api, 'gpt-5'], [sub, 'local-llama']] as const) {
      const run = { id: id('run'), accountId: account.id, model, fingerprint: 'f', status: 'completed' as const, outputStarted: true, cancelRequested: false };
      store.createRun(run);
      store.recordUsage(run.id, account.id, model, usage);
    }
    const report = store.usageReport();
    expect(report.cost.subscriptionUsd).toBeCloseTo(1.25, 6);
    expect(report.cost.apiUsd).toBeCloseTo(1.25, 6);
    expect(report.cost.estimatedCostUsd).toBeCloseTo(2.5, 6);
    expect(report.cost.unpricedRuns).toBe(1);
    expect(report.cost.unpricedModels).toEqual(['local-llama']);
    const work = report.accounts.find(entry => entry.alias === 'codex-work')!;
    expect(work).toMatchObject({ tier: 'primary', cost: { estimatedCostUsd: 1.25, unpricedRuns: 1 } });
    expect(report.runs.find(run => run.model === 'local-llama')!.estimatedCostUsd).toBeNull();
  });
});

describe('cache hit rate', () => {
  it('is the cached share of input, and is unknown rather than zero when nothing was measured', () => {
    expect(cacheHitRate({ inputTokens: 1_000, cachedInputTokens: 250 })).toBe(0.25);
    expect(cacheHitRate({ inputTokens: 3, cachedInputTokens: 1 })).toBe(0.3333);
    expect(cacheHitRate({ inputTokens: 1_000, cachedInputTokens: 0 })).toBe(0);
    expect(cacheHitRate({ inputTokens: 0, cachedInputTokens: 0 })).toBeNull();
    // A provider reporting more cached than input tokens is a bad number, not a cache better than perfect.
    expect(cacheHitRate({ inputTokens: 100, cachedInputTokens: 500 })).toBe(1);
  });

  it('derives a rate per sub, per key and overall from the stored counts', async () => {
    const store = new Store();
    const warm = { id: 'acct_warm', alias: 'warm', tier: 'primary' as const, state: 'ready' as const, models: ['gpt-5-codex'], quota: { remaining: 1, observedAt: now() }, health: 1, activeRuns: 0 };
    const cold = { ...warm, id: 'acct_cold', alias: 'cold' };
    store.addAccount(warm); store.addAccount(cold);
    const key = store.issueKey('puffle-prod');
    const measured = [[warm, 900] as const, [cold, 100] as const];
    for (const [account, cached] of measured) {
      const run = { id: id('run'), accountId: account.id, model: 'gpt-5-codex', fingerprint: 'f', status: 'completed' as const, outputStarted: true, cancelRequested: false, apiKeyId: key.id };
      store.createRun(run);
      store.recordUsage(run.id, account.id, 'gpt-5-codex', { inputTokens: 1_000, cachedInputTokens: cached, outputTokens: 10, reasoningOutputTokens: 0, totalTokens: 1_010 });
    }
    const report = store.usageReport();
    expect(report.accounts.find(entry => entry.alias === 'warm')!.cacheHitRate).toBe(0.9);
    expect(report.accounts.find(entry => entry.alias === 'cold')!.cacheHitRate).toBe(0.1);
    expect(report.keys.find(entry => entry.keyId === key.id)!.cacheHitRate).toBe(0.5);
    expect(report.totals.cacheHitRate).toBe(0.5);
    expect(report.runs.map(run => run.cacheHitRate).sort()).toEqual([0.1, 0.9]);
    expect(store.runHistory().map(run => run.cacheHitRate).sort()).toEqual([0.1, 0.9]);
  });

  it('reports a warm thread as partly cached on a fake sub, so the rate can be seen without a real one', async () => {
    const store = new Store();
    const a = account('warm-thread');
    store.addAccount(a);
    const coordinator = new Coordinator(store, new Router(store), new Map([[a.id, new FakeAdapter()]]));
    const cold = await coordinator.start({ model: 'gpt-5-codex', input: 'first turn of a conversation' });
    const thread = await coordinator.createThread('gpt-5-codex', a.id);
    const warm = await coordinator.start({ model: 'gpt-5-codex', input: 'second turn of a conversation', threadId: thread.threadId });
    await new Promise(resolve => setTimeout(resolve, 30));
    const rate = (run: string) => store.usageReport().runs.find(entry => entry.runId === run)!.cacheHitRate!;
    expect(rate(cold)).toBe(0);
    expect(rate(warm)).toBeGreaterThan(0.5);
  });

  it('leaves an unmetered run without a hit rate instead of calling it a miss', () => {
    const store = new Store();
    const account = { id: 'acct_unmetered', alias: 'unmetered', tier: 'primary' as const, state: 'ready' as const, models: ['gpt-5-codex'], quota: { remaining: 1, observedAt: now() }, health: 1, activeRuns: 0 };
    store.addAccount(account);
    store.createRun({ id: id('run'), accountId: account.id, model: 'gpt-5-codex', fingerprint: 'f', status: 'completed', outputStarted: true, cancelRequested: false });
    expect(store.runHistory()).toMatchObject([{ inputTokens: null, cachedInputTokens: null, cacheHitRate: null }]);
    expect(store.usageReport().totals.cacheHitRate).toBeNull();
  });
});

describe('structured output plumbing', () => {
  it('accepts the response_format shapes OpenAI clients send and refuses the rest', () => {
    expect(parseResponseFormat(undefined)).toBeUndefined();
    expect(parseResponseFormat({ type: 'json_object' })).toEqual({ type: 'json_object' });
    expect(parseResponseFormat({ type: 'json_schema', json_schema: { name: 'c', strict: true, schema: { type: 'object', additionalProperties: false }, extra: 'ignored' } })).toEqual({ type: 'json_schema', json_schema: { name: 'c', strict: true, schema: { type: 'object', additionalProperties: false } } });
    for (const bad of [
      { type: 'json_schema' },
      { type: 'json_schema', json_schema: { schema: 'object' } },
      { type: 'json_schema', json_schema: { schema: { type: 'object', properties: { a: { type: 'string' } } } } },
      { type: 'json_schema', json_schema: { schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } } },
      { type: 'nonsense' }
    ]) expect(() => parseResponseFormat(bad), JSON.stringify(bad)).toThrow();
  });
  it('translates response_format into the app-server output schema', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    expect(codexOutputSchema({ type: 'json_schema', json_schema: { schema } })).toBe(schema);
    expect(codexOutputSchema({ type: 'json_object' })).toEqual({ type: 'object' });
    expect(codexOutputSchema({ type: 'text' })).toBeUndefined();
    expect(codexOutputSchema(undefined)).toBeUndefined();
  });
  it('tells the model the caller\'s functions exist and how to reach them', () => {
    const preamble = bridgePreamble([{ type: 'function', function: { name: 'get_weather', description: 'Current weather for a city' } }, { type: 'function', function: { name: 'send_email' } }]);
    expect(preamble).toContain('- get_weather: Current weather for a city');
    expect(preamble).toContain('- send_email');
    /** The CLI hides MCP tools until they are searched for, so a preamble that omits this reads as if the tools were already listed. */
    expect(preamble).toContain('tool_search');
    expect(preamble).toContain('patty');
  });
  it('replays the schema onto the next sub when the first one fails', async () => {
    const store = new Store(); const adapters = new Map<string, ProviderAdapter>();
    const first = account('first'), second = account('second');
    store.addAccount(first); store.addAccount(second);
    const seen: unknown[] = [];
    class Recording extends FakeAdapter { override async run(thread: string | undefined, model: string, input: string, emit: (event: PattyEvent) => void, turn?: Parameters<ProviderAdapter['run']>[4], options?: Parameters<ProviderAdapter['run']>[5]) { seen.push(options?.responseFormat); return super.run(thread, model, input, emit, turn, options); } }
    const failing = new FakeAdapter(['gpt-5-codex'], { remaining: 1, observedAt: now() }).failNext('boom');
    adapters.set(first.id, failing); adapters.set(second.id, new Recording());
    const coordinator = new Coordinator(store, new Router(store), adapters);
    const responseFormat = { type: 'json_schema', json_schema: { schema: { type: 'object', properties: { a: { type: 'string' } } } } } as const;
    const runId = await coordinator.start({ model: 'gpt-5-codex', input: 'x', responseFormat });
    await coordinator.collect(runId);
    expect(seen).toEqual([responseFormat]);
  });
});

describe('strict structured output schema validation', () => {
  it('accepts valid strict schemas', () => {
    expect(() => validateStrictSchema({ type: 'object', additionalProperties: false })).not.toThrow();
    expect(() => validateStrictSchema({
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        nickname: { type: ['string', 'null'] }
      },
      required: ['name', 'nickname']
    })).not.toThrow();
  });

  it('rejects optional scalar properties', () => {
    expect(() => validateStrictSchema({
      type: 'object',
      additionalProperties: false,
      properties: { name: { type: 'string' }, nickname: { type: 'string' } },
      required: ['name']
    })).toThrow(expect.objectContaining({ code: 'invalid_json_schema', path: '$.properties.nickname', message: 'Every object property must be listed in required for Codex outputSchema.' }));
  });

  it('rejects objects without additionalProperties false', () => {
    expect(() => validateStrictSchema({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a']
    })).toThrow(expect.objectContaining({ code: 'invalid_json_schema', path: '$', message: 'Object schemas must set additionalProperties to false for Codex outputSchema.' }));
  });

  it('rejects optional nested objects', () => {
    expect(() => validateStrictSchema({
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        address: {
          type: 'object',
          additionalProperties: false,
          properties: { city: { type: 'string' } },
          required: ['city']
        }
      },
      required: ['name']
    })).toThrow(expect.objectContaining({ code: 'invalid_json_schema', path: '$.properties.address', message: 'Every object property must be listed in required for Codex outputSchema.' }));
  });

  it('rejects nested objects that violate strict rules', () => {
    expect(() => validateStrictSchema({
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        address: {
          type: 'object',
          additionalProperties: true,
          properties: { city: { type: 'string' } },
          required: ['city']
        }
      },
      required: ['name', 'address']
    })).toThrow(expect.objectContaining({ code: 'invalid_json_schema', path: '$.properties.address', message: 'Object schemas must set additionalProperties to false for Codex outputSchema.' }));
  });

  it('rejects optional properties inside array items', () => {
    expect(() => validateStrictSchema({
      type: 'object',
      additionalProperties: false,
      properties: {
        tags: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { label: { type: 'string' } },
            required: ['label']
          }
        }
      },
      required: ['tags']
    })).not.toThrow();
    expect(() => validateStrictSchema({
      type: 'object',
      additionalProperties: false,
      properties: {
        tags: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { label: { type: 'string' }, score: { type: 'number' } },
            required: ['label']
          }
        }
      },
      required: ['tags']
    })).toThrow(expect.objectContaining({ code: 'invalid_json_schema', path: '$.properties.tags.items.properties.score', message: 'Every object property must be listed in required for Codex outputSchema.' }));
  });
});

describe('roles and per-turn knobs', () => {
  it('separates the turn’s rules from the conversation', () => {
    expect(splitConversation([{ role: 'system', content: 'be terse' }, { role: 'developer', content: [{ text: 'in French' }] }, { role: 'user', content: 'hi' }])).toEqual({ instructions: 'be terse\n\nin French', input: 'hi' });
    expect(splitConversation([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hey' }])).toEqual({ instructions: undefined, input: 'user: hi\n\nassistant: hey' });
  });
  it('accepts the sampling knobs OpenAI clients send and refuses the out-of-range ones', () => {
    expect(parseSampling({})).toBeUndefined();
    expect(parseSampling({ temperature: 0.2, top_p: 1, max_completion_tokens: 64, stop: 'END', seed: 7 })).toEqual({ temperature: 0.2, topP: 1, maxOutputTokens: 64, stop: ['END'], seed: 7 });
    // `max_completion_tokens` is the newer spelling and wins when a client sends both.
    expect(parseSampling({ max_tokens: 10, max_completion_tokens: 20 })).toEqual({ maxOutputTokens: 20 });
    for (const bad of [{ temperature: -1 }, { temperature: 3 }, { top_p: 1.5 }, { max_tokens: 0 }, { max_tokens: 1.5 }, { seed: 0.5 }, { stop: [''] }, { stop: ['a', 'b', 'c', 'd', 'e'] }]) expect(() => parseSampling(bad), JSON.stringify(bad)).toThrow('invalid_request');
  });
  it('takes whatever effort the model advertises but not free text', () => {
    expect(parseReasoningEffort(undefined)).toBeUndefined();
    expect(parseReasoningEffort('minimal')).toBe('minimal');
    for (const bad of ['', 'HIGH', 'think very hard', 'x'.repeat(33)]) expect(() => parseReasoningEffort(bad), bad).toThrow('invalid_request');
  });
  it('replays instructions and knobs onto the next sub when the first one fails', async () => {
    const store = new Store(); const adapters = new Map<string, ProviderAdapter>();
    const first = account('first'), second = account('second');
    store.addAccount(first); store.addAccount(second);
    const seen: unknown[] = [];
    class Recording extends FakeAdapter { override async run(thread: string | undefined, model: string, input: string, emit: (event: PattyEvent) => void, turn?: Parameters<ProviderAdapter['run']>[4], options?: Parameters<ProviderAdapter['run']>[5]) { seen.push(options); return super.run(thread, model, input, emit, turn, options); } }
    adapters.set(first.id, new FakeAdapter(['gpt-5-codex'], { remaining: 1, observedAt: now() }).failNext('boom')); adapters.set(second.id, new Recording());
    const coordinator = new Coordinator(store, new Router(store), adapters);
    const runId = await coordinator.start({ model: 'gpt-5-codex', input: 'x', instructions: 'be terse', reasoningEffort: 'high', sampling: { temperature: 0.2 } });
    await coordinator.collect(runId);
    expect(seen).toEqual([{ instructions: 'be terse', reasoningEffort: 'high', sampling: { temperature: 0.2 } }]);
  });
});

describe('tool bridge', () => {
  const tools = [{ type: 'function' as const, function: { name: 'get_weather', parameters: { type: 'object' } } }];

  it('publishes only the session’s tools and answers a call with what the caller sent back', async () => {
    const bridge = new ToolBridge(() => 'http://127.0.0.1:1');
    const calls: ChatToolCall[] = [];
    const session = bridge.open(tools, call => calls.push(call));
    expect(bridge.list(session.token)).toEqual([{ name: 'get_weather', description: '', inputSchema: { type: 'object' } }]);
    const answered = bridge.call(session.token, 'get_weather', { city: 'Denver' });
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ city: 'Denver' });
    expect(bridge.waiting(calls[0]!.id)).toBe(true);
    expect(bridge.settle(calls[0]!.id, 'sunny')).toBe(true);
    expect(await answered).toBe('sunny');
    /** The same result cannot be delivered twice, so a retrying caller cannot resume a turn that already moved on. */
    expect(bridge.settle(calls[0]!.id, 'sunny')).toBe(false);
    session.close();
  });

  it('refuses an unknown session, an untouched tool, and outlives neither', async () => {
    const bridge = new ToolBridge(() => 'http://127.0.0.1:1');
    expect(() => bridge.list('nope')).toThrow('unknown_bridge_session');
    const session = bridge.open(tools, () => undefined);
    expect(() => bridge.call(session.token, 'rm_rf', {})).toThrow('unknown_tool');
    const pending = bridge.call(session.token, 'get_weather', {});
    session.close();
    await expect(pending).rejects.toThrow('turn_ended');
    expect(() => bridge.list(session.token)).toThrow('unknown_bridge_session');
  });

  it('gives up on a caller that never answers rather than holding the turn forever', async () => {
    const bridge = new ToolBridge(() => 'http://127.0.0.1:1', 10);
    const session = bridge.open(tools, () => undefined);
    await expect(bridge.call(session.token, 'get_weather', {})).rejects.toThrow('tool_result_timeout');
    session.close();
  });
});

describe('supported Codex versions', () => {
  it('accepts the baseline and later releases below the ceiling, and nothing outside it', () => {
    expect(codexVersionSupported(`codex-cli ${SUPPORTED_CODEX_VERSIONS.min}`, undefined)).toBe(true);
    expect(codexVersionSupported('codex-cli 0.146.1', undefined)).toBe(true);
    expect(codexVersionSupported('codex-cli 0.147.0\n', undefined)).toBe(true);
    expect(codexVersionSupported('codex-cli 0.144.9', undefined)).toBe(false);
    expect(codexVersionSupported(`codex-cli ${SUPPORTED_CODEX_VERSIONS.below}`, undefined)).toBe(false);
  });

  it('reads only an official Codex CLI, and takes the operator\u2019s word for one exact release', () => {
    expect(codexVersionSupported('0.147.0', undefined)).toBe(false);
    expect(codexVersionSupported('codex-cli 0.148.0-alpha.6', undefined)).toBe(false);
    expect(codexVersionSupported('codex-cli 0.148.0', '0.148.0')).toBe(true);
    expect(codexVersionSupported('codex-cli 0.149.0', '0.148.0')).toBe(false);
  });
});

describe('model aliases', () => {
  const served = (model: string) => model === 'gpt-5-codex';

  it('prefers a model the stack serves, then the map, then the catch-all, then the name itself', () => {
    const aliases = { 'gpt-5-codex': 'ignored', 'gpt-5-nano': 'gpt-5-codex', '*': 'gpt-5-codex' };
    expect(resolveModel('gpt-5-codex', aliases, served)).toBe('gpt-5-codex');
    expect(resolveModel('gpt-5-nano', aliases, served)).toBe('gpt-5-codex');
    expect(resolveModel('claude-3-5-sonnet', aliases, served)).toBe('gpt-5-codex');
    expect(resolveModel('claude-3-5-sonnet', {}, served)).toBe('claude-3-5-sonnet');
  });

  it('refuses a broken map at boot rather than routing somewhere surprising', () => {
    expect(loadAliases(undefined)).toEqual({});
    expect(loadAliases('  ')).toEqual({});
    expect(loadAliases('{"gpt-5-nano":"gpt-5-codex"}')).toEqual({ 'gpt-5-nano': 'gpt-5-codex' });
    for (const broken of ['not json', '["gpt-5-codex"]', '{"gpt-5-nano":5}', '{"gpt-5-nano":"a model"}', '{"a model":"gpt-5-codex"}']) expect(() => loadAliases(broken), broken).toThrow('PATTY_MODEL_ALIASES');
  });
});

describe('responses translation', () => {
  it('turns Responses items back into the chat turn they describe', () => {
    expect(responsesToChat({ model: 'm', instructions: 'be terse', input: [
      { role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Denver"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'sunny' }
    ], tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object' } }], reasoning: { effort: 'high' }, max_output_tokens: 64, text: { format: { type: 'json_schema', name: 'w', strict: true, schema: { type: 'object', additionalProperties: false } } } })).toEqual({
      model: 'm',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Denver"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'sunny' }
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
      response_format: { type: 'json_schema', json_schema: { name: 'w', strict: true, schema: { type: 'object', additionalProperties: false } } },
      reasoning_effort: 'high', max_completion_tokens: 64
    });
  });

  it('refuses a request with no model and a tool no stacked sub could run', () => {
    expect(() => responsesToChat({ input: 'hi' })).toThrow('invalid_request');
    expect(() => responsesToChat({ model: 'm', input: 42 })).toThrow('invalid_request');
    expect(() => responsesToChat({ model: 'm', input: 'hi', tools: [{ type: 'web_search_preview' }] })).toThrow('invalid_request');
  });

  it('reports a call as an output item beside whatever the model said', () => {
    const body = responsesBody('resp_1', 'm', 1, 'here you go', [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }]);
    expect(body).toMatchObject({ id: 'resp_1', object: 'response', status: 'completed', output_text: 'here you go' });
    expect(body.output.map(item => item.type)).toEqual(['message', 'function_call']);
    expect(body.output[1]).toMatchObject({ call_id: 'call_1', name: 'get_weather', arguments: '{}' });
  });
});

describe('reasoning traces', () => {
  const settled = async (c: Coordinator, runId: string) => { for (let attempt = 0; attempt < 100 && !c.events(runId).some(event => event.type === 'completed'); attempt++) await new Promise(resolve => setTimeout(resolve, 1)); };
  const thinkingAdapter = (chunks: PattyEvent['type'][] | { type: PattyEvent['type']; text?: string }[]): ProviderAdapter => ({ login: async () => ({}), cancelLogin: async () => {}, snapshot: async () => ({ models: ['gpt-5-codex'], quota: { observedAt: now() } }), createThread: async () => 'thread', run: async (_thread, _model, _input, emit) => { await wait(); for (const chunk of chunks) { const step = typeof chunk === 'string' ? { type: chunk } as { type: PattyEvent['type']; text?: string } : chunk; emit({ version: 1, type: step.type, runId: 'provider', ...(step.text === undefined ? {} : { data: { text: step.text } }) }); } return { turnId: 'provider' }; }, interrupt: async () => {}, approve: async () => {}, logout: async () => {}, health: async () => true, shutdown: async () => {} });
  const thinking = (input = 'x', adapter?: ProviderAdapter) => { const store = new Store(); const a = account('thinker'); store.addAccount(a); const c = new Coordinator(store, new Router(store), new Map([[a.id, adapter ?? thinkingAdapter([{ type: 'reasoning', text: 'first ' }, { type: 'reasoning', text: 'second' }, { type: 'delta', text: 'answer' }, { type: 'completed' }])]])); return { store, c, run: c.start({ model: 'gpt-5-codex', input }) }; };

  it('forwards reasoning live, buffers it for a late subscriber, and persists it redacted', async () => {
    const { store, c, run } = thinking();
    const runId = await run;
    const seen: PattyEvent[] = [];
    c.on(runId, event => seen.push(event));
    await settled(c, runId);
    expect(c.liveReasoning(runId)).toBe('first second');
    /** A subscriber that attaches mid-turn is handed the thinking so far, which is why it is buffered rather than only streamed. */
    expect(seen.filter(event => event.type === 'reasoning').map(event => (event.data as { text: string }).text)).toEqual(['first ', 'second']);
    expect(c.eventItems(runId).map(item => item.event.type)).toContain('reasoning');
    const rows = store.db.prepare("SELECT data FROM run_events WHERE run_id=? AND type='reasoning'").all(runId) as { data: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(row => row.data === JSON.stringify({ redacted: true }))).toBe(true);
    expect(rows.map(row => row.data).join('')).not.toContain('first');
  });

  it('collects reasoning apart from the answer, seeding a mid-turn caller from the buffer', async () => {
    const { c, run } = thinking();
    const runId = await run;
    const seeded: string[] = [];
    await settled(c, runId);
    const result = await c.collect(runId, undefined, 1_000, true, chunk => seeded.push(chunk));
    expect(result.text).toBe('answer');
    expect(result.reasoning).toBe('first second');
    expect(seeded.join('')).toBe('first second');
  });

  /** Reasoning is the model's private working, so the operator can refuse to hand it out without giving up the answer. */
  it('drops reasoning entirely when forwarding is switched off', async () => {
    process.env.PATTY_FORWARD_REASONING = '0';
    try {
      const { c, run } = thinking();
      const runId = await run;
      await settled(c, runId);
      expect(c.liveReasoning(runId)).toBeUndefined();
      expect(c.events(runId).map(event => event.type)).not.toContain('reasoning');
      expect((await c.collect(runId, undefined, 1_000)).reasoning).toBe('');
      expect((await c.collect(runId, undefined, 1_000)).text).toBe('answer');
    } finally { delete process.env.PATTY_FORWARD_REASONING; }
  });

  /** Thinking is not an answer: a sub that only thought before dying has produced nothing the caller has seen, so the turn may still move. */
  it('does not count reasoning as started output, so a pre-answer failure still fails over', async () => {
    const store = new Store(); const first = account('first'); const second = account('second'); store.addAccount(first); store.addAccount(second);
    const thinksThenDies: ProviderAdapter = { ...thinkingAdapter([]), run: async (_thread, _model, _input, emit) => { emit({ version: 1, type: 'reasoning', runId: 'provider', data: { text: 'hmm' } }); throw new Error('early'); } };
    const c = new Coordinator(store, new Router(store), new Map([[first.id, thinksThenDies], [second.id, new FakeAdapter()]]));
    const runId = await c.start({ model: 'gpt-5-codex', input: 'x', accountId: first.id });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(store.publicRun(runId)?.status).toBe('completed');
  });

  it('forwards an upstream provider’s reasoning_content and OpenRouter’s reasoning alike', async () => {
    const { OpenAiCompatibleAdapter } = await import('../src/openai-provider.js');
    const stream = (chunks: string[]) => new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }));
    process.env.PATTY_TEST_PROVIDER_KEY = 'sk-not-a-real-key';
    const seen: { type: string; text?: string }[] = [];
    const adapter = new OpenAiCompatibleAdapter({ baseUrl: 'https://api.example.invalid/v1', apiKeyEnv: 'PATTY_TEST_PROVIDER_KEY', fetch: (async () => stream([
      'data: {"choices":[{"delta":{"reasoning_content":"weighing "}}]}\n',
      'data: {"choices":[{"delta":{"reasoning":"the options"}}]}\n',
      'data: {"choices":[{"delta":{"reasoning":{"summary":"structured"}}}]}\n',
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n',
      'data: [DONE]\n',
    ])) as unknown as typeof fetch });
    await adapter.run(undefined, 'm', 'hi', event => seen.push({ type: event.type, text: (event.data as { text?: string } | undefined)?.text }));
    for (let attempt = 0; attempt < 50 && !seen.some(event => event.type === 'completed'); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(seen.map(event => event.type)).toEqual(['reasoning', 'reasoning', 'delta', 'completed']);
    expect(seen.filter(event => event.type === 'reasoning').map(event => event.text).join('')).toBe('weighing the options');
    expect(seen.find(event => event.type === 'delta')?.text).toBe('hello');
    delete process.env.PATTY_TEST_PROVIDER_KEY;
  });
});

describe('credential leases', () => {
  it('holds one of the sub\'s run slots for as long as the loan lives', () => { const store = new Store(); const a = account('a'); store.addAccount(a); const lease = store.openCredentialLease(a.id, 60_000, 'puffle'); expect(lease).toMatchObject({ accountId: a.id, alias: 'a', holder: 'puffle', models: ['gpt-5-codex'] }); expect(store.account(a.id)?.activeRuns).toBe(1); expect(eligible(store.account(a.id)!, { model: 'gpt-5-codex', input: '' })).toBe(true); store.openCredentialLease(a.id, 60_000); expect(store.account(a.id)?.activeRuns).toBe(2); expect(eligible(store.account(a.id)!, { model: 'gpt-5-codex', input: '' })).toBe(false); expect(() => store.openCredentialLease(a.id, 60_000)).toThrow('no_eligible_account'); });
  it('gives the sub back on release and on expiry, so a holder that dies cannot pin it', () => { const store = new Store(); const a = account('a'); store.addAccount(a); const kept = store.openCredentialLease(a.id, 60_000); const abandoned = store.openCredentialLease(a.id, 60_000); expect(store.releaseCredentialLease(kept.id)).toBe(true); expect(store.releaseCredentialLease(kept.id)).toBe(false); expect(store.account(a.id)?.activeRuns).toBe(1); store.db.prepare('UPDATE credential_leases SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', abandoned.id); expect(store.credentialLease(abandoned.id)).toBeUndefined(); expect(store.credentialLeases()).toEqual([]); expect(store.account(a.id)?.activeRuns).toBe(0); });
  it('renews an existing loan and refuses to resurrect a released one', () => { const store = new Store(); const a = account('a'); store.addAccount(a); const lease = store.openCredentialLease(a.id, 60_000); const renewed = store.renewCredentialLease(lease.id, 600_000)!; expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(lease.expiresAt)); store.releaseCredentialLease(lease.id); expect(store.renewCredentialLease(lease.id, 600_000)).toBeUndefined(); });
  it('drops live loans on restart, because the borrower did not survive the daemon it borrowed from', () => { const path = join(tmpdir(), `patty-lease-${randomUUID()}.sqlite`); const first = new Store(path); const a = account('a'); first.addAccount(a); first.openCredentialLease(a.id, 3_600_000); first.close(); const second = new Store(path); second.reconcileWorkers(); expect(second.credentialLeases()).toEqual([]); expect(second.account(a.id)?.activeRuns).toBe(0); });
  it('caps how long a sub can be lent and rejects a nonsense window', () => { expect(leaseTtlMs(undefined)).toBe(300_000); expect(leaseTtlMs(120)).toBe(120_000); expect(leaseTtlMs(86_400)).toBe(3_600_000); expect(() => leaseTtlMs(5)).toThrow('invalid_request'); expect(() => leaseTtlMs('600')).toThrow('invalid_request'); });
});

describe('failure detail', () => {
  it('keeps a provider error readable and bounded', async () => {
    const { failureDetail } = await import('../src/log.js');
    expect(failureDetail(new Error('401 Unauthorized: refresh_token_invalidated'))).toBe('401 Unauthorized: refresh_token_invalidated');
    expect(failureDetail('plain string')).toBe('plain string');
    /** A provider can answer with a whole HTML error page, and a log line is not the place for it. */
    const long = failureDetail(new Error('x'.repeat(1_000)));
    expect(long).toHaveLength(301);
    expect(long.endsWith('…')).toBe(true);
  });
});
