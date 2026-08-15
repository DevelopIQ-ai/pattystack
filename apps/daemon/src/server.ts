import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Account, AccountTier, ChatResponseFormat, ChatTool, ChatToolCall, ChatTurn, ProviderAdapter, RunRequest, TokenUsage, TurnOptions, TurnSampling } from '@patty/contracts';
import { Coordinator, FakeAdapter, KeyLimiter, RateLimited, Router, Store, effectiveQuota, eligible, id, now, score, tiers } from './core.js';
import { CodexAppServerAdapter, SUPPORTED_CODEX_VERSIONS, codexVersionOf, codexVersionSupported, supportedCodexVersions } from './codex.js';
import { consoleHtml } from './ui.js';
import { chmodSync, mkdirSync, existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { OpenAiCompatibleAdapter } from './openai-provider.js';
import { ToolBridge } from './tool-bridge.js';
import { loadAliases, resolveModel } from './aliases.js';
import { failureDetail, logLine } from './log.js';
import { type ChatBody, type ResponsesBody, responsesBody, responsesToChat } from './responses.js';
import { InvalidSchemaError } from './schema-strict.js';
import { formatJsonSchema, getOriginalSchema, ORIGINAL_SCHEMA } from './schema-compat.js';
const json=async(req:IncomingMessage)=>{let data='';for await(const c of req)data+=c;return data?JSON.parse(data):{};};
const write=(res:ServerResponse,status:number,value:unknown,headers:Record<string,string>={})=>{res.writeHead(status,{'content-type':'application/json',...headers});res.end(JSON.stringify(value));};
/** Thrown errors that start with `invalid_request: ` carry a client-safe detail; bare `invalid_request` falls back to a generic phrase. */
const invalidRequestMessage=(error:unknown,fallback:string)=>{const message=(error as Error).message??'';if(message.startsWith('invalid_request: '))return message.slice('invalid_request: '.length);if(message&&message!=='invalid_request')return message;return fallback;};
const invalidSchemaResponse=(res:ServerResponse,error:InvalidSchemaError,requestId:string)=>write(res,400,{error:{type:'invalid_request_error',code:'invalid_json_schema',message:error.message,path:error.path,requestId,retryable:false}});
type ChatMessage={role?:unknown;content?:unknown};
/** A tool result the caller sends back, naming the call it answers. */
type ToolMessage=ChatMessage&{tool_call_id?:unknown};
/** OpenAI clients send structured messages; the app-server takes one text input, so the transcript is flattened. */
export function messageText(message:ChatMessage){const content=typeof message.content==='string'?message.content:Array.isArray(message.content)?message.content.map(part=>typeof (part as {text?:unknown})?.text==='string'?(part as {text:string}).text:'').join(''):'';return content.trim();}
export function flattenMessages(messages:ChatMessage[]){const parts=messages.map(message=>({role:typeof message.role==='string'?message.role:'user',content:messageText(message)})).filter(message=>message.content);if(parts.length===1&&parts[0]!.role==='user')return parts[0]!.content;return parts.map(message=>`${message.role}: ${message.content}`).join('\n\n');}
/**
 * Splits the transcript the way a provider needs it: the system and developer messages are the
 * rules for the turn, the rest is the conversation. Flattening them together tells a single-input
 * provider the words of the system prompt without telling it that they are the system prompt.
 */
export function splitConversation(messages:ChatMessage[]){const isRule=(message:ChatMessage)=>message.role==='system'||message.role==='developer';return {instructions:messages.filter(isRule).map(messageText).filter(Boolean).join('\n\n')||undefined,input:flattenMessages(messages.filter(message=>!isRule(message)))};}
/**
 * OpenAI's decoding knobs in provider-neutral names, validated here so an out-of-range value is
 * refused rather than silently reinterpreted by whichever sub happens to serve the run.
 */
export function parseSampling(body:{temperature?:unknown;top_p?:unknown;max_tokens?:unknown;max_completion_tokens?:unknown;stop?:unknown;seed?:unknown}):TurnSampling|undefined{
 const bounded=(value:unknown,low:number,high:number)=>{if(value===undefined||value===null)return undefined;if(typeof value!=='number'||!Number.isFinite(value)||value<low||value>high)throw new Error('invalid_request');return value;};
 const count=(value:unknown)=>{if(value===undefined||value===null)return undefined;if(typeof value!=='number'||!Number.isInteger(value)||value<1)throw new Error('invalid_request');return value;};
 const stops=(value:unknown)=>{if(value===undefined||value===null)return undefined;const list=typeof value==='string'?[value]:value;if(!Array.isArray(list)||list.length>4||list.some(entry=>typeof entry!=='string'||!entry))throw new Error('invalid_request');return list as string[];};
 const seed=(value:unknown)=>{if(value===undefined||value===null)return undefined;if(typeof value!=='number'||!Number.isInteger(value))throw new Error('invalid_request');return value;};
 const sampling:TurnSampling={...(bounded(body.temperature,0,2)!==undefined?{temperature:body.temperature as number}:{}),...(bounded(body.top_p,0,1)!==undefined?{topP:body.top_p as number}:{}),...(count(body.max_completion_tokens??body.max_tokens)!==undefined?{maxOutputTokens:(body.max_completion_tokens??body.max_tokens) as number}:{}),...(stops(body.stop)?{stop:stops(body.stop)!}:{}),...(seed(body.seed)!==undefined?{seed:body.seed as number}:{})};
 return Object.keys(sampling).length?sampling:undefined;}
/** Reasoning effort is a free-form string in the app-server protocol — whatever the model advertises — so it is length-checked rather than enumerated. */
export function parseReasoningEffort(value:unknown){if(value===undefined||value===null)return undefined;if(typeof value!=='string'||!/^[a-z][a-z0-9_-]{0,31}$/.test(value))throw new Error('invalid_request');return value;}
/** Patty's own run bodies carry the same knobs in camelCase, validated by the same rules as the OpenAI-shaped ones. */
export function parseRunOptions(body:RunRequest):TurnOptions{
 const given=body.sampling;
 const instructions=body.instructions;
 if(instructions!==undefined&&(typeof instructions!=='string'||!instructions.trim()))throw new Error('invalid_request');
 const sampling=parseSampling({temperature:given?.temperature,top_p:given?.topP,max_tokens:given?.maxOutputTokens,stop:given?.stop,seed:given?.seed});
 const reasoningEffort=parseReasoningEffort(body.reasoningEffort),responseFormat=parseResponseFormat(body.responseFormat);
 return {...(instructions?{instructions:instructions.trim()}:{}),...(reasoningEffort?{reasoningEffort}:{}),...(sampling?{sampling}:{}),...(responseFormat?{responseFormat}:{})};}
/** Provider counts, in OpenAI's shape. `reasoningOutputTokens` is billed as completion output, matching how OpenAI reports reasoning models. */
export function openaiUsage(usage?:TokenUsage){if(!usage)return undefined;return {prompt_tokens:usage.inputTokens,completion_tokens:usage.outputTokens+usage.reasoningOutputTokens,total_tokens:usage.totalTokens,prompt_tokens_details:{cached_tokens:usage.cachedInputTokens},completion_tokens_details:{reasoning_tokens:usage.reasoningOutputTokens}};}
/**
 * OpenAI's `response_format`, validated before it reaches a provider. A schema the caller mistyped
 * would otherwise be dropped silently and answered with prose, which is the one failure a
 * structured caller cannot see coming, so a malformed one is refused instead.
 */
export function parseResponseFormat(value:unknown):ChatResponseFormat|undefined{if(value===undefined||value===null)return undefined;const format=value as {type?:unknown;json_schema?:{name?:unknown;description?:unknown;schema?:unknown;strict?:unknown}};if(format.type==='text')return {type:'text'};if(format.type==='json_object')return {type:'json_object'};if(format.type!=='json_schema')throw new Error('invalid_request');const declared=format.json_schema;return formatJsonSchema(declared?.name,declared?.description,declared?.strict,declared?.schema) as ChatResponseFormat;}
/** Limits are replaced wholesale: an omitted or null field means unlimited, so a PUT is the key's complete policy. */
export function parseLimits(body:Record<string,unknown>){const one=(value:unknown)=>{if(value===undefined||value===null)return undefined;if(typeof value!=='number'||!Number.isFinite(value)||value<1)throw new Error('invalid_request');return Math.floor(value);};return {rpm:one(body.rpm),concurrency:one(body.concurrency)};}
/**
 * How long a sub is lent for. Short by default and capped by `PATTY_LEASE_MAX_SECONDS`, because a
 * lease is the one thing Patty cannot observe: the holder renews for as long as its work lasts, and
 * a holder that dies gives the sub back within the window instead of pinning it.
 */
export function leaseTtlMs(value:unknown,max=Number(process.env.PATTY_LEASE_MAX_SECONDS??3_600)){if(value===undefined||value===null)return 300_000;if(typeof value!=='number'||!Number.isFinite(value)||value<30)throw new Error('invalid_request');return Math.min(Math.floor(value),max)*1_000;}
/** Create or verify a private, owner-only directory without following a symlink. */
export function privateDirectory(path:string){mkdirSync(path,{recursive:true,mode:0o700});const entry=lstatSync(path);if(!entry.isDirectory()||entry.isSymbolicLink())throw new Error('unsafe_account_home');if(typeof process.getuid==='function'&&entry.uid!==process.getuid())throw new Error('unsafe_account_home');chmodSync(path,0o700);return realpathSync(path);}
export { logLine } from './log.js';


export function prometheus(samples:{name:string;help:string;type:'gauge'|'counter';values:{labels?:Record<string,string>;value:number}[]}[]){
 const label=(labels?:Record<string,string>)=>labels&&Object.keys(labels).length?`{${Object.entries(labels).map(([k,v])=>`${k}="${String(v).replace(/(["\\])/g,'\\$1')}"`).join(',')}}`:'';
 return samples.flatMap(sample=>[`# HELP ${sample.name} ${sample.help}`,`# TYPE ${sample.name} ${sample.type}`,...sample.values.map(entry=>`${sample.name}${label(entry.labels)} ${entry.value}`)]).join('\n')+'\n';
}

