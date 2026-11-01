import { mineValues, type MinedValues } from '../arbitraries/mine.js';
import { compileSignature } from '../arbitraries/compile.js';
import { asFunctionLike, reachableLocalFunctions, usesThis, type LocateResult } from '../analyze/locate.js';
import { indexModule } from '../detect/toplevel.js';
import type { SourceFile } from 'ts-morph';
import type { CompareOptions } from '../compare/compare.js';
import {
  explore,
  type Cluster,
  type ExploreResult,
  type NondeterminismReport,
  type PairOutcome,
} from '../explore/explore.js';
import { signatureFromNode } from '../types/fromType.js';
import { signatureAccepts } from '../types/accepts.js';
import { printSpec, signatureUnsupported, type SignatureSpec } from '../types/spec.js';
import { fnv1a } from '../util/stableKey.js';
import type { VerifySession } from './session.js';

export interface FunctionTarget {
  /** Stable identifier, e.g. `src/pricing.ts#applyDiscount`. */
  id: string;
  /** Export name in the base and head version (usually identical). */
  exportName: string;
  baseFile: string;
  headFile: string;
  /** Why this function is a target (e.g. "body changed", "calls changed helper toCents()"). */
  reason?: string;
}

export interface VerifyFunctionOptions {
  /** Root seed of the run. Each function derives its own seed from it. */
  seed: number;
  runs: number;
  /** Absolute wall-clock deadline for this function's exploration (epoch ms). */
  deadline?: number;
  compare?: CompareOptions;
  examples?: unknown[][];
  onProgress?: (p: { inputsRun: number; clusters: number }) => void;
}

export type FunctionStatus = 'changed' | 'unchanged' | 'skipped' | 'nondeterministic';

export interface FunctionResult {
  id: string;
  exportName: string;
  file: string;
  status: FunctionStatus;
  reason?: string;
  targetReason?: string;
  signature?: string;
  seed: number;
  inputsRun: number;
  differingInputs: number;
  clusters: Cluster[];
  flakyClusters: number;
  nondeterministic?: NondeterminismReport;
  stoppedBy?: ExploreResult['stoppedBy'];
  failures: number;
  shrinkEvaluations: number;
  durationMs: number;
  mined?: { numbers: number; strings: number; thresholds: number[] };
}

/** Locate an exported function through the module index (ESM exports, re-exports and CommonJS). */
export function locateExport(sf: SourceFile, exportName: string): LocateResult {
  const index = indexModule(sf);
  const top = index.exports.get(exportName);
  if (top === undefined) return { ok: false, reason: `no export named \`${exportName}\``, missing: true };
  return asFunctionLike(index.decls.get(top)!.node);
}

export function printSignature(name: string, sig: SignatureSpec): string {
  const params = sig.params.map(
    (p) =>
      `${p.rest ? '...' : ''}${p.name}${p.optional && !p.rest ? '?' : ''}: ${printSpec(p.spec)}${p.rest ? '[]' : ''}`,
  );
  return `${name}(${params.join(', ')})`;
}

export function functionSeed(rootSeed: number, id: string): number {
  return fnv1a(`${rootSeed}:${id}`);
}

const FEATURE_THRESHOLDS = 8;

function featureThresholds(mined: MinedValues): number[] {
  const all = [...new Set([0, ...mined.thresholds])].sort((a, b) => a - b);
  if (all.length <= FEATURE_THRESHOLDS) return all;
  // Keep 0 and the thresholds closest to it in magnitude (most likely to be "real" boundaries).
  return [
    0,
    ...all
      .filter((t) => t !== 0)
      .sort((a, b) => Math.abs(a) - Math.abs(b))
      .slice(0, FEATURE_THRESHOLDS - 1),
  ].sort((a, b) => a - b);
}

