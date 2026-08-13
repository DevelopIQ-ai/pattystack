import { access, chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PattyDaemon, privateDirectory } from '../src/server.js';
import type { FakeAdapter } from '../src/core.js';
import type { ChatTool } from '@patty/contracts';
import { spawn } from 'node:child_process';
let server: Server | undefined;
afterEach(async () => { await new Promise<void>(resolveClose => server?.close(() => resolveClose()) ?? resolveClose()); server = undefined; });
describe('loopback HTTP API', () => {
  it('requires a local key and creates an idempotent run', async () => { const daemon = new PattyDaemon(); daemon.addFakeAccount('one'); server = await daemon.listen(); const address = server.address() as { port: number }; const url = `http://127.0.0.1:${address.port}`; expect((await fetch(`${url}/v1/accounts`)).status).toBe(401); const headers = { authorization: `Bearer ${daemon.key}`, 'content-type': 'application/json' }; const input = { model: 'gpt-5-codex', input: 'hello', idempotencyKey: 'same' }; const one = await fetch(`${url}/v1/runs`, { method: 'POST', headers, body: JSON.stringify(input) }); expect(one.status).toBe(202); const first = await one.json() as { id: string }; const two = await fetch(`${url}/v1/runs`, { method: 'POST', headers, body: JSON.stringify(input) }); expect((await two.json() as { id: string }).id).toBe(first.id); const conflict = await fetch(`${url}/v1/runs`, { method: 'POST', headers, body: JSON.stringify({ ...input, input: 'different' }) }); expect((await conflict.json() as { error: { code: string } }).error.code).toBe('idempotency_conflict'); });
  it('returns a JSON 404 rather than opening SSE for an unknown run', async () => { const daemon = new PattyDaemon(); server = await daemon.listen(); const address = server.address() as { port: number }; const response = await fetch(`http://127.0.0.1:${address.port}/v1/runs/missing/events`, { headers: { authorization: `Bearer ${daemon.key}` } }); expect(response.status).toBe(404); expect(response.headers.get('content-type')).toContain('application/json'); });
  it('refuses remote binding', () => expect(() => new PattyDaemon().listen(0, '0.0.0.0')).toThrow('loopback'));
  it('publishes the built daemon at the bin target', async () => { const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8')) as { bin: { pattyd: string } }; expect(manifest.bin.pattyd).toBe('./dist/src/main.js'); await expect(access(resolve(import.meta.dirname, '..', manifest.bin.pattyd))).resolves.toBeUndefined(); });
});

describe('SSE lifecycle', () => {
  it('retains terminal events and closes the stream', async () => { const daemon = new PattyDaemon(); daemon.addFakeAccount('one'); server = await daemon.listen(); const port = (server.address() as { port: number }).port; const headers = { authorization: `Bearer ${daemon.key}`, 'content-type': 'application/json' }; const created = await fetch(`http://127.0.0.1:${port}/v1/runs`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', input: 'x' }) }); const { id } = await created.json() as { id: string }; await new Promise(resolve => setTimeout(resolve, 10)); const stream = await fetch(`http://127.0.0.1:${port}/v1/runs/${id}/events`, { headers }); const text = await stream.text(); expect(text).toContain('id: 1'); expect(text).toContain('"type":"completed"'); });
});

it('returns an allowlisted public run DTO', async () => { const daemon = new PattyDaemon(); const account = daemon.addFakeAccount('dto'); server = await daemon.listen(); const port = (server.address() as {port:number}).port; const headers={authorization:`Bearer ${daemon.key}`,'content-type':'application/json'}; const created=await fetch(`http://127.0.0.1:${port}/v1/runs`,{method:'POST',headers,body:JSON.stringify({model:'gpt-5-codex',input:'secret'})}); const {id}=await created.json() as {id:string}; const dto=await (await fetch(`http://127.0.0.1:${port}/v1/runs/${id}`,{headers})).json() as Record<string,unknown>; expect(dto).toHaveProperty('id'); expect(dto).not.toHaveProperty('provider_turn_id'); expect(dto).not.toHaveProperty('fingerprint'); expect(dto).not.toHaveProperty('idempotency_key'); });

it('uses strict method dispatch and validates thread turns', async () => { const daemon = new PattyDaemon(); daemon.addFakeAccount('strict'); server = await daemon.listen(); const port=(server.address() as {port:number}).port; const headers={authorization:`Bearer ${daemon.key}`,'content-type':'application/json'}; expect((await fetch(`http://127.0.0.1:${port}/v1/runs`,{method:'PUT',headers})).status).toBe(404);expect((await fetch(`http://127.0.0.1:${port}/v1/runs`,{method:'GET',headers})).status).toBe(200); const thread=await (await fetch(`http://127.0.0.1:${port}/v1/threads`,{method:'POST',headers,body:JSON.stringify({model:'gpt-5-codex'})})).json() as {threadId:string}; expect((await fetch(`http://127.0.0.1:${port}/v1/threads/${thread.threadId}/turns`,{method:'POST',headers,body:JSON.stringify({model:'gpt-5-codex',input:''})})).status).toBe(400); expect((await fetch(`http://127.0.0.1:${port}/v1/threads/${thread.threadId}/turns`,{method:'GET',headers})).status).toBe(405); });
it('rejects cancellation of a terminal run', async () => { const daemon=new PattyDaemon(); daemon.addFakeAccount('terminal'); server=await daemon.listen(); const port=(server.address() as {port:number}).port;const headers={authorization:`Bearer ${daemon.key}`,'content-type':'application/json'};const run=await (await fetch(`http://127.0.0.1:${port}/v1/runs`,{method:'POST',headers,body:JSON.stringify({model:'gpt-5-codex',input:'x'})})).json() as {id:string};await new Promise(resolve=>setTimeout(resolve,10));expect((await fetch(`http://127.0.0.1:${port}/v1/runs/${run.id}/cancel`,{method:'POST',headers})).status).toBe(409); });

it('emits executable Node shebangs for both packaged entrypoints', async () => { const daemonEntry=await readFile(resolve(import.meta.dirname,'../dist/src/main.js'),'utf8'); const cliEntry=await readFile(resolve(import.meta.dirname,'../../cli/dist/index.js'),'utf8'); expect(daemonEntry.startsWith('#!/usr/bin/env node')).toBe(true); expect(cliEntry.startsWith('#!/usr/bin/env node')).toBe(true); });

it('accepts only GET health checks', async () => { const daemon=new PattyDaemon(); server=await daemon.listen(); const port=(server.address() as {port:number}).port; expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200); expect((await fetch(`http://127.0.0.1:${port}/healthz`,{method:'POST'})).status).toBe(405); });

it('rejects non-boolean approval decisions', async () => { const daemon=new PattyDaemon();daemon.addFakeAccount('approval');server=await daemon.listen();const port=(server.address() as {port:number}).port;const headers={authorization:`Bearer ${daemon.key}`,'content-type':'application/json'};const response=await fetch(`http://127.0.0.1:${port}/v1/runs/nope/approvals/a`,{method:'POST',headers,body:JSON.stringify({approved:'false'})});expect(response.status).toBe(400); });

it('exposes authenticated models and router status', async () => { const daemon=new PattyDaemon();daemon.addFakeAccount('pool');server=await daemon.listen();const port=(server.address() as {port:number}).port;const headers={authorization:`Bearer ${daemon.key}`};expect((await fetch(`http://127.0.0.1:${port}/v1/models`,{headers})).status).toBe(200);expect((await fetch(`http://127.0.0.1:${port}/v1/router/status`,{headers})).status).toBe(200); });

it('leaves no account state behind when the Codex CLI cannot be started', async () => { const keys=['PATTY_CODEX_COMMAND','PATTY_ACCOUNT_HOME_ROOT'] as const;const saved=new Map(keys.map(key=>[key,process.env[key]]));const dir=await mkdtemp(join(tmpdir(),'patty-nocodex-'));process.env.PATTY_CODEX_COMMAND=join(dir,'no-such-codex');process.env.PATTY_ACCOUNT_HOME_ROOT=join(dir,'accounts');const daemon=new PattyDaemon();try{await expect(daemon.addCodexAccount('offline','device_code')).rejects.toThrow();expect(daemon.store.accounts()).toEqual([]);expect(daemon.adapters.size).toBe(0);expect(daemon.homes.size).toBe(0);}finally{await daemon.shutdown();for(const [key,value] of saved)value===undefined?delete process.env[key]:process.env[key]=value;await rm(dir,{recursive:true,force:true});} });


it('enforces owner-only, non-symlink Codex home directories', async () => { const root = await mkdtemp(join(tmpdir(), 'patty-home-')); const privateRoot = privateDirectory(join(root, 'accounts')); expect((await stat(privateRoot)).mode & 0o777).toBe(0o700); await symlink(privateRoot, join(root, 'link')); expect(() => privateDirectory(join(root, 'link'))).toThrow('unsafe_account_home'); await chmod(privateRoot, 0o755); expect(privateDirectory(privateRoot)).toBe(privateRoot); expect((await stat(privateRoot)).mode & 0o777).toBe(0o700); });

it('serves the loopback console without a key and reports usage only with one', async () => { const daemon=new PattyDaemon();daemon.addFakeAccount('console');server=await daemon.listen();const port=(server.address() as {port:number}).port;const page=await fetch(`http://127.0.0.1:${port}/`);expect(page.status).toBe(200);expect(page.headers.get('content-type')).toContain('text/html');expect(await page.text()).toContain('Pattystack');expect((await fetch(`http://127.0.0.1:${port}/v1/usage`)).status).toBe(401); });

it('reports measured token usage per sub after a routed run', async () => { const daemon=new PattyDaemon();const account=daemon.addFakeAccount('measured');server=await daemon.listen();const port=(server.address() as {port:number}).port;const headers={authorization:`Bearer ${daemon.key}`,'content-type':'application/json'};await fetch(`http://127.0.0.1:${port}/v1/runs`,{method:'POST',headers,body:JSON.stringify({model:'gpt-5-codex',input:'count these tokens please'})});await new Promise(resolve=>setTimeout(resolve,10));const {data}=await (await fetch(`http://127.0.0.1:${port}/v1/usage`,{headers})).json() as {data:{totals:{runs:number;inputTokens:number;outputTokens:number};accounts:{accountId:string;alias:string;totalTokens:number}[];runs:{model:string}[]}};expect(data.totals.runs).toBe(1);expect(data.totals.inputTokens).toBeGreaterThan(0);expect(data.totals.outputTokens).toBeGreaterThan(0);expect(data.accounts).toHaveLength(1);expect(data.accounts[0]).toMatchObject({accountId:account.id,alias:'measured'});expect(data.runs[0]).toMatchObject({model:'gpt-5-codex'}); });

it('replays in-flight output text to a subscriber that joins after the turn produced it', async () => { const daemon=new PattyDaemon();daemon.addFakeAccount('replay');server=await daemon.listen();const port=(server.address() as {port:number}).port;const headers={authorization:`Bearer ${daemon.key}`,'content-type':'application/json'};const {id}=await (await fetch(`http://127.0.0.1:${port}/v1/runs`,{method:'POST',headers,body:JSON.stringify({model:'gpt-5-codex',input:'late subscriber'})})).json() as {id:string};await new Promise(resolve=>setTimeout(resolve,10));const stream=await fetch(`http://127.0.0.1:${port}/v1/runs/${id}/events`,{headers});const frames=await stream.text();const deltas=frames.split('\n\n').map(frame=>frame.split('\n').find(line=>line.startsWith('data: '))).filter(Boolean).map(line=>JSON.parse(line!.slice(6)) as {type:string;data?:{text?:string}}).filter(event=>event.type==='delta');expect(deltas).toHaveLength(1);expect(deltas[0]!.data?.text).toBe('fake: late subscriber');expect(daemon.store.db.prepare("SELECT data FROM run_events WHERE run_id=? AND type='delta'").get(id)).toMatchObject({data:JSON.stringify({redacted:true})}); });

it('hides removed subs from accounts, router status, and models while keeping their usage history', async () => { const daemon=new PattyDaemon();const kept=daemon.addFakeAccount('kept');const dropped=daemon.addFakeAccount('dropped');server=await daemon.listen();const port=(server.address() as {port:number}).port;const headers={authorization:`Bearer ${daemon.key}`,'content-type':'application/json'};await fetch(`http://127.0.0.1:${port}/v1/runs`,{method:'POST',headers,body:JSON.stringify({model:'gpt-5-codex',input:'before removal',accountId:dropped.id})});await new Promise(resolve=>setTimeout(resolve,10));expect((await fetch(`http://127.0.0.1:${port}/v1/accounts/${dropped.id}`,{method:'DELETE',headers})).status).toBe(204);const list=await (await fetch(`http://127.0.0.1:${port}/v1/accounts`,{headers})).json() as {data:{id:string}[]};expect(list.data.map(account=>account.id)).toEqual([kept.id]);const router=await (await fetch(`http://127.0.0.1:${port}/v1/router/status`,{headers})).json() as {data:{alias:string}[]};expect(router.data.map(entry=>entry.alias)).toEqual(['kept']);const usage=await (await fetch(`http://127.0.0.1:${port}/v1/usage`,{headers})).json() as {data:{accounts:{alias:string}[]}};expect(usage.data.accounts.map(entry=>entry.alias)).toEqual(['dropped']); });

describe('restart restore', () => {
  const liveKeys = ['PATTY_CODEX_COMMAND', 'PATTY_ACCOUNT_HOME_ROOT'] as const;
  async function withLive<T>(dir: string, command: string, body: () => Promise<T>) { const saved = new Map(liveKeys.map(key => [key, process.env[key]])); process.env.PATTY_CODEX_COMMAND = command; process.env.PATTY_ACCOUNT_HOME_ROOT = join(dir, 'accounts'); try { return await body(); } finally { for (const [key, value] of saved) value === undefined ? delete process.env[key] : process.env[key] = value; } }
  const stub = `#!/usr/bin/env node
if(process.argv.includes('--version')){console.log('codex-cli 0.145.0');process.exit(0)}
const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const r=JSON.parse(line),out=x=>process.stdout.write(JSON.stringify(x)+'\\n');if(r.method==='initialize')out({jsonrpc:'2.0',id:r.id,result:{userAgent:'stub',codexHome:process.env.CODEX_HOME,platformFamily:'unix',platformOs:'linux'}});if(r.method==='account/login/start')out({jsonrpc:'2.0',id:r.id,result:{type:'chatgptDeviceCode',loginId:'login-1',verificationUrl:'https://example.invalid',userCode:'CODE'}});if(r.method==='account/logout')out({jsonrpc:'2.0',id:r.id,result:{}});if(r.method==='account/read')out({jsonrpc:'2.0',id:r.id,result:{account:{type:'chatgpt',email:null,planType:'pro'},requiresOpenaiAuth:true}});if(r.method==='model/list')out({jsonrpc:'2.0',id:r.id,result:{data:[{id:'gpt-5-codex',model:'gpt-5-codex'}],nextCursor:null}});if(r.method==='account/rateLimits/read')out({jsonrpc:'2.0',id:r.id,result:{rateLimits:{primary:{usedPercent:25,windowDurationMins:null,resetsAt:100},secondary:null}}});});
`;
  /** Without restore, a sub logged in before a restart is stranded in reconnect_required with no worker. */
  it('re-attaches a persisted sub whose isolated home survives a restart', async () => { const dir = await mkdtemp(join(tmpdir(), 'patty-restore-')); const command = join(dir, 'codex'); await writeFile(command, stub); await chmod(command, 0o700); await withLive(dir, command, async () => { const first = new PattyDaemon(join(dir, 'patty.sqlite')); await first.addCodexAccount('sub-one', 'device_code'); await first.shutdown(); const second = new PattyDaemon(join(dir, 'patty.sqlite')); try { expect(second.adapters.size).toBe(0); expect((await second.restoreCodexAccounts()).map(account => account.alias)).toEqual(['sub-one']); expect(second.store.accounts()[0]).toMatchObject({ alias: 'sub-one', state: 'ready', models: ['gpt-5-codex'] }); expect(second.store.accounts()[0]?.quota.remaining).toBeCloseTo(.75); } finally { await second.shutdown(); } }); });
  it('restores nothing while the live gate is closed', async () => { const saved = new Map(liveKeys.map(key => [key, process.env[key]])); for (const key of liveKeys) delete process.env[key]; const daemon = new PattyDaemon(); try { expect(await daemon.restoreCodexAccounts()).toEqual([]); expect(daemon.adapters.size).toBe(0); } finally { await daemon.shutdown(); for (const [key, value] of saved) value === undefined ? delete process.env[key] : process.env[key] = value; } });
});

describe('OpenAI-compatible surface', () => {
  const setup = async () => { const daemon = new PattyDaemon(); daemon.addFakeAccount('sub-a'); server = await daemon.listen(); const { port } = server.address() as { port: number }; return { daemon, url: `http://127.0.0.1:${port}`, headers: { authorization: `Bearer ${daemon.key}`, 'content-type': 'application/json' } }; };

  it('answers a non-streaming chat completion with provider counts and the serving sub', async () => { const { url, headers } = await setup();
    const response = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi there' }] }) });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-patty-sub')).toBe('sub-a');
    const body = await response.json() as { object: string; choices: { message: { role: string; content: string }; finish_reason: string }[]; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; prompt_tokens_details: { cached_tokens: number } } };
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0]?.finish_reason).toBe('stop');
    // The fake worker echoes what it was told, which proves the system message reached the provider as the turn's rules rather than as more prompt text.
    expect(body.choices[0]?.message).toEqual({ role: 'assistant', content: 'fake [instructions: be terse]: hi there' });
    expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens + body.usage.completion_tokens);
    expect(body.usage.prompt_tokens).toBeGreaterThan(0);
    expect(body.usage.prompt_tokens_details.cached_tokens).toBe(0);
  });

  it('streams OpenAI chunks and reports usage on the final chunk', async () => { const { url, headers } = await setup();
    const response = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', messages: [{ role: 'user', content: [{ type: 'text', text: 'stream me' }] }], stream: true }) });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const payload = await response.text();
    const chunks = payload.split('\n\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6));
    expect(chunks.at(-1)).toBe('[DONE]');
    const parsed = chunks.slice(0, -1).map(chunk => JSON.parse(chunk) as { object: string; choices: { delta: { role?: string; content?: string }; finish_reason: string | null }[]; usage?: { total_tokens: number } });
    expect(parsed[0]?.choices[0]?.delta.role).toBe('assistant');
    expect(parsed.map(chunk => chunk.choices[0]?.delta.content ?? '').join('')).toBe('fake: stream me');
    expect(parsed.at(-1)?.choices[0]?.finish_reason).toBe('stop');
    expect(parsed.at(-1)?.usage?.total_tokens).toBeGreaterThan(0);
    expect(parsed.every(chunk => chunk.object === 'chat.completion.chunk')).toBe(true);
  });

  it('rejects a request without usable message text', async () => { const { url, headers } = await setup();
    for (const body of [{ model: 'gpt-5-codex' }, { model: 'gpt-5-codex', messages: [] }, { messages: [{ role: 'user', content: 'hi' }] }])
      expect((await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) })).status).toBe(400);
  });

  it('lists models in OpenAI shape and names the subs serving each one', async () => { const { daemon, url, headers } = await setup();
    daemon.addFakeAccount('sub-b', ['gpt-5-codex', 'gpt-5.5']);
    const body = await (await fetch(`${url}/v1/models`, { headers })).json() as { object: string; data: { id: string; object: string; owned_by: string; subs: string[] }[] };
    expect(body.object).toBe('list');
    expect(body.data.map(model => model.id)).toEqual(['gpt-5-codex', 'gpt-5.5']);
    expect(body.data[0]).toMatchObject({ object: 'model', owned_by: 'pattystack', subs: ['sub-a', 'sub-b'] });
    expect(body.data[1]?.subs).toEqual(['sub-b']);
  });

  it('meters chat completions into the same per-sub usage report as /v1/runs', async () => { const { url, headers } = await setup();
    await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', messages: [{ role: 'user', content: 'metered' }] }) });
    const report = await (await fetch(`${url}/v1/usage`, { headers })).json() as { data: { totals: { runs: number; totalTokens: number }; accounts: { alias: string; runs: number }[] } };
    expect(report.data.totals.runs).toBe(1);
    expect(report.data.totals.totalTokens).toBeGreaterThan(0);
    expect(report.data.accounts).toMatchObject([{ alias: 'sub-a', runs: 1 }]);
  });

  it('accepts a non-strict json_schema by translating it and returning schema-valid output', async () => { const { url, headers } = await setup();
    const response = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', messages: [{ role: 'user', content: 'x' }], response_format: { type: 'json_schema', json_schema: { name: 'person', schema: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, nickname: { type: 'string' } }, required: ['name'] } } } }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { choices: { message: { content: string } }[] };
    expect(JSON.parse(body.choices[0]!.message.content)).toEqual({ name: 'fake' });
  });

  it('accepts a strict json_schema for chat completions', async () => { const { url, headers } = await setup();
    const response = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', messages: [{ role: 'user', content: 'x' }], response_format: { type: 'json_schema', json_schema: { name: 'person', schema: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, nickname: { type: ['string', 'null'] } }, required: ['name', 'nickname'] } } } }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { choices: { message: { content: string } }[] };
    expect(JSON.parse(body.choices[0]!.message.content)).toEqual({ name: 'fake', nickname: null });
  });

  it('accepts a non-strict schema on /v1/responses and returns schema-valid output', async () => { const { url, headers } = await setup();
    const response = await fetch(`${url}/v1/responses`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', input: 'x', text: { format: { type: 'json_schema', name: 'person', schema: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, nickname: { type: 'string' } }, required: ['name'] } } } }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { output_text: string };
    expect(JSON.parse(body.output_text)).toEqual({ name: 'fake' });
  });

  it('accepts a strict schema on /v1/responses', async () => { const { url, headers } = await setup();
    const response = await fetch(`${url}/v1/responses`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', input: 'x', text: { format: { type: 'json_schema', name: 'person', schema: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' } }, required: ['name'] } } } }) });
    expect(response.status).toBe(200);
  });
});

