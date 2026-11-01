import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { summarize } from '../report/build.js';
import type { Report } from '../report/model.js';
import type { LlmProvider } from './providers.js';
import { buildUserPrompt, CLAIM_SCHEMA, SYSTEM_PROMPT } from './prompt.js';
import { validateClaimResponse } from './validate.js';

export interface ClaimMatchOptions {
  provider: LlmProvider;
  diff: string;
  /** Response cache directory (default ~/.cache/doppeldiff/llm); null disables caching. */
  cacheDir?: string | null;
  onWarning?: (message: string) => void;
}

export interface ClaimMatchOutcome {
  report: Report;
  /** Behaviors labeled by the LLM after validation. */
  labeled: number;
  /** Behaviors left neutral because the LLM output for them failed validation. */
  rejected: number;
  problems: string[];
  cached: boolean;
}

function cachePath(dir: string, key: string): string {
  return join(dir, `${key}.json`);
}

/**
 * Label each behavior as claimed / unclaimed / suspicious by comparing it with the PR description.
 * The LLM can only label behaviors the engine found; its output is validated against the evidence and
 * anything that fails validation stays neutral. One retry is made with the validation problems as feedback.
 */
export async function matchClaims(input: Report, options: ClaimMatchOptions): Promise<ClaimMatchOutcome> {
  const report: Report = structuredClone(input);
  const total = report.functions.reduce((s, f) => s + f.behaviors.length, 0);
  if (total === 0 || report.claim.refactor || !report.claim.text) {
    return { report, labeled: 0, rejected: 0, problems: [], cached: false };
  }
  const user = buildUserPrompt(report, options.diff);
  const key = createHash('sha256')
    .update(JSON.stringify([options.provider.name, options.provider.model, SYSTEM_PROMPT, user]))
    .digest('hex')
    .slice(0, 32);
  const cacheDir =
    options.cacheDir === undefined ? join(homedir(), '.cache', 'doppeldiff', 'llm') : options.cacheDir;

  let raw: unknown;
  let cached = false;
  if (cacheDir && existsSync(cachePath(cacheDir, key))) {
    try {
      raw = JSON.parse(readFileSync(cachePath(cacheDir, key), 'utf8'));
      cached = true;
    } catch {
      raw = undefined;
    }
  }
  let result = raw === undefined ? undefined : validateClaimResponse(raw, report, options.diff);
  for (let attempt = 0; attempt < 2 && (!result || result.problems.length > 0); attempt++) {
    const feedback =
      attempt === 0 || !result
        ? ''
        : `\n\nYour previous answer had these problems; fix them and label every behavior id exactly once:\n- ${result.problems.join('\n- ')}`;
    const text = await options.provider.complete({
      system: SYSTEM_PROMPT,
      user: user + feedback,
      schema: CLAIM_SCHEMA,
      schemaName: 'claim_labels',
    });
    try {
      raw = JSON.parse(text);
    } catch {
      raw = null;
    }
    const next = validateClaimResponse(raw, report, options.diff);
    if (!result || next.labels.size >= result.labels.size) result = next;
    cached = false;
  }
  if (cacheDir && !cached && result && result.problems.length === 0) {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath(cacheDir, key), JSON.stringify(raw));
  }

  const labels = result?.labels ?? new Map();
  let labeled = 0;
  for (const f of report.functions) {
    for (const b of f.behaviors) {
      const l = labels.get(b.id);
      if (!l) continue;
      b.label = l.label;
      b.labelSource = 'llm';
      b.explanation = l.explanation;
      labeled++;
    }
  }
  for (const p of result?.problems ?? []) options.onWarning?.(`claim matching: ${p}`);
  report.claim.llm = { provider: options.provider.name, model: options.provider.model };
  report.summary = summarize(report.functions, report.skipped.length, report.summary.durationMs);
  return { report, labeled, rejected: total - labeled, problems: result?.problems ?? [], cached };
}
