import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { findExportedFunction } from '../../src/core/analyze/locate.js';
import { signatureOf } from '../../src/core/types/fromType.js';
import { accepts, signatureAccepts } from '../../src/core/types/accepts.js';
import { printSpec, signatureUnsupported } from '../../src/core/types/spec.js';

const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true } });
let fileCounter = 0;

function sigOf(code: string, name = 'f') {
  const sf = project.createSourceFile(`/m${fileCounter++}.ts`, code);
  const loc = findExportedFunction(sf, name);
  if (!loc.ok) throw new Error(loc.reason);
  return signatureOf(loc.node);
}

const params = (code: string, name = 'f') =>
  sigOf(code, name).params.map(
    (p) => `${p.name}${p.optional ? '?' : ''}${p.rest ? '...' : ''}: ${printSpec(p.spec)}`,
  );

describe('type → ArbSpec', () => {
  it('handles primitives, literals and unions', () => {
    expect(params('export function f(a: number, b: string, c: boolean, d: bigint) {}')).toEqual([
      'a: number',
      'b: string',
      'c: boolean',
      'd: bigint',
    ]);
    expect(params("export function f(a: 'x' | 'y', b: 1 | 2, c: string | null) {}")).toEqual([
      'a: "x" | "y"',
      'b: 1 | 2',
      'c: null | string',
    ]);
  });

  it('handles optional and default parameters as union with undefined', () => {
    expect(params('export function f(a?: number, b = 3) {}')).toEqual([
      'a?: undefined | number',
      'b?: number | undefined',
    ]);
  });

  it('handles enums', () => {
    expect(params('enum Color { Red = "r", Green = "g" } export function f(c: Color) {}')).toEqual([
      'c: "r" | "g"',
    ]);
    expect(params('enum N { A, B } export function f(n: N) {}')).toEqual(['n: 0 | 1']);
  });

  it('handles arrays, tuples, objects, records, Date, Map, Set', () => {
    expect(
      params(`
        interface Item { sku: string; qty?: number }
        export function f(a: number[], b: [string, number?], c: Item, d: Record<string, boolean>, e: Date,
          m: Map<string, number>, s: ReadonlySet<number>, r: readonly string[]) {}`),
    ).toEqual([
      'a: number[]',
      'b: [string, undefined | number?]',
      'c: { sku: string; qty?: number }',
      'd: Record<string, boolean>',
      'e: Date',
      'm: Map<string, number>',
      's: Set<number>',
      'r: string[]',
    ]);
  });

  it('handles rest parameters and callbacks', () => {
    expect(params('export function f(cb: (x: number) => string, ...xs: number[]) {}')).toEqual([
      'cb: () => string',
      'xs...: number',
    ]);
    expect(params('export function f(cb: () => Promise<number>) {}')).toEqual(['cb: () => Promise<number>']);
  });

  it('unwraps branded primitives', () => {
    expect(params("type Cents = number & { __brand: 'Cents' }; export function f(c: Cents) {}")).toEqual([
      'c: number',
    ]);
  });

  it('maps any/unknown to anything and generics to their constraint', () => {
    expect(params('export function f<T extends string>(a: any, b: unknown, c: T) {}')).toEqual([
      'a: unknown',
      'b: unknown',
      'c: string',
    ]);
  });

  it('handles recursive types with a reference', () => {
    const [p] = params('interface Tree { value: number; children: Tree[] } export function f(t: Tree) {}');
    expect(p).toBe('t: T0={ value: number; children: T0[] }');
  });

  it('marks class instances and unknown built-ins as unsupported', () => {
    const s1 = sigOf('class Foo { x = 1 } export function f(a: Foo) {}');
    expect(signatureUnsupported(s1)).toMatch(/class instance `Foo`/);
    const s2 = sigOf('export function f(a: Promise<number>) {}');
    expect(signatureUnsupported(s2)).toMatch(/built-in type `Promise`/);
  });

  it('supports arrow function and re-exported declarations', () => {
    expect(params('export const g = (x: number): number => x;', 'g')).toEqual(['x: number']);
    expect(params('const h = function (s: string) { return s; }; export { h as k };', 'k')).toEqual([
      's: string',
    ]);
  });

  it('reports skip reasons for non-functions', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const sf = project.createSourceFile(
      '/m.ts',
      'export class C {} export const v = 3; export function* gen() {} export function o(a: string): void; export function o(a: any) {}',
    );
    expect(findExportedFunction(sf, 'C')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/class/),
    });
    expect(findExportedFunction(sf, 'v')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not a function/),
    });
    expect(findExportedFunction(sf, 'gen')).toMatchObject({ ok: false, reason: 'generator function' });
    expect(findExportedFunction(sf, 'o')).toMatchObject({ ok: false, reason: 'overloaded function' });
    expect(findExportedFunction(sf, 'missing')).toMatchObject({ ok: false, missing: true });
  });
});

describe('signature compatibility', () => {
  it('accepts identical and widened signatures', () => {
    expect(
      signatureAccepts(sigOf('export function f(a: number) {}'), sigOf('export function f(a: number) {}')),
    ).toBe(true);
    // Head generates 'x'|'y'; base accepts any string.
    expect(
      signatureAccepts(sigOf('export function f(a: string) {}'), sigOf("export function f(a: 'x' | 'y') {}")),
    ).toBe(true);
    // New optional parameter: inputs with it are still valid calls for the base.
    expect(
      signatureAccepts(
        sigOf('export function f(a: number) {}'),
        sigOf('export function f(a: number, b?: number) {}'),
      ),
    ).toBe(true);
  });

  it('rejects incompatible signatures', () => {
    expect(
      signatureAccepts(sigOf('export function f(a: number) {}'), sigOf('export function f(a: string) {}')),
    ).toBe(false);
    expect(
      signatureAccepts(
        sigOf('export function f(a: number) {}'),
        sigOf('export function f(a: number, b: number) {}'),
      ),
    ).toBe(false);
    expect(
      signatureAccepts(
        sigOf('export function f(a: number, b: number) {}'),
        sigOf('export function f(a: number) {}'),
      ),
    ).toBe(false);
  });

  it('accepts object specs with the same required props', () => {
    expect(
      accepts(
        { kind: 'object', props: [{ name: 'a', spec: { kind: 'number' }, optional: false }] },
        { kind: 'object', props: [{ name: 'a', spec: { kind: 'literal', value: 3 }, optional: false }] },
      ),
    ).toBe(true);
  });
});

describe('callable values', () => {
  it('derives a signature from the type of a callable export', () => {
    expect(
      params(
        'function make() { return (a: number, b?: string, ...rest: boolean[]) => a; }\nexport const f = make();',
      ),
    ).toEqual(['a: number', 'b?: undefined | string', 'rest...: boolean']);
  });
});
