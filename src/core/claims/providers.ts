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
  readonly name: 'anthropic' | 'openai' | 'fake';
  readonly model: string;
  /** Returns the raw JSON text produced by the model. */
  complete(req: StructuredRequest): Promise<string>;
}

export const DEFAULT_MODELS = { anthropic: 'claude-opus-5-5', openai: 'gpt-5.5' } as const;

export class LlmUnavailableError extends Error {}
export class LlmRefusalError extends Error {}

async function importOptional<T>(name: string): Promise<T> {
  try {
    return (await import(name)) as T;
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
      const { default: Anthropic } = await importOptional<typeof AnthropicModule>('@anthropic-ai/sdk');
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
      const { default: OpenAI } = await importOptional<typeof OpenAIModule>('openai');
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

export interface ProviderSelection {
  /** 'auto' (default): Anthropic if ANTHROPIC_API_KEY is set, else OpenAI if OPENAI_API_KEY is set, else none. */
  provider?: 'auto' | 'anthropic' | 'openai' | 'off';
  model?: string;
  env?: NodeJS.ProcessEnv;
}

/** Pick a provider from flags and environment. Returns null when the LLM layer is off or no key is available. */
export function selectProvider(sel: ProviderSelection = {}): LlmProvider | null {
  const env = sel.env ?? process.env;
  const choice = sel.provider ?? (env.DOPPELDIFF_LLM as ProviderSelection['provider']) ?? 'auto';
  const model = sel.model ?? env.DOPPELDIFF_LLM_MODEL;
  const fallbacks = env.DOPPELDIFF_LLM_FALLBACKS !== '0';
  if (choice === 'off') return null;
  if (choice === 'anthropic') return anthropicProvider(model, { fallbacks });
  if (choice === 'openai') return openaiProvider(model);
  if (env.ANTHROPIC_API_KEY) return anthropicProvider(model, { fallbacks });
  if (env.OPENAI_API_KEY) return openaiProvider(model);
  return null;
}
