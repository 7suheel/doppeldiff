import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { inferGuards } from '../../src/core/analyze/guards.js';
import { collectUsage } from '../../src/core/analyze/usage.js';
import { inputRealism, realismContext } from '../../src/core/explore/realism.js';
import { FN_TAG } from '../../src/core/runner/tags.js';

function files(map: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'dd-usage-'));
  for (const [p, c] of Object.entries(map)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return root;
}

describe('usage mining', () => {
  it('collects literal call sites and test values, but not expected values or test titles', () => {
    const root = files({
      'src/a.ts': 'export function cmp(a: number, b: number) { return a - b; }',
      'src/b.ts': "import { cmp } from './a';\nexport const x = cmp(3, 4);\nexport const y = cmp(z(), 1);",
      'test/a.test.ts': [
        "import { cmp } from '../src/a';",
        "it('compares -5 things', () => {",
        '  expect(cmp(1, 2)).toBe(-1);',
        '  t.equal(cmp(7, 8), -1);',
        '  for (const [a, b] of [[10, 20], [30, 40]]) cmp(a, b);',
        '});',
      ].join('\n'),
    });
    const u = collectUsage(root, ['src/a.ts', 'src/b.ts', 'test/a.test.ts'], ['cmp']);
    expect(u.tuples).toEqual([
      [3, 4],
      [1, 2],
      [7, 8],
    ]);
    expect(u.numbers.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 7, 8, 10, 20, 30, 40]);
    expect(u.strings).not.toContain('compares -5 things');
    expect(u.files).toBe(3);
  });
});

describe('realism', () => {
  const ctx = realismContext({ numbers: [1, 2, 3], strings: ['alpha'], numberObservations: 5 });
  it.each([
    [[1, 2], 3],
    [['alpha'], 3],
    [[4], 2],
    [['hello'], 2],
    [[-1], 1],
    [[0.5], 1],
    [[NaN], 0],
    [[-0], 0],
    [[Infinity], 0],
    [[1e12], 0],
    [['\uD800'], 0],
    [['a​b'], 0],
    [[new Date(NaN)], 0],
    [[{ a: [1, -1] }], 1],
    [[{ [FN_TAG]: { returns: NaN, async: false } }], 2],
  ])('%j -> tier %i', (input, tier) => {
    expect(inputRealism(input as unknown[], ctx).tier).toBe(tier);
  });
  it('does not restrict the domain without enough observations', () => {
    const weak = realismContext({ numbers: [1], strings: [], numberObservations: 1 });
    expect(inputRealism([-1], weak).tier).toBe(2);
    expect(inputRealism([0.5], weak).tier).toBe(2);
  });
});

describe('guard inference', () => {
  const project = new Project({ useInMemoryFileSystem: true });
  let n = 0;
  const guardsOf = (code: string) => {
    const sf = project.createSourceFile(`/g${n++}.ts`, code);
    return inferGuards(sf.getFunctions()[0]!);
  };
  it('evaluates leading throw/return guards', () => {
    const g = guardsOf(`function f(price: number, rate: number) {
      assertNumber(price);
      if (price < 0) throw new RangeError('neg');
      if (rate < 0 || rate > 1) { throw new RangeError('rate'); }
      if (!Number.isInteger(price) && typeof rate !== 'number') return 0;
      return price * rate;
    }`)!;
    expect(g.conditions).toHaveLength(3);
    expect(g.accepts([10, 0.5])).toBe(true);
    expect(g.accepts([-1, 0.5])).toBe(false);
    expect(g.accepts([10, 2])).toBe(false);
  });
  it('ignores conditions it cannot evaluate and stops at the first non-guard statement', () => {
    const g = guardsOf(`function f(s: string) {
      if (isWeird(s)) throw new Error('x');
      const t = s.trim();
      if (t.length > 3) throw new Error('late');
      return t;
    }`);
    expect(g).toBeUndefined();
    const h = guardsOf(`function f(s: string) { if (s.length > 100) return undefined; return s; }`)!;
    expect(h.accepts(['x'.repeat(101)])).toBe(false);
    expect(h.accepts(['ok'])).toBe(true);
  });
});
