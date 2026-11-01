import { describe, expect, it } from 'vitest';
import { analyzeClaim, nameParts, ruleLabel, type RuleTarget } from '../../src/core/claims/rules.js';

const t = (exportName: string, file = 'src/x.ts', helpers: string[] = []): RuleTarget => ({
  exportName,
  file,
  helpers,
});

describe('claim intent', () => {
  it.each([
    ['Refactor cart and slug utilities\n\nPure refactor, no behavior change.', 'no-change'],
    ['refactor: make `isPlainObject` logic more readable', 'no-change'],
    ['perf: faster paths for compare (#813)', 'no-change'],
    ['fix: faster paths for compare (#813)', 'no-change'],
    ['fix: crash in compare fast path', 'change'],
    ['chore: tidy imports', 'no-change'],
    ['Clean up the parser', 'no-change'],
    ['fix(withoutBase): collapse leading slashes (#335)', 'change'],
    ['fix[startCase]: only uppercase the first letter of each word', 'change'],
    ['Fix discount rounding for prices over $1000', 'change'],
    ["Fixed negative decimals less than -10 don't work (#111)", 'change'],
    ['feat: support Infinity', 'change'],
    ['Simplify and fix the slug regex', 'change'],
    ['Update dependencies', 'unknown'],
    ['', 'unknown'],
  ])('%s -> %s', (text, intent) => {
    expect(analyzeClaim(text).intent).toBe(intent);
  });
});

describe('rule labels', () => {
  it('claims functions the PR names (export name, distinctive name part, changed helper)', () => {
    const a = analyzeClaim('fix(withBase, withoutBase): prevent false prefix matches');
    expect(ruleLabel(t('withBase'), a, [])).toMatchObject({ label: 'claimed' });
    const b = analyzeClaim('Fix discount rounding for prices over $1000');
    expect(ruleLabel(t('applyDiscount'), b, [])).toMatchObject({
      label: 'claimed',
      explanation: 'The PR mentions "discount" (`applyDiscount`).',
    });
    const c = analyzeClaim('Fix toCents rounding');
    expect(ruleLabel(t('price', 'src/p.ts', ['toCents']), c, [])).toMatchObject({ label: 'claimed' });
  });

  it('marks unnamed functions unclaimed when the PR names others, neutral otherwise', () => {
    const a = analyzeClaim('fix(withBase): prevent false prefix matches');
    const targets = [t('withBase'), t('isSamePath')];
    expect(ruleLabel(targets[1]!, a, targets)).toMatchObject({ label: 'unclaimed' });
    const vague = analyzeClaim('Fix a bug');
    expect(ruleLabel(t('isSamePath'), vague, [t('isSamePath')])).toEqual({ label: 'behavior-change' });
  });

  it('does not claim via generic name parts', () => {
    const a = analyzeClaim('Fix the parser for values');
    expect(ruleLabel(t('formatValue'), a, [])).toEqual({ label: 'behavior-change' });
  });

  it('uses the file name for default exports', () => {
    const a = analyzeClaim('fix(isSlug): restrict allowed characters');
    expect(ruleLabel(t('default', 'src/lib/isSlug.js'), a, [])).toMatchObject({ label: 'claimed' });
  });

  it('every change is unclaimed when no change is intended', () => {
    const a = analyzeClaim('refactor(withBase): simplify');
    expect(ruleLabel(t('withBase'), a, [])).toEqual({ label: 'unclaimed' });
  });

  it('splits identifiers', () => {
    expect(nameParts('applyDiscount')).toEqual(['apply', 'discount']);
    expect(nameParts('HTTPServer_url')).toEqual(['http', 'server', 'url']);
  });
});
