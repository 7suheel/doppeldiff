import { z } from 'zod';
import type { Report } from '../report/model.js';

export const ClaimResponse = z.object({
  behaviors: z.array(
    z.object({
      id: z.string(),
      label: z.enum(['claimed', 'unclaimed', 'suspicious']),
      explanation: z.string(),
    }),
  ),
});
export type ClaimResponse = z.infer<typeof ClaimResponse>;

export interface ValidatedLabel {
  id: string;
  label: 'claimed' | 'unclaimed' | 'suspicious';
  explanation: string;
}

export interface ValidationResult {
  labels: Map<string, ValidatedLabel>;
  problems: string[];
}

/** Numbers and quoted strings mentioned in a sentence. */
export function quotedValues(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"([^"]{1,80})"|“([^”]{1,80})”|`([^`]{1,80})`/g))
    out.push((m[1] ?? m[2] ?? m[3])!);
  const withoutQuotes = text.replace(/"[^"]*"|“[^”]*”|`[^`]*`/g, ' ');
  for (const m of withoutQuotes.matchAll(
    /(?<![\w.])-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:e[+-]?\d+)?(?![\w])/gi,
  ))
    out.push(m[0]);
  return out;
}

/** Normalize evidence so a value quoted as `1,104.99` or `$1000` still matches `1104.99` / `1000`. */
function norm(s: string): string {
  return s.replace(/[,$€£\s]/g, '').toLowerCase();
}

/**
 * Validate an LLM claim-matching response against the evidence. Entries for unknown ids, duplicates, overly
 * long explanations, or explanations quoting values that appear nowhere in the evidence are rejected.
 */
export function validateClaimResponse(raw: unknown, report: Report, diff: string): ValidationResult {
  const problems: string[] = [];
  const labels = new Map<string, ValidatedLabel>();
  const parsed = ClaimResponse.safeParse(raw);
  if (!parsed.success)
    return {
      labels,
      problems: [`response does not match the schema: ${parsed.error.message.slice(0, 300)}`],
    };

  const behaviors = new Map(
    report.functions.flatMap((f) => f.behaviors.map((b) => [b.id, { f, b }] as const)),
  );
  const globalEvidence = norm(`${report.claim.text ?? ''}\n${diff}`);
  for (const entry of parsed.data.behaviors) {
    const target = behaviors.get(entry.id);
    if (!target) {
      problems.push(`unknown behavior id ${JSON.stringify(entry.id).slice(0, 100)}`);
      continue;
    }
    if (labels.has(entry.id)) {
      problems.push(`behavior ${entry.id} labeled more than once`);
      labels.delete(entry.id);
      continue;
    }
    const explanation = entry.explanation.trim().replace(/\s+/g, ' ');
    if (explanation.length === 0 || explanation.length > 400) {
      problems.push(`behavior ${entry.id}: explanation empty or too long`);
      continue;
    }
    const { f, b } = target;
    const local = norm(
      [
        f.exportName,
        f.file,
        f.signature ?? '',
        b.title,
        String(b.count),
        String(f.inputsRun),
        ...b.examples.flatMap((e) => [e.call, e.old.display, e.new.display]),
      ].join('\n'),
    );
    const invented = quotedValues(explanation).filter((v) => {
      const n = norm(v);
      return n.length > 0 && !local.includes(n) && !globalEvidence.includes(n);
    });
    if (invented.length > 0) {
      problems.push(
        `behavior ${entry.id}: explanation quotes values not in the evidence (${invented.slice(0, 3).join(', ')})`,
      );
      continue;
    }
    labels.set(entry.id, { id: entry.id, label: entry.label, explanation });
  }
  for (const id of behaviors.keys())
    if (!labels.has(id) && !problems.some((p) => p.includes(id)))
      problems.push(`behavior ${id} was not labeled`);
  return { labels, problems };
}
