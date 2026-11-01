import { isFnDescriptor } from '../runner/tags.js';

/**
 * "Humanizing" shrink pass. fast-check's shrinker minimizes structurally, but a minimal double such as
 * 9007199254740991 or 2.220446049250313e-16 is not what a reviewer wants to read. This pass tries to
 * replace each numeric/string leaf of an input with a simpler value (0, 1, 0.5, 1001, "a", …) while the
 * input stays in the same behavior cluster.
 */
export type LeafPath = (string | number)[];

export interface Leaf {
  path: LeafPath;
  value: number | string;
}

/** Enumerate numeric and string leaves of an input (arrays and plain objects only). */
export function leaves(input: unknown[]): Leaf[] {
  const out: Leaf[] = [];
  const walk = (v: unknown, path: LeafPath, depth: number) => {
    if (depth > 6) return;
    if (typeof v === 'number' || typeof v === 'string') {
      out.push({ path, value: v });
      return;
    }
    if (typeof v !== 'object' || v === null || isFnDescriptor(v)) return;
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, [...path, i], depth + 1));
      return;
    }
    if (Object.getPrototypeOf(v) !== Object.prototype) return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, [...path, k], depth + 1);
  };
  input.forEach((v, i) => walk(v, [i], 0));
  return out;
}

/** Copy of `input` with the leaf at `path` replaced. Only arrays and plain objects along the path are copied. */
export function setLeaf(input: unknown[], path: LeafPath, value: unknown): unknown[] {
  const copy = (node: unknown, i: number): unknown => {
    if (i === path.length) return value;
    const key = path[i]!;
    if (Array.isArray(node)) {
      const arr = node.slice();
      arr[key as number] = copy(node[key as number], i + 1);
      return arr;
    }
    const obj = { ...(node as Record<string, unknown>) };
    obj[key as string] = copy(obj[key as string], i + 1);
    return obj;
  };
  return copy(input, 0) as unknown[];
}

/** Lower is simpler. 0 < small integers < round decimals < long or special values. */
export function numberComplexity(n: number): number {
  if (Object.is(n, 0)) return 0;
  if (Number.isNaN(n) || !Number.isFinite(n)) return 6;
  if (Object.is(n, -0)) return 3;
  const s = String(Math.abs(n));
  if (s.includes('e')) return 25;
  const digits = s.replace('.', '').replace(/^0+/, '').replace(/0+$/, '').length || 1;
  return digits + (n < 0 ? 1 : 0) + (Number.isInteger(n) ? 0 : 1);
}

export function stringComplexity(s: string): number {
  let c = s.length;
  for (const ch of s) if (!/[a-z0-9 ]/.test(ch)) c += 1;
  return c;
}

export function valueComplexity(v: number | string): number {
  return typeof v === 'number' ? numberComplexity(v) : stringComplexity(v);
}

/** Total complexity of an input: used to rank witnesses. */
export function inputComplexity(input: unknown[]): number {
  return (
    leaves(input).reduce((s, l) => s + valueComplexity(l.value), 0) +
    JSON.stringify(input, (_k, v) => (typeof v === 'bigint' ? String(v) : v))?.length / 100
  );
}

const NICE_NUMBERS = [
  0, 1, -1, 2, 0.5, 10, 0.1, 0.15, 0.25, 0.2, 3, 5, 100, -10, 1.5, 0.01, 1000, 0.99, 99.99,
];

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

export function numberCandidates(n: number, thresholds: readonly number[]): number[] {
  const set = new Set<number>(NICE_NUMBERS);
  if (Number.isFinite(n)) {
    for (const d of [0, 1, 2]) set.add(round(n, d));
    set.add(Math.trunc(n));
    if (n !== 0) {
      const mag = 10 ** Math.floor(Math.log10(Math.abs(n)));
      for (const m of [1, 2, 5]) set.add(Math.sign(n) * m * mag);
      set.add(-n);
    }
  }
  for (const t of thresholds) {
    for (const d of [0, 1, -1, 0.5, -0.5, 0.01, -0.01, 0.07, -0.07, 0.99, 0.1]) set.add(round(t + d, 2));
    set.add(t * 2);
  }
  const c = numberComplexity(n);
  return [...set]
    .filter((x) => Number.isFinite(x) && !Object.is(x, n) && numberComplexity(x) < c)
    .sort((a, b) => numberComplexity(a) - numberComplexity(b) || Math.abs(a) - Math.abs(b))
    .slice(0, 40);
}

export function stringCandidates(s: string): string[] {
  const set = new Set<string>(['', 'a', ' ', '-', 'A', '0', 'a b', 'é']);
  const ascii = s.replace(/[^\x20-\x7e]/g, '');
  set.add(ascii);
  set.add(s.trim());
  for (let k = 1; k < Math.min(s.length, 8); k++) set.add(s.slice(0, k));
  for (const ch of new Set(s)) set.add(ch);
  const c = stringComplexity(s);
  return [...set]
    .filter((x) => x !== s && stringComplexity(x) < c)
    .sort((a, b) => stringComplexity(a) - stringComplexity(b))
    .slice(0, 24);
}

export interface HumanizeOptions {
  /** True if `candidate` still exhibits the same behavior difference. Evaluates in batches. */
  sameCluster: (candidates: unknown[][]) => Promise<boolean[]>;
  thresholds: readonly number[];
  budget: number;
}

/** Simplify leaves one at a time until no leaf can be simplified or the budget is used. */
export async function humanize(
  input: unknown[],
  options: HumanizeOptions,
): Promise<{ input: unknown[]; evaluations: number }> {
  let cur = input;
  let evaluations = 0;
  let improved = true;
  while (improved && evaluations < options.budget) {
    improved = false;
    for (const leaf of leaves(cur)) {
      if (evaluations >= options.budget) break;
      const values =
        typeof leaf.value === 'number'
          ? numberCandidates(leaf.value, options.thresholds)
          : stringCandidates(leaf.value);
      if (values.length === 0) continue;
      const take = values.slice(0, Math.max(1, options.budget - evaluations));
      const candidates = take.map((v) => setLeaf(cur, leaf.path, v));
      const ok = await options.sameCluster(candidates);
      evaluations += candidates.length;
      const hit = ok.findIndex(Boolean);
      if (hit !== -1) {
        cur = candidates[hit]!;
        improved = true;
      }
    }
  }
  return { input: cur, evaluations };
}
