import fc, { type Arbitrary } from 'fast-check';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';
import { diffOutcome, type CompareOptions, type OutcomeDiff } from '../compare/compare.js';
import type { Outcome } from '../compare/observed.js';
import { formatArgs } from '../format/format.js';
import { stableKey } from '../util/stableKey.js';
import { clusterKey, describeTransition, inputFeatures } from './cluster.js';
import { humanize, inputComplexity } from './humanize.js';
import type { Realism } from './realism.js';

export interface PairOutcome {
  base: Outcome;
  head: Outcome;
}

/** Runs inputs on both versions. Must return outcomes in input order. */
export type Evaluator = (inputs: unknown[][]) => Promise<PairOutcome[]>;

export interface ExploreOptions {
  arbitrary: Arbitrary<unknown[]>;
  evaluate: Evaluator;
  seed: number;
  /** Max number of distinct generated inputs to run during exploration. */
  runs: number;
  /** Wall-clock deadline (epoch ms) for exploration; shrinking gets a small grace period. */
  deadline?: number;
  /** Explicit inputs evaluated first (e.g. mined from existing tests). */
  examples?: unknown[][];
  compare?: CompareOptions;
  /** Numeric decision thresholds used for input features. */
  thresholds?: readonly number[];
  maxClusters?: number;
  /** Max shrink evaluations per cluster. */
  shrinkBudget?: number;
  /** Max witnesses kept per cluster. */
  maxWitnesses?: number;
  /** Stop exploring after this many timeouts/crashes (they are expensive: the runner is respawned). */
  maxFailures?: number;
  /** Number of inputs run twice per version to detect nondeterminism. */
  selfCheck?: number;
  /** Max evaluations of the humanizing pass per witness. */
  humanizeBudget?: number;
  /**
   * Input domain: generated inputs outside it are skipped. Strict (config `where`) skips all of them; otherwise
   * (guards inferred from the old version) 3 of 4 are skipped, so changed validation is still exercised.
   */
  inDomain?: (input: unknown[]) => boolean;
  strictDomain?: boolean;
  /** Realism of an input; witnesses are chosen most-realistic first. */
  realism?: (input: unknown[]) => Realism;
  onProgress?: (p: { inputsRun: number; clusters: number }) => void;
}

export interface Witness {
  input: unknown[];
  base: Outcome;
  head: Outcome;
  diff: OutcomeDiff;
  /** True for the simplest example of the cluster (after shrinking and humanizing). */
  minimal: boolean;
  /** How realistic the input is (see realism.ts). */
  realism?: Realism;
}

export interface Cluster {
  key: string;
  transition: string;
  features: string[];
  /** Number of explored inputs that fell into this cluster. */
  count: number;
  witnesses: Witness[];
}

export interface NondeterminismReport {
  side: 'base' | 'head';
  input: unknown[];
  first: Outcome;
  second: Outcome;
}

export interface ExploreResult {
  inputsRun: number;
  differingInputs: number;
  clusters: Cluster[];
  nondeterministic?: NondeterminismReport;
  /** Clusters dropped because a re-run did not reproduce them. */
  flakyClusters: number;
  stoppedBy: 'runs' | 'deadline' | 'failures' | 'exhausted';
  shrinkEvaluations: number;
  failures: number;
}

interface Pending {
  value: fc.Value<unknown[]>;
  key: string;
}

/** fast-check's own bias schedule: strongly biased towards small values first, then broader. */
function biasFor(runIndex: number): number {
  return 2 + Math.floor(Math.log(runIndex + 1) / Math.log(10));
}

const size = (input: unknown[]) => formatArgs(input, 10_000).length;

