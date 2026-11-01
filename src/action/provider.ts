import { selectProvider, type LlmProvider, type ProviderChoice } from '../core/claims/providers.js';
import type { ActionIO } from './types.js';

/**
 * The Action's optional LLM provider. Off unless the workflow explicitly sets `llm` or passes an API key input.
 * Keys are exported to the SDKs' environment variables only in this (trusted) process.
 */
export function actionProvider(io: ActionIO): LlmProvider | null {
  const anthropicKey = io.getInput('anthropic-api-key');
  const openaiKey = io.getInput('openai-api-key');
  let choice = (io.getInput('llm') || 'off') as ProviderChoice;
  if (choice === 'off' && (anthropicKey || openaiKey)) choice = 'auto';
  if (choice === 'off') return null;
  if (anthropicKey) process.env.ANTHROPIC_API_KEY = anthropicKey;
  if (openaiKey) process.env.OPENAI_API_KEY = openaiKey;
  return selectProvider({
    provider: choice,
    ...(io.getInput('llm-model') ? { model: io.getInput('llm-model') } : {}),
    ...(io.getInput('llm-base-url') ? { baseUrl: io.getInput('llm-base-url') } : {}),
    env: {
      ANTHROPIC_API_KEY: anthropicKey,
      OPENAI_API_KEY: openaiKey,
      ...(io.getInput('llm-api-key') ? { DOPPELDIFF_LLM_API_KEY: io.getInput('llm-api-key') } : {}),
    },
  });
}
