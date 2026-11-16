import Anthropic from '@anthropic-ai/sdk';
import { log } from './log.js';

export const PROVIDER = (process.env.LLM_PROVIDER || 'anthropic').trim().toLowerCase();
const DEFAULT_MODELS = { anthropic: 'claude-sonnet-5-5', openai: 'gpt-5.4' };
export const MODEL = (process.env.AGENT_MODEL || DEFAULT_MODELS[PROVIDER] || '').trim();
const MAX_OUTPUT_TOKENS = 16000;

export class BudgetError extends Error {}

/** Returns a human-readable problem with the LLM env config, or null if it looks usable. */
export function checkLlmConfig() {
  if (PROVIDER === 'anthropic') {
    return process.env.ANTHROPIC_API_KEY ? null : 'ANTHROPIC_API_KEY is not set.';
  }
  if (PROVIDER === 'openai') {
    if (!process.env.OPENAI_API_KEY) return 'OPENAI_API_KEY is not set.';
    if (!MODEL) return 'AGENT_MODEL is not set.';
    return null;
  }
  return `Unknown LLM_PROVIDER "${PROVIDER}". Use "anthropic" or "openai".`;
}

/*
 * Provider adapters. Each keeps the conversation in its own wire format and
 * exposes the same small interface to the agent loop:
 *   turn()             -> { text, calls: [{ id, name, input }], usage: { input_tokens, output_tokens } }
 *   addUser(text)      -> append a plain user message
 *   addToolResults(rs) -> append [{ id, content, isError }]
 */

function anthropicAdapter({ system, prompt, schemas }) {
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    ...(process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL.trim() } : {}),
  });
  const messages = [{ role: 'user', content: prompt }];
  return {
    async turn() {
      const res = await client.messages.create({ model: MODEL, max_tokens: MAX_OUTPUT_TOKENS, system, tools: schemas, messages });
      messages.push({ role: 'assistant', content: res.content });
      return {
        text: res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
        calls: res.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input })),
        usage: res.usage,
      };
    },
    addUser(text) {
      messages.push({ role: 'user', content: text });
    },
    addToolResults(results) {
      messages.push({
        role: 'user',
        content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, is_error: r.isError })),
      });
    },
  };
}

/** OpenAI-compatible Chat Completions (OpenAI, Azure OpenAI /openai/v1, and other compatible gateways). */
function openaiAdapter({ system, prompt, schemas }) {
  const baseURL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  const apiKey = process.env.OPENAI_API_KEY.trim();
  const tools = schemas.map(({ name, description, input_schema }) => ({
    type: 'function',
    function: { name, description, parameters: input_schema },
  }));
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: prompt },
  ];

  async function request(body) {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          'api-key': apiKey, // Azure OpenAI auth header; ignored by api.openai.com
        },
        body: JSON.stringify(body),
      });
      if (res.ok) return res.json();
      const errText = await res.text();
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= 4) throw new Error(`LLM request failed (${res.status}): ${errText.slice(0, 1000)}`);
      const wait = Number(res.headers.get('retry-after')) * 1000 || 2 ** attempt * 1000;
      log.warn(`LLM returned ${res.status}, retrying in ${Math.round(wait / 1000)}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  return {
    async turn() {
      const data = await request({ model: MODEL, max_completion_tokens: MAX_OUTPUT_TOKENS, tools, messages });
      const msg = data.choices?.[0]?.message ?? { content: '' };
      messages.push({ role: 'assistant', content: msg.content ?? null, ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
      const calls = (msg.tool_calls ?? [])
        .filter((c) => c.type === 'function')
        .map((c) => {
          let input;
          try {
            input = c.function.arguments ? JSON.parse(c.function.arguments) : {};
          } catch {
            input = { __invalid_json__: c.function.arguments };
          }
          return { id: c.id, name: c.function.name, input };
        });
      return {
        text: msg.content ?? '',
        calls,
        usage: { input_tokens: data.usage?.prompt_tokens ?? 0, output_tokens: data.usage?.completion_tokens ?? 0 },
      };
    },
    addUser(text) {
      messages.push({ role: 'user', content: text });
    },
    addToolResults(results) {
      for (const r of results) {
        messages.push({ role: 'tool', tool_call_id: r.id, content: r.isError ? `[error] ${r.content}` : r.content });
      }
    },
  };
}

function createAdapter(opts) {
  const problem = checkLlmConfig();
  if (problem) throw new Error(problem);
  return PROVIDER === 'openai' ? openaiAdapter(opts) : anthropicAdapter(opts);
}

const truncate = (s, max = 20000) => (s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]` : s);
const brief = (input) => {
  const s = JSON.stringify(input);
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
};

/**
 * The core agent loop: call the model, run any tools it asks for, feed the
 * results back, repeat. The loop ends when the model calls a "submit_*" tool
 * (its handler returns { final }) or stops asking for tools.
 */
export async function runAgent({ system, prompt, tools, state, stage, maxTurns }) {
  const schemas = tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  const handlers = Object.fromEntries(tools.map((t) => [t.name, t.handler]));
  const limit = maxTurns ?? 40;
  const llm = createAdapter({ system, prompt, schemas });

  for (let turn = 1; turn <= limit; turn++) {
    const { text, calls, usage } = await llm.turn();
    state.addUsage(usage);
    state.save();

    if (calls.length === 0) {
      llm.addUser('Call the submit tool to finish this stage.');
      if (turn === limit) throw new BudgetError(`Stage ${stage} ended without a submission: ${text.slice(0, 500)}`);
      continue;
    }

    const results = [];
    for (const call of calls) {
      log.tool(call.name, brief(call.input));
      let out;
      let isError = false;
      try {
        const handler = handlers[call.name];
        if (!handler) throw new Error(`Unknown tool ${call.name}`);
        if (call.input && '__invalid_json__' in call.input) throw new Error('Tool arguments were not valid JSON');
        out = await handler(call.input);
      } catch (err) {
        out = `Error: ${err.message}`;
        isError = true;
      }
      state.audit({ stage, type: 'tool_call', tool: call.name, input: brief(call.input), ok: !isError });
      if (out && typeof out === 'object' && 'final' in out) return out.final;
      results.push({ id: call.id, content: truncate(String(out)), isError });
    }
    llm.addToolResults(results);

    const max = state.budget ?? Infinity;
    if (state.totalTokens() > max) throw new BudgetError(`Token budget exceeded (${state.totalTokens()} > ${max})`);
  }
  throw new BudgetError(`Stage ${stage} exceeded ${limit} turns`);
}

/** Builds a tool whose call ends the loop and returns its input as the stage result. */
export function submitTool(name, description, input_schema, validate) {
  return {
    name,
    description,
    input_schema,
    handler: async (input) => {
      const problem = validate?.(input);
      if (problem) throw new Error(problem);
      return { final: input };
    },
  };
}