export class PattyDaemon { store:Store; router:Router; coordinator:Coordinator; limiter:KeyLimiter; adapters=new Map<string,ProviderAdapter>(); key:string|undefined; homes=new Map<string,string>();
 /** Where the tool bridge's spawned MCP server calls back; loopback, and only known once the daemon is listening. */
 bridgeUrl='http://127.0.0.1:3210'; readonly bridge=new ToolBridge(()=>this.bridgeUrl);
 /** The operator's answer to "who serves the model this app asks for?", so an app can be pointed at the stack unedited. */
 aliases=loadAliases();
 /** Which parked turn owes an answer to which tool call, so the caller's follow-up request rejoins the turn it left. */
 readonly parked=new Map<string,string>();
 constructor(path=':memory:'){this.store=new Store(path);this.store.reconcileWorkers();this.router=new Router(this.store);this.coordinator=new Coordinator(this.store,this.router,this.adapters);this.limiter=new KeyLimiter(keyId=>this.store.keyLimits(keyId));this.key=this.store.hasActiveKey()?undefined:this.store.issueKey().key;}
 /** Holds a request against its key's limits before it is routed, answering 429 only once queueing cannot help. Returns undefined when the response has already been written. */
 async admit(keyId:string,res:ServerResponse,requestId:string){try{return await this.limiter.acquire(keyId);}catch(error){if(!(error instanceof RateLimited))throw error;write(res,429,{error:{code:'rate_limited',message:'this API key is over its limit; retry shortly',requestId,retryable:true,retryAfterMs:error.retryAfterMs}},{'retry-after':String(Math.max(1,Math.ceil(error.retryAfterMs/1000)))});return undefined;}}
 /** A key's slot is held for the whole run, not just the HTTP response, so a concurrency cap means runs in flight rather than sockets open. */
 releaseWhenSettled(runId:string,release:()=>void){void this.coordinator.collect(runId).then(release,release);}
 supervise(accountId:string,adapter:ProviderAdapter){if(adapter instanceof CodexAppServerAdapter)adapter.on('exit',()=>this.coordinator.failAccount(accountId));this.adapters.set(accountId,adapter);}
 addFakeAccount(alias:string,models=['gpt-5-codex'],remaining=1,tier:AccountTier='primary'){const existing=this.store.accounts().find(account=>account.alias===alias);if(existing){existing.state='ready';this.store.updateAccount(existing);this.supervise(existing.id,new FakeAdapter(existing.models,existing.quota,undefined,this.bridge));return existing;}const account:Account={id:id('acct'),alias,state:'ready',models,quota:{remaining,observedAt:now()},health:1,activeRuns:0,tier};this.store.addAccount(account);this.store.setCapabilities(account.id,['filesystem','shell','tools']);this.supervise(account.id,new FakeAdapter(models,account.quota,undefined,this.bridge));return account;}
 /** Stacks any OpenAI-compatible endpoint next to the Codex subs. The secret stays in the operator's
  * environment: Patty persists only the variable name, so the store never holds a provider key. */
 async addOpenAiCompatibleAccount(alias:string,baseUrl:string,apiKeyEnv:string,fetchImpl?:typeof fetch,tier:AccountTier='fallback'){
  if(!/^[a-z0-9-]{1,64}$/i.test(alias))throw new Error('invalid_request');
  const existing=this.store.accounts().find(account=>account.alias===alias&&account.state!=='removed');
  if(existing)throw new Error('invalid_request');
  const adapter=new OpenAiCompatibleAdapter({baseUrl,apiKeyEnv,fetch:fetchImpl});
  const snapshot=await adapter.snapshot();
  const account:Account={id:id('acct'),alias,state:'ready',models:snapshot.models,quota:snapshot.quota,health:1,activeRuns:0,tier};
  this.store.addAccount(account);
  this.store.setCapabilities(account.id,['chat',...(snapshot.capabilities??[])]);
  this.store.setProviderConfig(account.id,'openai_compatible',{baseUrl,apiKeyEnv,tier});
  this.supervise(account.id,adapter);
  return account;
 }
 /** The Codex CLI to supervise; the adapter still refuses to speak to a version Patty was not built against. */
 liveCodexCommand(){return process.env.PATTY_CODEX_COMMAND??'codex';}
 /** Re-attach app-server workers to subs that were already logged in before a restart. */
 /** Re-attaches OpenAI-compatible subs after a restart; the key is re-read from the environment, never from the store. */
 async restoreOpenAiCompatibleAccounts(){const restored:Account[]=[];for(const record of this.store.providerConfigs()){if(record.kind!=='openai_compatible')continue;const account=this.store.account(record.accountId);if(!account||account.state==='removed'||this.adapters.has(account.id))continue;this.supervise(account.id,new OpenAiCompatibleAdapter({baseUrl:record.config.baseUrl!,apiKeyEnv:record.config.apiKeyEnv!}));account.state='ready';this.store.updateAccount(account);restored.push(account);}return restored;}
 async restoreCodexAccounts(){
  const command=this.liveCodexCommand();
  const root=process.env.PATTY_ACCOUNT_HOME_ROOT??'.patty/accounts';
  const restored:Account[]=[];
  const work:(()=>Promise<void>)[]=[];
  for(const account of this.store.accounts()){
    if(account.state==='removed'||this.adapters.has(account.id))continue;
    const home=join(root,account.alias);
    if(!existsSync(home))continue;
    work.push(async()=>{
      const adapter=new CodexAppServerAdapter(command,['app-server'],privateDirectory(home),SUPPORTED_CODEX_VERSIONS.min,undefined,this.bridge);
      this.homes.set(account.id,home);
      this.supervise(account.id,adapter);
      try{
        await adapter.start();
        await adapter.identityFingerprint();
        restored.push(await this.refreshAccount(account.id));
      }catch(error){
        await adapter.shutdown().catch(()=>undefined);
        this.adapters.delete(account.id);
        this.homes.delete(account.id);
        /** A sub that silently sits in reconnect_required looks like an empty stack; the reason is the only way an operator learns the login is fine and the CLI is not. */
        logLine({event:'sub_restore_failed',sub:account.alias,reason:(error as Error).message});
        account.state='reconnect_required';
        this.store.updateAccount(account);
      }
    });
  }
  const concurrency=Math.max(1,Math.min(Number(process.env.PATTY_RESTORE_CONCURRENCY)||3,10));
  let index=0;
  const workers=Array.from({length:concurrency},async()=>{while(index<work.length){const task=work[index++];if(!task)break;await task();}});
  await Promise.all(workers);
  return restored;
}
 async addCodexAccount(alias:string,mode:'browser'|'device_code'){const command=this.liveCodexCommand();if(!/^[a-z0-9-]{1,64}$/i.test(alias))throw new Error('invalid_request');if(this.store.accounts().some(account=>account.alias===alias))throw new Error('invalid_request');const root=privateDirectory(process.env.PATTY_ACCOUNT_HOME_ROOT??'.patty/accounts');const home=privateDirectory(join(root,alias));const adapter=new CodexAppServerAdapter(command,['app-server'],home,SUPPORTED_CODEX_VERSIONS.min,undefined,this.bridge);const account:Account={id:id('acct'),alias,tier:'primary',state:'pending_login',models:[],quota:{observedAt:now()},health:1,activeRuns:0};this.store.addAccount(account);this.homes.set(account.id,home);this.supervise(account.id,adapter);try{await adapter.start();const challenge=await adapter.login(mode);return {id:account.id,...challenge};}catch(error){this.adapters.delete(account.id);this.homes.delete(account.id);rmSync(home,{recursive:true,force:true});this.store.deleteAccountCascade(account.id);throw error;}}
 /**
  * A revoked ChatGPT login is not a new sub: the alias, its history and its isolated home all still
  * stand, only the credential inside them is dead. Stacking it again is refused as a duplicate
  * alias, so re-login drives the same home through the login flow the sub was created with.
  */
 async reloginCodexAccount(aliasOrId:string,mode:'browser'|'device_code'){
  const account=this.store.accounts().find(candidate=>candidate.state!=='removed'&&(candidate.id===aliasOrId||candidate.alias===aliasOrId));
  if(!account)throw new Error('invalid_request');
  let adapter=this.adapters.get(account.id);
  if(!(adapter instanceof CodexAppServerAdapter)){
   if(adapter)throw new Error('invalid_request');
   const home=privateDirectory(join(process.env.PATTY_ACCOUNT_HOME_ROOT??'.patty/accounts',account.alias));
   adapter=new CodexAppServerAdapter(this.liveCodexCommand(),['app-server'],home,SUPPORTED_CODEX_VERSIONS.min,undefined,this.bridge);
   this.homes.set(account.id,home);
   this.supervise(account.id,adapter);
   await (adapter as CodexAppServerAdapter).start();
  }
  const challenge=await (adapter as CodexAppServerAdapter).login(mode);
  account.state='pending_login';
  this.store.updateAccount(account);
  logLine({event:'sub_relogin_started',sub:account.alias,mode});
  return {id:account.id,alias:account.alias,...challenge};
 }
 async refreshAccount(accountId:string){const account=this.store.account(accountId);const adapter=this.adapters.get(accountId);if(!account||!adapter)throw new Error('invalid_request');const snapshot=await adapter.snapshot();account.models=snapshot.models;account.quota=snapshot.quota;this.store.setCapabilities(accountId,snapshot.capabilities??[]);account.state='ready';this.store.updateAccount(account);return account;}
 async removeAccount(accountId:string){const account=this.store.account(accountId);const adapter=this.adapters.get(accountId);if(!account)throw new Error('invalid_request');account.state='draining';this.store.updateAccount(account);try{await adapter?.logout();}finally{await adapter?.shutdown();this.adapters.delete(accountId);account.state='removed';this.store.updateAccount(account);const home=this.homes.get(accountId);if(home){rmSync(home,{recursive:true,force:true});this.homes.delete(accountId);}}}

