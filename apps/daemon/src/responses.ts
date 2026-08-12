/**
 * OpenAI's Responses API, expressed in terms of the chat turn Patty already runs. Modern clients
 * (the OpenAI SDKs and the Vercel AI SDK among them) default to `/v1/responses`, so a stack that
 * only speaks `/v1/chat/completions` is unreachable to them without changing their code — which is
 * the one thing Patty is supposed to make unnecessary.
 */
import type { ChatToolCall, TokenUsage } from '@patty/contracts';
import { validateStrictSchema } from './schema-strict.js';

type Part = { type?: unknown; text?: unknown };
type InputItem = { type?: unknown; role?: unknown; content?: unknown; call_id?: unknown; name?: unknown; arguments?: unknown; output?: unknown };
export type ResponsesBody = {
  model?: unknown; input?: unknown; instructions?: unknown; stream?: unknown; tools?: unknown; tool_choice?: unknown;
  text?: { format?: { type?: unknown; name?: unknown; schema?: unknown; strict?: unknown; description?: unknown } };
  reasoning?: { effort?: unknown }; max_output_tokens?: unknown; temperature?: unknown; top_p?: unknown; seed?: unknown;
};
/** The chat body the rest of the daemon understands; every Responses request becomes one of these. */
export type ChatBody = { model?: unknown; messages?: unknown; stream?: unknown; tools?: unknown; tool_choice?: unknown; response_format?: unknown; reasoning_effort?: unknown; temperature?: unknown; top_p?: unknown; max_tokens?: unknown; max_completion_tokens?: unknown; stop?: unknown; seed?: unknown };

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(part => (typeof (part as Part)?.text === 'string' ? (part as { text: string }).text : '')).join('')
      : '';

/**
 * Responses items and chat messages carry the same conversation in different clothes: a
 * `function_call` item is an assistant turn holding one call, and a `function_call_output` item is
 * the `tool` message answering it — which is what lets a Responses caller resume a parked turn on
 * exactly the same machinery a chat caller uses.
 */
export function responsesToChat(body: ResponsesBody): ChatBody {
  if (typeof body.model !== 'string') throw new Error('invalid_request');
  const messages: Record<string, unknown>[] = [];
  if (typeof body.instructions === 'string' && body.instructions.trim()) messages.push({ role: 'system', content: body.instructions });
  const items: InputItem[] = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : Array.isArray(body.input) ? body.input as InputItem[] : [];
  if (typeof body.input !== 'string' && !Array.isArray(body.input)) throw new Error('invalid_request');
  for (const item of items) {
    if (item?.type === 'function_call') { messages.push({ role: 'assistant', content: null, tool_calls: [{ id: String(item.call_id ?? ''), type: 'function', function: { name: String(item.name ?? ''), arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}) } }] }); continue; }
    if (item?.type === 'function_call_output') { messages.push({ role: 'tool', tool_call_id: String(item.call_id ?? ''), content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '') }); continue; }
    const role = typeof item?.role === 'string' ? item.role : 'user';
    messages.push({ role, content: textOf(item?.content) });
  }
  const format = body.text?.format;
  /** Responses names the schema fields at the top of `text.format`; chat nests them under `json_schema`. */
  const responseFormat = format?.type === 'json_schema'
    ? (validateStrictSchema(format.schema as Record<string, unknown>, 'text.format.schema'),
      { type: 'json_schema', json_schema: { ...(typeof format.name === 'string' ? { name: format.name } : {}), ...(typeof format.description === 'string' ? { description: format.description } : {}), ...(typeof format.strict === 'boolean' ? { strict: format.strict } : {}), schema: format.schema as Record<string, unknown> } })
    : format?.type === undefined ? undefined : { type: format.type };
  /** Responses flattens the function onto the tool; chat keeps it nested. Hosted tools (web search and the like) are not something a stacked sub can run, so they are refused rather than dropped. */
  const tools = Array.isArray(body.tools) ? body.tools.map(tool => {
    const entry = tool as { type?: unknown; name?: unknown; description?: unknown; parameters?: unknown; function?: unknown };
    if (entry?.type !== 'function') throw new Error('invalid_request');
    if (entry.function) return entry;
    return { type: 'function', function: { name: entry.name, ...(entry.description === undefined ? {} : { description: entry.description }), ...(entry.parameters === undefined ? {} : { parameters: entry.parameters }) } };
  }) : undefined;
  return {
    model: body.model, messages, ...(body.stream === true ? { stream: true } : {}),
    ...(tools?.length ? { tools } : {}), ...(body.tool_choice !== undefined ? { tool_choice: body.tool_choice } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
    ...(body.reasoning?.effort !== undefined ? { reasoning_effort: body.reasoning.effort } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
    ...(body.max_output_tokens !== undefined ? { max_completion_tokens: body.max_output_tokens } : {}),
    ...(body.seed !== undefined ? { seed: body.seed } : {})
  };
}

export const responsesUsage = (usage?: TokenUsage) => usage && {
  input_tokens: usage.inputTokens, input_tokens_details: { cached_tokens: usage.cachedInputTokens },
  output_tokens: usage.outputTokens + usage.reasoningOutputTokens, output_tokens_details: { reasoning_tokens: usage.reasoningOutputTokens },
  total_tokens: usage.totalTokens
};

/** A response's `output` is a list of items rather than one message, so a turn that both spoke and called tools reports both. */
export function responsesOutput(text: string, calls?: ChatToolCall[]) {
  return [
    ...(text ? [{ type: 'message', id: `msg_${text.length.toString(36)}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }] : []),
    ...(calls ?? []).map((call, index) => ({ type: 'function_call', id: `fc_${index}`, call_id: call.id, name: call.function.name, arguments: call.function.arguments, status: 'completed' }))
  ];
}

export function responsesBody(runId: string, model: string, created: number, text: string, calls?: ChatToolCall[], usage?: TokenUsage) {
  return {
    /** A call the model made is an output item like any other: the response is complete, and it is the caller's move. */
    id: runId, object: 'response', created_at: created, model, status: 'completed',
    output: responsesOutput(text, calls), output_text: text,
    parallel_tool_calls: false, tool_choice: 'auto', tools: [], instructions: null, error: null, incomplete_details: null, metadata: {},
    ...(responsesUsage(usage) ? { usage: responsesUsage(usage) } : {})
  };
}
