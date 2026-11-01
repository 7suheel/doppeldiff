import { z } from 'zod';

/**
 * The stable, machine-readable report (schemaVersion 1). Every renderer (terminal, Markdown, JSON,
 * regression tests) consumes only this model. It is also the artifact that crosses the trust boundary in
 * the GitHub Action, so it is validated with this schema before use.
 */
export const SCHEMA_VERSION = 1 as const;

const MAX_TEXT = 4000;
const text = (max = MAX_TEXT) => z.string().max(max);

export const OutcomeView = z.object({
  kind: z.enum(['return', 'throw', 'timeout', 'crash']),
  async: z.boolean(),
  /** Human-readable rendering, e.g. `1104.99`, `throws RangeError: bad price`, `timeout (>250ms)`. */
  display: text(),
  /** JavaScript expression reproducing a returned value (absent if not expressible). */
  code: text().optional(),
  errorClass: text(200).optional(),
  message: text().optional(),
});
export type OutcomeView = z.infer<typeof OutcomeView>;

export const Example = z.object({
  /** e.g. `applyDiscount(2000, 0.07)` */
  call: text(),
  /** Arguments as JavaScript source (absent if not expressible). */
  argsCode: text().optional(),
  old: OutcomeView,
  new: OutcomeView,
  /** Present when the difference is in how arguments were mutated. */
  mutation: z
    .object({ argIndex: z.number().int(), old: text(), new: text(), newCode: text().optional() })
    .optional(),
  minimal: z.boolean(),
});
export type Example = z.infer<typeof Example>;

export const BehaviorLabel = z.enum(['behavior-change', 'claimed', 'unclaimed', 'suspicious']);
export type BehaviorLabel = z.infer<typeof BehaviorLabel>;

export const Behavior = z.object({
  /** Stable id within the report, e.g. `src/pricing.ts#applyDiscount/1`. */
  id: text(600),
  key: text(),
  title: text(),
  label: BehaviorLabel,
  /** Where the label came from: no claim analysis, the deterministic refactor rule, or an LLM. */
  labelSource: z.enum(['none', 'rules', 'llm']),
  explanation: text(1000).optional(),
  count: z.number().int().nonnegative(),
  variants: z.array(z.object({ transition: text(), features: z.array(text(200)), count: z.number().int() })),
  examples: z.array(Example),
});
export type Behavior = z.infer<typeof Behavior>;

export const FunctionStatus = z.enum(['changed', 'unchanged', 'skipped', 'nondeterministic']);

export const FunctionReport = z.object({
  id: text(600),
  file: text(500),
  exportName: text(200),
  signature: text().optional(),
  status: FunctionStatus,
  reason: text().optional(),
  /** Why the function was analyzed: "code changed", "uses changed `toCents`", … */
  targetReason: text().optional(),
  inputsRun: z.number().int().nonnegative(),
  stoppedBy: z.enum(['runs', 'deadline', 'failures', 'exhausted']).optional(),
  failures: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  seed: z.number().int(),
  /** Inputs suggested by the optional LLM step that passed type validation. */
  llmInputs: z.number().int().nonnegative().optional(),
  behaviors: z.array(Behavior),
  nondeterministic: z
    .object({ side: z.enum(['base', 'head']), call: text(), first: text(), second: text() })
    .optional(),
});
export type FunctionReport = z.infer<typeof FunctionReport>;

export const Listed = z.object({
  id: text(600),
  file: text(500),
  exportName: text(200),
  kind: text(100),
  reason: text().optional(),
});
export type Listed = z.infer<typeof Listed>;

export const Report = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  tool: z.object({ name: z.literal('doppeldiff'), version: text(50) }),
  base: z.object({ ref: text(300), sha: text(64) }),
  head: z.object({ ref: text(300), sha: text(64).nullable() }),
  claim: z.object({
    source: z.enum(['pr', 'flag', 'none']),
    text: text(20_000).nullable(),
    /** The claim asserts no behavior change (refactor mode): every behavior change is unclaimed. */
    refactor: z.boolean(),
    /** Claim matching by an LLM was performed (labels are "claimed"/"unclaimed"/"suspicious"). */
    llm: z.object({ provider: text(50), model: text(100) }).nullable(),
  }),
  settings: z.object({
    seed: z.number().int(),
    runs: z.number().int(),
    timeoutMs: z.number().int(),
    timeBudgetMs: z.number().int().nullable(),
    freeze: z.boolean(),
  }),
  summary: z.object({
    verdict: z.enum(['no-change', 'changes', 'unclaimed']),
    functions: z.number().int(),
    changed: z.number().int(),
    unchanged: z.number().int(),
    skipped: z.number().int(),
    nondeterministic: z.number().int(),
    behaviors: z.number().int(),
    unclaimed: z.number().int(),
    inputsRun: z.number().int(),
    durationMs: z.number(),
  }),
  functions: z.array(FunctionReport),
  skipped: z.array(Listed),
  added: z.array(Listed),
  removed: z.array(Listed),
  identical: z.array(Listed),
  errors: z.array(z.object({ file: text(500), message: text() })),
  regressionTests: z
    .object({ framework: z.enum(['vitest', 'jest']), files: z.array(text(500)), cases: z.number().int() })
    .nullable(),
  timing: z.object({
    totalMs: z.number(),
    materializeMs: z.number(),
    dependenciesMs: z.number(),
    detectMs: z.number(),
    verifyMs: z.number(),
  }),
});
export type Report = z.infer<typeof Report>;

/** JSON Schema of the report, published as schema/report.schema.json. */
export function reportJsonSchema(): unknown {
  return z.toJSONSchema(Report);
}
