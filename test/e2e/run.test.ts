import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run, type RunResult } from '../../src/core/run.js';
import { gitIn, makeRepo } from '../helpers/repo.js';
import { gitScenario } from '../helpers/scenarios.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const byId = (r: RunResult) => Object.fromEntries(r.functions.map((f) => [f.id, f]));

describe('run() with git integration', () => {
  it('compares the working tree against HEAD by default', async () => {
    const s = gitScenario('ai-refactor', 'worktree');
    cleanups.push(s.cleanup);
    const r = await run({ cwd: s.repo, runs: 300 });
    const f = byId(r);
    expect(Object.keys(f).sort()).toEqual([
      'src/cart.ts#cartTotal',
      'src/cart.ts#itemCount',
      'src/slug.ts#slugify',
    ]);
    expect(f['src/cart.ts#cartTotal']!.status).toBe('changed');
    expect(f['src/cart.ts#itemCount']!.status).toBe('unchanged');
    expect(r.head.sha).toBeNull();
  });

  it('compares two branches using their merge base', async () => {
    const s = gitScenario('honest-fix', 'branch');
    cleanups.push(s.cleanup);
    // Move main forward with an unrelated commit: it must not show up in the comparison.
    gitIn(s.repo, 'checkout', '-q', 'main');
    gitIn(
      s.repo,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'unrelated',
    );
    gitIn(s.repo, 'checkout', '-q', 'pr');
    const r = await run({ cwd: s.repo, base: 'main', head: 'pr', runs: 300 });
    expect(r.functions.map((f) => `${f.id}:${f.status}`)).toEqual(['src/pricing.ts#applyDiscount:changed']);
  });

  it('finds no behavior change for a pure refactor', async () => {
    const s = gitScenario('pure-refactor', 'branch');
    cleanups.push(s.cleanup);
    const r = await run({ cwd: s.repo, base: 'main', head: 'pr', runs: 300 });
    expect(r.functions.length).toBe(4);
    for (const f of r.functions) expect(f.status, f.id).toBe('unchanged');
  });

  it('respects a total time budget and reports inputs actually run', async () => {
    const s = gitScenario('ai-refactor', 'worktree');
    cleanups.push(s.cleanup);
    const r = await run({ cwd: s.repo, runs: 1_000_000, timeBudgetMs: 6000 });
    for (const f of r.functions) {
      expect(f.stoppedBy === 'deadline' || f.stoppedBy === 'exhausted').toBe(true);
      // At least the initial self-consistency sample; slow CI machines may not get further within the budget.
      expect(f.inputsRun).toBeGreaterThanOrEqual(50);
    }
    expect(r.timing.verifyMs).toBeLessThan(30_000);
  });
});