export async function explore(options: ExploreOptions): Promise<ExploreResult> {
  const {
    arbitrary,
    evaluate,
    seed,
    runs,
    deadline,
    compare = {},
    maxClusters = 24,
    shrinkBudget = 500,
    maxWitnesses = 3,
    maxFailures = 20,
    selfCheck = 50,
    humanizeBudget = 150,
  } = options;
  const thresholds = options.thresholds ?? [0];
  const mrng = new fc.Random(xoroshiro128plus(seed));

  const realismCache = new Map<string, number>();
  const tierOf = (input: unknown[]): number => {
    if (!options.realism) return 0;
    const k = stableKey(input);
    let t = realismCache.get(k);
    if (t === undefined) {
      t = options.realism(input).tier;
      realismCache.set(k, t);
    }
    return t;
  };
  let outOfDomain = 0;
  /** Domain filter for generated inputs (see `inDomain`). */
  const wanted = (input: unknown[]): boolean => {
    if (!options.inDomain || options.inDomain(input)) return true;
    if (options.strictDomain) return false;
    return outOfDomain++ % 4 === 0;
  };
  const cache = new Map<string, PairOutcome>();
  /** Values that came from explicit examples have no shrink context. */
  const exampleValues = new WeakSet<fc.Value<unknown[]>>();
  const exampleValue = (ex: unknown[]) => {
    const v = new fc.Value(ex, undefined);
    exampleValues.add(v);
    return v;
  };
  const seen = new Set<string>();
  const clusters = new Map<string, Cluster & { seed: fc.Value<unknown[]> }>();
  let inputsRun = 0;
  let differingInputs = 0;
  let failures = 0;
  let shrinkEvaluations = 0;
  let stoppedBy: ExploreResult['stoppedBy'] = 'runs';

  /** Inputs that timed out or crashed on either side (each one is expensive). */
  const countFailures = (r: PairOutcome) => {
    if ([r.base, r.head].some((o) => o.kind === 'timeout' || o.kind === 'crash')) failures++;
  };

  const evalCached = async (inputs: unknown[][]): Promise<PairOutcome[]> => {
    const keys = inputs.map(stableKey);
    const missing: unknown[][] = [];
    const missingKeys: string[] = [];
    keys.forEach((k, i) => {
      if (!cache.has(k) && !missingKeys.includes(k)) {
        missing.push(inputs[i]!);
        missingKeys.push(k);
      }
    });
    if (missing.length > 0) {
      const results = await evaluate(missing);
      results.forEach((r, i) => {
        cache.set(missingKeys[i]!, r);
        countFailures(r);
      });
    }
    return keys.map((k) => cache.get(k)!);
  };

  const classify = (
    input: unknown[],
    r: PairOutcome,
  ): { key: string; transition: string; features: string[]; diff: OutcomeDiff } | null => {
    const diff = diffOutcome(r.base, r.head, compare);
    if (!diff) return null;
    const transition = describeTransition(r.base, r.head, diff);
    const features = inputFeatures(input, thresholds);
    return { key: clusterKey(transition, features), transition, features, diff };
  };

  const record = (value: fc.Value<unknown[]>, r: PairOutcome) => {
    const c = classify(value.value, r);
    if (!c) return;
    differingInputs++;
    const existing = clusters.get(c.key);
    const witness: Witness = { input: value.value, base: r.base, head: r.head, diff: c.diff, minimal: false };
    if (existing) {
      existing.count++;
      existing.witnesses.push(witness);
      existing.witnesses.sort((a, b) => tierOf(b.input) - tierOf(a.input) || size(a.input) - size(b.input));
      existing.witnesses.length = Math.min(existing.witnesses.length, maxWitnesses);
      return;
    }
    if (clusters.size >= maxClusters) return;
    clusters.set(c.key, {
      key: c.key,
      transition: c.transition,
      features: c.features,
      count: 1,
      witnesses: [witness],
      seed: value,
    });
  };

  // 1. Self-consistency check on the first inputs: run them twice per version.
  const first: fc.Value<unknown[]>[] = [];
  for (const ex of options.examples ?? []) {
    if (first.length >= selfCheck) break;
    const k = stableKey(ex);
    if (seen.has(k)) continue;
    seen.add(k);
    first.push(exampleValue(ex));
  }
  let runIndex = 0;
  let stale = 0;
  while (first.length < Math.min(selfCheck, runs) && stale < 100) {
    const v = arbitrary.generate(mrng, biasFor(runIndex++));
    const k = stableKey(v.value);
    if (seen.has(k) || !wanted(v.value)) {
      stale++;
      continue;
    }
    seen.add(k);
    first.push(v);
  }
  if (first.length > 0) {
    const inputs = first.map((v) => v.value);
    const twice = await evaluate([...inputs, ...inputs]);
    const a = twice.slice(0, inputs.length);
    const b = twice.slice(inputs.length);
    for (let i = 0; i < inputs.length; i++) {
      for (const side of ['base', 'head'] as const) {
        const x = a[i]![side];
        const y = b[i]![side];
        if (x.kind === 'timeout' || x.kind === 'crash' || y.kind === 'timeout' || y.kind === 'crash')
          continue;
        if (diffOutcome(x, y, compare)) {
          return {
            inputsRun: inputs.length,
            differingInputs: 0,
            clusters: [],
            nondeterministic: { side, input: inputs[i]!, first: x, second: y },
            flakyClusters: 0,
            stoppedBy: 'runs',
            shrinkEvaluations: 0,
            failures,
          };
        }
      }
      cache.set(stableKey(inputs[i]!), a[i]!);
      countFailures(a[i]!);
      record(first[i]!, a[i]!);
    }
    inputsRun = inputs.length;
  }

  // 2. Remaining explicit examples, then batched exploration.
  const pendingExamples = (options.examples ?? []).filter((ex) => !seen.has(stableKey(ex))).map(exampleValue);
  let batchSize = 64;
  let staleBatches = 0;
  while (inputsRun < runs) {
    if (deadline !== undefined && Date.now() >= deadline) {
      stoppedBy = 'deadline';
      break;
    }
    if (failures >= maxFailures) {
      stoppedBy = 'failures';
      break;
    }
    const batch: Pending[] = [];
    const want = Math.min(batchSize, runs - inputsRun);
    let attempts = 0;
    while (batch.length < want && attempts < want * 4) {
      attempts++;
      const example = pendingExamples.shift();
      const v = example ?? arbitrary.generate(mrng, biasFor(runIndex++));
      if (!example && !wanted(v.value)) continue;
      const k = stableKey(v.value);
      if (seen.has(k)) continue;
      seen.add(k);
      batch.push({ value: v, key: k });
    }
    if (batch.length === 0) {
      if (++staleBatches >= 3) {
        stoppedBy = 'exhausted';
        break;
      }
      continue;
    }
    staleBatches = 0;
    const results = await evaluate(batch.map((p) => p.value.value));
    results.forEach((r, i) => {
      cache.set(batch[i]!.key, r);
      countFailures(r);
      record(batch[i]!.value, r);
    });
    inputsRun += batch.length;
    batchSize = Math.min(256, batchSize * 2);
    options.onProgress?.({ inputsRun, clusters: clusters.size });
  }

  // 3. Shrink one witness per cluster, accepting only candidates that stay in the same cluster.
  for (const cluster of clusters.values()) {
    let cur = cluster.seed;
    let evals = 0;
    if (exampleValues.has(cur) && !arbitrary.canShrinkWithoutContext(cur.value)) continue;
    let improved = true;
    while (improved && evals < shrinkBudget) {
      improved = false;
      const it = arbitrary.shrink(cur.value, cur.context)[Symbol.iterator]();
      let done = false;
      while (!done && evals < shrinkBudget) {
        const chunk: fc.Value<unknown[]>[] = [];
        while (chunk.length < 16) {
          const n = it.next();
          if (n.done) {
            done = true;
            break;
          }
          chunk.push(n.value);
        }
        if (chunk.length === 0) break;
        const results = await evalCached(chunk.map((c) => c.value));
        evals += chunk.length;
        const hit = chunk.findIndex((c, i) => classify(c.value, results[i]!)?.key === cluster.key);
        if (hit !== -1) {
          cur = chunk[hit]!;
          improved = true;
          break;
        }
      }
      if (failures >= maxFailures * 2) break;
    }
    shrinkEvaluations += evals;
    // Humanize the shrunk witness and the other kept witnesses, then keep the simplest distinct ones.
    const sameCluster = async (candidates: unknown[][]) => {
      const results = await evalCached(candidates);
      return candidates.map((c, i) => classify(c, results[i]!)?.key === cluster.key);
    };
    const starts = [cur.value, ...cluster.witnesses.map((w) => w.input)];
    const finals = new Map<string, unknown[]>();
    for (const start of starts.slice(0, maxWitnesses + 1)) {
      const h = await humanize(start, { sameCluster, thresholds, budget: humanizeBudget });
      shrinkEvaluations += h.evaluations;
      finals.set(stableKey(h.input), h.input);
      finals.set(stableKey(start), start);
    }
    const ranked = [...finals.values()]
      .filter((input) => classify(input, cache.get(stableKey(input))!)?.key === cluster.key)
      .sort((a, b) => tierOf(b) - tierOf(a) || inputComplexity(a) - inputComplexity(b))
      .slice(0, maxWitnesses);
    cluster.witnesses = ranked.map((input, i) => {
      const r = cache.get(stableKey(input))!;
      const w: Witness = {
        input,
        base: r.base,
        head: r.head,
        diff: classify(input, r)!.diff,
        minimal: i === 0,
      };
      if (options.realism) w.realism = options.realism(input);
      return w;
    });
  }

  // Score every witness (including clusters that could not be shrunk) and order them most realistic first.
  if (options.realism) {
    for (const cluster of clusters.values()) {
      for (const w of cluster.witnesses) w.realism ??= options.realism(w.input);
      cluster.witnesses.sort(
        (a, b) => b.realism!.tier - a.realism!.tier || inputComplexity(a.input) - inputComplexity(b.input),
      );
      cluster.witnesses.forEach((w, i) => (w.minimal = i === 0));
    }
  }

  // 4. Confirmation: re-run every reported witness once more (uncached) and drop clusters that do not reproduce.
  let flakyClusters = 0;
  const confirmed: Cluster[] = [];
  const all = [...clusters.values()];
  const witnessInputs = all.flatMap((c) => c.witnesses.map((w) => w.input));
  const rerun = witnessInputs.length > 0 ? await evaluate(witnessInputs) : [];
  let idx = 0;
  for (const c of all) {
    let stable = true;
    for (const w of c.witnesses) {
      const r = rerun[idx++]!;
      if (diffOutcome(w.base, r.base, compare) || diffOutcome(w.head, r.head, compare)) stable = false;
    }
    if (!stable) {
      flakyClusters++;
      continue;
    }
    const { seed: _seed, ...rest } = c;
    confirmed.push(rest);
  }
  confirmed.sort((a, b) => b.count - a.count);

  return {
    inputsRun,
    differingInputs,
    clusters: confirmed,
    flakyClusters,
    stoppedBy,
    shrinkEvaluations,
    failures,
  };
}
