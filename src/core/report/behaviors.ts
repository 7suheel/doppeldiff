import type { Outcome } from '../compare/observed.js';
import type { Cluster, Witness } from '../explore/explore.js';
import { encCategory, formatOutcome } from '../format/format.js';
import { inputComplexity } from '../explore/humanize.js';

/**
 * A behavior is what a reviewer reasons about: "now returns NaN where it used to return a number".
 * It groups fine-grained clusters whose coarse transition is the same.
 */
export interface Behavior {
  /** Coarse transition key, e.g. "returns number → returns NaN". */
  key: string;
  /** Human-readable title, e.g. "now returns NaN (previously a number)". */
  title: string;
  /** Number of explored inputs that showed this behavior. */
  count: number;
  /** Fine-grained variants (transition + input region). */
  variants: { transition: string; features: string[]; count: number }[];
  /** Up to `maxExamples` examples, simplest first, from distinct variants when possible. */
  examples: Witness[];
}

/** Coarse value category: numbers of any sign (including ±Infinity) are "number"; NaN stays distinct. */
function coarseCategory(o: Outcome): string {
  switch (o.kind) {
    case 'return': {
      let c = encCategory(o.value);
      if (['0', '-0', 'positive number', 'negative number', 'Infinity', '-Infinity'].includes(c))
        c = 'number';
      else if (c === 'empty string') c = 'string';
      else if (c === 'empty array') c = 'array';
      return `${o.async ? 'resolves' : 'returns'} ${c}`;
    }
    case 'throw':
      return `${o.async ? 'rejects' : 'throws'} ${encCategory(o.error)}`;
    case 'timeout':
      return 'timeout';
    case 'crash':
      return 'crash';
  }
}

export function coarseKey(w: Witness): string {
  const a = coarseCategory(w.base);
  const b = coarseCategory(w.head);
  if (a !== b) return `${a} → ${b}`;
  if (w.diff.aspect === 'mutation') return `${a}: mutates argument ${String(w.diff.path[0])} differently`;
  if (w.diff.aspect === 'async') return `${a}: sync/async changed`;
  if (w.diff.aspect === 'error') return `${a}: error changed`;
  return `${a}: value changed`;
}

const NO_ARTICLE = new Set(['undefined', 'null', 'NaN', 'Infinity', '-Infinity', 'Invalid Date']);
const valueWord = (cat: string) => (NO_ARTICLE.has(cat) ? cat : `a ${cat}`.replace(/^a ([aeiou])/i, 'an $1'));

/** Plain-English title for a coarse transition. */
export function behaviorTitle(w: Witness): string {
  const a = coarseCategory(w.base);
  const b = coarseCategory(w.head);
  const [aVerb, ...aRest] = a.split(' ');
  const [bVerb, ...bRest] = b.split(' ');
  const aWhat = aRest.join(' ');
  const bWhat = bRest.join(' ');
  if (a === b) {
    switch (w.diff.aspect) {
      case 'mutation':
        return `mutates argument ${Number(w.diff.path[0]) + 1} differently`;
      case 'async':
        return 'changed between sync and async';
      case 'error':
        return `still ${aVerb} ${aWhat}, but with a different ${w.diff.path.includes('message') ? 'message' : 'error'}`;
      default:
        return aVerb === 'resolves' ? 'resolved value changed' : 'return value changed';
    }
  }
  if (b === 'timeout') return 'now hangs (times out)';
  if (a === 'timeout') return `no longer hangs; now ${b}`;
  if (b === 'crash') return 'now crashes the process';
  if (a === 'crash') return `no longer crashes; now ${b}`;
  const isThrow = (v: string | undefined) => v === 'throws' || v === 'rejects';
  if (isThrow(bVerb) && !isThrow(aVerb))
    return `now ${bVerb} ${bWhat} (previously ${aVerb === 'resolves' ? 'resolved' : 'returned'} ${valueWord(aWhat)})`;
  if (isThrow(aVerb) && !isThrow(bVerb))
    return `no longer ${aVerb === 'throws' ? 'throws' : 'rejects with'} ${aWhat}; now ${bVerb} ${valueWord(bWhat)}`;
  if (isThrow(aVerb) && isThrow(bVerb)) return `now ${bVerb} ${bWhat} instead of ${aWhat}`;
  if (aVerb !== bVerb)
    return `now ${bVerb === 'resolves' ? 'returns a promise' : 'returns synchronously'} (${b}, previously ${a})`;
  return `now ${bVerb} ${valueWord(bWhat)} (previously ${valueWord(aWhat)})`;
}

/** Group clusters into behaviors, ordered by number of affected inputs. */
export function groupBehaviors(clusters: Cluster[], maxExamples = 3): Behavior[] {
  const groups = new Map<string, { title: string; clusters: Cluster[] }>();
  for (const c of clusters) {
    const w = c.witnesses[0];
    if (!w) continue;
    const key = coarseKey(w);
    const g = groups.get(key) ?? { title: behaviorTitle(w), clusters: [] };
    g.clusters.push(c);
    groups.set(key, g);
  }
  const behaviors: Behavior[] = [];
  for (const [key, g] of groups) {
    const sorted = [...g.clusters].sort((x, y) => y.count - x.count);
    // Prefer simple examples that show *different* old → new outcomes; then fill with the next simplest.
    const firsts = sorted
      .map((c) => c.witnesses[0]!)
      .sort((x, y) => inputComplexity(x.input) - inputComplexity(y.input));
    const rest = sorted
      .flatMap((c) => c.witnesses.slice(1))
      .sort((x, y) => inputComplexity(x.input) - inputComplexity(y.input));
    const candidates = [...firsts, ...rest];
    const pairKey = (w: Witness) => `${formatOutcome(w.base)}\u0000${formatOutcome(w.head)}`;
    const usedPairs = new Set<string>();
    const examples: Witness[] = [];
    for (const w of candidates) {
      if (examples.length >= maxExamples) break;
      if (usedPairs.has(pairKey(w))) continue;
      usedPairs.add(pairKey(w));
      examples.push(w);
    }
    for (const w of candidates) {
      if (examples.length >= maxExamples) break;
      if (!examples.includes(w)) examples.push(w);
    }
    behaviors.push({
      key,
      title: g.title,
      count: sorted.reduce((s, c) => s + c.count, 0),
      variants: sorted.map((c) => ({ transition: c.transition, features: c.features, count: c.count })),
      examples: examples.map((e, i) => ({ ...e, minimal: i === 0 })),
    });
  }
  return behaviors.sort((x, y) => y.count - x.count);
}
