import type * as AnthropicModule from '@anthropic-ai/sdk';
import type * as OpenAIModule from 'openai';

/**
 * Optional, bring-your-own-key LLM providers. SDKs are optional peer dependencies loaded lazily; keys come
 * only from environment variables and are never logged or written to reports.
 */
export interface StructuredRequest {
  system: string;
  user: string;
  /** JSON schema the response must follow. */
  schema: Record<string, unknown>;
  schemaName: string;
  maxTokens?: number;
}

export interface LlmProvider {
  readonly name: 'anthropic' | 'openai' | 'openai-compatible' | 'fake';
  readonly model: string;
  /** Returns the raw JSON text produced by the model. */
  complete(req: StructuredRequest): Promise<string>;
}

export const DEFAULT_MODELS = { anthropic: 'claude-opus-5-5', openai: 'gpt-5.5' } as const;

export class LlmUnavailableError extends Error {}
export class LlmRefusalError extends Error {}

/** Literal dynamic imports so bundlers (the GitHub Action build) can include the optional SDKs. */
async function importOptional<T>(name: string, load: () => Promise<unknown>): Promise<T> {
  try {
    return (await load()) as T;
  } catch {
    throw new LlmUnavailableError(`the optional package "${name}" is not installed (npm i -D ${name})`);
  }
}

export function anthropicProvider(
  model: string = DEFAULT_MODELS.anthropic,
  options: { fallbacks?: boolean } = {},
): LlmProvider {
  return {
    name: 'anthropic',
    model,
    async complete(req) {
      const { default: Anthropic } = await importOptional<typeof AnthropicModule>(
        '@anthropic-ai/sdk',
        () => import('@anthropic-ai/sdk'),
      );
      const client = new Anthropic({ maxRetries: 2, timeout: 120_000 });
      const useFallbacks = options.fallbacks !== false;
      const response = await client.beta.messages.create({
        model,
        max_tokens: req.maxTokens ?? 16000,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
        // A small classification task: low effort is enough; thinking stays adaptive (cannot be disabled).
        output_config: { effort: 'low', format: { type: 'json_schema', schema: req.schema } },
        // Server-side fallback re-runs the request on Anthropic's recommended model if a safety classifier declines.
        ...(useFallbacks
          ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
          : {}),
      });
      if (response.stop_reason === 'refusal') {
        throw new LlmRefusalError(
          `the model declined the request${response.stop_details?.category ? ` (${response.stop_details.category})` : ''}`,
        );
      }
      if (response.stop_reason === 'max_tokens')
        throw new Error('the model response was truncated (max_tokens)');
      const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      if (!text) throw new Error('the model returned no text');
      return text;
    },
  };
}

export function openaiProvider(model: string = DEFAULT_MODELS.openai): LlmProvider {
  return {
    name: 'openai',
    model,
    async complete(req) {
      const { default: OpenAI } = await importOptional<typeof OpenAIModule>('openai', () => import('openai'));
      const client = new OpenAI({ maxRetries: 2, timeout: 120_000 });
      const response = await client.responses.create({
        model,
        instructions: req.system,
        input: req.user,
        max_output_tokens: req.maxTokens ?? 16000,
        text: { format: { type: 'json_schema', name: req.schemaName, schema: req.schema, strict: true } },
      });
      const text = response.output_text;
      if (!text) throw new Error('the model returned no text');
      return text;
    },
  };
}

export const OLLAMA_BASE_URL = 'http://localhost:11434/v1';

/**
 * Any OpenAI-compatible Chat Completions endpoint: Ollama, llama.cpp server, LM Studio, vLLM, or a hosted gateway.
 * Uses plain fetch (no SDK). Free when it points at a local model.
 */
