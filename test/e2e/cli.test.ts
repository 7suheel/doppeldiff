import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Report } from '../../src/core/report/model.js';
import { gitScenario, REPO_ROOT, type GitScenario } from '../helpers/scenarios.js';

const CLI = join(REPO_ROOT, 'src', 'bin.ts');
const TSX = import.meta.resolve('tsx');
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((c) => c()));

function cli(cwd: string, args: string[]) {
  const r = spawnSync(process.execPath, ['--import', TSX, CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Make a report comparable across runs/machines: drop timings, SHAs and version. */
function normalizeMarkdown(md: string): string {
  return md
    .replace(/<sub>.*?<\/sub>/s, '<sub>FOOTER</sub>')
    .replace(/[0-9a-f]{7} → (working tree|[0-9a-f]{7})/, 'SHA → $1');
}

let honest: GitScenario;
beforeAll(() => {
  honest = gitScenario('honest-fix', 'branch');
  cleanups.push(honest.cleanup);
});

describe('CLI', () => {
  it('honest fix: neutral behavior change, Markdown + JSON + tests, exit 0', () => {
    const md = join(honest.repo, 'report.md');
    const json = join(honest.repo, 'report.json');
    const r = cli(honest.repo, [
      '--base',
      'main',
      '--head',
      'pr',
      '--claim',
      'Fix discount rounding for prices over $1000',
      '--markdown',
      md,
      '--json',
      json,
      '--write-tests',
    ]);
    expect(r.stderr).toContain('applyDiscount');
    expect(r.code).toBe(0);
    const report = Report.parse(JSON.parse(readFileSync(json, 'utf8')));
    expect(report.summary).toMatchObject({
      verdict: 'changes',
      behaviors: 1,
      unclaimed: 0,
      functions: 1,
      changed: 1,
    });
    expect(report.functions[0]!.behaviors[0]!.examples[0]!.call).toBe('applyDiscount(2000, 0.07)');
    // Keyless rules: "discount" in the claim names applyDiscount.
    expect(report.functions[0]!.behaviors[0]).toMatchObject({ label: 'claimed', labelSource: 'rules' });
    expect(normalizeMarkdown(readFileSync(md, 'utf8'))).toMatchSnapshot();
    expect(readdirSync(join(honest.repo, 'tests', 'doppeldiff'))).toEqual(['applyDiscount.test.ts']);
  });

  it('generated regression tests pass against the head version', () => {
    const r = spawnSync(
      process.execPath,
      [
        join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        '--root',
        honest.repo,
        'tests/doppeldiff',
      ],
      {
        cwd: honest.repo,
        encoding: 'utf8',
      },
    );
    // eslint-disable-next-line no-control-regex
    expect((r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, '')).toMatch(/Tests\s+3 passed/);
    expect(r.status).toBe(0);
  });

  it('AI refactor: the "no behavior change" claim makes every difference unclaimed (exit 1)', () => {
    const s = gitScenario('ai-refactor', 'branch');
    cleanups.push(s.cleanup);
    const claimFile = join(s.repo, 'claim.md');
    writeFileSync(claimFile, s.claim);
    const r = cli(s.repo, ['--base', 'main', '--head', 'pr', '--claim-file', claimFile, '--json', '-']);
    expect(r.code).toBe(1);
    const report = Report.parse(JSON.parse(r.stdout));
    expect(report.claim.refactor).toBe(true);
    expect(report.summary.verdict).toBe('unclaimed');
    const titles = report.functions.flatMap((f) =>
      f.behaviors.map((b) => `${f.exportName}: ${b.title} [${b.label}]`),
    );
    expect(titles).toContain('cartTotal: return value changed [unclaimed]');
    expect(titles).toContain('cartTotal: now returns NaN (previously a number) [unclaimed]');
    expect(titles.some((t) => t.startsWith('slugify:'))).toBe(true);
    expect(report.functions.find((f) => f.exportName === 'itemCount')!.status).toBe('unchanged');
  });

  it('pure refactor: confirms no behavior change (exit 0, even with --fail-on any)', () => {
    const s = gitScenario('pure-refactor', 'branch');
    cleanups.push(s.cleanup);
    const r = cli(s.repo, [
      '--base',
      'main',
      '--head',
      'pr',
      '--refactor',
      '--fail-on',
      'any',
      '--markdown',
      '-',
      '--runs',
      '300',
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('✅ **No behavior change** detected in 4 functions');
  });

  it('applies doppeldiff.config.ts (custom arguments, skip) and reports tool errors with exit 2', () => {
    const s = gitScenario('ai-refactor', 'worktree');
    cleanups.push(s.cleanup);
    writeFileSync(
      join(s.repo, 'doppeldiff.config.ts'),
      [
        "import { defineConfig } from 'doppeldiff';",
        'export default defineConfig({',
        '  functions: {',
        "    slugify: { skip: 'covered by snapshot tests' },",
        "    cartTotal: { args: (fc) => fc.tuple(fc.array(fc.record({ sku: fc.constant('A'), unitPrice: fc.integer({ min: 1, max: 100 }), quantity: fc.integer({ min: 1, max: 5 }) }))) },",
        '  },',
        '});',
      ].join('\n'),
    );
    const r = cli(s.repo, ['--json', '-', '--fail-on', 'never']);
    expect(r.code).toBe(0);
    const report = Report.parse(JSON.parse(r.stdout));
    // With only positive prices and quantities the refactor is equivalent.
    expect(report.functions.find((f) => f.exportName === 'cartTotal')!.status).toBe('unchanged');
    expect(report.skipped.find((x) => x.exportName === 'slugify')!.reason).toBe('covered by snapshot tests');

    const bad = cli(s.repo, ['--base', 'does-not-exist']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/doppeldiff:/);
  });

  it('prints help', () => {
    const r = cli(REPO_ROOT, ['--help']);
    expect(r.stdout).toContain('--write-tests');
    expect(r.code).toBe(0);
  });
});

void execFileSync;
void existsSync;