describe('dependencies', () => {
  const vendor = {
    'vendor/tiny-lib/package.json': JSON.stringify({ name: 'tiny-lib', version: '1.0.0', main: 'index.js' }),
    'vendor/tiny-lib/index.js': 'exports.double = (x) => x * 2;',
    '.gitignore': 'node_modules\n',
  };

  function npmPack(dir: string, dest: string) {
    execFileSync('npm', ['pack', '--pack-destination', dest], {
      cwd: dir,
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
  }

  function npmInstall(cwd: string) {
    execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--offline'], {
      cwd,
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
  }

  it('links node_modules into the base worktree when the lockfile is unchanged', async () => {
    const pkg = JSON.stringify({
      name: 'app',
      type: 'module',
      dependencies: { 'tiny-lib': 'file:./vendor/tiny-lib' },
    });
    const repo = makeRepo(
      {
        ...vendor,
        'package.json': pkg,
        'src/a.ts': "import { double } from 'tiny-lib';\nexport const f = (x: number) => double(x);",
      },
      {},
    );
    cleanups.push(repo.cleanup);
    npmInstall(repo.root);
    gitIn(repo.root, 'add', '-A');
    gitIn(repo.root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'lock');
    // Working-tree change that uses the dependency.
    execFileSync(
      'node',
      [
        '-e',
        "require('fs').writeFileSync('src/a.ts', \"import { double } from 'tiny-lib';\\nexport const f = (x: number) => double(x) + (x === 3 ? 1 : 0);\")",
      ],
      {
        cwd: repo.root,
      },
    );
    const r = await run({ cwd: repo.root, runs: 200, keepWorktrees: true });
    expect(r.dependencies.map((d) => d.action)).toEqual(['linked']);
    const f = r.functions[0]!;
    expect(f.reason ?? '').toBe('');
    expect(f.status).toBe('changed');
    expect(f.clusters[0]!.witnesses[0]!.input).toEqual([3]);
  });

  it('installs dependencies in the base worktree when the lockfile changed (scripts disabled)', async () => {
    // Tarball dependencies are extracted as real copies by every npm version (unlike `file:` folders, which
    // npm links), so the install can be cached like one from the registry.
    const pkgBase = JSON.stringify({
      name: 'app',
      type: 'module',
      dependencies: { 'tiny-lib': 'file:./vendor/tiny-lib-1.0.0.tgz' },
    });
    const repo = makeRepo(
      {
        ...vendor,
        'package.json': pkgBase,
        'src/a.ts': "import { double } from 'tiny-lib';\nexport const f = (x: number) => double(x);",
      },
      {},
    );
    cleanups.push(repo.cleanup);
    npmPack(join(repo.root, 'vendor', 'tiny-lib'), join(repo.root, 'vendor'));
    npmInstall(repo.root);
    gitIn(repo.root, 'add', '-A');
    gitIn(repo.root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'lock');
    // Head adds a second dependency, changing the lockfile.
    const extra = {
      'vendor/other-lib/package.json': JSON.stringify({
        name: 'other-lib',
        version: '1.0.0',
        main: 'index.js',
      }),
      'vendor/other-lib/index.js': 'exports.inc = (x) => x + 1;',
    };
    for (const [p, c] of Object.entries(extra)) {
      execFileSync(
        'node',
        [
          '-e',
          `const fs=require('fs');fs.mkdirSync(require('path').dirname(${JSON.stringify(p)}),{recursive:true});fs.writeFileSync(${JSON.stringify(p)}, ${JSON.stringify(c)})`,
        ],
        { cwd: repo.root },
      );
    }
    execFileSync(
      'node',
      [
        '-e',
        `require('fs').writeFileSync('package.json', ${JSON.stringify(JSON.stringify({ name: 'app', type: 'module', dependencies: { 'tiny-lib': 'file:./vendor/tiny-lib-1.0.0.tgz', 'other-lib': 'file:./vendor/other-lib-1.0.0.tgz' } }))})`,
      ],
      { cwd: repo.root },
    );
    npmPack(join(repo.root, 'vendor', 'other-lib'), join(repo.root, 'vendor'));
    npmInstall(repo.root);
    execFileSync(
      'node',
      [
        '-e',
        "require('fs').writeFileSync('src/a.ts', \"import { double } from 'tiny-lib';\\nimport { inc } from 'other-lib';\\nexport const f = (x: number) => (x < 0 ? inc(double(x)) : double(x));\")",
      ],
      { cwd: repo.root },
    );
    const cacheDir = mkdtempSync(join(tmpdir(), 'doppeldiff-depcache-'));
    const r = await run({ cwd: repo.root, runs: 200, depsCacheDir: cacheDir });
    expect(r.dependencies.map((d) => d.action)).toEqual(['installed']);
    const f = r.functions[0]!;
    expect(f.reason ?? '').toBe('');
    expect(f.status).toBe('changed');
    expect(f.clusters.every((c) => c.features[0] === '<0')).toBe(true);
    // Second run reuses the cached install.
    const again = await run({ cwd: repo.root, runs: 50, depsCacheDir: cacheDir });
    expect(again.dependencies.map((d) => d.action)).toEqual(['cached']);
    expect(again.functions[0]!.status).toBe('changed');
    rmSync(cacheDir, { recursive: true, force: true });
  });
});

describe('worktree hygiene', () => {
  it('removes worktrees after a run unless asked to keep them', async () => {
    const s = gitScenario('honest-fix', 'worktree');
    cleanups.push(s.cleanup);
    await run({ cwd: s.repo, runs: 50 });
    const list = gitIn(s.repo, 'worktree', 'list');
    expect(list.trim().split('\n')).toHaveLength(1);
    expect(existsSync(join(s.repo, 'node_modules'))).toBe(false);
  });
});

describe('monorepo workspaces', () => {
  it('uses each version’s own workspace packages and finds cross-package impact', async () => {
    const pkgB = JSON.stringify({
      name: '@org/b',
      version: '1.0.0',
      main: 'src/index.ts',
      types: 'src/index.ts',
    });
    const pkgA = JSON.stringify({
      name: '@org/a',
      version: '1.0.0',
      main: 'src/index.ts',
      dependencies: { '@org/b': '1.0.0' },
    });
    const tsconfig = JSON.stringify({
      compilerOptions: { strict: true, module: 'ESNext', moduleResolution: 'Bundler' },
    });
    const repo = makeRepo(
      {
        '.gitignore': 'node_modules\n',
        'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }),
        'packages/b/package.json': pkgB,
        'packages/b/tsconfig.json': tsconfig,
        'packages/b/src/index.ts': 'export function clamp(x: number) { return Math.max(0, x); }',
        'packages/a/package.json': pkgA,
        'packages/a/tsconfig.json': tsconfig,
        'packages/a/src/index.ts':
          "import { clamp } from '@org/b';\nexport function score(x: number) { return clamp(x) * 2; }",
      },
      {},
    );
    cleanups.push(repo.cleanup);
    execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--offline'], {
      cwd: repo.root,
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
    gitIn(repo.root, 'add', '-A');
    gitIn(repo.root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'lock');
    execFileSync(
      'node',
      [
        '-e',
        "require('fs').writeFileSync('packages/b/src/index.ts', 'export function clamp(x: number) { return Math.max(1, x); }')",
      ],
      {
        cwd: repo.root,
      },
    );
    const r = await run({ cwd: repo.root, runs: 200 });
    const f = byId(r);
    expect(Object.keys(f).sort()).toEqual(['packages/a/src/index.ts#score', 'packages/b/src/index.ts#clamp']);
    expect(f['packages/a/src/index.ts#score']!.targetReason).toBe(
      'uses changed `clamp` from packages/b/src/index.ts',
    );
    // If base resolved @org/b to the working copy, both versions would be identical and report "unchanged".
    expect(f['packages/a/src/index.ts#score']!.status, f['packages/a/src/index.ts#score']!.reason).toBe(
      'changed',
    );
    expect(f['packages/b/src/index.ts#clamp']!.status, f['packages/b/src/index.ts#clamp']!.reason).toBe(
      'changed',
    );
  });
});

describe('tsconfig paths', () => {
  it('resolves path aliases in both versions', async () => {
    const tsconfig = JSON.stringify({
      compilerOptions: {
        strict: true,
        module: 'ESNext',
        moduleResolution: 'Bundler',
        baseUrl: '.',
        paths: { '@/*': ['src/*'] },
      },
    });
    const repo = makeRepo(
      {
        'tsconfig.json': tsconfig,
        'src/util/round.ts': 'export const round = (x: number) => Math.round(x);',
        'src/price.ts':
          "import { round } from '@/util/round';\nexport function price(x: number) { return round(x * 1.1); }",
      },
      { 'src/util/round.ts': 'export const round = (x: number) => Math.floor(x);' },
    );
    cleanups.push(repo.cleanup);
    const r = await run({ cwd: repo.root, runs: 200 });
    const f = byId(r);
    expect(f['src/price.ts#price']?.targetReason).toBe('uses changed `round` from src/util/round.ts');
    expect(f['src/price.ts#price']?.status).toBe('changed');
    expect(f['src/util/round.ts#round']?.status).toBe('changed');
  });
});

describe('CommonJS end to end', () => {
  it('verifies functions exported with module.exports (JSDoc types, require)', async () => {
    const repo = makeRepo(
      {
        'package.json': JSON.stringify({ name: 'cjs-app', version: '1.0.0' }),
        'lib/util.js': 'exports.half = (x) => x / 2;',
        'lib/price.js': [
          "const { half } = require('./util');",
          '/** @param {number} p @param {boolean} member */',
          'function price(p, member) { return member ? half(p) : p; }',
          'module.exports = { price };',
        ].join('\n'),
      },
      {
        'lib/price.js': [
          "const { half } = require('./util');",
          '/** @param {number} p @param {boolean} member */',
          'function price(p, member) { return member && p > 10 ? half(p) : p; }',
          'module.exports = { price };',
        ].join('\n'),
      },
    );
    cleanups.push(repo.cleanup);
    const r = await run({ cwd: repo.root, runs: 300 });
    const f = byId(r)['lib/price.js#price']!;
    expect(f.reason ?? '').toBe('');
    expect(f.signature).toBe('price(p: number, member: boolean)');
    expect(f.status).toBe('changed');
    for (const c of f.clusters) expect(c.witnesses[0]!.input[1]).toBe(true);
  });
});

describe('input domains', () => {
  it('honours a declared `where` domain from the config', async () => {
    const repo = makeRepo(
      { 'src/id.ts': 'export function cmp(a: number, b: number) { return a < b ? -1 : a > b ? 1 : 0; }' },
      {
        'src/id.ts':
          'export function cmp(a: number, b: number) { return a < 0 || b < 0 ? 0 : a < b ? -1 : a > b ? 1 : 0; }',
      },
    );
    cleanups.push(repo.cleanup);
    const free = await run({ cwd: repo.root, runs: 300 });
    expect(free.functions[0]!.status).toBe('changed');
    const domain = await run({
      cwd: repo.root,
      runs: 300,
      functions: { cmp: { where: ([a, b]) => (a as number) >= 0 && (b as number) >= 0 } },
    });
    expect(domain.functions[0]!.status).toBe('unchanged');
  });
});