describe('quota failover', () => {
  it('retries a 429 on another sub, parks the burned one until its reset, and still answers the caller', async () => {
    const daemon = new PattyDaemon();
    const burned = daemon.addFakeAccount('burned', ['gpt-5-codex'], .9);
    daemon.addFakeAccount('spare', ['gpt-5-codex'], .5);
    const resetAt = new Date(Date.now() + 3_600_000).toISOString();
    burned.quota = { remaining: .9, resetAt, observedAt: new Date().toISOString() };
    daemon.store.updateAccount(burned);
    (daemon.adapters.get(burned.id) as FakeAdapter).failNext('HTTP 429 rate limit reached');
    server = await daemon.listen();
    const { port } = server.address() as { port: number };
    const headers = { authorization: `Bearer ${daemon.key}`, 'content-type': 'application/json' };
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', messages: [{ role: 'user', content: 'survive the 429' }] }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { choices: { message: { content: string } }[] };
    expect(body.choices[0]?.message.content).toBe('fake: survive the 429');
    // The burned sub was picked first (higher quota), so the answer proves the retry landed elsewhere.
    expect(daemon.store.account(burned.id)).toMatchObject({ quota: { remaining: 0, resetAt }, cooldownUntil: resetAt });
    const usage = await (await fetch(`http://127.0.0.1:${port}/v1/usage`, { headers })).json() as { data: { accounts: { alias: string }[] } };
    expect(usage.data.accounts.map(entry => entry.alias)).toEqual(['spare']);
    const attempts = daemon.store.db.prepare('SELECT account_id,attempt,reason FROM run_attempts ORDER BY attempt').all() as { account_id: string; attempt: number; reason: string }[];
    expect(attempts.map(attempt => attempt.reason)).toEqual(['selected', 'quota_failover']);
    expect(attempts[0]?.account_id).toBe(burned.id);
  });

  it('keeps a fallback sub idle while a lower-scoring primary sub can still serve', async () => {
    const daemon = new PattyDaemon();
    daemon.addFakeAccount('codex-sub', ['gpt-5-codex'], .05);
    daemon.addFakeAccount('api-credit', ['gpt-5-codex'], 1, 'fallback');
    server = await daemon.listen();
    const { port } = server.address() as { port: number };
    const headers = { authorization: `Bearer ${daemon.key}`, 'content-type': 'application/json' };
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', messages: [{ role: 'user', content: 'stay on the stack' }] }) });
    expect(response.status).toBe(200);
    // The fallback sub has far more headroom, so serving from the primary proves tiers are not scored against each other.
    expect(response.headers.get('x-patty-sub')).toBe('codex-sub');
    const status = await (await fetch(`http://127.0.0.1:${port}/v1/router/status?model=gpt-5-codex`, { headers })).json() as { data: { alias: string; tier: string; score: number }[] };
    expect(status.data.map(entry => entry.tier)).toEqual(['primary', 'fallback']);
    expect(status.data[1]?.score).toBeGreaterThan(status.data[0]!.score);
  });

  it('spills to the fallback sub once every primary sub is rate limited, and returns to the stack after the window rolls over', async () => {
    const daemon = new PattyDaemon();
    const burned = daemon.addFakeAccount('codex-sub', ['gpt-5-codex'], .9);
    daemon.addFakeAccount('api-credit', ['gpt-5-codex'], .3, 'fallback');
    (daemon.adapters.get(burned.id) as FakeAdapter).failNext('HTTP 429 usage limit reached');
    server = await daemon.listen();
    const { port } = server.address() as { port: number };
    const headers = { authorization: `Bearer ${daemon.key}`, 'content-type': 'application/json' };
    const spilled = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', messages: [{ role: 'user', content: 'spill over' }] }) });
    expect(spilled.status).toBe(200);
    // Before this, the header named the sub picked first rather than the one that answered after failover.
    expect(spilled.headers.get('x-patty-sub')).toBe('api-credit');
    expect(daemon.store.account(burned.id)?.quota.remaining).toBe(0);
    const attempts = daemon.store.db.prepare('SELECT account_id,reason FROM run_attempts ORDER BY attempt').all() as { account_id: string; reason: string }[];
    expect(attempts.map(attempt => attempt.reason)).toEqual(['selected', 'quota_failover']);
    // A rolled-over window makes the subscription usable again, and it must reclaim the traffic from paid credit.
    const restored = daemon.store.account(burned.id)!;
    restored.quota = { remaining: 0, resetAt: new Date(Date.now() - 1_000).toISOString(), observedAt: new Date().toISOString() };
    restored.cooldownUntil = undefined;
    daemon.store.updateAccount(restored);
    daemon.store.db.prepare('DELETE FROM cooldowns WHERE account_id=?').run(burned.id);
    const back = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', messages: [{ role: 'user', content: 'back on the stack' }] }) });
    expect(back.status).toBe(200);
    expect(back.headers.get('x-patty-sub')).toBe('codex-sub');
  });

  it('fails the run as quota_exhausted when every sub is out of headroom', async () => {
    const daemon = new PattyDaemon();
    const only = daemon.addFakeAccount('only', ['gpt-5-codex'], .4);
    (daemon.adapters.get(only.id) as FakeAdapter).failNext('usage limit reached', 2);
    server = await daemon.listen();
    const { port } = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${daemon.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5-codex', messages: [{ role: 'user', content: 'nowhere to go' }] }) });
    expect(response.status).toBe(502);
    expect(daemon.store.run(response.headers.get('x-patty-run')!)).toMatchObject({ status: 'failed' });
    expect(daemon.store.account(only.id)?.quota.remaining).toBe(0);
  });

  it('routes to a sub whose window has already rolled over even though its last snapshot read empty', async () => {
    const daemon = new PattyDaemon();
    const stale = daemon.addFakeAccount('stale', ['gpt-5-codex'], 0);
    stale.quota = { remaining: 0, resetAt: new Date(Date.now() - 60_000).toISOString(), observedAt: new Date(Date.now() - 7_200_000).toISOString() };
    daemon.store.updateAccount(stale);
    server = await daemon.listen();
    const { port } = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${daemon.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5-codex', messages: [{ role: 'user', content: 'window rolled over' }] }) });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-patty-sub')).toBe('stale');
  });
});

