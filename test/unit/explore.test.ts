import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Outcome } from '../../src/core/compare/observed.js';
import { explore, type PairOutcome } from '../../src/core/explore/explore.js';
import { encode } from '../../src/core/runner/encode.js';

/** In-process evaluator for fast, deterministic tests of the exploration loop. */
function inProcess(base: (...a: never[]) => unknown, head: (...a: never[]) => unknown) {
  const call = (f: (...a: never[]) => unknown, input: unknown[]): Outcome => {
    const args = structuredClone(input) as never[];
    try {
      return { kind: 'return', value: encode(f(...args)), async: false, args: args.map((a) => encode(a)) };
    } catch (e) {
      return { kind: 'throw', error: encode(e), async: false, args: args.map((a) => encode(a)) };
    }
  };
  let calls = 0;
  const evaluate = async (inputs: unknown[][]): Promise<PairOutcome[]> => {
    calls += inputs.length;
    return inputs.map((i) => ({ base: call(base, i), head: call(head, i) }));
  };
  return { evaluate, calls: () => calls };
}

const numPair = fc.tuple(
  fc.oneof(fc.integer({ min: -2000, max: 2000 }), fc.double()),
  fc.double({ min: 0, max: 1, noNaN: true }),
);

describe('explore', () => {
  it('finds no clusters for equivalent implementations', async () => {
    const { evaluate } = inProcess(
      (a: number, b: number) => a * b,
      (a: number, b: number) => b * a,
    );
    const r = await explore({ arbitrary: numPair, evaluate, seed: 1, runs: 500 });
    expect(r.clusters).toEqual([]);
    expect(r.inputsRun).toBe(500);
  });

  it('finds distinct clusters and shrinks each within its cluster', async () => {
    const base = (p: number) => {
      if (p < 0) throw new RangeError('negative');
      return p > 1000 ? Math.floor(p) : p;
    };
    const head = (p: number) => (p > 1000 ? Math.round(p) : p < 0 ? NaN : p);
    const { evaluate } = inProcess(base, head);
    const r = await explore({
      arbitrary: fc.tuple(
        fc.oneof(fc.integer({ min: -5000, max: 5000 }), fc.double({ min: -5000, max: 5000, noNaN: true })),
      ),
      evaluate,
      seed: 7,
      runs: 1000,
      thresholds: [0, 1000],
    });
    const transitions = r.clusters.map((c) => c.transition).sort();
    expect(transitions).toEqual([
      'returns positive number: value changed',
      'throws RangeError → returns NaN',
    ]);
    const neg = r.clusters.find((c) => c.transition.startsWith('throws'))!;
    expect(neg.witnesses[0]!.minimal).toBe(true);
    expect(neg.witnesses[0]!.input).toEqual([-1]);
    const big = r.clusters.find((c) => c.transition.includes('value changed'))!;
    const [p] = big.witnesses[0]!.input as [number];
    expect(p).toBeGreaterThan(1000);
    expect(Math.round(p) !== Math.floor(p)).toBe(true);
  });

  it('is reproducible for the same seed', async () => {
    const make = () =>
      inProcess(
        (s: string) => s.trim(),
        (s: string) => s.replace(/^ +| +$/g, ''),
      );
    const arb = fc.tuple(fc.string({ unit: fc.constantFrom(' ', '\t', 'a'), maxLength: 6 }));
    const a = await explore({ arbitrary: arb, evaluate: make().evaluate, seed: 99, runs: 300 });
    const b = await explore({ arbitrary: arb, evaluate: make().evaluate, seed: 99, runs: 300 });
    expect(a.clusters.map((c) => c.witnesses.map((w) => w.input))).toEqual(
      b.clusters.map((c) => c.witnesses.map((w) => w.input)),
    );
    expect(a.clusters.length).toBeGreaterThan(0);
  });

  it('detects nondeterministic versions', async () => {
    let n = 0;
    const { evaluate } = inProcess(
      (x: number) => x,
      () => n++,
    );
    const r = await explore({ arbitrary: fc.tuple(fc.integer()), evaluate, seed: 1, runs: 100 });
    expect(r.nondeterministic?.side).toBe('head');
    expect(r.clusters).toEqual([]);
  });

  it('stops when the input space is exhausted', async () => {
    const { evaluate } = inProcess(
      (b: boolean) => b,
      (b: boolean) => b,
    );
    const r = await explore({ arbitrary: fc.tuple(fc.boolean()), evaluate, seed: 1, runs: 1000 });
    expect(r.inputsRun).toBe(2);
    expect(r.stoppedBy).toBe('exhausted');
  });

  it('runs explicit examples first', async () => {
    const { evaluate } = inProcess(
      (x: number) => x,
      (x: number) => (x === 123456.789 ? -x : x),
    );
    const r = await explore({
      arbitrary: fc.tuple(fc.integer({ min: 0, max: 10 })),
      evaluate,
      seed: 1,
      runs: 50,
      examples: [[123456.789]],
    });
    expect(r.clusters).toHaveLength(1);
  });
});

