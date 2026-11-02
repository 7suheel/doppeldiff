import type { Outcome } from '../compare/observed.js';
import type { Witness } from '../explore/explore.js';
import { formatArgs, formatEnc, formatOutcome } from '../format/format.js';
import type { RunResult } from '../run.js';
import type { FunctionResult } from '../verify/verifyFunction.js';
import { groupBehaviors } from './behaviors.js';
import { REALISM_NAMES } from '../explore/realism.js';
import { analyzeClaim, helpersFromReason, ruleLabel, type RuleLabel } from '../claims/rules.js';
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

/**
 * True when the claim says the change should not alter behavior (see the rules in ../claims/rules.ts):
 * explicit phrases, refactor-type conventional commits, or refactor-style wording without change words.
 */
export function isRefactorClaim(text: string | null | undefined): boolean {
  return analyzeClaim(text).intent === 'no-change';
}

/**
 * Label every behavior from the claim with the deterministic rules (no LLM). Mutates and returns the report.
 * `forceRefactor` comes from --refactor / verify_refactor.
 */
export function applyRuleLabels(report: Report, forceRefactor = false): Report {
  const a = analyzeClaim(report.claim.text);
  const refactor = forceRefactor || a.intent === 'no-change';
  report.claim.refactor = refactor;
  const targets = new Map(
    report.functions
      .filter((f) => f.behaviors.length > 0)
      .map(
        (f) =>
          [
            f,
            { exportName: f.exportName, file: f.file, helpers: helpersFromReason(f.targetReason) },
          ] as const,
      ),
  );
  const all = [...targets.values()];
  for (const [f, target] of targets) {
    const r: RuleLabel = refactor
      ? { label: 'unclaimed' }
      : report.claim.text
        ? ruleLabel(target, a, all)
        : { label: 'behavior-change' };
    for (const b of f.behaviors) {
      b.label = r.label;
      b.labelSource = r.label === 'behavior-change' ? 'none' : 'rules';
      if (r.explanation) b.explanation = r.explanation;
      else delete b.explanation;
    }
  }
  report.summary = summarize(report.functions, report.skipped.length, report.summary.durationMs);
  return report;
}

const MAX_DISPLAY = 300;

export function outcomeView(o: Outcome, abbreviate = true): OutcomeView {
  switch (o.kind) {
    case 'return': {
      const code = encToCode(o.value);
      return {
        kind: 'return',
        async: o.async,
        display: formatOutcome(o, MAX_DISPLAY, abbreviate),
        ...(code !== undefined && code.length < 4000 ? { code } : {}),
      };
    }
    case 'throw': {
      const e = o.error;
      return {
        kind: 'throw',
        async: o.async,
        display: formatOutcome(o, MAX_DISPLAY, abbreviate),
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
  // Abbreviated long lists can hide the difference: then show both in full (still length-limited).
  if (ex.old.display === ex.new.display) {
    ex.old = outcomeView(w.base, false);
    ex.new = outcomeView(w.head, false);
  }
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
      const full = formatEnc(a, MAX_DISPLAY) === formatEnc(b, MAX_DISPLAY);
      ex.mutation = {
        argIndex: i,
        old: formatEnc(a, MAX_DISPLAY, !full),
        new: formatEnc(b, MAX_DISPLAY, !full),
        ...(newCode !== undefined && newCode.length < 4000 ? { newCode } : {}),
      };
    }
  }
  return ex;
}

function functionReport(f: FunctionResult): FunctionReport {
  const behaviors: Behavior[] = groupBehaviors(f.clusters).map((b, i) => ({
    id: `${f.id}/${i + 1}`,
    key: b.key,
    title: b.title,
    realism: REALISM_NAMES[b.realism.tier],
    ...(b.realism.tier < 2 && b.realism.reason ? { realismNote: b.realism.reason } : {}),
    label: 'behavior-change',
    labelSource: 'none',
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
    ...(f.edgeFailures ? { edgeTimeouts: f.edgeFailures } : {}),
    ...(f.skippedEdgeInputs ? { skippedEdgeInputs: f.skippedEdgeInputs } : {}),
    durationMs: f.durationMs,
    seed: f.seed,
    ...(f.usage ? { usage: f.usage } : {}),
    ...(f.guards ? { guards: f.guards.map((g) => g.slice(0, 300)) } : {}),
    ...(f.llmInputs !== undefined ? { llmInputs: f.llmInputs } : {}),
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
  const all = functions.flatMap((f) => f.behaviors);
  const behaviors = all.filter((b) => b.realism !== 'edge');
  const isUnclaimed = (b: Behavior) => b.label === 'unclaimed' || b.label === 'suspicious';
  const unclaimed = behaviors.filter(isUnclaimed).length;
  const unclaimedRealistic = behaviors.filter(
    (b) => isUnclaimed(b) && (b.realism === 'seen' || b.realism === 'ordinary'),
  ).length;
  return {
    verdict: behaviors.length === 0 ? 'no-change' : unclaimed > 0 ? 'unclaimed' : 'changes',
    functions: functions.length,
    changed: functions.filter((f) => f.status === 'changed').length,
    unchanged: functions.filter((f) => f.status === 'unchanged').length,
    skipped: functions.filter((f) => f.status === 'skipped').length + skippedListed,
    nondeterministic: functions.filter((f) => f.status === 'nondeterministic').length,
    behaviors: behaviors.length,
    edgeCaseBehaviors: all.length - behaviors.length,
    unclaimed,
    unclaimedRealistic,
    inputsRun: functions.reduce((s, f) => s + f.inputsRun, 0),
    durationMs,
  };
}

export function buildReport(run: RunResult, claim: ClaimInput = { text: null, source: 'none' }): Report {
  const functions = run.functions.map((f) => functionReport(f));
  const report: Report = {
    schemaVersion: SCHEMA_VERSION,
    tool: run.tool,
    base: run.base,
    head: run.head,
    claim: { source: claim.source, text: claim.text, refactor: false, llm: null },
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
  return applyRuleLabels(report, claim.refactor ?? false);
}

/**
 * Re-derive claim fields and deterministic labels for a report from a (trusted) claim text, discarding any
 * labels it carried. Used by the GitHub Action's trusted job on the report produced by the untrusted job.
 */
export function relabel(report: Report, claim: ClaimInput): Report {
  const out: Report = structuredClone(report);
  out.claim = { source: claim.source, text: claim.text, refactor: false, llm: null };
  for (const f of out.functions) for (const b of f.behaviors) delete b.explanation;
  return applyRuleLabels(out, claim.refactor ?? false);
}
