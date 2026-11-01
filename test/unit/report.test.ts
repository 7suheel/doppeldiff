import { describe, expect, it } from 'vitest';
import { exitCodeFor } from '../../src/cli.js';
import type { Outcome } from '../../src/core/compare/observed.js';
import { diffOutcome } from '../../src/core/compare/compare.js';
import type { Cluster } from '../../src/core/explore/explore.js';
import { behaviorTitle, groupBehaviors } from '../../src/core/report/behaviors.js';
import { isRefactorClaim } from '../../src/core/report/build.js';
import { argsToCode, encToCode, valueToCode } from '../../src/core/report/codegen.js';
import { code, escapeText } from '../../src/core/report/markdown.js';
import type { Report } from '../../src/core/report/model.js';
import { encode } from '../../src/core/runner/encode.js';
import { FN_TAG } from '../../src/core/runner/tags.js';

const ret = (v: unknown): Outcome => ({ kind: 'return', value: encode(v), async: false, args: [] });
const thr = (e: Error): Outcome => ({ kind: 'throw', error: encode(e), async: false, args: [] });

function cluster(
  input: unknown[],
  base: Outcome,
  head: Outcome,
  count = 1,
  features: string[] = ['x'],
): Cluster {
  const diff = diffOutcome(base, head)!;
  return {
    key: JSON.stringify([base, head, features]),
    transition: 't',
    features,
    count,
    witnesses: [{ input, base, head, diff, minimal: true }],
  };
}

describe('behaviors', () => {
  it('groups sign-level variants into one behavior and keeps NaN/throws distinct', () => {
    const groups = groupBehaviors([
      cluster([-1], ret(-1), ret(0), 10),
      cluster([-Infinity], ret(-Infinity), ret(0), 5),
      cluster([NaN], ret(0), ret(NaN), 3),
      cluster([-2], thr(new RangeError('neg')), ret(-2), 2),
    ]);
    expect(groups.map((g) => [g.title, g.count])).toEqual([
      ['return value changed', 15],
      ['now returns NaN (previously a number)', 3],
      ['no longer throws RangeError; now returns a number', 2],
    ]);
    expect(groups[0]!.examples.map((e) => e.input)).toEqual([[-1], [-Infinity]]);
  });

  it('writes readable titles', () => {
    const w = (base: Outcome, head: Outcome) => ({
      input: [],
      base,
      head,
      diff: diffOutcome(base, head)!,
      minimal: true,
    });
    expect(behaviorTitle(w(ret(1), thr(new TypeError('x'))))).toBe(
      'now throws TypeError (previously returned a number)',
    );
    expect(behaviorTitle(w(thr(new TypeError('x')), thr(new RangeError('x'))))).toBe(
      'now throws RangeError instead of TypeError',
    );
    expect(behaviorTitle(w(ret('a'), { kind: 'timeout', ms: 5 }))).toBe('now hangs (times out)');
    expect(behaviorTitle(w(thr(new Error('a')), thr(new Error('b'))))).toBe(
      'still throws Error, but with a different message',
    );
  });
});

describe('claims', () => {
  it('recognizes explicit "no behavior change" claims', () => {
    for (const t of [
      'Pure refactor, no behavior change.',
      'No functional changes',
      'behavior-preserving cleanup',
      'Purely refactoring',
    ]) {
      expect(isRefactorClaim(t), t).toBe(true);
    }
    for (const t of ['Fix discount rounding', 'Change behavior of parser', ''])
      expect(isRefactorClaim(t), t).toBe(false);
  });
});

describe('code generation', () => {
  it('writes inputs as JavaScript', () => {
    expect(argsToCode([NaN, -0, Infinity, 'a"b', undefined, null, 3n])).toBe(
      'NaN, -0, Infinity, "a\\"b", undefined, null, 3n',
    );
    expect(valueToCode({ 'a-b': [new Date(0)], m: new Map([[1, new Set([2])]]) })).toBe(
      '{ "a-b": [new Date("1970-01-01T00:00:00.000Z")], m: new Map([[1, new Set([2])]]) }',
    );
    expect(valueToCode({ [FN_TAG]: { returns: { a: 1 }, async: false } })).toBe('() => ({ a: 1 })');
    expect(valueToCode(Symbol('x'))).toBeUndefined();
  });

  it('writes observed values as JavaScript where faithful', () => {
    expect(encToCode(encode({ a: [1, -0, NaN] }))).toBe('{ a: [1, -0, NaN] }');
    class K {}
    expect(encToCode(encode(new K()))).toBeUndefined();
    expect(encToCode(encode(new Uint8Array([1])))).toBe('new Uint8Array([1])');
  });
});

describe('markdown safety', () => {
  it('escapes untrusted prose', () => {
    expect(escapeText('<img src=x> @octocat *bold* `x` | y')).toBe(
      '&lt;img src=x&gt; @​octocat \\*bold\\* \\`x\\` \\| y',
    );
  });
  it('builds code spans that survive backticks and pipes', () => {
    expect(code('a|b')).toBe('`a\\|b`');
    expect(code('x `y` z')).toBe('``x `y` z``');
    expect(code('`edge`')).toBe('`` `edge` ``');
    expect(code('a'.repeat(300), 10)).toBe('`aaaaaaaaa…`');
  });
});

describe('exit codes', () => {
  const report = (behaviors: number, unclaimed: number) => ({ summary: { behaviors, unclaimed } }) as Report;
  it('fails on unclaimed changes by default semantics', () => {
    expect(exitCodeFor(report(2, 0), 'unclaimed')).toBe(0);
    expect(exitCodeFor(report(2, 1), 'unclaimed')).toBe(1);
    expect(exitCodeFor(report(2, 0), 'any')).toBe(1);
    expect(exitCodeFor(report(0, 0), 'any')).toBe(0);
    expect(exitCodeFor(report(5, 5), 'never')).toBe(0);
  });
});

describe('JSON schema', () => {
  it('schema/report.schema.json is up to date (run `npm run schema`)', async () => {
    const { readFileSync } = await import('node:fs');
    const { reportJsonSchema } = await import('../../src/core/report/model.js');
    const onDisk = JSON.parse(
      readFileSync(new URL('../../schema/report.schema.json', import.meta.url), 'utf8'),
    );
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(reportJsonSchema())));
  });
});