export async function verifyFunction(
  session: VerifySession,
  target: FunctionTarget,
  options: VerifyFunctionOptions,
): Promise<FunctionResult> {
  const started = Date.now();
  const seed = functionSeed(options.seed, target.id);
  const base: FunctionResult = {
    id: target.id,
    exportName: target.exportName,
    file: target.id.split('#')[0] ?? target.headFile,
    status: 'skipped',
    seed,
    inputsRun: 0,
    differingInputs: 0,
    clusters: [],
    flakyClusters: 0,
    failures: 0,
    shrinkEvaluations: 0,
    durationMs: 0,
    ...(target.reason ? { targetReason: target.reason } : {}),
  };
  const skip = (reason: string): FunctionResult => ({
    ...base,
    status: 'skipped',
    reason,
    durationMs: Date.now() - started,
  });

  // 1. Locate both versions.
  let baseLoc, headLoc;
  try {
    baseLoc = locateExport(session.sourceFile('base', target.baseFile), target.exportName);
    headLoc = locateExport(session.sourceFile('head', target.headFile), target.exportName);
  } catch (e) {
    return skip(`could not parse source: ${(e as Error).message}`);
  }
  if (!headLoc.ok) return skip(headLoc.reason);
  if (!baseLoc.ok) return skip(`base version: ${baseLoc.reason}`);
  if (usesThis(headLoc.node) || usesThis(baseLoc.node))
    return skip('uses `this` (methods are out of scope in v1)');

  // 2. Signatures.
  const headSig = signatureFromNode(headLoc.node);
  const baseSig = signatureFromNode(baseLoc.node);
  const signature = printSignature(target.exportName, headSig);
  base.signature = signature;
  const unsupported = signatureUnsupported(headSig);
  if (unsupported) return skip(`unsupported parameter type: ${unsupported}`);
  if (!signatureAccepts(baseSig, headSig)) {
    return skip(
      `signature changed incompatibly: ${printSignature(target.exportName, baseSig)} → ${signature}`,
    );
  }

  // 3. Inputs: type-driven arbitrary biased with values mined from both versions and reachable helpers.
  const mined = mineValues([
    baseLoc.node,
    headLoc.node,
    ...reachableLocalFunctions(baseLoc.node, 3),
    ...reachableLocalFunctions(headLoc.node, 3),
  ]);
  base.mined = { numbers: mined.numbers.length, strings: mined.strings.length, thresholds: mined.thresholds };
  const arbitrary = compileSignature(headSig, { mined });
  if (!arbitrary) return skip('could not build an input generator for the signature');

  // 4. Load both versions in their sandboxes.
  let baseMod, headMod;
  try {
    [baseMod, headMod] = await Promise.all([
      session.loadModule('base', target.baseFile),
      session.loadModule('head', target.headFile),
    ]);
  } catch (e) {
    return skip(`could not bundle or start runner: ${(e as Error).message.split('\n')[0]}`);
  }
  for (const [label, m] of [
    ['base', baseMod],
    ['head', headMod],
  ] as const) {
    if (!m.load.ok) {
      const err = m.load.error;
      return skip(
        `module failed to load (${label}): ${err?.code ? `${err.code} ` : ''}${err?.message ?? 'unknown error'}`,
      );
    }
    if (!m.load.exports.includes(target.exportName))
      return skip(`export \`${target.exportName}\` not found at runtime (${label})`);
  }

  // 5. Explore.
  const evaluate = async (inputs: unknown[][]): Promise<PairOutcome[]> => {
    const [b, h] = await Promise.all([
      session.pools.base.run(baseMod.moduleId, target.exportName, inputs),
      session.pools.head.run(headMod.moduleId, target.exportName, inputs),
    ]);
    return b.map((o, i) => ({ base: o, head: h[i]! }));
  };
  const result = await explore({
    arbitrary,
    evaluate,
    seed,
    runs: options.runs,
    thresholds: featureThresholds(mined),
    ...(options.deadline !== undefined ? { deadline: options.deadline } : {}),
    ...(options.compare ? { compare: options.compare } : {}),
    ...(options.examples ? { examples: options.examples } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });

  const common = {
    ...base,
    inputsRun: result.inputsRun,
    differingInputs: result.differingInputs,
    clusters: result.clusters,
    flakyClusters: result.flakyClusters,
    stoppedBy: result.stoppedBy,
    failures: result.failures,
    shrinkEvaluations: result.shrinkEvaluations,
    durationMs: Date.now() - started,
  };
  if (result.nondeterministic) {
    return {
      ...common,
      status: 'nondeterministic',
      nondeterministic: result.nondeterministic,
      reason: `the ${result.nondeterministic.side} version returned different results for the same input`,
    };
  }
  return { ...common, status: result.clusters.length > 0 ? 'changed' : 'unchanged' };
}