describe('router status', () => {
  it('explains the ranking with quota windows rather than a redacted score', async () => {
    const daemon = new PattyDaemon();
    const roomy = daemon.addFakeAccount('roomy', ['gpt-5-codex'], .8);
    const tight = daemon.addFakeAccount('tight', ['gpt-5-codex'], .2);
    tight.quota = { remaining: .2, resetAt: new Date(Date.now() + 1_800_000).toISOString(), observedAt: new Date().toISOString() };
    daemon.store.updateAccount(tight);
    server = await daemon.listen();
    const { port } = server.address() as { port: number };
    const body = await (await fetch(`http://127.0.0.1:${port}/v1/router/status?model=gpt-5-codex`, { headers: { authorization: `Bearer ${daemon.key}` } })).json() as { data: { alias: string; eligible: boolean; effectiveQuota: number; resetsInMs?: number; score: number }[] };
    expect(body.data.map(entry => entry.alias)).toEqual(['roomy', 'tight']);
    expect(body.data.every(entry => entry.eligible)).toBe(true);
    expect(body.data[0]?.score).toBeGreaterThan(body.data[1]!.score);
    expect(body.data[0]?.effectiveQuota).toBeCloseTo(.8);
    expect(body.data[0]?.resetsInMs).toBeUndefined();
    expect(body.data[1]?.resetsInMs).toBeGreaterThan(1_700_000);
    expect(daemon.store.account(roomy.id)?.alias).toBe('roomy');
  });

  it('marks a model nobody serves as ineligible without hiding the sub', async () => {
    const daemon = new PattyDaemon();
    daemon.addFakeAccount('only-codex', ['gpt-5-codex']);
    server = await daemon.listen();
    const { port } = server.address() as { port: number };
    const body = await (await fetch(`http://127.0.0.1:${port}/v1/router/status?model=gpt-4o`, { headers: { authorization: `Bearer ${daemon.key}` } })).json() as { data: { alias: string; ready: boolean; eligible: boolean }[] };
    expect(body.data).toMatchObject([{ alias: 'only-codex', ready: true, eligible: false }]);
  });
});

describe('multiple API keys', () => {
  it('issues named keys, attributes usage to the caller, and revokes one without affecting the other', async () => {
    const daemon = new PattyDaemon();
    daemon.addFakeAccount('shared', ['gpt-5-codex']);
    server = await daemon.listen();
    const { port } = server.address() as { port: number };
    const bootstrap = { authorization: `Bearer ${daemon.key}`, 'content-type': 'application/json' };
    const issue = async (name: string) => await (await fetch(`http://127.0.0.1:${port}/v1/api-keys`, { method: 'POST', headers: bootstrap, body: JSON.stringify({ name }) })).json() as { id: string; name: string; key: string; warning: string };
    const prod = await issue('puffle-prod');
    const dev = await issue('puffle-dev');
    expect(prod).toMatchObject({ name: 'puffle-prod', warning: 'secret shown once; store it securely' });
    const complete = async (key: string, content: string) => await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5-codex', messages: [{ role: 'user', content }] }) });
    expect((await complete(prod.key, 'from prod')).status).toBe(200);
    expect((await complete(prod.key, 'from prod again')).status).toBe(200);
    expect((await complete(dev.key, 'from dev')).status).toBe(200);
    const usage = await (await fetch(`http://127.0.0.1:${port}/v1/usage`, { headers: bootstrap })).json() as { data: { keys: { keyId: string; name: string; runs: number }[] } };
    expect(usage.data.keys).toMatchObject([{ keyId: prod.id, name: 'puffle-prod', runs: 2 }, { keyId: dev.id, name: 'puffle-dev', runs: 1 }]);
    expect((await fetch(`http://127.0.0.1:${port}/v1/api-keys/${prod.id}`, { method: 'DELETE', headers: bootstrap })).status).toBe(204);
    expect((await complete(prod.key, 'revoked')).status).toBe(401);
    expect((await complete(dev.key, 'still fine')).status).toBe(200);
  });

  it('lists keys with their state and never re-exposes a secret', async () => {
    const daemon = new PattyDaemon();
    server = await daemon.listen();
    const { port } = server.address() as { port: number };
    const headers = { authorization: `Bearer ${daemon.key}`, 'content-type': 'application/json' };
    const issued = await (await fetch(`http://127.0.0.1:${port}/v1/api-keys`, { method: 'POST', headers, body: JSON.stringify({ name: 'ci' }) })).json() as { id: string; key: string };
    await fetch(`http://127.0.0.1:${port}/v1/api-keys/${issued.id}`, { method: 'DELETE', headers });
    const listed = await (await fetch(`http://127.0.0.1:${port}/v1/api-keys`, { headers })).json() as { data: { id: string; name: string | null; prefix: string; revoked_at: string | null }[] };
    const ci = listed.data.find(entry => entry.id === issued.id);
    expect(ci).toMatchObject({ name: 'ci' });
    expect(ci?.revoked_at).not.toBeNull();
    expect(JSON.stringify(listed)).not.toContain(issued.key);
    expect(JSON.stringify(listed)).not.toContain(issued.key.slice(-12));
  });
});

