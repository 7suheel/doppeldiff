import fc from 'fast-check';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { compileSignature, compileSpec } from '../../src/core/arbitraries/compile.js';
import { mineValues, nextAfter } from '../../src/core/arbitraries/mine.js';
import { isFnDescriptor } from '../../src/core/runner/tags.js';
import type { ArbSpec } from '../../src/core/types/spec.js';

const sample = (spec: ArbSpec, n = 300) => fc.sample(compileSpec(spec)!, { seed: 1, numRuns: n });

describe('ArbSpec → fast-check', () => {
  it('generates values of the right shape', () => {
    for (const v of sample({ kind: 'number' })) expect(typeof v).toBe('number');
    for (const v of sample({ kind: 'string' })) expect(typeof v).toBe('string');
    for (const v of sample({ kind: 'date' })) expect(v).toBeInstanceOf(Date);
    for (const v of sample({ kind: 'array', items: { kind: 'boolean' } }))
      expect(Array.isArray(v)).toBe(true);
    for (const v of sample({ kind: 'map', key: { kind: 'string' }, value: { kind: 'number' } }))
      expect(v).toBeInstanceOf(Map);
  });

  it('includes boundary values for numbers', () => {
    const values = sample({ kind: 'number' }, 2000) as number[];
    expect(values.some((v) => Number.isNaN(v))).toBe(true);
    expect(values.some((v) => Object.is(v, -0))).toBe(true);
    expect(values.some((v) => v === Infinity)).toBe(true);
    expect(values.some((v) => v === 0)).toBe(true);
  });

  it('respects optional object properties and generates plain objects', () => {
    const spec: ArbSpec = {
      kind: 'object',
      props: [
        { name: 'a', spec: { kind: 'number' }, optional: false },
        { name: 'b', spec: { kind: 'string' }, optional: true },
      ],
    };
    const values = sample(spec, 500) as Record<string, unknown>[];
    expect(values.every((v) => 'a' in v)).toBe(true);
    expect(values.some((v) => !('b' in v))).toBe(true);
    expect(values.some((v) => 'b' in v)).toBe(true);
    expect(values.every((v) => Object.getPrototypeOf(v) === Object.prototype)).toBe(true);
  });

  it('terminates recursive specs at the depth limit', () => {
    const spec: ArbSpec = {
      kind: 'recursive',
      id: 'T',
      spec: {
        kind: 'object',
        props: [
          { name: 'children', spec: { kind: 'array', items: { kind: 'ref', id: 'T' } }, optional: false },
        ],
      },
    };
    const depth = (t: { children: unknown[] }): number =>
      1 + Math.max(0, ...t.children.map((c) => depth(c as { children: unknown[] })));
    for (const v of sample(spec, 200)) expect(depth(v as { children: unknown[] })).toBeLessThanOrEqual(5);
  });

  it('produces function descriptors for callbacks', () => {
    for (const v of sample({ kind: 'function', returns: { kind: 'number' }, async: false }, 20)) {
      expect(isFnDescriptor(v)).toBe(true);
    }
  });

  it('drops unsupported union options and returns null when nothing is possible', () => {
    expect(compileSpec({ kind: 'unsupported', reason: 'x' })).toBeNull();
    const u = compileSpec({
      kind: 'union',
      options: [{ kind: 'unsupported', reason: 'x' }, { kind: 'null' }],
    })!;
    expect(fc.sample(u, 10).every((v) => v === null)).toBe(true);
  });

  it('compiles rest parameters into variadic argument lists', () => {
    const arb = compileSignature({
      params: [
        { name: 'a', spec: { kind: 'string' }, optional: false, rest: false },
        { name: 'xs', spec: { kind: 'number' }, optional: false, rest: true },
      ],
      async: false,
    })!;
    const lens = new Set(fc.sample(arb, { seed: 3, numRuns: 200 }).map((args) => args.length));
    expect(lens.has(1)).toBe(true);
    expect([...lens].some((l) => l > 2)).toBe(true);
  });

  it('is reproducible for a given seed', () => {
    const arb = compileSpec({ kind: 'array', items: { kind: 'number' } })!;
    expect(fc.sample(arb, { seed: 7, numRuns: 50 })).toEqual(fc.sample(arb, { seed: 7, numRuns: 50 }));
  });
});

describe('value mining', () => {
  it('mines literals, thresholds and neighbours', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const sf = project.createSourceFile(
      '/m.ts',
      "export function f(p: number, s: string) { if (p > 1000) return 'big'; if (s === 'VIP') return -5; return p * 0.15; }",
    );
    const mined = mineValues([sf]);
    expect(mined.thresholds).toEqual([1000]);
    expect(mined.numbers).toEqual(
      expect.arrayContaining([1000, 1001, 999, 1000.01, 999.99, -5, 0.15, nextAfter(1000, Infinity)]),
    );
    expect(mined.strings).toEqual(expect.arrayContaining(['VIP', 'vip', ' VIP ', 'big', '']));
  });

  it('computes adjacent doubles', () => {
    expect(nextAfter(1, Infinity)).toBe(1 + Number.EPSILON);
    expect(nextAfter(0, -Infinity)).toBe(-Number.MIN_VALUE);
    expect(nextAfter(-1, Infinity)).toBeGreaterThan(-1);
  });
});
