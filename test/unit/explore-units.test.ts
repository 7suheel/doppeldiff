import { describe, expect, it } from 'vitest';
import { argFeature, describeTransition } from '../../src/core/explore/cluster.js';
import {
  humanize,
  leaves,
  numberCandidates,
  numberComplexity,
  setLeaf,
} from '../../src/core/explore/humanize.js';
import { encode } from '../../src/core/runner/encode.js';
import { stableKey } from '../../src/core/util/stableKey.js';
import { diffOutcome } from '../../src/core/compare/compare.js';
import type { Outcome } from '../../src/core/compare/observed.js';

const ret = (v: unknown): Outcome => ({ kind: 'return', value: encode(v), async: false, args: [] });

describe('clustering features', () => {
  it('buckets numbers relative to thresholds', () => {
    const t = [0, 1000];
    expect(argFeature(1500, t)).toBe('>1000');
    expect(argFeature(500, t)).toBe('(0,1000)');
    expect(argFeature(-1, t)).toBe('<0');
    expect(argFeature(1000, t)).toBe('=1000');
    expect(argFeature(NaN, t)).toBe('NaN');
    expect(argFeature(-0, t)).toBe('-0');
  });

  it('describes transitions', () => {
    const a = ret(1);
    const b = ret(NaN);
    expect(describeTransition(a, b, diffOutcome(a, b)!)).toBe('returns positive number → returns NaN');
    const c = ret(2);
    expect(describeTransition(a, c, diffOutcome(a, c)!)).toBe('returns positive number: value changed');
  });
});

describe('humanize', () => {
  it('ranks simple numbers lower', () => {
    expect(numberComplexity(0)).toBeLessThan(numberComplexity(1));
    expect(numberComplexity(1001)).toBeLessThan(numberComplexity(9007199254740991));
    expect(numberComplexity(0.15)).toBeLessThan(numberComplexity(2.220446049250313e-16));
    expect(numberCandidates(9007199254740991, [1000])).toContain(1001);
  });

  it('enumerates and replaces leaves without mutating the input', () => {
    const input = [[{ price: 12.345, name: 'x' }], 7];
    expect(leaves(input).map((l) => l.path)).toEqual([[0, 0, 'price'], [0, 0, 'name'], [1]]);
    const next = setLeaf(input, [0, 0, 'price'], 1);
    expect(next).toEqual([[{ price: 1, name: 'x' }], 7]);
    expect(input).toEqual([[{ price: 12.345, name: 'x' }], 7]);
  });

  it('simplifies leaves while the predicate holds', async () => {
    // Behavior difference exists whenever x > 1000 and y is non-zero.
    const pred = (i: unknown[]) => (i[0] as number) > 1000 && (i[1] as number) !== 0;
    const { input } = await humanize([9007199254740991, 2.220446049250313e-16], {
      sameCluster: async (cands) => cands.map(pred),
      thresholds: [1000],
      budget: 200,
    });
    expect(input).toEqual([2000, 1]);
  });
});

describe('stableKey', () => {
  it('distinguishes values that JSON conflates', () => {
    expect(stableKey([0])).not.toBe(stableKey([-0]));
    expect(stableKey([NaN])).not.toBe(stableKey([null]));
    expect(stableKey([undefined])).not.toBe(stableKey([null]));
    expect(stableKey(new Map([[1, 2]]))).not.toBe(stableKey({ 1: 2 }));
    expect(stableKey({ a: 1 })).toBe(stableKey({ a: 1 }));
  });
});