describe('observability', () => {
  it('exposes Prometheus metrics covering quota windows, failover reasons and token totals', async () => {
    const daemon = new PattyDaemon();
    const burned = daemon.addFakeAccount('burned', ['gpt-5-codex'], .9);
    daemon.addFakeAccount('spare', ['gpt-5-codex'], .5);
    burned.quota = { remaining: .9, resetAt: new Date(Date.now() + 600_000).toISOString(), observedAt: new Date().toISOString() };
    daemon.store.updateAccount(burned);
    (daemon.adapters.get(burned.id) as FakeAdapter).failNext('HTTP 429 usage limit');
    server = await daemon.listen();
    const { port } = server.address() as { port: number };
    const headers = { authorization: `Bearer ${daemon.key}`, 'content-type': 'application/json' };
    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', messages: [{ role: 'user', content: 'metrics run' }] }) });
    const response = await fetch(`http://127.0.0.1:${port}/metrics`, { headers });
    expect(response.headers.get('content-type')).toContain('text/plain');
    const body = await response.text();
    expect(body).toContain('# TYPE patty_sub_quota_remaining gauge');
    expect(body).toMatch(/patty_sub_quota_remaining\{sub="burned",tier="primary"\} 0\b/);
    expect(body).toMatch(/patty_sub_quota_reset_seconds\{sub="burned"\} \d+/);
    expect(body).toMatch(/patty_run_attempts_total\{reason="quota_failover"\} 1/);
    expect(body).toMatch(/patty_runs_total\{status="completed"\} 1/);
    expect(body).toMatch(/patty_tokens_total\{sub="spare",direction="input"\} \d+/);
    expect(body).toMatch(/patty_cached_input_tokens_total\{sub="spare"\} \d+/);
    expect(body).toMatch(/patty_cache_hit_ratio\{sub="spare"\} [\d.]+/);
    expect((await fetch(`http://127.0.0.1:${port}/metrics`)).status).toBe(401);
  });

  it('filters run history by sub, model and status', async () => {
    const daemon = new PattyDaemon();
    daemon.addFakeAccount('one', ['gpt-5-codex']);
    daemon.addFakeAccount('two', ['gpt-5-codex']);
    server = await daemon.listen();
    const { port } = server.address() as { port: number };
    const headers = { authorization: `Bearer ${daemon.key}`, 'content-type': 'application/json' };
    for (const content of ['first', 'second', 'third']) await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', messages: [{ role: 'user', content }] }) });
    const history = async (query: string) => (await (await fetch(`http://127.0.0.1:${port}/v1/runs${query}`, { headers })).json() as { data: { runId: string; alias: string; status: string; model: string; attempts: number }[] }).data;
    const all = await history('');
    expect(all).toHaveLength(3);
    expect(all.every(entry => entry.status === 'completed' && entry.attempts === 1)).toBe(true);
    expect(await history('?status=failed')).toHaveLength(0);
    expect(await history('?model=gpt-4o')).toHaveLength(0);
    expect(await history('?limit=1')).toHaveLength(1);
    const sub = all[0]!.alias;
    expect((await history(`?sub=${sub}`)).every(entry => entry.alias === sub)).toBe(true);
    expect(await history('?sub=nobody')).toHaveLength(0);
  });

  it('reports actionable doctor checks instead of a bare router dump', async () => {
    const empty = new PattyDaemon();
    server = await empty.listen();
    let port = (server.address() as { port: number }).port;
    const read = async (daemon: PattyDaemon, at: number) => await (await fetch(`http://127.0.0.1:${at}/v1/doctor`, { headers: { authorization: `Bearer ${daemon.key}` } })).json() as { data: { ok: boolean; checks: { check: string; ok: boolean; hint?: string }[] } };
    const bare = await read(empty, port);
    expect(bare.data.ok).toBe(false);
    expect(bare.data.checks.find(check => check.check === 'subs_stacked')).toMatchObject({ ok: false });
    expect(bare.data.checks.find(check => check.check === 'subs_stacked')?.hint).toContain('--fake');
    server.close();

    const stacked = new PattyDaemon();
    stacked.addFakeAccount('healthy', ['gpt-5-codex']);
    server = await stacked.listen();
    port = (server.address() as { port: number }).port;
    /** Pinned to a path that cannot exist, so the check reads the same here as on a machine without the Codex CLI. */
    const savedCommand = process.env.PATTY_CODEX_COMMAND;
    process.env.PATTY_CODEX_COMMAND = join(tmpdir(), 'patty-no-such-codex');
    const ready = await read(stacked, port);
    savedCommand === undefined ? delete process.env.PATTY_CODEX_COMMAND : process.env.PATTY_CODEX_COMMAND = savedCommand;
    /** A missing Codex CLI is reported, not fatal: `--fake` subs still make the daemon healthy. */
    expect(ready.data.ok).toBe(true);
    expect(ready.data.checks.map(check => check.check)).toEqual(['subs_stacked', 'subs_servable', 'models_discovered', 'codex_cli', 'subs_authenticated', 'active_keys', 'store_writable']);
    expect(ready.data.checks.find(check => check.check === 'codex_cli')).toMatchObject({ ok: false });
    expect(ready.data.checks.filter(check => check.hint !== undefined).map(check => check.check)).toEqual(['codex_cli']);
    server.close();

    /**
     * The failure a stuck operator cannot otherwise see: the CLI is installed and the logins are
     * intact, but the version on the box speaks a protocol Patty does not, so every Codex sub is
     * dead. That is ill health, unlike no CLI at all.
     */
    const upgraded = new PattyDaemon();
    upgraded.addFakeAccount('healthy', ['gpt-5-codex']);
    server = await upgraded.listen();
    port = (server.address() as { port: number }).port;
    const unspeakable = join(await mkdtemp(join(tmpdir(), 'patty-codex-')), 'codex');
    await writeFile(unspeakable, '#!/bin/sh\necho codex-cli 0.148.0\n');
    await chmod(unspeakable, 0o700);
    process.env.PATTY_CODEX_COMMAND = unspeakable;
    const drifted = await read(upgraded, port);
    savedCommand === undefined ? delete process.env.PATTY_CODEX_COMMAND : process.env.PATTY_CODEX_COMMAND = savedCommand;
    expect(drifted.data.ok).toBe(false);
    expect(drifted.data.checks.find(check => check.check === 'codex_cli')).toMatchObject({ ok: false, detail: expect.stringContaining('0.148.0') });
    expect(drifted.data.checks.find(check => check.check === 'codex_cli')?.hint).toContain('PATTY_CODEX_VERSION');
  });

  /**
   * The outage doctor used to call healthy: a sub keeps its `ready` state, its discovered models and
   * its last quota reading after the provider revokes the login underneath it, so only using the
   * credential tells an operator that every run will fail.
   */
  it('fails when a stored sub can no longer use its credential', async () => {
    const daemon = new PattyDaemon();
    const account = daemon.addFakeAccount('revoked', ['gpt-5-codex']);
    const adapter = daemon.adapters.get(account.id)!;
    adapter.snapshot = async () => { throw new Error('Your authentication token has been invalidated. Please try signing in again.'); };
    server = await daemon.listen();
    const port = (server.address() as { port: number }).port;
    const body = await (await fetch(`http://127.0.0.1:${port}/v1/doctor`, { headers: { authorization: `Bearer ${daemon.key}` } })).json() as { data: { ok: boolean; checks: { check: string; ok: boolean; detail: string; hint?: string }[] } };
    const check = body.data.checks.find(entry => entry.check === 'subs_authenticated')!;
    expect(body.data.ok).toBe(false);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('revoked: Your authentication token has been invalidated');
    expect(check.hint).toContain('relogin');
    /** The stack still looks servable, which is exactly why the credential needs its own check. */
    expect(body.data.checks.find(entry => entry.check === 'subs_servable')?.ok).toBe(true);
  });

  it('bounds the credential probe so one hung sub cannot hang doctor', async () => {
    const daemon = new PattyDaemon();
    const account = daemon.addFakeAccount('hung', ['gpt-5-codex']);
    daemon.adapters.get(account.id)!.snapshot = () => new Promise(() => undefined);
    const probes = await daemon.credentials(20);
    expect(probes).toEqual([{ alias: 'hung', ok: false, reason: 'probe_timed_out' }]);
  });
});

describe('OpenAI-compatible provider adapter', () => {
  const upstream = (handler: (path: string, body: unknown) => Response): typeof fetch => (async (input: string | URL | Request, init?: RequestInit) => handler(new URL(String(input)).pathname, init?.body ? JSON.parse(String(init.body)) : undefined)) as unknown as typeof fetch;
  const sse = (chunks: string[]) => new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }), { headers: { 'x-ratelimit-remaining-requests': '40', 'x-ratelimit-limit-requests': '100', 'x-ratelimit-reset-requests': '120s' } });

  it('stacks a third-party endpoint, streams its answer and meters its reported usage', async () => {
    const daemon = new PattyDaemon();
    const fetchImpl = upstream((path) => path.endsWith('/models')
      ? new Response(JSON.stringify({ data: [{ id: 'llama-3.3-70b' }, { id: 'gpt-4o-mini' }] }), { headers: { 'content-type': 'application/json', 'x-ratelimit-remaining-requests': '40', 'x-ratelimit-limit-requests': '100' } })
      : sse(['data: {"choices":[{"delta":{"content":"hello "}}]}\n', 'data: {"choices":[{"delta":{"content":"from llama"}}]}\n', 'data: {"usage":{"prompt_tokens":11,"completion_tokens":3,"total_tokens":14}}\n', 'data: [DONE]\n']));
    process.env.PATTY_TEST_PROVIDER_KEY = 'sk-not-a-real-key';
    const account = await daemon.addOpenAiCompatibleAccount('together', 'https://api.example.invalid/v1', 'PATTY_TEST_PROVIDER_KEY', fetchImpl);
    expect(account.models).toEqual(['llama-3.3-70b', 'gpt-4o-mini']);
    expect(account.quota.remaining).toBeCloseTo(.4);

    server = await daemon.listen();
    const { port } = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${daemon.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'llama-3.3-70b', messages: [{ role: 'user', content: 'hi' }] }) });
    const body = await response.json() as { choices: { message: { content: string } }[]; usage: { prompt_tokens: number; completion_tokens: number } };
    expect(response.status).toBe(200);
    expect(response.headers.get('x-patty-sub')).toBe('together');
    expect(body.choices[0]!.message.content).toBe('hello from llama');
    expect(body.usage).toMatchObject({ prompt_tokens: 11, completion_tokens: 3 });
    const usage = await (await fetch(`http://127.0.0.1:${port}/v1/usage`, { headers: { authorization: `Bearer ${daemon.key}` } })).json() as { data: { accounts: { alias: string; totalTokens: number }[] } };
    expect(usage.data.accounts).toMatchObject([{ alias: 'together', totalTokens: 14 }]);
    delete process.env.PATTY_TEST_PROVIDER_KEY;
  });

  it('keeps the provider’s cached and reasoning token details, so a cached turn is priced as one', async () => {
    const daemon = new PattyDaemon();
    const fetchImpl = upstream((path) => path.endsWith('/models')
      ? new Response(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }] }), { headers: { 'content-type': 'application/json' } })
      : sse(['data: {"choices":[{"delta":{"content":"hi"}}]}\n', 'data: {"usage":{"prompt_tokens":1000,"completion_tokens":100,"total_tokens":1100,"prompt_tokens_details":{"cached_tokens":800},"completion_tokens_details":{"reasoning_tokens":40}}}\n', 'data: [DONE]\n']));
    process.env.PATTY_TEST_PROVIDER_KEY = 'sk-not-a-real-key';
    await daemon.addOpenAiCompatibleAccount('together', 'https://api.example.invalid/v1', 'PATTY_TEST_PROVIDER_KEY', fetchImpl);
    server = await daemon.listen();
    const { port } = server.address() as { port: number };
    const headers = { authorization: `Bearer ${daemon.key}`, 'content-type': 'application/json' };
    const body = await (await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }) })).json() as { usage: { prompt_tokens_details: { cached_tokens: number }; completion_tokens_details: { reasoning_tokens: number } } };
    expect(body.usage.prompt_tokens_details.cached_tokens).toBe(800);
    expect(body.usage.completion_tokens_details.reasoning_tokens).toBe(40);
    const usage = await (await fetch(`http://127.0.0.1:${port}/v1/usage`, { headers })).json() as { data: { accounts: { cachedInputTokens: number }[]; cost: { apiUsd: number } } };
    expect(usage.data.accounts[0]!.cachedInputTokens).toBe(800);
    /** gpt-4o-mini at .15/.075/.6 per million: 200 uncached in, 800 cached in, 100 out — billing the cached input at full rate would give .00015. */
    expect(usage.data.cost.apiUsd).toBeCloseTo((200 * .15 + 800 * .075 + 100 * .6) / 1e6, 10);
    delete process.env.PATTY_TEST_PROVIDER_KEY;
  });

  it('never persists the provider secret and refuses to run without it', async () => {
    const daemon = new PattyDaemon();
    const fetchImpl = upstream(() => new Response(JSON.stringify({ data: [{ id: 'm' }] }), { headers: { 'content-type': 'application/json' } }));
    process.env.PATTY_TEST_PROVIDER_KEY = 'sk-not-a-real-key';
    await daemon.addOpenAiCompatibleAccount('byok', 'https://api.example.invalid/v1', 'PATTY_TEST_PROVIDER_KEY', fetchImpl);
    delete process.env.PATTY_TEST_PROVIDER_KEY;
    expect(JSON.stringify(daemon.store.accounts())).not.toContain('sk-');
    const dumped = daemon.store.db.prepare('SELECT * FROM accounts').all().map(row => JSON.stringify(row)).join('');
    expect(dumped).not.toContain('sk-not-a-real-key');
    expect(dumped).toContain('byok');
    server = await daemon.listen();
    const { port } = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${daemon.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }) });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'upstream_failed' } });
    expect(daemon.store.runHistory()).toMatchObject([{ alias: 'byok', status: 'failed' }]);
  });

  it('rejects an unusable configuration instead of storing a broken sub', async () => {
    const daemon = new PattyDaemon();
    await expect(daemon.addOpenAiCompatibleAccount('bad', 'ftp://example.invalid', 'KEY')).rejects.toThrow(/http/);
    await expect(daemon.addOpenAiCompatibleAccount('bad', 'https://example.invalid/v1', 'not a var name')).rejects.toThrow(/environment variable/);
    expect(daemon.store.accounts()).toHaveLength(0);
  });
});