describe('timeouts', () => {
  const timeout: Outcome = { kind: 'timeout', ms: 250 };
  const ret = (v: unknown): Outcome => ({ kind: 'return', value: encode(v), async: false, args: [] });
  const sizes = fc.oneof(
    { arbitrary: fc.integer({ min: 0, max: 50 }), weight: 9 },
    { arbitrary: fc.integer({ min: 1e15, max: 1e15 + 1000 }), weight: 1 },
  );
  const huge = (n: number) => (n >= 1e9 ? { tier: 0 as const, reason: 'huge number' } : { tier: 2 as const });

  it('keeps exploring after timeouts on edge-case inputs and skips similar ones', async () => {
    const evaluate = async (inputs: unknown[][]): Promise<PairOutcome[]> =>
      inputs.map(([n]) =>
        (n as number) >= 1e9 ? { base: timeout, head: timeout } : { base: ret(n), head: ret(n) },
      );
    const r = await explore({
      arbitrary: fc.tuple(sizes),
      evaluate,
      seed: 1,
      runs: 200,
      selfCheck: 0,
      maxFailures: 3,
      realism: ([n]) => huge(n as number),
    });
    expect(r.stoppedBy).not.toBe('failures');
    expect(r.edgeFailures).toBeGreaterThanOrEqual(2);
    expect(r.skippedEdgeInputs).toBeGreaterThan(0);
  });

  it('still stops after repeated timeouts on ordinary inputs', async () => {
    const evaluate = async (inputs: unknown[][]): Promise<PairOutcome[]> =>
      inputs.map(() => ({ base: timeout, head: timeout }));
    const r = await explore({
      arbitrary: fc.tuple(fc.integer({ min: 0, max: 1000 })),
      evaluate,
      seed: 1,
      runs: 1000,
      maxFailures: 5,
      realism: () => ({ tier: 2 }),
    });
    expect(r.stoppedBy).toBe('failures');
  });

  it('re-runs a timeout on an ordinary input once before believing it', async () => {
    let calls = 0;
    // The first call for 7 times out (a busy machine), the second one returns.
    const evaluate = async (inputs: unknown[][]): Promise<PairOutcome[]> =>
      inputs.map(([n]) => {
        if (n === 7 && calls++ === 0) return { base: timeout, head: ret(7) };
        return { base: ret(n), head: ret(n) };
      });
    const r = await explore({
      arbitrary: fc.tuple(fc.constantFrom(7, 8)),
      evaluate,
      seed: 1,
      runs: 2,
      examples: [[7]],
      selfCheck: 0,
      realism: () => ({ tier: 2 }),
    });
    expect(r.clusters).toEqual([]);
    expect(r.failures).toBe(0);
  });
});
