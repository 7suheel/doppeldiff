import type { Outcome } from '../compare/observed.js';
import type { Witness } from '../explore/explore.js';
import { formatArgs, formatEnc, formatOutcome } from '../format/format.js';
import type { RunResult } from '../run.js';
import type { FunctionResult } from '../verify/verifyFunction.js';
import { groupBehaviors } from './behaviors.js';
import { argsToCode, encToCode } from './codegen.js';
import {
  SCHEMA_VERSION,
  type Behavior,
  type Example,
  type FunctionReport,
  type OutcomeView,
  type Report,
} from './model.js';

export interface ClaimInput {
  text: string | null;
  source: 'pr' | 'flag' | 'none';
  /** Force refactor mode (assert no behavior change), e.g. `--refactor` or the MCP verify_refactor tool. */
  refactor?: boolean;
}

const REFACTOR_PATTERNS = [
  /\bno (?:functional|behaviou?ral|behaviou?r|logic) changes?\b/i,
  /\bno changes? (?:in|to) (?:behaviou?r|functionality|logic)\b/i,
  /\bpure(?:ly)?[- ]refactor/i,
  /\bbehaviou?r[- ]preserving\b/i,
  /\bnon[- ]functional (?:change|refactor)/i,
  /\bwithout (?:changing|any change (?:in|to)) (?:behaviou?r|functionality)\b/i,
];

/**
 * Deterministic claim rule (no LLM): a PR description that explicitly asserts "no behavior change" puts the
 * report in refactor mode, where every behavior change is unclaimed.
 */
export function isRefactorClaim(text: string | null | undefined): boolean {
  return !!text && REFACTOR_PATTERNS.some((re) => re.test(text));
}

const MAX_DISPLAY = 300;

export function outcomeView(o: Outcome): OutcomeView {
  switch (o.kind) {
    case 'return': {
      const code = encToCode(o.value);
      return {
        kind: 'return',
        async: o.async,
        display: formatOutcome(o, MAX_DISPLAY),
        ...(code !== undefined && code.length < 4000 ? { code } : {}),
      };
    }
    case 'throw': {
      const e = o.error;
      return {
        kind: 'throw',
        async: o.async,
        display: formatOutcome(o, MAX_DISPLAY),
        ...(e.t === 'error' ? { errorClass: e.ctor.slice(0, 200), message: e.message.slice(0, 4000) } : {}),
      };
    }
    default:
      return { kind: o.kind, async: false, display: formatOutcome(o, MAX_DISPLAY) };
  }
}

export function exampleFrom(exportName: string, w: Witness): Example {
  const argsCode = argsToCode(w.input);
  const ex: Example = {
    call: `${exportName}(${formatArgs(w.input, MAX_DISPLAY)})`.slice(0, 4000),
    ...(argsCode !== undefined && argsCode.length < 4000 ? { argsCode } : {}),
    old: outcomeView(w.base),
    new: outcomeView(w.head),
    minimal: w.minimal,
  };
  if (
    w.diff.aspect === 'mutation' &&
    (w.base.kind === 'return' || w.base.kind === 'throw') &&
    (w.head.kind === 'return' || w.head.kind === 'throw')
  ) {
    const i = Number(w.diff.path[0]);
    const a = w.base.args[i];
    const b = w.head.args[i];
    if (a && b) {
      const newCode = encToCode(b);
      ex.mutation = {
        argIndex: i,
        old: formatEnc(a, MAX_DISPLAY),
        new: formatEnc(b, MAX_DISPLAY),
        ...(newCode !== undefined && newCode.length < 4000 ? { newCode } : {}),
      };
    }
  }
  return ex;
}

function functionReport(f: FunctionResult, refactor: boolean): FunctionReport {
  const behaviors: Behavior[] = groupBehaviors(f.clusters).map((b, i) => ({
    id: `${f.id}/${i + 1}`,
    key: b.key,
    title: b.title,
    label: refactor ? 'unclaimed' : 'behavior-change',
    labelSource: refactor ? 'refactor-claim' : 'none',
    count: b.count,
    variants: b.variants,
    examples: b.examples.map((w) => exampleFrom(f.exportName, w)),
  }));
  const nd = f.nondeterministic;
  return {
    id: f.id,
    file: f.file,
    exportName: f.exportName,
    ...(f.signature ? { signature: f.signature } : {}),
    status: f.status,
    ...(f.reason ? { reason: f.reason } : {}),
    ...(f.targetReason ? { targetReason: f.targetReason } : {}),
    inputsRun: f.inputsRun,
    ...(f.stoppedBy ? { stoppedBy: f.stoppedBy } : {}),
    failures: f.failures,
    durationMs: f.durationMs,
    seed: f.seed,
    behaviors,
    ...(nd
      ? {
          nondeterministic: {
            side: nd.side,
            call: `${f.exportName}(${formatArgs(nd.input, MAX_DISPLAY)})`,
            first: formatOutcome(nd.first, MAX_DISPLAY),
            second: formatOutcome(nd.second, MAX_DISPLAY),
          },
        }
      : {}),
  };
}

export function summarize(
  functions: FunctionReport[],
  skippedListed: number,
  durationMs: number,
): Report['summary'] {
  const behaviors = functions.flatMap((f) => f.behaviors);
  const unclaimed = behaviors.filter((b) => b.label === 'unclaimed' || b.label === 'suspicious').length;
  return {
    verdict: behaviors.length === 0 ? 'no-change' : unclaimed > 0 ? 'unclaimed' : 'changes',
    functions: functions.length,
    changed: functions.filter((f) => f.status === 'changed').length,
    unchanged: functions.filter((f) => f.status === 'unchanged').length,
    skipped: functions.filter((f) => f.status === 'skipped').length + skippedListed,
    nondeterministic: functions.filter((f) => f.status === 'nondeterministic').length,
    behaviors: behaviors.length,
    unclaimed,
    inputsRun: functions.reduce((s, f) => s + f.inputsRun, 0),
    durationMs,
  };
}

export function buildReport(run: RunResult, claim: ClaimInput = { text: null, source: 'none' }): Report {
  const refactor = claim.refactor ?? isRefactorClaim(claim.text);
  const functions = run.functions.map((f) => functionReport(f, refactor));
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: run.tool,
    base: run.base,
    head: run.head,
    claim: { source: claim.source, text: claim.text, refactor, llm: null },
    settings: { seed: run.seed, ...run.settings },
    summary: summarize(functions, run.skipped.length, run.timing.totalMs),
    functions,
    skipped: run.skipped,
    added: run.added,
    removed: run.removed,
    identical: run.identical,
    errors: run.errors,
    regressionTests: null,
    timing: run.timing,
  };
}