 /**
  * Subs that can be lent rather than called. An agent that drives Codex itself — its own threads,
  * tools and streaming — cannot be served by an OpenAI-shaped endpoint, so it borrows a
  * subscription instead of an answer. Only a Codex login has one to lend; an API-key sub has none.
  */
 leasable(model?:string,at=Date.now()){return this.store.accounts().filter(a=>Boolean(this.adapters.get(a.id)?.credential)&&eligible(a,{model:model??a.models[0]??'',input:''},undefined,at)).sort((x,y)=>tiers.indexOf(x.tier)-tiers.indexOf(y.tier)||score(y,'lease',at)-score(x,'lease',at));}
 /** The same tier order routing uses, so a lease spends the stacked subscriptions before anything metered. */
 async leaseSubscription(ttlMs:number,model?:string,holder?:string,apiKeyId?:string){
  for(const account of this.leasable(model)){
   let lease;try{lease=this.store.openCredentialLease(account.id,ttlMs,holder,apiKeyId);}catch{continue;}
   /** A sub whose token cannot be minted is not lendable, so its slot goes back and the next sub is tried instead of failing the caller. */
   try{return {...lease,credential:await this.adapters.get(account.id)!.credential!()};}catch{this.store.releaseCredentialLease(lease.id);logLine({event:'lease_mint_failed',sub:account.alias});}}
  throw new Error('no_eligible_account');}
 /** Renewing re-mints the token as well as extending the loan, because the caller's Codex process needs a live one for the turns it is still running. */
 async renewLease(leaseId:string,ttlMs:number){const held=this.store.credentialLease(leaseId);if(!held)return undefined;const credential=await this.adapters.get(held.accountId)?.credential?.();if(!credential)throw new Error('credential_unavailable');const renewed=this.store.renewCredentialLease(leaseId,ttlMs);return renewed&&{...renewed,credential};}
 alias(runId:string){const record=this.store.publicRun(runId);return record?this.store.account(record.accountId)?.alias:undefined;}
 /** Every model name a caller may ask for is resolved once, at the edge, so routing, metering and the answer all name the model that actually ran. */
 resolveModel(model:string){return resolveModel(model,this.aliases,candidate=>this.store.accounts().some(account=>account.state!=='removed'&&account.models.includes(candidate)));}
 toolsServable(model:string){return this.store.accounts().some(account=>account.state!=='removed'&&account.models.includes(model)&&this.store.supports(account.id,['tools']));}
 /** OpenAI-compatible chat completions, so any OpenAI client can drive the stack with `OPENAI_BASE_URL`. Routing, metering and failover are the same ones `/v1/runs` uses; `x-patty-sub` names the sub that served the request. */
 async chatCompletions(req:IncomingMessage,res:ServerResponse,requestId:string,apiKeyId:string,release:()=>void){return this.complete(await json(req) as ChatBody,res,requestId,apiKeyId,release,'chat');}
 /** The Responses API, which is what a current OpenAI or AI SDK client reaches for by default. It is a translation, not a second engine: the request becomes the same chat turn and only the answer is dressed differently. */
 async responses(req:IncomingMessage,res:ServerResponse,requestId:string,apiKeyId:string,release:()=>void){let body:ChatBody;
  try{body=responsesToChat(await json(req) as ResponsesBody);}catch(error){release();if(error instanceof InvalidSchemaError)return invalidSchemaResponse(res,error,requestId);return write(res,400,{error:{code:'invalid_request',message:invalidRequestMessage(error,'model and input required; only function tools are supported'),requestId,retryable:false}});}
  return this.complete(body,res,requestId,apiKeyId,release,'responses');}
 async complete(body:ChatBody,res:ServerResponse,requestId:string,apiKeyId:string,release:()=>void,shape:'chat'|'responses'){
  if(typeof body.model!=='string'||!Array.isArray(body.messages)){release();return write(res,400,{error:{code:'invalid_request',message:'model and messages required',requestId,retryable:false}});}
  const tools=Array.isArray(body.tools)?body.tools as ChatTool[]:undefined;
  if(tools?.some(tool=>tool?.type!=='function'||typeof tool.function?.name!=='string')){release();return write(res,400,{error:{code:'invalid_request',message:'each tool needs type "function" and function.name',requestId,retryable:false}});}
  const {instructions,input}=splitConversation(body.messages as ChatMessage[]);
  /** A tool round trip can carry no prose at all — an assistant turn of pure `tool_calls` answered by a `tool` message — so text is only mandatory when there are no tools. */
  if(!input&&!tools?.length){release();return write(res,400,{error:{code:'invalid_request',message:'messages must contain text content',requestId,retryable:false}});}
  const model=this.resolveModel(body.model);
  /** Only a sub whose provider honours tools may serve a request offering them, and "nobody here can" is a permanent answer worth stating plainly instead of a routing failure the caller would retry. */
  if(tools?.length&&!this.toolsServable(model)){release();return write(res,400,{error:{code:'model_unavailable',message:`no stacked sub can serve tool calls for ${model}; stack an OpenAI-compatible sub to use tools`,requestId,retryable:false}});}
  /** The verbatim messages always travel with the turn, so a provider that speaks roles keeps them and only a single-input provider falls back to the flattened prompt. */
  const chat:ChatTurn={messages:body.messages,...(tools?.length?{tools}:{}),...(tools?.length&&body.tool_choice!==undefined?{toolChoice:body.tool_choice as ChatTurn['toolChoice']}:{})};
  let responseFormat:ChatResponseFormat|undefined;try{responseFormat=parseResponseFormat(body.response_format);}catch(error){release();if(error instanceof InvalidSchemaError)return invalidSchemaResponse(res,error,requestId);return write(res,400,{error:{code:'invalid_request',message:invalidRequestMessage(error,'response_format must be text, json_object, or json_schema with a schema object'),requestId,retryable:false}});}
  let knobs:{reasoningEffort?:string;sampling?:TurnSampling};try{knobs={...(parseReasoningEffort(body.reasoning_effort)?{reasoningEffort:parseReasoningEffort(body.reasoning_effort)!}:{}),...(parseSampling(body)?{sampling:parseSampling(body)!}:{})};}catch{release();return write(res,400,{error:{code:'invalid_request',message:'temperature, top_p, max_tokens, stop, seed and reasoning_effort must be in range',requestId,retryable:false}});}
  /** A turn parked on one of these calls is still open on its sub, so answering it means rejoining that run rather than starting a new one and losing everything the model has done so far. */
  const resumed=this.resumeParkedRun(body.messages as ToolMessage[]);
  const stream=body.stream===true;
  if(resumed){release();return shape==='chat'?this.answer(res,resumed,model,stream,requestId,false):this.answerResponses(res,resumed,model,stream,requestId,false);}
  const runId=await this.coordinator.start({model,input,chat,...(tools?.length?{capabilities:['tools']}:{}),...(instructions?{instructions}:{}),...(responseFormat?{responseFormat}:{}),...knobs},apiKeyId);
  this.releaseWhenSettled(runId,release);
  return shape==='chat'?this.answer(res,runId,model,stream,requestId,true):this.answerResponses(res,runId,model,stream,requestId,true);
 }
 /** Remembers which run owes an answer to each call the caller is about to be handed, so the reply can find its turn again. */
 park(runId:string,result:{status:string;toolCalls?:ChatToolCall[]}){const calls=result.toolCalls;if(result.status==='awaiting_tools')for(const call of calls??[]){
  /** A caller that walks away from a call would otherwise leave its id here forever, so the oldest are dropped once the map is implausibly large. */
  if(this.parked.size>=10_000)this.parked.delete(this.parked.keys().next().value!);this.parked.set(call.id,runId);}
  return calls;}
 /** Hands the caller's tool results to the turn that is waiting for them, and names that turn. */
 resumeParkedRun(messages:ToolMessage[]){let runId:string|undefined;
  for(const message of messages){if(message?.role!=='tool'||typeof message.tool_call_id!=='string')continue;const parked=this.parked.get(message.tool_call_id);if(!parked)continue;this.parked.delete(message.tool_call_id);if(this.bridge.settle(message.tool_call_id,messageText(message)))runId=parked;}
  return runId;}
 /** One OpenAI-shaped answer for a run, whether it was just started or rejoined after a tool round trip. */
 async answer(res:ServerResponse,runId:string,model:string,stream:boolean,requestId:string,seed:boolean){const created=Math.floor(Date.now()/1000);
  /** Failover can move a run to another sub before output starts, so the routed sub is only known once the answer is in hand. */
  const headers=()=>({'x-patty-run':runId,...(this.alias(runId)?{'x-patty-sub':this.alias(runId)!}:{})});
  if(!stream){const result=await this.coordinator.collect(runId,undefined,undefined,seed);
   if(result.status!=='completed'&&result.status!=='awaiting_tools')return write(res,502,{error:{code:'upstream_failed',message:`run ${result.status}`,requestId,retryable:true}},headers());
   const calls=this.park(runId,result);
   let finalText=result.text;
   if(!calls?.length){try{finalText=this.coordinator.finalizeOutput(runId,result.text,result.status);}catch{return write(res,502,{error:{code:'upstream_failed',message:'output did not match the requested schema',requestId,retryable:true}},headers());}}
   return write(res,200,{id:runId,object:'chat.completion',created,model,choices:[{index:0,message:{role:'assistant',content:calls?.length?null:finalText,...(result.reasoning?{reasoning_content:result.reasoning}:{}),...(calls?.length?{tool_calls:calls}:{})},finish_reason:calls?.length?'tool_calls':'stop'}],...(openaiUsage(result.usage)?{usage:openaiUsage(result.usage)}:{})},headers());
  }
  const chunk=(value:unknown)=>res.write(`data: ${JSON.stringify(value)}\n\n`);
  const delta=(value:Record<string,unknown>,finish:string|null=null,usage?:TokenUsage)=>chunk({id:runId,object:'chat.completion.chunk',created,model,choices:[{index:0,delta:value,finish_reason:finish}],...(usage&&openaiUsage(usage)?{usage:openaiUsage(usage)}:{})});
  const begin=()=>{if(res.headersSent)return;res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache',connection:'keep-alive',...headers()});delta({role:'assistant',content:''});};
  /** Thinking travels in its own key on the same chunk shape DeepSeek, vLLM and OpenRouter use, so a client that renders a reasoning block reads it and one that does not sees an unchanged stream. */
  const result=await this.coordinator.collect(runId,text=>{begin();delta({content:text});},undefined,seed,text=>{begin();delta({reasoning_content:text});});
  begin();
  const streamed=this.park(runId,result);
  if(result.status==='completed'||result.status==='awaiting_tools'){if(streamed?.length)delta({tool_calls:streamed.map((call,index)=>({index,...call}))});delta({},streamed?.length?'tool_calls':'stop',result.usage);}
  else chunk({error:{code:'upstream_failed',message:`run ${result.status}`,requestId,retryable:true}});
  res.write('data: [DONE]\n\n');res.end();
 }
 /** The same run, told as a Responses API answer. Streaming is a named-event protocol rather than opaque chunks, so a client can follow the message being built. */
 async answerResponses(res:ServerResponse,runId:string,model:string,stream:boolean,requestId:string,seed:boolean){const created=Math.floor(Date.now()/1000);
  const headers=()=>({'x-patty-run':runId,...(this.alias(runId)?{'x-patty-sub':this.alias(runId)!}:{})});
  if(!stream){const result=await this.coordinator.collect(runId,undefined,undefined,seed);
   if(result.status!=='completed'&&result.status!=='awaiting_tools')return write(res,502,{error:{code:'upstream_failed',message:`run ${result.status}`,requestId,retryable:true}},headers());
   const calls=this.park(runId,result);
   let finalText=result.text;
   if(!calls?.length){try{finalText=this.coordinator.finalizeOutput(runId,result.text,result.status);}catch{return write(res,502,{error:{code:'upstream_failed',message:'output did not match the requested schema',requestId,retryable:true}},headers());}}
   return write(res,200,responsesBody(runId,model,created,calls?.length?'':finalText,calls,result.usage),headers());
  }
  let sequence=0,text='';const item='msg_0',reasoningItem='rs_0';
  const event=(type:string,payload:Record<string,unknown>)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,sequence_number:sequence++,...payload})}\n\n`);
  const begin=()=>{if(res.headersSent)return;res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache',connection:'keep-alive',...headers()});
   event('response.created',{response:responsesBody(runId,model,created,'')});
   event('response.in_progress',{response:responsesBody(runId,model,created,'')});
   event('response.output_item.added',{output_index:0,item:{type:'message',id:item,status:'in_progress',role:'assistant',content:[]}});
   event('response.content_part.added',{item_id:item,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});};
  const result=await this.coordinator.collect(runId,chunk=>{begin();text+=chunk;event('response.output_text.delta',{item_id:item,output_index:0,content_index:0,delta:chunk});},undefined,seed,chunk=>{begin();event('response.reasoning_summary_text.delta',{item_id:reasoningItem,output_index:0,summary_index:0,delta:chunk});});
  begin();
  const calls=this.park(runId,result);
  if(result.status==='completed'||result.status==='awaiting_tools'){
   event('response.output_text.done',{item_id:item,output_index:0,content_index:0,text});
   event('response.content_part.done',{item_id:item,output_index:0,content_index:0,part:{type:'output_text',text,annotations:[]}});
   event('response.output_item.done',{output_index:0,item:{type:'message',id:item,status:'completed',role:'assistant',content:[{type:'output_text',text,annotations:[]}]}});
   (calls??[]).forEach((call,index)=>event('response.output_item.done',{output_index:index+1,item:{type:'function_call',id:`fc_${index}`,call_id:call.id,name:call.function.name,arguments:call.function.arguments,status:'completed'}}));
   event('response.completed',{response:responsesBody(runId,model,created,text,calls,result.usage)});
  } else event('response.failed',{response:{...responsesBody(runId,model,created,text),status:'failed',error:{code:'upstream_failed',message:`run ${result.status}`}}});
  res.end();
 }
 async handler(req:IncomingMessage,res:ServerResponse){const requestId=randomUUID();const startedAt=Date.now();res.once('finish',()=>logLine({event:'request',requestId,method:req.method,path:(req.url??'/').split('?')[0],status:res.statusCode,ms:Date.now()-startedAt,sub:res.getHeader('x-patty-sub')??undefined,run:res.getHeader('x-patty-run')??undefined}));try {const url=new URL(req.url??'/', 'http://localhost');if(req.method==='GET'&&(url.pathname==='/'||url.pathname==='/ui')){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'"});res.end(consoleHtml);return;} if(url.pathname==='/healthz'){if(req.method!=='GET')return write(res,405,{error:{code:'invalid_request',message:'method not allowed',requestId,retryable:false}});return write(res,200,{ok:true});} /** The tool bridge's own loopback callback: it is the MCP server Codex spawned, not a caller, so it presents its one-turn session token instead of a Patty key and can reach nothing else. */
 if(url.pathname.startsWith('/internal/tool-bridge/')){const token=req.headers['x-patty-bridge-token'];if(typeof token!=='string')return write(res,401,{error:{code:'unauthorized',message:'bridge token required',requestId,retryable:false}});
  try{if(req.method==='GET'&&url.pathname==='/internal/tool-bridge/tools')return write(res,200,{tools:this.bridge.list(token)});
   if(req.method==='POST'&&url.pathname==='/internal/tool-bridge/call'){const call=await json(req) as {name?:unknown;arguments?:unknown};if(typeof call.name!=='string')throw new Error('invalid_request');return write(res,200,{output:await this.bridge.call(token,call.name,call.arguments)});}}
  catch(error){return write(res,400,{error:{code:'invalid_request',message:(error as Error).message,requestId,retryable:false}});}
  return write(res,404,{error:{code:'invalid_request',message:'route not found',requestId,retryable:false}});}
 const presented=req.headers.authorization?.replace('Bearer ','');const caller=presented?this.store.verifyKey(presented):undefined;if(!caller)return write(res,401,{error:{code:'unauthorized',message:'valid Patty API key required',requestId,retryable:false}});if(req.method==='DELETE'&&/^\/v1\/api-keys\/[^/]+$/.test(url.pathname)){this.store.revokeKey(url.pathname.split('/').at(-1)!);return write(res,204,{});}if(req.method==='POST'&&url.pathname==='/v1/accounts/openai-compatible'){const body=await json(req) as {alias?:string;baseUrl?:string;apiKeyEnv?:string;tier?:string};if(!body.alias||!body.baseUrl||!body.apiKeyEnv)throw new Error('invalid_request');if(body.tier!==undefined&&body.tier!=='primary'&&body.tier!=='fallback')throw new Error('invalid_request');return write(res,201,await this.addOpenAiCompatibleAccount(body.alias,body.baseUrl,body.apiKeyEnv,undefined,body.tier??'fallback'));}if(req.method==='POST'&&url.pathname==='/v1/accounts/codex/login'){const body=await json(req) as {alias?:string;mode?:'browser'|'device_code'};if(!body.alias)throw new Error('invalid_request');return write(res,202,await this.addCodexAccount(body.alias,body.mode??'browser'));}const accountAction=/^\/v1\/accounts\/([^/]+)(\/refresh|\/login\/cancel|\/relogin)?$/.exec(url.pathname);if(accountAction){const accountId=accountAction[1]!;if(accountAction[2]==='/refresh'&&req.method==='POST')return write(res,200,await this.refreshAccount(accountId));if(accountAction[2]==='/relogin'&&req.method==='POST'){const body=await json(req) as {mode?:'browser'|'device_code'};return write(res,202,await this.reloginCodexAccount(accountId,body.mode??'browser'));}if(accountAction[2]==='/login/cancel'&&req.method==='POST'){await this.adapters.get(accountId)?.cancelLogin();return write(res,202,{id:accountId,status:'cancelled'});}if(!accountAction[2]&&req.method==='DELETE'){await this.removeAccount(accountId);return write(res,204,{});}};if(req.method==='POST'&&url.pathname==='/v1/subscriptions/lease'){const body=await json(req) as {model?:unknown;ttlSeconds?:unknown;holder?:unknown};if(body.model!==undefined&&typeof body.model!=='string')throw new Error('invalid_request');if(body.holder!==undefined&&typeof body.holder!=='string')throw new Error('invalid_request');return write(res,201,await this.leaseSubscription(leaseTtlMs(body.ttlSeconds),body.model,typeof body.holder==='string'?body.holder.slice(0,128):undefined,caller.id));}if(req.method==='GET'&&url.pathname==='/v1/subscriptions/leases')return write(res,200,{data:this.store.credentialLeases()});const leaseAction=/^\/v1\/subscriptions\/leases\/([^/]+)(\/renew)?$/.exec(url.pathname);if(leaseAction){const leaseId=leaseAction[1]!;if(leaseAction[2]==='/renew'&&req.method==='POST'){const body=await json(req) as {ttlSeconds?:unknown};const renewed=await this.renewLease(leaseId,leaseTtlMs(body.ttlSeconds));return renewed?write(res,200,renewed):write(res,404,{error:{code:'invalid_request',message:'lease not found or expired',requestId,retryable:false}});}if(!leaseAction[2]&&req.method==='DELETE'){this.store.releaseCredentialLease(leaseId);return write(res,204,{});}if(!leaseAction[2]&&req.method==='GET'){const held=this.store.credentialLease(leaseId);return held?write(res,200,held):write(res,404,{error:{code:'invalid_request',message:'lease not found or expired',requestId,retryable:false}});}return write(res,405,{error:{code:'invalid_request',message:'method not allowed',requestId,retryable:false}});}if(req.method==='GET'&&url.pathname==='/v1/accounts')return write(res,200,{data:this.store.accounts().filter(a=>a.state!=='removed').map(({quota,...a})=>({...a,quota}))});if(req.method==='GET'&&url.pathname==='/v1/usage')return write(res,200,{data:this.store.usageReport()});if(req.method==='GET'&&url.pathname==='/v1/models'){const subs=this.store.accounts().filter(a=>a.state!=='removed');const models=[...new Set(subs.flatMap(a=>a.models))];/** An aliased name is listed as a model in its own right, because to the client asking for it that is exactly what it is; `aliasOf` says who actually answers. */
  const aliased=Object.entries(this.aliases).filter(([from])=>from!=='*'&&!models.includes(from)).map(([from,to])=>({id:from,object:'model',owned_by:'pattystack',aliasOf:to,subs:subs.filter(a=>a.models.includes(to)).map(a=>a.alias)}));
  return write(res,200,{object:'list',data:[...models.map(model=>({id:model,object:'model',owned_by:'pattystack',subs:subs.filter(a=>a.models.includes(model)).map(a=>a.alias)})),...aliased]});}if(req.method==='GET'&&url.pathname==='/v1/router/status'){const at=Date.now();const model=url.searchParams.get('model')??undefined;return write(res,200,{data:this.store.accounts().filter(a=>a.state!=='removed').map(a=>({alias:a.alias,tier:a.tier,state:a.state,ready:a.state==='ready',eligible:model?eligible(a,{model,input:''},undefined,at):a.state==='ready',
    /** Quota and cooldown decide servability regardless of the model asked about, so a console with no model filter still shows which subs are actually parked. */
    servable:eligible(a,{model:a.models[0]??'',input:''},undefined,at),quotaRemaining:a.quota.remaining,effectiveQuota:effectiveQuota(a,at),resetAt:a.quota.resetAt,resetsInMs:a.quota.resetAt?Math.max(0,Date.parse(a.quota.resetAt)-at):undefined,health:a.health,activeRuns:a.activeRuns,cooldownUntil:a.cooldownUntil,score:Number(score(a,'status',at).toFixed(4))})).sort((x,y)=>tiers.indexOf(x.tier)-tiers.indexOf(y.tier)||y.score-x.score)});}if(req.method==='GET'&&url.pathname==='/metrics'){res.writeHead(200,{'content-type':'text/plain; version=0.0.4; charset=utf-8','cache-control':'no-store'});res.end(this.metrics());return;}if(req.method==='GET'&&url.pathname==='/v1/doctor')return write(res,200,{data:await this.doctor()});if(req.method==='GET'&&url.pathname==='/v1/runs')return write(res,200,{data:this.store.runHistory({alias:url.searchParams.get('sub')??undefined,model:url.searchParams.get('model')??undefined,status:url.searchParams.get('status')??undefined,keyId:url.searchParams.get('keyId')??undefined,since:url.searchParams.get('since')??undefined,limit:url.searchParams.has('limit')?Number(url.searchParams.get('limit')):undefined})});if(req.method==='GET'&&url.pathname==='/v1/api-keys')return write(res,200,{data:this.store.keys().map(({scopes,rpm,concurrency,...key})=>({...key,scopes:JSON.parse(scopes) as string[],rpm:rpm??null,concurrency:concurrency??null,...this.limiter.pressure(key.id)})),queue:{maxDepth:this.limiter.maxQueue,maxWaitMs:this.limiter.maxWaitMs}});if(req.method==='POST'&&url.pathname==='/v1/api-keys'){const body=await json(req) as {name?:unknown;rpm?:unknown;concurrency?:unknown};const issued=this.store.issueKey(typeof body.name==='string'&&body.name.trim()?body.name.trim():undefined);const limits=parseLimits(body);if(limits.rpm!==undefined||limits.concurrency!==undefined)this.store.setKeyLimits(issued.id,limits);return write(res,201,{...issued,...this.store.keyLimits(issued.id),warning:'secret shown once; store it securely'});}const keyLimits=/^\/v1\/api-keys\/([^/]+)\/limits$/.exec(url.pathname);if(keyLimits&&req.method==='PUT'){this.store.setKeyLimits(keyLimits[1]!,parseLimits(await json(req) as Record<string,unknown>));return write(res,200,{id:keyLimits[1]!,...this.store.keyLimits(keyLimits[1]!)});}if(req.method==='POST'&&url.pathname==='/v1/threads'){const body=await json(req) as {model?:string;accountId?:string;instructions?:string};if(!body.model)throw new Error('invalid_request');/** Instructions given at thread creation are the thread's standing rules, so every later turn inherits them without resending. */const threadOptions=parseRunOptions({model:body.model,input:'',...(body.instructions!==undefined?{instructions:body.instructions}:{})});return write(res,201,await this.coordinator.createThread(body.model,body.accountId,Object.keys(threadOptions).length?threadOptions:undefined));}const turns=/^\/v1\/threads\/([^/]+)\/turns$/.exec(url.pathname);if(turns){if(req.method!=='POST')return write(res,405,{error:{code:'invalid_request',message:'method not allowed',requestId,retryable:false}});const body=await json(req) as RunRequest;if(!body.model||typeof body.input!=='string'||!body.input)return write(res,400,{error:{code:'invalid_request',message:'model and non-empty input required',requestId,retryable:false}});const turnOverrides=parseRunOptions(body);const turnRelease=await this.admit(caller.id,res,requestId);if(!turnRelease)return;let turnId:string;try{turnId=await this.coordinator.start({...body,model:this.resolveModel(body.model),threadId:turns[1],...turnOverrides},caller.id);}catch(error){turnRelease();throw error;}this.releaseWhenSettled(turnId,turnRelease);return write(res,202,{id:turnId,events:`/v1/runs/${turnId}/events`});}if(req.method==='POST'&&url.pathname==='/v1/chat/completions'){const release=await this.admit(caller.id,res,requestId);if(!release)return;try{return await this.chatCompletions(req,res,requestId,caller.id,release);}catch(error){release();throw error;}}if(req.method==='POST'&&url.pathname==='/v1/responses'){const release=await this.admit(caller.id,res,requestId);if(!release)return;try{return await this.responses(req,res,requestId,caller.id,release);}catch(error){release();throw error;}}if(req.method==='POST'&&url.pathname==='/v1/runs'){const body=await json(req) as RunRequest; if(!body.model||typeof body.input!=='string')throw new Error('invalid_request');body.model=this.resolveModel(body.model);const offered=body.chat?.tools;if(offered?.length){if(offered.some(tool=>tool?.type!=='function'||typeof tool.function?.name!=='string'))throw new Error('invalid_request');
   /** Same permanent answer the OpenAI-compatible route gives: a request offering tools is only routable to a sub whose provider honours them. */
   if(!this.toolsServable(body.model))return write(res,400,{error:{code:'model_unavailable',message:`no stacked sub can serve tool calls for ${body.model}; stack an OpenAI-compatible sub to use tools`,requestId,retryable:false}});}const request:RunRequest={...body,...(offered?.length?{capabilities:['tools']}:{}),...parseRunOptions(body)};const release=await this.admit(caller.id,res,requestId);if(!release)return;let runId:string;try{runId=await this.coordinator.start(request,caller.id);}catch(error){release();throw error;}this.releaseWhenSettled(runId,release);return write(res,202,{id:runId,events:`/v1/runs/${runId}/events`});}/** The native counterpart of an OpenAI tool-result message: a run parked on the caller's function is resumed by answering the call, and the run's event stream simply carries on. */
 const toolResults=/^\/v1\/runs\/([^/]+)\/tool-results$/.exec(url.pathname);if(toolResults&&req.method==='POST'){const body=await json(req) as {results?:{toolCallId?:unknown;output?:unknown}[]};if(!Array.isArray(body.results)||!body.results.length)throw new Error('invalid_request');
  const settled=body.results.filter(result=>{if(typeof result?.toolCallId!=='string'||typeof result.output!=='string')throw new Error('invalid_request');/** Only the run that made the call may answer it, so a stray id cannot resume somebody else's turn. */if(!this.coordinator.liveCalls(toolResults[1]!)?.some(call=>call.id===result.toolCallId))throw new Error('invalid_request');this.parked.delete(result.toolCallId);return this.bridge.settle(result.toolCallId,result.output);});
  if(!settled.length)throw new Error('invalid_request');this.coordinator.awaitingTools.delete(toolResults[1]!);return write(res,202,{id:toolResults[1],accepted:settled.length,events:`/v1/runs/${toolResults[1]}/events`});}
 const approval=/^\/v1\/runs\/([^/]+)\/approvals\/([^/]+)$/.exec(url.pathname);if(approval&&req.method==='POST'){const body=await json(req) as {approved?:unknown};if(typeof body.approved!=='boolean')throw new Error('invalid_request');await this.coordinator.approve(approval[1]!,approval[2]!,body.approved);return write(res,202,{id:approval[1]!,approvalId:approval[2]!});}const match=/^\/v1\/runs\/([^/]+)(\/events|\/cancel)?$/.exec(url.pathname);if(match){const runId=match[1]!;if(match[2]==='/cancel'){if(req.method!=='POST')return write(res,405,{error:{code:'invalid_request',message:'method not allowed',requestId,retryable:false}});const current=this.store.publicRun(runId);if(!current)return write(res,404,{error:{code:'invalid_request',message:'run not found',requestId,retryable:false}});if(current.status!=='running')return write(res,409,current);this.coordinator.cancel(runId);return write(res,202,{id:runId,status:'cancelled'});}if(match[2]==='/events'){if(req.method!=='GET')return write(res,405,{error:{code:'invalid_request',message:'method not allowed',requestId,retryable:false}});if(!this.store.run(runId))return write(res,404,{error:{code:'invalid_request',message:'run not found',requestId,retryable:false}});res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'});let sequence=0;let closed=false;const cleanup=()=>{if(closed)return;closed=true;clearInterval(beat);this.coordinator.off(runId,listener);};const listener=(event:unknown,eventId?:number)=>{if(closed)return;sequence=eventId??sequence+1;const ok=res.write(`id: ${sequence}\nevent: patty\ndata: ${JSON.stringify(event)}\n\n`);if(!ok){cleanup();res.end();return;}const type=(event as {type?:string}).type;if(type==='completed'||type==='failed'||type==='cancelled'){cleanup();res.end();}};const beat=setInterval(()=>{if(!res.write(': heartbeat\n\n')){cleanup();res.end();}},15_000);const after=Number(req.headers['last-event-id']??0);const live=this.coordinator.liveText(runId);const liveCalls=this.coordinator.liveCalls(runId);const liveReasoning=this.coordinator.liveReasoning(runId);let replayedText=false;let replayedReasoning=false;for(const item of this.coordinator.eventItems(runId,Number.isFinite(after)?after:0)){if(item.event.type==='delta'&&live!==undefined){if(replayedText)continue;replayedText=true;listener({...item.event,data:{text:live}},item.sequence);continue;}if(item.event.type==='reasoning'&&liveReasoning!==undefined){if(replayedReasoning)continue;replayedReasoning=true;listener({...item.event,data:{text:liveReasoning}},item.sequence);continue;}
   /** A tool call is persisted redacted, so a subscriber that arrived after the provider answered would replay `{redacted:true}`; the live buffer holds the real calls for as long as the turn does. */
   if(item.event.type==='tool_calls'&&liveCalls?.length){listener({...item.event,data:{toolCalls:liveCalls}},item.sequence);continue;}
   listener(item.event,item.sequence);}if(!closed)this.coordinator.on(runId,listener);req.on('close',cleanup);return;}if(!match[2]&&req.method==='GET'){const record=this.store.publicRun(runId);return record?write(res,200,record):write(res,404,{error:{code:'invalid_request',message:'run not found',requestId,retryable:false}});}return write(res,405,{error:{code:'invalid_request',message:'method not allowed',requestId,retryable:false}});}return write(res,404,{error:{code:'invalid_request',message:'route not found',requestId,retryable:false}});}catch(e){if(e instanceof InvalidSchemaError)return invalidSchemaResponse(res,e,requestId);const message=(e as Error).message??'';const code=message==='idempotency_conflict'?'idempotency_conflict':message==='no_eligible_account'?'no_eligible_account':'invalid_request';
  /** Nothing servable right now is a capacity condition, not a malformed request: a client should back off and retry, so it gets a 503 with Retry-After rather than a 400 it would treat as fatal. */
  if(code==='no_eligible_account')return write(res,503,{error:{code,message:'no sub can serve this request right now; every eligible sub is busy, cooling down or out of quota',requestId,retryable:true,retryAfterMs:5_000}},{'retry-after':'5'});
  return write(res,400,{error:{code,message:invalidRequestMessage(e,'invalid request'),requestId,retryable:false}});}}
 metrics(){const at=Date.now();const subs=this.store.accounts().filter(a=>a.state!=='removed');const leases=this.store.credentialLeases();const report=this.store.usageReport();const bySub=(pick:(entry:typeof report.accounts[number])=>number)=>report.accounts.map(entry=>({labels:{sub:entry.alias},value:pick(entry)}));
  return prometheus([
   {name:'patty_subs',help:'Stacked subs by state.',type:'gauge',values:Object.entries(subs.reduce<Record<string,number>>((totals,a)=>({...totals,[a.state]:(totals[a.state]??0)+1}),{})).map(([state,value])=>({labels:{state},value}))},
   {name:'patty_sub_quota_remaining',help:'Effective remaining quota fraction, counting a rolled-over window as full.',type:'gauge',values:subs.map(a=>({labels:{sub:a.alias,tier:a.tier},value:effectiveQuota(a,at)}))},
   {name:'patty_sub_servable',help:'1 when the sub can take the next request, so spillover to a fallback sub is visible in a dashboard.',type:'gauge',values:subs.map(a=>({labels:{sub:a.alias,tier:a.tier},value:eligible(a,{model:a.models[0]??'',input:''},undefined,at)?1:0}))},
   {name:'patty_sub_quota_reset_seconds',help:'Seconds until the sub quota window resets.',type:'gauge',values:subs.filter(a=>a.quota.resetAt).map(a=>({labels:{sub:a.alias},value:Math.max(0,Math.round((Date.parse(a.quota.resetAt!)-at)/1000))}))},
   {name:'patty_sub_health',help:'Router health score per sub.',type:'gauge',values:subs.map(a=>({labels:{sub:a.alias},value:a.health}))},
   {name:'patty_sub_active_runs',help:'In-flight runs per sub.',type:'gauge',values:subs.map(a=>({labels:{sub:a.alias},value:a.activeRuns}))},
   /** Turns run under a lease are the sub's work that Patty never sees, so the count of live loans is the only place they show up at all. */
   {name:'patty_sub_credential_leases',help:'Live credential leases per sub; turns run under a lease are not metered by Patty.',type:'gauge',values:subs.map(a=>({labels:{sub:a.alias},value:leases.filter(lease=>lease.accountId===a.id).length}))},
   {name:'patty_runs_total',help:'Runs by terminal status.',type:'counter',values:this.store.runCounts().map(row=>({labels:{status:row.status},value:row.runs}))},
   {name:'patty_run_attempts_total',help:'Routing attempts by reason, including failover.',type:'counter',values:this.store.failoverCounts().map(row=>({labels:{reason:row.reason},value:row.attempts}))},
   {name:'patty_tokens_total',help:'Provider-reported tokens per sub.',type:'counter',values:[...bySub(entry=>entry.inputTokens).map(entry=>({labels:{...entry.labels,direction:'input'},value:entry.value})),...bySub(entry=>entry.outputTokens).map(entry=>({labels:{...entry.labels,direction:'output'},value:entry.value}))]},
   {name:'patty_key_tokens_total',help:'Provider-reported tokens per API key.',type:'counter',values:report.keys.map(entry=>({labels:{key:entry.name??entry.keyId??'unattributed'},value:entry.totalTokens}))},
   /** Cached input is a subset of `patty_tokens_total{direction="input"}`, so it is its own series rather than a third direction that would double-count input when the directions are summed. */
   {name:'patty_cached_input_tokens_total',help:'Provider-reported cached input tokens per sub, a subset of the input direction.',type:'counter',values:bySub(entry=>entry.cachedInputTokens)},
   /** A sub with no measured input has no hit rate, and reporting 0 would make a dashboard alert on a cache that was never asked anything. */
   {name:'patty_cache_hit_ratio',help:'Cached share of provider-reported input tokens per sub; absent until the sub has served a metered run.',type:'gauge',values:report.accounts.filter(entry=>entry.cacheHitRate!==null).map(entry=>({labels:{sub:entry.alias},value:entry.cacheHitRate!}))},
   /** Dollars are estimated from local prices, and a `primary` sub's figure is money the subscription absorbed rather than money spent, so the tier label is the part that makes the number mean anything. */
   {name:'patty_estimated_cost_usd_total',help:'Estimated USD at local list prices for the tokens each sub served; primary is absorbed by a subscription, fallback is real API spend.',type:'counter',values:report.accounts.map(entry=>({labels:{sub:entry.alias,tier:entry.tier},value:entry.cost.estimatedCostUsd}))},
   {name:'patty_unpriced_runs',help:'Measured runs whose model has no local price, so they are missing from the cost estimate.',type:'gauge',values:[{labels:{},value:report.cost.unpricedRuns}]},
   ...(()=>{const pressure=this.limiter.report(this.store.keys().filter(key=>!key.revoked_at).map(key=>({id:key.id,name:key.name})));const gauge=(name:string,help:string,pick:(entry:typeof pressure[number])=>number|undefined)=>({name,help,type:'gauge' as const,values:pressure.filter(entry=>pick(entry)!==undefined).map(entry=>({labels:{key:entry.name??entry.keyId},value:pick(entry)!}))});
    return [gauge('patty_key_in_flight','Runs in flight per API key, which is what a concurrency limit caps.',entry=>entry.inFlight),gauge('patty_key_queued','Requests waiting for a slot on their API key.',entry=>entry.queued),{...gauge('patty_key_throttled_total','Requests answered 429 because queueing could not satisfy the key limit.',entry=>entry.throttled),type:'counter' as const},gauge('patty_key_limit_rpm','Configured requests-per-minute limit; absent when the key is unlimited.',entry=>entry.rpm),gauge('patty_key_limit_concurrency','Configured concurrent-run limit; absent when the key is unlimited.',entry=>entry.concurrency)];})(),
  ]);}
 /** Answers the only question a stuck operator has: is anything able to serve a request, and if not, why not. */
 /** Reports the Codex CLI Patty would supervise, so `doctor` says "no Codex CLI" instead of a sub failing to start later. */
 codexCliVersion(){try{return execFileSync(this.liveCodexCommand(),['--version'],{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:5_000}).trim()||undefined;}catch{return undefined;}}
 /**
  * Asks every stored sub for a live snapshot, because a credential is only proven by using it: a
  * subscription whose ChatGPT login was revoked while the daemon ran keeps its `ready` state, its
  * discovered models and its last quota reading, and fails every run with nothing else to show.
  */
 async credentials(timeoutMs=Number(process.env.PATTY_DOCTOR_PROBE_MS??15_000)){
  const subs=this.store.accounts().filter(account=>account.state!=='removed');
  return Promise.all(subs.map(async account=>{
   const adapter=this.adapters.get(account.id);
   if(!adapter)return {alias:account.alias,ok:false,reason:'no worker is attached; restart Patty to restore the sub'};
   try{
    await Promise.race([adapter.snapshot(),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('probe_timed_out')),timeoutMs);timer.unref?.();})]);
    return {alias:account.alias,ok:true};
   }catch(error){return {alias:account.alias,ok:false,reason:failureDetail(error)};}
  }));
 }
 async doctor(){const at=Date.now();const credentials=await this.credentials();const dead=credentials.filter(probe=>!probe.ok);const codexVersion=this.codexCliVersion();const codexSpeakable=codexVersion!==undefined&&codexVersionSupported(codexVersion);const codexLabel=codexVersion===undefined?undefined:codexVersionOf(codexVersion)??codexVersion;const subs=this.store.accounts().filter(a=>a.state!=='removed');const models=[...new Set(subs.flatMap(a=>a.models))];
  const servable=subs.filter(a=>models.some(model=>eligible(a,{model,input:''},undefined,at)));
  const checks=[
   {check:'subs_stacked',ok:subs.length>0,detail:`${subs.length} sub(s) stored`,hint:subs.length?undefined:'stack one with `patty accounts add <alias>`, or start with --fake=<alias> to try it offline'},
   {check:'subs_servable',ok:servable.length>0,detail:servable.length?`${servable.map(a=>a.alias).join(', ')} can serve a request now`:'no sub is currently eligible',hint:servable.length?undefined:'check quota windows and cooldowns in /v1/router/status'},
   {check:'models_discovered',ok:models.length>0,detail:models.length?`${models.length} model(s): ${models.join(', ')}`:'no models discovered',hint:models.length?undefined:'refresh a sub to discover its models'},
   {check:'codex_cli',ok:codexSpeakable,detail:codexLabel?codexSpeakable?`Codex CLI ${codexLabel}`:`Codex CLI ${codexLabel} speaks a protocol Patty does not; every Codex sub fails to start`:`no usable Codex CLI at \`${this.liveCodexCommand()}\``,hint:codexSpeakable?undefined:codexVersion?`install ${supportedCodexVersions()}, or set PATTY_CODEX_VERSION=<version> once you have verified this release`:'install the Codex CLI, or set PATTY_CODEX_COMMAND to its path; --fake subs work without it'},
   {check:'subs_authenticated',ok:dead.length===0,detail:credentials.length?dead.length?`${dead.map(probe=>`${probe.alias}: ${probe.reason}`).join('; ')}`:`${credentials.length} sub(s) answered a live provider call`:'no sub to authenticate',hint:dead.length?'the credential itself is refused, so re-login that sub with `patty accounts relogin <alias>`':undefined},
   {check:'active_keys',ok:this.store.keys().some(key=>!key.revoked_at),detail:`${this.store.keys().filter(key=>!key.revoked_at).length} active key(s)`,hint:undefined},
   {check:'store_writable',ok:(()=>{try{this.store.db.prepare('SELECT 1').get();return true}catch{return false}})(),detail:'store readable',hint:undefined},
  ];
  /** A missing Codex CLI is worth reporting but is not ill health: a stack of OpenAI-compatible or fake subs serves requests without one. A CLI that is present and unspeakable is, because every Codex login on the box is dead until it is fixed. */
  return {ok:checks.every(check=>check.ok||(check.check==='codex_cli'&&codexVersion===undefined)),checks:checks.map(({hint,...check})=>({...check,...(hint?{hint}:{})}))};}
 async shutdown(){await this.coordinator.shutdown();}
 /** Loopback stays the default and the only unguarded option: a non-loopback bind exposes stacked
  * subscriptions to the network, so it requires an explicit opt-in and never a wildcard address. */
 static assertBindable(host:string,optedIn=process.env.PATTY_ALLOW_NON_LOOPBACK==='1'){
  if(host==='127.0.0.1'||host==='::1'||host==='localhost')return;
  if(!optedIn)throw new Error(`refusing to bind ${host}: loopback is the default; set PATTY_ALLOW_NON_LOOPBACK=1 to expose Patty on a trusted network`);
  if(host==='0.0.0.0'||host==='::'||host==='')throw new Error('refusing to bind a wildcard address: name the exact interface (for example your tailnet address)');
 }
 listen(port=0,host='127.0.0.1'){PattyDaemon.assertBindable(host);const server=createServer(this.handler.bind(this));return new Promise<typeof server>(resolve=>server.listen(port,host,()=>{const address=server.address();if(address&&typeof address==='object')this.bridgeUrl=`http://127.0.0.1:${address.port}`;resolve(server);}));}
}
