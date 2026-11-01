import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compileSpec } from '../../src/core/arbitraries/compile.js';
import {
  approximateProperties,
  inlineBackreferences,
  regexArbitraries,
  regexDiffStrings,
} from '../../src/core/arbitraries/regex.js';
import { inputRealism, realismContext } from '../../src/core/explore/realism.js';
import { formatValue } from '../../src/core/format/format.js';
import { isViewDescriptor, PROTO_TAG, toWire, VIEW_TAG } from '../../src/core/runner/tags.js';
import { stableKey } from '../../src/core/util/stableKey.js';

describe('binary values', () => {
  it('generates DataViews that are windows into a larger buffer', () => {
    const views = fc.sample(compileSpec({ kind: 'binary', ctor: 'DataView' })!, { numRuns: 200, seed: 3 });
    expect(views.every((v) => v instanceof DataView)).toBe(true);
    const windowed = (views as DataView[]).filter(
      (v) => v.byteOffset > 0 || v.byteLength < v.buffer.byteLength,
    );
    expect(windowed.length).toBeGreaterThan(150);
  });

  it('generates typed arrays of the requested kind', () => {
    const xs = fc.sample(compileSpec({ kind: 'binary', ctor: 'Int16Array' })!, { numRuns: 20, seed: 1 });
    expect(xs.every((x) => x instanceof Int16Array)).toBe(true);
  });

  it('includes binary values and objects with inherited properties for untyped parameters', () => {
    const xs = fc.sample(compileSpec({ kind: 'anything' })!, { numRuns: 2000, seed: 1 });
    expect(xs.some((x) => x instanceof DataView)).toBe(true);
    expect(xs.some((x) => x instanceof ArrayBuffer)).toBe(true);
    expect(xs.some((x) => typeof x === 'object' && x !== null && PROTO_TAG in x)).toBe(true);
  });

  it('sends views over IPC as descriptors that keep buffer, offset and length', () => {
    const view = new DataView(new Uint8Array([1, 2, 3, 4]).buffer, 1, 2);
    const wire = toWire([{ a: view }, new Map([['k', new Uint8Array([9])]])]) as [
      { a: unknown },
      Map<string, unknown>,
    ];
    expect(isViewDescriptor(wire[0].a)).toBe(true);
    const d = (wire[0].a as { [VIEW_TAG]: { buffer: ArrayBuffer; byteOffset: number; length: number } })[
      VIEW_TAG
    ];
    expect([d.byteOffset, d.length, d.buffer.byteLength]).toEqual([1, 2, 4]);
    expect(isViewDescriptor(wire[1].get('k'))).toBe(true);
  });

  it('formats and keys views by their window', () => {
    const a = new DataView(new Uint8Array([1, 2, 3]).buffer, 1, 1);
    const b = new DataView(new Uint8Array([1, 2, 3]).buffer, 0, 1);
    expect(formatValue(a)).toContain('new DataView(');
    expect(stableKey([a])).not.toBe(stableKey([b]));
  });

  it('rates objects with inherited enumerable properties as unusual', () => {
    const r = inputRealism([{ [PROTO_TAG]: { proto: { x: 1 }, own: {} } }], realismContext(undefined));
    expect(r.tier).toBe(1);
  });
});

describe('regex-derived strings', () => {
  it('inlines backreferences so the regex can be generated from', () => {
    expect(inlineBackreferences(String.raw`(a)(?<n>b)\1\2[\1]`)).toBe(String.raw`(a)(?<n>b)(?:a)(?:b)[\1]`);
    expect(regexArbitraries([{ source: String.raw`^(\d{4})(-?)\d{2}\2\d{2}$`, flags: '' }])).toHaveLength(1);
  });

  it('approximates Unicode property classes with readable characters', () => {
    const approx = new RegExp(approximateProperties(String.raw`^\p{Lu}[\p{L}\d]*\P{N}$`), 'u');
    expect(approx.source).not.toContain('\\p');
    expect(approx.test('Ab1x')).toBe(true);
    expect(approx.test('ab1x')).toBe(false);
    expect(approx.test('Ab1')).toBe(false);
  });

  it('finds the strings on which a changed regex disagrees between versions', () => {
    const before = { source: String.raw`^\d{4}-(0\d\d|[12]\d\d|3([0-5]\d|6[1-6]))$`, flags: '' };
    const after = { source: String.raw`^\d{4}-(0\d\d|[12]\d\d|3([0-5]\d|6[0-6]))$`, flags: '' };
    const diff = regexDiffStrings([before], [after]);
    expect(diff.length).toBeGreaterThan(0);
    expect(diff.every((s) => /-360$/.test(s))).toBe(true);
    expect(regexDiffStrings([before], [before])).toEqual([]);
  });
});
