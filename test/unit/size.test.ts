import fc from 'fast-check';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { sizeLikeParams } from '../../src/core/analyze/sizeParams.js';
import { compileSpec } from '../../src/core/arbitraries/compile.js';
import { formatEnc } from '../../src/core/format/format.js';
import { encode } from '../../src/core/runner/encode.js';

function fnNode(code: string) {
  const sf = new Project({ useInMemoryFileSystem: true }).createSourceFile('f.ts', code);
  return sf.getFunctions()[0] ?? sf.getVariableDeclarations()[0]!.getInitializerOrThrow();
}

describe('size-like parameters', () => {
  it('recognizes loop bounds, lengths and indexes', () => {
    const loop = fnNode(
      'export function f(total: number, people: number) { for (let i = 0; i < people; i++) {} return total; }',
    );
    expect([...sizeLikeParams([loop])]).toEqual(['people']);
    const len = fnNode('export const f = (s: string, w: number) => Array.from({ length: w }, () => s);');
    expect([...sizeLikeParams([len])]).toEqual(['w']);
    const idx = fnNode('export function f(xs: number[], at: number) { return xs[at]; }');
    expect([...sizeLikeParams([idx])]).toEqual(['at']);
    const rep = fnNode('export function f(s: string, times: number) { return s.repeat(times); }');
    expect([...sizeLikeParams([rep])]).toEqual(['times']);
  });

  it('leaves amounts and other numbers alone', () => {
    const f = fnNode('export function f(price: number, rate: number) { return price * rate; }');
    expect(sizeLikeParams([f]).size).toBe(0);
  });

  it('generates sizes mostly in realistic ranges, huge values only rarely', () => {
    const xs = fc.sample(compileSpec({ kind: 'number', size: true })!, {
      numRuns: 4000,
      seed: 1,
    }) as number[];
    const small = xs.filter((n) => Number.isInteger(n) && n >= 0 && n <= 1000).length;
    const huge = xs.filter((n) => !Number.isFinite(n) || Math.abs(n) >= 1e9).length;
    expect(small / xs.length).toBeGreaterThan(0.85);
    expect(huge).toBeGreaterThan(0);
    expect(huge / xs.length).toBeLessThan(0.03);
  });
});

describe('display of large values', () => {
  it('abbreviates long arrays', () => {
    const s = formatEnc(encode(Array.from({ length: 1000 }, (_, i) => i % 2)));
    expect(s).toBe('[0, 1, 0, 1, 0, 1, … 994 more]');
  });
});
