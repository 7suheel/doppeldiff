import { describe, expect, it } from 'vitest';
import { diffEnc, diffOutcome } from '../../src/core/compare/compare.js';
import type { Outcome } from '../../src/core/compare/observed.js';
import { encode } from '../../src/core/runner/encode.js';

const eq = (a: unknown, b: unknown, opts = {}) => diffEnc(encode(a), encode(b), opts) === null;
const ret = (v: unknown, args: unknown[] = []): Outcome => ({
  kind: 'return',
  value: encode(v),
  async: false,
  args: args.map((a) => encode(a)),
});
const thr = (e: unknown): Outcome => ({ kind: 'throw', error: encode(e), async: false, args: [] });

describe('structural equality', () => {
  it('treats NaN as equal to NaN but -0 as different from 0', () => {
    expect(eq(NaN, NaN)).toBe(true);
    expect(eq(0, -0)).toBe(false);
    expect(eq(0, -0, { epsilon: 1e-9 })).toBe(true);
    expect(eq(0.1 + 0.2, 0.3)).toBe(false);
    expect(eq(0.1 + 0.2, 0.3, { epsilon: 1e-9 })).toBe(true);
  });

  it('compares dates by time value, including invalid dates', () => {
    expect(eq(new Date(5), new Date(5))).toBe(true);
    expect(eq(new Date(5), new Date(6))).toBe(false);
    expect(eq(new Date(NaN), new Date(NaN))).toBe(true);
  });

  it('compares Map and Set by contents, ignoring order', () => {
    expect(
      eq(
        new Map([
          [1, 'a'],
          [2, 'b'],
        ]),
        new Map([
          [2, 'b'],
          [1, 'a'],
        ]),
      ),
    ).toBe(true);
    expect(eq(new Map([[1, 'a']]), new Map([[1, 'b']]))).toBe(false);
    expect(eq(new Set([1, 2]), new Set([2, 1]))).toBe(true);
    expect(eq(new Set([1, 2]), new Set([1, 3]))).toBe(false);
  });

  it('treats undefined properties as missing unless strictUndefined', () => {
    expect(eq({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(eq({ a: 1, b: undefined }, { a: 1 }, { strictUndefined: true })).toBe(false);
    expect(eq({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('compares class instances by prototype and own properties', () => {
    class A {
      constructor(public x: number) {}
    }
    class B {
      constructor(public x: number) {}
    }
    expect(eq(new A(1), new A(1))).toBe(true);
    expect(eq(new A(1), new B(1))).toBe(false);
    expect(eq(new A(1), { x: 1 })).toBe(false);
  });

  it('handles cycles', () => {
    const a: Record<string, unknown> = { v: 1 };
    a.self = a;
    const b: Record<string, unknown> = { v: 1 };
    b.self = b;
    expect(eq(a, b)).toBe(true);
    expect(eq(a, { v: 1, self: { v: 1 } })).toBe(false);
  });

  it('reports the path of the first difference', () => {
    expect(diffEnc(encode({ a: [1, { b: 2 }] }), encode({ a: [1, { b: 3 }] }))).toEqual(['a', 1, 'b']);
  });
});

describe('outcome comparison', () => {
  it('detects returns vs throws', () => {
    expect(diffOutcome(ret(1), thr(new RangeError('x')))).toEqual({ aspect: 'kind', path: [] });
  });

  it('compares errors by class and message', () => {
    expect(diffOutcome(thr(new RangeError('a')), thr(new RangeError('a')))).toBeNull();
    expect(diffOutcome(thr(new RangeError('a')), thr(new TypeError('a')))?.aspect).toBe('error');
    expect(diffOutcome(thr(new RangeError('a')), thr(new RangeError('b')))?.aspect).toBe('error');
    expect(
      diffOutcome(thr(new RangeError('a')), thr(new RangeError('b')), { ignoreErrorMessages: true }),
    ).toBeNull();
  });

  it('detects argument mutations', () => {
    expect(diffOutcome(ret(1, [[1, 2]]), ret(1, [[1, 2, 3]]))).toEqual({
      aspect: 'mutation',
      path: [0, 'length'],
    });
    expect(diffOutcome(ret(1, [[1, 2]]), ret(1, [[1, 2, 3]]), { compareMutations: false })).toBeNull();
  });

  it('detects sync vs async and timeouts', () => {
    expect(diffOutcome(ret(1), { ...ret(1), async: true } as Outcome)?.aspect).toBe('async');
    expect(diffOutcome(ret(1), { kind: 'timeout', ms: 100 })?.aspect).toBe('kind');
    expect(diffOutcome({ kind: 'timeout', ms: 100 }, { kind: 'timeout', ms: 100 })).toBeNull();
  });
});

describe('encode', () => {
  it('encodes special values and builtins', () => {
    expect(encode(-0)).toEqual({ t: 'number', v: -0 });
    expect(encode(10n)).toEqual({ t: 'bigint', v: '10' });
    expect(encode(/a/g)).toEqual({ t: 'regexp', source: 'a', flags: 'g' });
    expect(encode(new Uint8Array([1, 2]))).toEqual({ t: 'typed', ctor: 'Uint8Array', items: [1, 2] });
    expect(encode(Object.create(null))).toEqual({ t: 'object', ctor: 'null-prototype', entries: [] });
    expect(encode(new RangeError('bad'))).toMatchObject({ t: 'error', ctor: 'RangeError', message: 'bad' });
  });

  it('survives throwing getters and huge structures', () => {
    const o = {
      get boom(): number {
        throw new Error('nope');
      },
    };
    expect(encode(o)).toMatchObject({ t: 'object', entries: [['boom', { t: 'truncated' }]] });
    const big = encode(Array.from({ length: 50_000 }, (_, i) => i));
    expect(JSON.stringify(big)).toContain('too many nodes');
  });
});