export function openaiCompatibleProvider(options: {
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): LlmProvider {
  const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const doFetch = options.fetchImpl ?? fetch;
  return {
    name: 'openai-compatible',
    model: options.model,
    async complete(req) {
      const send = async (responseFormat: unknown, extraInstruction: string) => {
        const res = await doFetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: options.model,
            temperature: 0,
            messages: [
              { role: 'system', content: req.system + extraInstruction },
              { role: 'user', content: req.user },
            ],
            response_format: responseFormat,
          }),
          signal: AbortSignal.timeout(300_000),
        });
        const body = (await res.json().catch(() => ({}))) as {
          choices?: { message?: { content?: string | null } }[];
          error?: { message?: string } | string;
        };
        return { ok: res.ok, status: res.status, body };
      };
      // Prefer strict JSON-schema output; fall back to plain JSON mode for servers without schema support.
      let r = await send(
        { type: 'json_schema', json_schema: { name: req.schemaName, schema: req.schema, strict: true } },
        '',
      );
      if (!r.ok && r.status >= 400 && r.status < 500) {
        r = await send(
          { type: 'json_object' },
          `\n\nAnswer with a single JSON object matching this JSON schema:\n${JSON.stringify(req.schema)}`,
        );
      }
      if (!r.ok) {
        const msg = typeof r.body.error === 'string' ? r.body.error : r.body.error?.message;
        throw new Error(`LLM endpoint returned HTTP ${r.status}${msg ? `: ${msg.slice(0, 200)}` : ''}`);
      }
      const text = r.body.choices?.[0]?.message?.content;
      if (!text) throw new Error('the model returned no text');
      return text;
    },
  };
}

export type ProviderChoice = 'off' | 'auto' | 'anthropic' | 'openai' | 'openai-compatible' | 'ollama';

export interface ProviderSelection {
  /**
   * Default 'off': the LLM layer is never used unless explicitly chosen. 'ollama' / 'openai-compatible' are
   * free with a local model; 'anthropic' / 'openai' use your own (paid) key; 'auto' picks whichever key is set.
   */
  provider?: ProviderChoice;
  model?: string;
  /** Base URL for 'openai-compatible' (default for 'ollama': http://localhost:11434/v1). */
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}

/** Pick a provider from flags and environment. Returns null unless an LLM was explicitly enabled. */
export function selectProvider(sel: ProviderSelection = {}): LlmProvider | null {
  const env = sel.env ?? process.env;
  const choice = sel.provider ?? (env.DOPPELDIFF_LLM as ProviderChoice | undefined) ?? 'off';
  const model = sel.model ?? env.DOPPELDIFF_LLM_MODEL;
  const baseUrl = sel.baseUrl ?? env.DOPPELDIFF_LLM_BASE_URL;
  const fallbacks = env.DOPPELDIFF_LLM_FALLBACKS !== '0';
  switch (choice) {
    case 'off':
      return null;
    case 'anthropic':
      return anthropicProvider(model, { fallbacks });
    case 'openai':
      return openaiProvider(model);
    case 'ollama':
    case 'openai-compatible': {
      const url = baseUrl ?? (choice === 'ollama' ? OLLAMA_BASE_URL : undefined);
      if (!url)
        throw new LlmUnavailableError(
          '--llm openai-compatible needs --llm-base-url (or DOPPELDIFF_LLM_BASE_URL)',
        );
      if (!model)
        throw new LlmUnavailableError(`--llm ${choice} needs --llm-model (e.g. qwen2.5:7b for Ollama)`);
      return openaiCompatibleProvider({
        baseUrl: url,
        model,
        ...(env.DOPPELDIFF_LLM_API_KEY ? { apiKey: env.DOPPELDIFF_LLM_API_KEY } : {}),
      });
    }
    case 'auto':
      if (env.ANTHROPIC_API_KEY) return anthropicProvider(model, { fallbacks });
      if (env.OPENAI_API_KEY) return openaiProvider(model);
      return null;
    default:
      throw new LlmUnavailableError(`unknown LLM provider "${String(choice)}"`);
  }
}