describe('per-key rate limits and queueing', () => {
  const boot = async (limits: { rpm?: number; concurrency?: number }) => {
    const daemon = new PattyDaemon();
    daemon.addFakeAccount('shared', ['gpt-5-codex']);
    server = await daemon.listen();
    const { port } = server.address() as { port: number };
    const headers = { authorization: `Bearer ${daemon.key}`, 'content-type': 'application/json' };
    const issued = await (await fetch(`http://127.0.0.1:${port}/v1/api-keys`, { method: 'POST', headers, body: JSON.stringify({ name: 'puffle-prod' }) })).json() as { id: string; key: string };
    const set = await fetch(`http://127.0.0.1:${port}/v1/api-keys/${issued.id}/limits`, { method: 'PUT', headers, body: JSON.stringify(limits) });
    expect(set.status).toBe(200);
    const complete = (content: string) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${issued.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5-codex', messages: [{ role: 'user', content }] }) });
    return { daemon, port, headers, issued, complete };
  };

  it('serves a burst past the concurrency limit by queueing it instead of failing it', async () => {
    const { port, headers, complete } = await boot({ concurrency: 1 });
    const answers = await Promise.all(['a', 'b', 'c'].map(complete));
    expect(answers.map(answer => answer.status)).toEqual([200, 200, 200]);
    const listed = await (await fetch(`http://127.0.0.1:${port}/v1/api-keys`, { headers })).json() as { data: { name: string | null; rpm: number | null; concurrency: number | null; inFlight: number; queued: number; throttled: number }[]; queue: { maxDepth: number; maxWaitMs: number } };
    const key = listed.data.find(entry => entry.name === 'puffle-prod')!;
    expect(key).toMatchObject({ rpm: null, concurrency: 1, queued: 0, throttled: 0 });
    expect(listed.queue.maxDepth).toBeGreaterThan(0);
  });

  it('answers 429 with Retry-After once the rolling minute cannot be waited out', async () => {
    const { port, headers, complete } = await boot({ rpm: 1 });
    expect((await complete('first')).status).toBe(200);
    const denied = await complete('second');
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = await denied.json() as { error: { code: string; retryable: boolean; retryAfterMs: number } };
    expect(body.error).toMatchObject({ code: 'rate_limited', retryable: true });
    expect(body.error.retryAfterMs).toBeGreaterThan(0);
    const metrics = await (await fetch(`http://127.0.0.1:${port}/metrics`, { headers })).text();
    expect(metrics).toContain('patty_key_limit_rpm{key="puffle-prod"} 1');
    expect(metrics).toContain('patty_key_throttled_total{key="puffle-prod"} 1');
    expect(metrics).toContain('patty_key_in_flight{key="puffle-prod"} 0');
  });

  it('leaves other keys unlimited and rejects a nonsense limit', async () => {
    const { port, headers, issued } = await boot({ concurrency: 2 });
    const other = await (await fetch(`http://127.0.0.1:${port}/v1/api-keys`, { method: 'POST', headers, body: JSON.stringify({ name: 'free' }) })).json() as { rpm?: number; concurrency?: number };
    expect(other.rpm).toBeUndefined();
    expect(other.concurrency).toBeUndefined();
    const bad = await fetch(`http://127.0.0.1:${port}/v1/api-keys/${issued.id}/limits`, { method: 'PUT', headers, body: JSON.stringify({ rpm: 0 }) });
    expect(bad.status).toBe(400);
    const cleared = await fetch(`http://127.0.0.1:${port}/v1/api-keys/${issued.id}/limits`, { method: 'PUT', headers, body: JSON.stringify({}) });
    expect(await cleared.json()).toEqual({ id: issued.id });
  });
});

it('answers a saturated stack with a retryable 503 rather than a fatal 400', async () => {
  const daemon = new PattyDaemon(); const account = daemon.addFakeAccount('busy'); server = await daemon.listen();
  const port = (server.address() as { port: number }).port; const headers = { authorization: `Bearer ${daemon.key}`, 'content-type': 'application/json' };
  daemon.store.updateAccount({ ...account, activeRuns: 2 });
  const response = await fetch(`http://127.0.0.1:${port}/v1/runs`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', input: 'x' }) });
  expect(response.status).toBe(503);
  expect(response.headers.get('retry-after')).toBe('5');
  const body = await response.json() as { error: { code: string; retryable: boolean; retryAfterMs: number } };
  expect(body.error).toMatchObject({ code: 'no_eligible_account', retryable: true, retryAfterMs: 5_000 });
});

it('names the model in run history even when the provider reports no usage', async () => {
  const daemon = new PattyDaemon(); daemon.addFakeAccount('unmetered'); server = await daemon.listen();
  const port = (server.address() as { port: number }).port; const headers = { authorization: `Bearer ${daemon.key}`, 'content-type': 'application/json' };
  const { id } = await (await fetch(`http://127.0.0.1:${port}/v1/runs`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', input: 'x' }) })).json() as { id: string };
  daemon.store.db.prepare('DELETE FROM usage_events WHERE run_id=?').run(id);
  const history = await (await fetch(`http://127.0.0.1:${port}/v1/runs?model=gpt-5-codex`, { headers })).json() as { data: { runId: string; model: string | null; totalTokens: number | null }[] };
  const row = history.data.find(entry => entry.runId === id);
  expect(row?.model).toBe('gpt-5-codex');
  expect(row?.totalTokens).toBeNull();
});

describe('tool calling', () => {
  const tools = [{ type: 'function', function: { name: 'get_weather', description: 'current weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }];
  const boot = async () => {
    const daemon = new PattyDaemon(); daemon.addFakeAccount('codex-work'); server = await daemon.listen();
    return { port: (server.address() as { port: number }).port, headers: { authorization: `Bearer ${daemon.key}`, 'content-type': 'application/json' }, daemon };
  };

  it('returns tool_calls with a tool_calls finish reason', async () => {
    const { port, headers } = await boot();
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', messages: [{ role: 'user', content: 'weather in Denver?' }], tools }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { choices: { finish_reason: string; message: { content: string | null; tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[] } }[] };
    const choice = body.choices[0]!;
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message.content).toBeNull();
    expect(choice.message.tool_calls?.[0]).toMatchObject({ type: 'function', function: { name: 'get_weather' } });
    expect(JSON.parse(choice.message.tool_calls![0]!.function.arguments)).toEqual({});
  });

  it('streams the calls in a delta before the tool_calls finish reason', async () => {
    const { port, headers } = await boot();
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', messages: [{ role: 'user', content: 'weather?' }], tools, stream: true }) });
    const stream = await response.text();
    const chunks = stream.split('\n\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6)) as { choices: { delta: { tool_calls?: { index: number; function: { name: string } }[] }; finish_reason: string | null }[] });
    expect(chunks.find(chunk => chunk.choices[0]!.delta.tool_calls)?.choices[0]!.delta.tool_calls![0]).toMatchObject({ index: 0, function: { name: 'get_weather' } });
    expect(chunks.at(-1)!.choices[0]!.finish_reason).toBe('tool_calls');
  });

  it('accepts a tool result turn that carries no prose of its own', async () => {
    const { port, headers } = await boot();
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', tools, messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Denver"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '' },
    ] }) });
    /** An id from a turn Patty no longer holds is not resumable, so the request is served as a fresh one rather than refused. */
    expect(response.status).toBe(200);
  });

  it('refuses tools plainly when no stacked sub supports them', async () => {
    const { port, headers, daemon } = await boot();
    for (const account of daemon.store.accounts()) daemon.store.setCapabilities(account.id, ['filesystem']);
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', messages: [{ role: 'user', content: 'hi' }], tools }) });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { code: string; message: string; retryable: boolean } };
    expect(body.error).toMatchObject({ code: 'model_unavailable', retryable: false });
    expect(body.error.message).toContain('tool calls');
  });

  it('rejects a malformed tool definition', async () => {
    const { port, headers } = await boot();
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: {} }] }) });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('invalid_request');
  });

  it('never persists a tool call, only that one happened', async () => {
    const { port, headers, daemon } = await boot();
    const body = await (await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', messages: [{ role: 'user', content: 'weather in Denver?' }], tools }) })).json() as { id: string };
    const stored = daemon.store.db.prepare('SELECT type,data FROM run_events WHERE run_id=? AND type=?').all(body.id, 'tool_calls') as { type: string; data: string | null }[];
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0]!.data!)).toEqual({ redacted: true });
    expect(stored[0]!.data).not.toContain('get_weather');
  });

  it('offers tools through the console path, and resumes the run when the caller answers the call', async () => {
    const { port, headers } = await boot();
    const accepted = await (await fetch(`http://127.0.0.1:${port}/v1/runs`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', input: 'weather in Denver?', chat: { messages: [{ role: 'user', content: 'weather in Denver?' }], tools } }) })).json() as { id: string };
    const events: { type: string; data?: { toolCalls?: { id: string; function: { name: string } }[]; text?: string } }[] = [];
    const stream = await fetch(`http://127.0.0.1:${port}/v1/runs/${accepted.id}/events`, { headers });
    const reader = stream.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffered = '', answered = false;
    while (!events.some(event => event.type === 'completed')) {
      const { value, done } = await reader.read(); if (done) break;
      buffered += value;
      const frames = buffered.split('\n\n'); buffered = frames.pop() ?? '';
      for (const frame of frames) { const line = frame.split('\n').find(part => part.startsWith('data: ')); if (line) events.push(JSON.parse(line.slice(6))); }
      const call = events.find(event => event.type === 'tool_calls')?.data?.toolCalls?.[0];
      if (call && !answered) {
        answered = true;
        expect(call).toMatchObject({ function: { name: 'get_weather' } });
        const resumed = await fetch(`http://127.0.0.1:${port}/v1/runs/${accepted.id}/tool-results`, { method: 'POST', headers, body: JSON.stringify({ results: [{ toolCallId: call.id, output: 'sunny' }] }) });
        expect(resumed.status).toBe(202);
      }
    }
    await reader.cancel();
    expect(events.find(event => event.type === 'delta')?.data?.text).toContain('fake used get_weather: sunny');
  });

  /** The half Codex actually drives: the spawned server speaks MCP on stdio and every tool it publishes is the caller's, fetched over loopback. */
  it('serves MCP over stdio from the spawned bridge server', async () => {
    const { port, headers: _headers, daemon } = await boot();
    const calls: { id: string; function: { name: string } }[] = [];
    const session = daemon.bridge.open(tools as ChatTool[], call => { calls.push(call); setTimeout(() => daemon.bridge.settle(call.id, 'sunny'), 10); });
    const child = spawn(session.command, session.args, { env: { ...process.env, PATTY_BRIDGE_URL: `http://127.0.0.1:${port}`, PATTY_BRIDGE_TOKEN: session.token }, stdio: 'pipe' });
    const replies: Record<number, { result?: { tools?: { name: string }[]; content?: { text: string }[]; serverInfo?: { name: string } } }> = {};
    child.stdout.on('data', data => { for (const line of String(data).split('\n').filter(Boolean)) { const message = JSON.parse(line) as { id: number; result?: { tools?: { name: string }[]; content?: { text: string }[]; serverInfo?: { name: string } } }; replies[message.id] = message; } });
    const ask = async (id: number, method: string, params?: unknown) => { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`); for (let attempt = 0; attempt < 200 && !replies[id]; attempt++) await new Promise(resolve => setTimeout(resolve, 10)); return replies[id]!; };
    try {
      expect((await ask(1, 'initialize', { protocolVersion: '2024-11-05' })).result?.serverInfo?.name).toBe('patty');
      expect((await ask(2, 'tools/list')).result?.tools).toEqual([{ name: 'get_weather', description: 'current weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } }]);
      expect((await ask(3, 'tools/call', { name: 'get_weather', arguments: { city: 'Denver' } })).result?.content?.[0]?.text).toBe('sunny');
      expect(calls[0]).toMatchObject({ function: { name: 'get_weather' } });
      expect(JSON.parse((calls[0] as unknown as { function: { arguments: string } }).function.arguments)).toEqual({ city: 'Denver' });
    } finally { child.kill(); session.close(); }
  });

  it('refuses a tool result that does not belong to the run', async () => {
    const { port, headers } = await boot();
    const accepted = await (await fetch(`http://127.0.0.1:${port}/v1/runs`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', input: 'weather?', chat: { messages: [{ role: 'user', content: 'weather?' }], tools } }) })).json() as { id: string };
    const response = await fetch(`http://127.0.0.1:${port}/v1/runs/${accepted.id}/tool-results`, { method: 'POST', headers, body: JSON.stringify({ results: [{ toolCallId: 'call_someone_else', output: 'sunny' }] }) });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('invalid_request');
  });

  it('carries the caller’s tool result back into the same turn and answers with it', async () => {
    const { port, headers } = await boot();
    const messages: unknown[] = [{ role: 'user', content: 'weather in Denver?' }];
    const first = await (await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', messages, tools }) })).json() as { id: string; choices: { message: { tool_calls: { id: string; function: { name: string } }[] } }[] };
    const call = first.choices[0]!.message.tool_calls[0]!;
    messages.push({ role: 'assistant', content: null, tool_calls: first.choices[0]!.message.tool_calls }, { role: 'tool', tool_call_id: call.id, content: 'sunny, 21C' });
    const second = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', messages, tools }) });
    expect(second.status).toBe(200);
    const body = await second.json() as { id: string; choices: { finish_reason: string; message: { content: string } }[] };
    /** The same run, rejoined: the sub never lost the turn while the caller was running the function. */
    expect(body.id).toBe(first.id);
    expect(body.choices[0]!.finish_reason).toBe('stop');
    expect(body.choices[0]!.message.content).toBe('fake used get_weather: sunny, 21C');
  });

  it('publishes the caller’s tools to the bridge only with that turn’s token', async () => {
    const { port, headers, daemon } = await boot();
    const opened = daemon.bridge.open([{ type: 'function', function: { name: 'get_weather', description: 'current weather', parameters: { type: 'object', properties: {} } } }], () => undefined);
    const listed = await fetch(`http://127.0.0.1:${port}/internal/tool-bridge/tools`, { headers: { 'x-patty-bridge-token': opened.token } });
    expect((await listed.json() as { tools: { name: string }[] }).tools[0]).toMatchObject({ name: 'get_weather' });
    expect((await fetch(`http://127.0.0.1:${port}/internal/tool-bridge/tools`, { headers })).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/internal/tool-bridge/tools`, { headers: { 'x-patty-bridge-token': 'not-a-session' } })).status).toBe(400);
    /** The bridge is not a way into the rest of the daemon. */
    expect((await fetch(`http://127.0.0.1:${port}/internal/tool-bridge/../v1/usage`, { headers: { 'x-patty-bridge-token': opened.token } })).status).toBe(401);
    opened.close();
  });

  it('refuses a console tool run when no stacked sub supports tools', async () => {
    const { port, headers, daemon } = await boot();
    for (const account of daemon.store.accounts()) daemon.store.setCapabilities(account.id, ['filesystem']);
    const response = await fetch(`http://127.0.0.1:${port}/v1/runs`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', input: 'hi', chat: { messages: [{ role: 'user', content: 'hi' }], tools } }) });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: { code: string; retryable: boolean } }).error).toMatchObject({ code: 'model_unavailable', retryable: false });
  });
});

describe('structured output', () => {
  const schema = { type: 'object', properties: { company_name: { type: 'string' }, employee_count: { type: 'integer' }, remote: { type: 'boolean' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['company_name', 'employee_count', 'remote', 'tags'], additionalProperties: false };
  const responseFormat = { type: 'json_schema', json_schema: { name: 'company', strict: true, schema } };
  const boot = async () => { const daemon = new PattyDaemon(); daemon.addFakeAccount('codex-work'); server = await daemon.listen(); return { port: (server.address() as { port: number }).port, headers: { authorization: `Bearer ${daemon.key}`, 'content-type': 'application/json' } }; };

  it('answers a json_schema request with JSON in the caller’s shape rather than prose', async () => {
    const { port, headers } = await boot();
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', messages: [{ role: 'user', content: 'describe this company' }], response_format: responseFormat }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { choices: { message: { content: string } }[] };
    expect(JSON.parse(body.choices[0]!.message.content)).toEqual({ company_name: 'fake', employee_count: 0, remote: false, tags: ['fake'] });
  });

  it('streams the same JSON to a structured caller that asked for a stream', async () => {
    const { port, headers } = await boot();
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', messages: [{ role: 'user', content: 'describe' }], response_format: responseFormat, stream: true }) });
    const text = (await response.text()).split('\n\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => (JSON.parse(line.slice(6)) as { choices: { delta: { content?: string } }[] }).choices[0]!.delta.content ?? '').join('');
    expect(JSON.parse(text)).toMatchObject({ company_name: 'fake' });
  });

  it('carries a schema through /v1/runs and thread turns too', async () => {
    const { port, headers } = await boot();
    const run = await (await fetch(`http://127.0.0.1:${port}/v1/runs`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', input: 'describe', responseFormat }) })).json() as { id: string };
    await new Promise(resolve => setTimeout(resolve, 10));
    const events = await (await fetch(`http://127.0.0.1:${port}/v1/runs/${run.id}/events`, { headers })).text();
    expect(events).toContain('company_name');
    const thread = await (await fetch(`http://127.0.0.1:${port}/v1/threads`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex' }) })).json() as { threadId: string };
    expect((await fetch(`http://127.0.0.1:${port}/v1/threads/${thread.threadId}/turns`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', input: 'describe', responseFormat }) })).status).toBe(202);
  });

  it('refuses a malformed response_format instead of silently answering with prose', async () => {
    const { port, headers } = await boot();
    for (const format of [{ type: 'json_schema' }, { type: 'json_schema', json_schema: { name: 'x' } }, { type: 'json_schema', json_schema: { schema: [] } }, { type: 'yaml' }]) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', messages: [{ role: 'user', content: 'hi' }], response_format: format }) });
      expect(response.status, JSON.stringify(format)).toBe(400);
      expect((await response.json() as { error: { code: string } }).error.code).toBe('invalid_request');
    }
    const runs = await fetch(`http://127.0.0.1:${port}/v1/runs`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', input: 'hi', responseFormat: { type: 'json_schema' } }) });
    expect(runs.status).toBe(400);
  });

  it('forwards response_format verbatim to a stacked OpenAI-compatible sub', async () => {
    const daemon = new PattyDaemon();
    const sent: unknown[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      if (new URL(String(input)).pathname.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }] }), { headers: { 'content-type': 'application/json' } });
      sent.push(body?.response_format);
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"{\\"company_name\\":\\"Acme\\"}"}}]}\ndata: [DONE]\n')); controller.close(); } }));
    }) as unknown as typeof fetch;
    process.env.PATTY_TEST_PROVIDER_KEY = 'sk-not-a-real-key';
    await daemon.addOpenAiCompatibleAccount('together', 'https://api.example.invalid/v1', 'PATTY_TEST_PROVIDER_KEY', fetchImpl);
    server = await daemon.listen();
    const { port } = server.address() as { port: number };
    const body = await (await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${daemon.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], response_format: responseFormat }) })).json() as { choices: { message: { content: string } }[] };
    expect(sent[0]).toEqual(responseFormat);
    expect(JSON.parse(body.choices[0]!.message.content)).toEqual({ company_name: 'Acme' });
    delete process.env.PATTY_TEST_PROVIDER_KEY;
  });
});

describe('roles and per-turn knobs', () => {
  const boot = async () => { const daemon = new PattyDaemon(); daemon.addFakeAccount('codex-work'); server = await daemon.listen(); return { port: (server.address() as { port: number }).port, headers: { authorization: `Bearer ${daemon.key}`, 'content-type': 'application/json' } }; };
  const content = async (port: number, headers: Record<string, string>, body: Record<string, unknown>) => ((await (await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', ...body }) })).json()) as { choices: { message: { content: string } }[] }).choices[0]!.message.content;

  it('keeps the system prompt as the turn’s rules and the rest as the conversation', async () => {
    const { port, headers } = await boot();
    expect(await content(port, headers, { messages: [{ role: 'system', content: 'be terse' }, { role: 'developer', content: 'answer in French' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'salut' }, { role: 'user', content: 'again' }] }))
      .toBe('fake [instructions: be terse\n\nanswer in French]: user: hi\n\nassistant: salut\n\nuser: again');
  });

  it('carries reasoning effort and sampling knobs to the sub', async () => {
    const { port, headers } = await boot();
    expect(await content(port, headers, { messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'high', temperature: 0.2, top_p: 0.9, max_tokens: 256, stop: ['END'], seed: 7 }))
      .toBe('fake [effort: high; sampling: {"temperature":0.2,"topP":0.9,"maxOutputTokens":256,"stop":["END"],"seed":7}]: hi');
  });

  it('refuses knobs that are out of range instead of quietly reinterpreting them', async () => {
    const { port, headers } = await boot();
    for (const knobs of [{ temperature: 5 }, { top_p: 2 }, { max_tokens: 0 }, { seed: 1.5 }, { stop: ['a', 'b', 'c', 'd', 'e'] }, { reasoning_effort: 'VERY HIGH' }]) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', messages: [{ role: 'user', content: 'hi' }], ...knobs }) });
      expect(response.status, JSON.stringify(knobs)).toBe(400);
      expect((await response.json() as { error: { code: string } }).error.code).toBe('invalid_request');
    }
  });

  it('accepts the same knobs in Patty’s own run shape', async () => {
    const { port, headers } = await boot();
    const run = await (await fetch(`http://127.0.0.1:${port}/v1/runs`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', input: 'hi', instructions: 'be terse', reasoningEffort: 'low', sampling: { temperature: 0.1 } }) })).json() as { id: string };
    await new Promise(resolve => setTimeout(resolve, 10));
    const events = await (await fetch(`http://127.0.0.1:${port}/v1/runs/${run.id}/events`, { headers })).text();
    expect(events).toContain('instructions: be terse');
    expect(events).toContain('effort: low');
    expect((await fetch(`http://127.0.0.1:${port}/v1/runs`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', input: 'hi', sampling: { temperature: 9 } }) })).status).toBe(400);
  });

  it('forwards roles and knobs to a stacked OpenAI-compatible sub', async () => {
    const daemon = new PattyDaemon();
    const sent: Record<string, unknown>[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      if (new URL(String(input)).pathname.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }] }), { headers: { 'content-type': 'application/json' } });
      if (body) sent.push(body);
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\ndata: [DONE]\n')); controller.close(); } }));
    }) as unknown as typeof fetch;
    process.env.PATTY_TEST_PROVIDER_KEY = 'sk-not-a-real-key';
    await daemon.addOpenAiCompatibleAccount('together', 'https://api.example.invalid/v1', 'PATTY_TEST_PROVIDER_KEY', fetchImpl);
    server = await daemon.listen();
    const { port } = server.address() as { port: number };
    const messages = [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi' }];
    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${daemon.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o-mini', messages, reasoning_effort: 'medium', temperature: 0.3, top_p: 0.8, max_completion_tokens: 128, stop: 'END', seed: 3 }) });
    expect(sent[0]).toMatchObject({ messages, reasoning_effort: 'medium', temperature: 0.3, top_p: 0.8, max_tokens: 128, stop: ['END'], seed: 3 });
    delete process.env.PATTY_TEST_PROVIDER_KEY;
  });
});

describe('responses API', () => {
  const boot = async () => { const daemon = new PattyDaemon(); daemon.addFakeAccount('codex-work'); server = await daemon.listen(); return { port: (server.address() as { port: number }).port, headers: { authorization: `Bearer ${daemon.key}`, 'content-type': 'application/json' } }; };
  const post = (port: number, headers: Record<string, string>, body: Record<string, unknown>) => fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', ...body }) });
  type ResponseBody = { id: string; object: string; status: string; model: string; output: { type: string; call_id?: string; name?: string; content?: { type: string; text: string }[] }[]; output_text: string; usage?: { input_tokens: number; output_tokens: number; total_tokens: number } };

  it('answers a plain input with an output_text item and Responses-shaped usage', async () => {
    const { port, headers } = await boot();
    const response = await post(port, headers, { input: 'hi there' });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-patty-sub')).toBe('codex-work');
    const body = await response.json() as ResponseBody;
    expect(body).toMatchObject({ object: 'response', status: 'completed', model: 'gpt-5-codex', output_text: 'fake: hi there' });
    expect(body.output[0]).toMatchObject({ type: 'message', content: [{ type: 'output_text', text: 'fake: hi there' }] });
    expect(body.usage).toMatchObject({ input_tokens: expect.any(Number), output_tokens: expect.any(Number), total_tokens: expect.any(Number) });
  });

  it('keeps instructions as the turn’s rules and reads a list of input items', async () => {
    const { port, headers } = await boot();
    const body = await (await post(port, headers, { instructions: 'be terse', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }, { role: 'assistant', content: 'salut' }, { role: 'user', content: 'again' }], reasoning: { effort: 'high' }, max_output_tokens: 64 })).json() as ResponseBody;
    expect(body.output_text).toBe('fake [instructions: be terse; effort: high; sampling: {"maxOutputTokens":64}]: user: hi\n\nassistant: salut\n\nuser: again');
  });

  it('honours text.format json_schema the way response_format does', async () => {
    const { port, headers } = await boot();
    const body = await (await post(port, headers, { input: 'describe', text: { format: { type: 'json_schema', name: 'company', strict: true, schema: { type: 'object', additionalProperties: false, properties: { company_name: { type: 'string' } }, required: ['company_name'] } } } })).json() as ResponseBody;
    expect(JSON.parse(body.output_text)).toEqual({ company_name: 'fake' });
  });

  it('streams named response events, not opaque chunks', async () => {
    const { port, headers } = await boot();
    const raw = await (await post(port, headers, { input: 'hi there', stream: true })).text();
    const frames = raw.split('\n\n').filter(Boolean).map(frame => ({ event: frame.split('\n')[0]!.slice(7), data: JSON.parse(frame.split('\n')[1]!.slice(6)) as { sequence_number: number; delta?: string; response?: ResponseBody } }));
    expect(frames.map(frame => frame.event)).toEqual(['response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added', 'response.output_text.delta', 'response.output_text.done', 'response.content_part.done', 'response.output_item.done', 'response.completed']);
    expect(frames.map(frame => frame.data.sequence_number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(frames.find(frame => frame.event === 'response.output_text.delta')?.data.delta).toBe('fake: hi there');
    expect(frames.at(-1)!.data.response).toMatchObject({ status: 'completed', output_text: 'fake: hi there' });
  });

  it('runs a whole tool round trip in Responses items', async () => {
    const { port, headers } = await boot();
    const tools = [{ type: 'function', name: 'get_weather', description: 'current weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }];
    const first = await (await post(port, headers, { input: 'weather in Denver?', tools })).json() as ResponseBody;
    const call = first.output.find(item => item.type === 'function_call')!;
    expect(call).toMatchObject({ type: 'function_call', name: 'get_weather' });
    const second = await (await post(port, headers, { tools, input: [{ role: 'user', content: 'weather in Denver?' }, { type: 'function_call', call_id: call.call_id, name: 'get_weather', arguments: '{}' }, { type: 'function_call_output', call_id: call.call_id, output: 'sunny, 21C' }] })).json() as ResponseBody;
    /** The parked turn was rejoined, so the answer belongs to the same response the call came from. */
    expect(second.id).toBe(first.id);
    expect(second.output_text).toBe('fake used get_weather: sunny, 21C');
  });

  it('refuses a request with no model, and a hosted tool no stacked sub could run', async () => {
    const { port, headers } = await boot();
    expect((await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', headers, body: JSON.stringify({ input: 'hi' }) })).status).toBe(400);
    expect((await post(port, headers, { input: 'hi', tools: [{ type: 'web_search_preview' }] })).status).toBe(400);
  });
});

describe('model aliases', () => {
  const boot = async (aliases?: Record<string, string>) => {
    const daemon = new PattyDaemon();
    if (aliases) daemon.aliases = aliases;
    daemon.addFakeAccount('codex-work');
    server = await daemon.listen();
    return { daemon, port: (server.address() as { port: number }).port, headers: { authorization: `Bearer ${daemon.key}`, 'content-type': 'application/json' } };
  };
  const ask = async (port: number, headers: Record<string, string>, model: string) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }) });

  it('serves a model the stack has never heard of, and says which one answered', async () => {
    const { port, headers } = await boot({ 'gpt-5-nano': 'gpt-5-codex' });
    const response = await ask(port, headers, 'gpt-5-nano');
    expect(response.status).toBe(200);
    /** The answer names the model that actually ran, so a caller is never told a subscription served something it cannot serve. */
    expect((await response.json() as { model: string }).model).toBe('gpt-5-codex');
  });

  it('catches everything unmapped with * and refuses unmapped models without one', async () => {
    const caught = await boot({ '*': 'gpt-5-codex' });
    expect((await ask(caught.port, caught.headers, 'claude-3-5-sonnet')).status).toBe(200);
    const bare = await boot();
    const refused = await ask(bare.port, bare.headers, 'claude-3-5-sonnet');
    /** Without a mapping the name is left alone, so it fails as the honest “nothing here serves that” it is. */
    expect(refused.status).toBe(503);
    expect((await refused.json() as { error: { code: string } }).error.code).toBe('no_eligible_account');
  });

  it('never aliases over a model the stack actually serves', async () => {
    const { port, headers } = await boot({ 'gpt-5-codex': 'somewhere-else' });
    expect((await (await ask(port, headers, 'gpt-5-codex')).json() as { model: string }).model).toBe('gpt-5-codex');
  });

  it('lists an alias as a model of its own, naming who answers it', async () => {
    const { port, headers } = await boot({ 'gpt-5-nano': 'gpt-5-codex', '*': 'gpt-5-codex' });
    const listed = await (await fetch(`http://127.0.0.1:${port}/v1/models`, { headers })).json() as { data: { id: string; aliasOf?: string; subs: string[] }[] };
    expect(listed.data).toEqual([{ id: 'gpt-5-codex', object: 'model', owned_by: 'pattystack', subs: ['codex-work'] }, { id: 'gpt-5-nano', object: 'model', owned_by: 'pattystack', aliasOf: 'gpt-5-codex', subs: ['codex-work'] }]);
  });

  it('applies the alias on Patty’s own run shape too', async () => {
    const { port, headers } = await boot({ 'gpt-5-nano': 'gpt-5-codex' });
    const run = await (await fetch(`http://127.0.0.1:${port}/v1/runs`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-nano', input: 'hi' }) })).json() as { id: string };
    await new Promise(resolve => setTimeout(resolve, 20));
    const history = await (await fetch(`http://127.0.0.1:${port}/v1/runs`, { headers })).json() as { data: { runId: string; model: string }[] };
    expect(history.data.find(record => record.runId === run.id)?.model).toBe('gpt-5-codex');
  });
});

describe('lending a subscription to a caller that drives Codex itself', () => {
  it('hands out a short-lived credential, renews it, and takes the sub back on release', async () => {
    const daemon = new PattyDaemon(); const sub = daemon.addFakeAccount('lend'); server = await daemon.listen(); const port = (server.address() as { port: number }).port; const headers = { authorization: `Bearer ${daemon.key}`, 'content-type': 'application/json' };
    expect((await fetch(`http://127.0.0.1:${port}/v1/subscriptions/lease`, { method: 'POST', body: JSON.stringify({}) })).status).toBe(401);
    const response = await fetch(`http://127.0.0.1:${port}/v1/subscriptions/lease`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5-codex', ttlSeconds: 60, holder: 'puffle-agent' }) });
    expect(response.status).toBe(201);
    const lease = await response.json() as { id: string; alias: string; expiresAt: string; models: string[]; credential: { accessToken: string; chatgptAccountId: string; chatgptPlanType: string | null } };
    expect(lease).toMatchObject({ alias: 'lend', models: ['gpt-5-codex'], credential: { chatgptAccountId: 'fake-chatgpt-account', chatgptPlanType: 'plus' } });
    expect(lease.credential.accessToken).toMatch(/^fake-access-/);
    /** The sub is doing work Patty cannot see, so routing must already know it is busier than it looks. */
    expect(daemon.store.account(sub.id)?.activeRuns).toBe(1);
    const listed = await (await fetch(`http://127.0.0.1:${port}/v1/subscriptions/leases`, { headers })).json() as { data: { id: string; holder: string | null; credential?: unknown }[] };
    expect(listed.data).toHaveLength(1); expect(listed.data[0]).toMatchObject({ id: lease.id, holder: 'puffle-agent' }); expect(listed.data[0]).not.toHaveProperty('credential');
    const renewed = await (await fetch(`http://127.0.0.1:${port}/v1/subscriptions/leases/${lease.id}/renew`, { method: 'POST', headers, body: JSON.stringify({ ttlSeconds: 900 }) })).json() as { expiresAt: string; credential: { accessToken: string } };
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(lease.expiresAt));
    expect(renewed.credential.accessToken).not.toBe(lease.credential.accessToken);
    expect(await (await fetch(`http://127.0.0.1:${port}/metrics`, { headers })).text()).toContain('patty_sub_credential_leases{sub="lend"} 1');
    expect((await fetch(`http://127.0.0.1:${port}/v1/subscriptions/leases/${lease.id}`, { method: 'DELETE', headers })).status).toBe(204);
    expect(daemon.store.account(sub.id)?.activeRuns).toBe(0);
    expect((await fetch(`http://127.0.0.1:${port}/v1/subscriptions/leases/${lease.id}/renew`, { method: 'POST', headers, body: JSON.stringify({}) })).status).toBe(404);
  });
  it('spends a primary subscription before a fallback one and never lends an API key', async () => {
    const daemon = new PattyDaemon(); daemon.addFakeAccount('spillover', ['gpt-5-codex'], 1, 'fallback'); const primary = daemon.addFakeAccount('stacked'); server = await daemon.listen(); const port = (server.address() as { port: number }).port; const headers = { authorization: `Bearer ${daemon.key}`, 'content-type': 'application/json' };
    const lease = await (await fetch(`http://127.0.0.1:${port}/v1/subscriptions/lease`, { method: 'POST', headers, body: JSON.stringify({}) })).json() as { alias: string; accountId: string };
    expect(lease).toMatchObject({ alias: 'stacked', accountId: primary.id });
    process.env.PATTY_TEST_PROVIDER_KEY = 'sk-not-a-real-key';
    const models = (async () => new Response(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }] }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const keyOnly = new PattyDaemon(); await keyOnly.addOpenAiCompatibleAccount('byok', 'https://api.example.invalid/v1', 'PATTY_TEST_PROVIDER_KEY', models);
    /** An API key is not a subscription: there is nothing to lend, so the caller is told the stack is empty rather than handed the operator's key. */
    expect(keyOnly.leasable()).toEqual([]);
    await expect(keyOnly.leaseSubscription(60_000)).rejects.toThrow('no_eligible_account');
  });
  it('answers a lease request with a retryable 503 when every sub is out of quota', async () => {
    const daemon = new PattyDaemon(); const sub = daemon.addFakeAccount('dry'); daemon.store.exhaustQuota(sub.id); server = await daemon.listen(); const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/subscriptions/lease`, { method: 'POST', headers: { authorization: `Bearer ${daemon.key}`, 'content-type': 'application/json' }, body: JSON.stringify({}) });
    expect(response.status).toBe(503);
    expect(await response.json() as { error: { code: string; retryable: boolean } }).toMatchObject({ error: { code: 'no_eligible_account', retryable: true } });
  });
  it('never writes a lent token to the database or the audit log', async () => {
    const daemon = new PattyDaemon(); daemon.addFakeAccount('secret'); const lease = await daemon.leaseSubscription(60_000, undefined, 'holder');
    const dump = (daemon.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(table => JSON.stringify(daemon.store.db.prepare(`SELECT * FROM ${table.name}`).all())).join('');
    expect(lease.credential.accessToken).toMatch(/^fake-access-/);
    expect(dump).not.toContain(lease.credential.accessToken);
    expect(dump).not.toContain('fake-chatgpt-account');
  });
});

describe('reasoning traces on the OpenAI-compatible surface', () => {
  /** The reasoning notifications a real upstream sends: two thinking fragments, then the answer. */
  const thinkingUpstream = (): typeof fetch => (async (input: string | URL | Request) => new URL(String(input)).pathname.endsWith('/models')
    ? new Response(JSON.stringify({ data: [{ id: 'deepseek-reasoner' }] }), { headers: { 'content-type': 'application/json' } })
    : new Response(new ReadableStream({ start(controller) { for (const chunk of [
      'data: {"choices":[{"delta":{"reasoning_content":"the user said hi. "}}]}\n',
      'data: {"choices":[{"delta":{"reasoning_content":"i will greet them."}}]}\n',
      'data: {"choices":[{"delta":{"content":"hello!"}}]}\n',
      'data: {"usage":{"prompt_tokens":4,"completion_tokens":6,"total_tokens":10,"completion_tokens_details":{"reasoning_tokens":5}}}\n',
      'data: [DONE]\n',
    ]) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }))) as unknown as typeof fetch;
  const boot = async () => { const daemon = new PattyDaemon(); process.env.PATTY_TEST_PROVIDER_KEY = 'sk-not-a-real-key'; await daemon.addOpenAiCompatibleAccount('reasoner', 'https://api.example.invalid/v1', 'PATTY_TEST_PROVIDER_KEY', thinkingUpstream()); server = await daemon.listen(); return { daemon, port: (server.address() as { port: number }).port, headers: { authorization: `Bearer ${daemon.key}`, 'content-type': 'application/json' } }; };
  const chunksOf = (payload: string) => payload.split('\n\n').filter(frame => frame.startsWith('data: ')).map(frame => frame.slice(6)).filter(chunk => chunk !== '[DONE]').map(chunk => JSON.parse(chunk) as { choices: { delta: { content?: string; reasoning_content?: string } }[] });

  it('streams reasoning_content deltas beside the answer’s content deltas', async () => {
    const { port, headers } = await boot();
    const payload = await (await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'deepseek-reasoner', messages: [{ role: 'user', content: 'hi' }], stream: true }) })).text();
    const chunks = chunksOf(payload);
    expect(chunks.map(chunk => chunk.choices[0]?.delta.reasoning_content ?? '').join('')).toBe('the user said hi. i will greet them.');
    /** Thinking is not the answer: a client that only reads `content` sees exactly what it saw before. */
    expect(chunks.map(chunk => chunk.choices[0]?.delta.content ?? '').join('')).toBe('hello!');
    expect(chunks.filter(chunk => chunk.choices[0]?.delta.reasoning_content !== undefined).every(chunk => chunk.choices[0]?.delta.content === undefined)).toBe(true);
    delete process.env.PATTY_TEST_PROVIDER_KEY;
  });

  it('carries the accumulated reasoning on a non-streaming message and persists it redacted', async () => {
    const { daemon, port, headers } = await boot();
    const body = await (await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'deepseek-reasoner', messages: [{ role: 'user', content: 'hi' }] }) })).json() as { choices: { message: { content: string; reasoning_content?: string } }[]; usage: { completion_tokens_details: { reasoning_tokens: number } } };
    expect(body.choices[0]!.message).toEqual({ role: 'assistant', content: 'hello!', reasoning_content: 'the user said hi. i will greet them.' });
    expect(body.usage.completion_tokens_details.reasoning_tokens).toBe(5);
    const rows = daemon.store.db.prepare("SELECT data FROM run_events WHERE type='reasoning'").all() as { data: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(row => row.data === JSON.stringify({ redacted: true }))).toBe(true);
    const dump = (daemon.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(table => JSON.stringify(daemon.store.db.prepare(`SELECT * FROM ${table.name}`).all())).join('');
    expect(dump).not.toContain('i will greet them');
    delete process.env.PATTY_TEST_PROVIDER_KEY;
  });

  it('replays the reasoning so far to a subscriber that joins mid-turn', async () => {
    const { port, headers } = await boot();
    const { id } = await (await fetch(`http://127.0.0.1:${port}/v1/runs`, { method: 'POST', headers, body: JSON.stringify({ model: 'deepseek-reasoner', input: 'hi' }) })).json() as { id: string };
    await new Promise(resolve => setTimeout(resolve, 20));
    const frames = (await (await fetch(`http://127.0.0.1:${port}/v1/runs/${id}/events`, { headers })).text()).split('\n\n').map(frame => frame.split('\n').find(line => line.startsWith('data: '))).filter(Boolean).map(line => JSON.parse(line!.slice(6)) as { type: string; data?: { text?: string } });
    const reasoning = frames.filter(frame => frame.type === 'reasoning');
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]!.data?.text).toBe('the user said hi. i will greet them.');
    expect(frames.filter(frame => frame.type === 'delta').map(frame => frame.data?.text)).toEqual(['hello!']);
    delete process.env.PATTY_TEST_PROVIDER_KEY;
  });

  it('streams a reasoning summary delta on the Responses surface', async () => {
    const { port, headers } = await boot();
    const raw = await (await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', headers, body: JSON.stringify({ model: 'deepseek-reasoner', input: 'hi', stream: true }) })).text();
    const frames = raw.split('\n\n').filter(Boolean).map(frame => ({ event: frame.split('\n')[0]!.slice(7), data: JSON.parse(frame.split('\n')[1]!.slice(6)) as { delta?: string; summary_index?: number; item_id?: string } }));
    expect(frames.filter(frame => frame.event === 'response.reasoning_summary_text.delta').map(frame => frame.data.delta).join('')).toBe('the user said hi. i will greet them.');
    expect(frames.find(frame => frame.event === 'response.reasoning_summary_text.delta')?.data).toMatchObject({ summary_index: 0, output_index: 0 });
    expect(frames.find(frame => frame.event === 'response.output_text.delta')?.data.delta).toBe('hello!');
    expect(frames.at(-1)!.event).toBe('response.completed');
    delete process.env.PATTY_TEST_PROVIDER_KEY;
  });

  it('says nothing about reasoning on any surface when forwarding is switched off', async () => {
    process.env.PATTY_FORWARD_REASONING = '0';
    try {
      const { daemon, port, headers } = await boot();
      const payload = await (await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'deepseek-reasoner', messages: [{ role: 'user', content: 'hi' }], stream: true }) })).text();
      expect(payload).not.toContain('reasoning_content');
      expect(chunksOf(payload).map(chunk => chunk.choices[0]?.delta.content ?? '').join('')).toBe('hello!');
      expect(daemon.store.db.prepare("SELECT COUNT(*) AS n FROM run_events WHERE type='reasoning'").get()).toMatchObject({ n: 0 });
    } finally { delete process.env.PATTY_FORWARD_REASONING; delete process.env.PATTY_TEST_PROVIDER_KEY; }
  });
});
