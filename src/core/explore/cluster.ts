import type { OutcomeDiff } from '../compare/compare.js';
import type { Outcome } from '../compare/observed.js';
import { outcomeCategory } from '../format/format.js';
import { isFnDescriptor, isProtoDescriptor } from '../runner/tags.js';

/**
 * A behavior difference is described by (a) the outcome transition, e.g. "returns number → returns NaN",
 * and (b) a coarse input feature vector, e.g. "arg0>1000". Together they form the cluster key.
 */
export function describeTransition(base: Outcome, head: Outcome, diff: OutcomeDiff): string {
  const a = outcomeCategory(base);
  const b = outcomeCategory(head);
  if (a !== b) return `${a} → ${b}`;
  switch (diff.aspect) {
    case 'value':
      return `${a}: value changed`;
    case 'error':
      return `${a}: ${diff.path.includes('message') ? 'message changed' : 'error changed'}`;
    case 'mutation':
      return `${a}: argument ${String(diff.path[0])} mutated differently`;
    case 'async':
      return `${a}: sync/async changed`;
    default:
      return `${a} → ${b}`;
  }
}

function fmtThreshold(t: number): string {
  return Object.is(t, -0) ? '-0' : String(t);
}

/** Coarse feature of a single argument. Numeric features are relative to mined decision thresholds. */
export function argFeature(v: unknown, thresholds: readonly number[]): string {
  switch (typeof v) {
    case 'number': {
      if (Number.isNaN(v)) return 'NaN';
      if (v === Infinity) return '+Inf';
      if (v === -Infinity) return '-Inf';
      if (Object.is(v, -0)) return '-0';
      const ts = thresholds.length > 0 ? thresholds : [0];
      const eq = ts.find((t) => t === v);
      if (eq !== undefined) return `=${fmtThreshold(eq)}`;
      const below = ts.find((t) => v < t);
      const above = [...ts].reverse().find((t) => v > t);
      if (above === undefined) return `<${fmtThreshold(below!)}`;
      if (below === undefined) return `>${fmtThreshold(above)}`;
      return `(${fmtThreshold(above)},${fmtThreshold(below)})`;
    }
    case 'string':
      return v.length === 0 ? 'empty' : v.trim().length === 0 ? 'blank' : 'text';
    case 'boolean':
      return String(v);
    case 'undefined':
      return 'undefined';
    case 'bigint':
      return v < 0n ? 'neg' : v === 0n ? '0n' : 'pos';
    case 'object':
      if (v === null) return 'null';
      if (isFnDescriptor(v)) return 'fn';
      if (isProtoDescriptor(v)) return 'inherited{…}';
      if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return 'binary';
      if (Array.isArray(v)) return v.length === 0 ? 'empty[]' : '[…]';
      if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'InvalidDate' : 'Date';
      if (v instanceof Map || v instanceof Set) return v.size === 0 ? 'empty' : 'nonempty';
      return Object.keys(v).length === 0 ? '{}' : '{…}';
    default:
      return typeof v;
  }
}

export function inputFeatures(input: unknown[], thresholds: readonly number[]): string[] {
  return input.map((v) => argFeature(v, thresholds));
}

export function clusterKey(transition: string, features: string[]): string {
  return `${transition} | ${features.join(' ')}`;
}
