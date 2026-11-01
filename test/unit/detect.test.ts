import { afterEach, describe, expect, it } from 'vitest';
import { detectChanges, type Detection } from '../../src/core/detect/detect.js';
import { parseHunks, resolveCommit } from '../../src/core/git/git.js';
import { addWorktree } from '../../src/core/git/worktree.js';
import { VerifySession } from '../../src/core/verify/session.js';
import { makeRepo, type Files } from '../helpers/repo.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true, module: 'ESNext', moduleResolution: 'Bundler' },
});

function detect(base: Files, head: Files, opts: { commit?: boolean; exclude?: string[] } = {}): Detection {
  const repo = makeRepo({ 'tsconfig.json': TSCONFIG, ...base }, head, opts);
  const baseSha = resolveCommit(repo.root, 'main');
  const wt = addWorktree(repo.root, baseSha);
  const headSha = opts.commit ? resolveCommit(repo.root, 'pr') : undefined;
  const headRoot = headSha ? addWorktree(repo.root, headSha).path : repo.root;
  const session = new VerifySession({ baseRoot: wt.path, headRoot, timeoutMs: 100, freeze: true, seed: 1 });
  cleanups.push(() => {
    wt.dispose();
    repo.cleanup();
  });
  return detectChanges({
    repo: repo.root,
    baseSha,
    ...(headSha ? { headSha } : {}),
    baseRoot: wt.path,
    headRoot,
    ...(opts.exclude ? { exclude: opts.exclude } : {}),
    sourceFile: (side, f) => session.sourceFile(side, f),
  });
}

const ids = (d: Detection) => d.targets.map((t) => `${t.id} [${t.reason}]`).sort();

describe('change detection', () => {
  it('finds directly changed exported functions in all declaration forms', () => {
    const d = detect(
      {
        'src/a.ts': [
          'export function f(x: number) { return x + 1; }',
          'export const g = (x: number) => x * 2;',
          'const h = function (x: number) { return x - 1; };',
          'export { h as k };',
          'export default function (x: number) { return x; }',
          'export function same(x: number) { return x; }',
        ].join('\n'),
      },
      {
        'src/a.ts': [
          'export function f(x: number) { return x + 2; }',
          'export const g = (x: number) => x * 3;',
          'const h = function (x: number) { return x - 2; };',
          'export { h as k };',
          'export default function (x: number) { return -x; }',
          'export function same(x: number) { return x; }',
        ].join('\n'),
      },
    );
    expect(ids(d)).toEqual([
      'src/a.ts#default [code changed]',
      'src/a.ts#f [code changed]',
      'src/a.ts#g [code changed]',
      'src/a.ts#k [code changed]',
    ]);
  });

  it('treats comment and formatting changes as identical', () => {
    const d = detect(
      { 'src/a.ts': 'export function f(x: number) { return x + 1; }\n' },
      { 'src/a.ts': '/** Adds one. */\nexport function f(x: number) {\n  // increment\n  return x+1;\n}\n' },
    );
    expect(d.targets).toEqual([]);
    expect(d.identical.map((i) => i.id)).toEqual(['src/a.ts#f']);
  });

  it('finds unchanged exports that use a changed helper or constant (transitive impact)', () => {
    const d = detect(
      {
        'src/a.ts': [
          'const RATE = 0.2;',
          'function toCents(x: number) { return Math.round(x * 100); }',
          'function wrap(x: number) { return toCents(x); }',
          'export function price(x: number) { return wrap(x) / 100; }',
          'export function tax(x: number) { return x * RATE; }',
          'export function unrelated(x: number) { return x; }',
        ].join('\n'),
      },
      {
        'src/a.ts': [
          'const RATE = 0.21;',
          'function toCents(x: number) { return Math.floor(x * 100); }',
          'function wrap(x: number) { return toCents(x); }',
          'export function price(x: number) { return wrap(x) / 100; }',
          'export function tax(x: number) { return x * RATE; }',
          'export function unrelated(x: number) { return x; }',
        ].join('\n'),
      },
    );
    expect(ids(d)).toEqual([
      'src/a.ts#price [uses changed `toCents` (via wrap)]',
      'src/a.ts#tax [uses changed `RATE`]',
    ]);
  });

  it('ignores shadowed names that only look like a changed helper', () => {
    const d = detect(
      {
        'src/a.ts':
          'function helper() { return 1; }\nexport function f(helper: number) { return helper; }\nexport const u = () => helper();',
      },
      {
        'src/a.ts':
          'function helper() { return 2; }\nexport function f(helper: number) { return helper; }\nexport const u = () => helper();',
      },
    );
    expect(ids(d)).toEqual(['src/a.ts#u [uses changed `helper`]']);
  });

  it('follows imports one module deep, including unchanged files', () => {
    const d = detect(
      {
        'src/money.ts':
          'export function round(x: number) { return Math.round(x); }\nexport function keep(x: number) { return x; }',
        'src/cart.ts':
          "import { round, keep } from './money';\nexport function total(xs: number[]) { return round(xs.reduce((a, b) => a + b, 0)); }\nexport function k(x: number) { return keep(x); }",
      },
      {
        'src/money.ts':
          'export function round(x: number) { return Math.floor(x); }\nexport function keep(x: number) { return x; }',
      },
    );
    expect(ids(d)).toEqual([
      'src/cart.ts#total [uses changed `round` from src/money.ts]',
      'src/money.ts#round [code changed]',
    ]);
  });

  it('treats a changed import binding as a change', () => {
    const d = detect(
      {
        'src/a.ts':
          'export const r = (x: number) => Math.round(x);\nexport const f = (x: number) => Math.floor(x);',
        'src/b.ts': "import { r } from './a';\nexport function g(x: number) { return r(x); }",
      },
      { 'src/b.ts': "import { f as r } from './a';\nexport function g(x: number) { return r(x); }" },
    );
    expect(ids(d)).toEqual(['src/b.ts#g [uses changed `r`]']);
  });

  it('lists added, removed and skipped exports', () => {
    const d = detect(
      {
        'src/a.ts':
          'export function gone() {}\nexport class C { m() { return 1; } }\nexport const LIMIT = 10;\nexport function* gen() { yield 1; }',
      },
      {
        'src/a.ts':
          'export function fresh() {}\nexport class C { m() { return 2; } }\nexport const LIMIT = 20;\nexport function* gen() { yield 2; }',
        'src/new.ts': 'export const n = () => 1;',
      },
    );
    expect(d.added.map((a) => a.id).sort()).toEqual(['src/a.ts#fresh', 'src/new.ts#n']);
    expect(d.removed.map((a) => a.id)).toEqual(['src/a.ts#gone']);
    expect(d.skipped.map((s) => `${s.id}: ${s.reason}`).sort()).toEqual([
      'src/a.ts#C: class (class methods are out of scope in v1)',
      'src/a.ts#LIMIT: not a function (exported value)',
      'src/a.ts#gen: generator function',
    ]);
    expect(d.targets).toEqual([]);
  });

  it('excludes tests and honours exclude globs', () => {
    const d = detect(
      {
        'src/a.test.ts': 'export const t = () => 1;',
        'src/b.ts': 'export const b = () => 1;',
        'lib/c.ts': 'export const c = () => 1;',
      },
      {
        'src/a.test.ts': 'export const t = () => 2;',
        'src/b.ts': 'export const b = () => 2;',
        'lib/c.ts': 'export const c = () => 2;',
      },
      { exclude: ['lib/**'] },
    );
    expect(ids(d)).toEqual(['src/b.ts#b [code changed]']);
  });

  it('maps renamed files to their base path', () => {
    const body = Array.from({ length: 20 }, (_, i) => `export const v${i} = (x: number) => x + ${i};`).join(
      '\n',
    );
    const d = detect(
      { 'src/old.ts': body },
      { 'src/old.ts': null, 'src/new.ts': body.replace('x + 3;', 'x + 33;') },
      { commit: true },
    );
    expect(d.files[0]).toMatchObject({ status: 'renamed', basePath: 'src/old.ts', headPath: 'src/new.ts' });
    expect(ids(d)).toEqual(['src/new.ts#v3 [code changed]']);
    expect(d.targets[0]!.baseFile.replace(/\\/g, '/')).toMatch(/src\/old\.ts$/);
  });

  it('handles JavaScript (ESM and CommonJS-style exports)', () => {
    const d = detect(
      {
        'src/a.mjs': 'export function f(x) { return x + 1; }',
        'src/b.js': 'export const g = (s) => s.trim();',
      },
      {
        'src/a.mjs': 'export function f(x) { return x + 2; }',
        'src/b.js': 'export const g = (s) => s.trimStart();',
      },
    );
    expect(ids(d)).toEqual(['src/a.mjs#f [code changed]', 'src/b.js#g [code changed]']);
  });
});

describe('diff hunks', () => {
  it('parses unified diff hunk headers', () => {
    expect(parseHunks('@@ -1,2 +1,3 @@\n@@ -10 +11,0 @@')).toEqual([
      { baseStart: 1, baseLines: 2, headStart: 1, headLines: 3 },
      { baseStart: 10, baseLines: 1, headStart: 11, headLines: 0 },
    ]);
  });
});

describe('CommonJS', () => {
  it('detects changes in module.exports / exports.x patterns', () => {
    const d = detect(
      {
        'src/a.cjs': [
          'function total(xs) { return xs.reduce((a, b) => a + b, 0); }',
          'function keep(x) { return x; }',
          'exports.inline = (s) => s.trim();',
          'module.exports.other = function (n) { return n * 2; };',
          'module.exports = { total, keep, renamed: keep };',
        ].join('\n'),
      },
      {
        'src/a.cjs': [
          'function total(xs) { return xs.reduce((a, b) => a + b, 1); }',
          'function keep(x) { return x; }',
          'exports.inline = (s) => s.trimEnd();',
          'module.exports.other = function (n) { return n * 2; };',
          'module.exports = { total, keep, renamed: keep };',
        ].join('\n'),
      },
    );
    expect(ids(d)).toEqual(['src/a.cjs#inline [code changed]', 'src/a.cjs#total [code changed]']);
  });
});

describe('workspace packages', () => {
  it('reads npm/yarn workspaces and pnpm-workspace.yaml from a tree', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { workspacePackages } = await import('../../src/core/materialize/bundle.js');
    const mk = (root: string, files: Record<string, string>) => {
      for (const [p, c] of Object.entries(files)) {
        mkdirSync(join(root, p, '..'), { recursive: true });
        writeFileSync(join(root, p), c);
      }
    };
    const npmRoot = mkdtempSync(join(tmpdir(), 'dd-ws-npm-'));
    mk(npmRoot, {
      'package.json': JSON.stringify({ workspaces: ['packages/*', 'tools/cli'] }),
      'packages/a/package.json': JSON.stringify({ name: '@org/a' }),
      'packages/b/package.json': JSON.stringify({ name: '@org/b' }),
      'tools/cli/package.json': JSON.stringify({ name: 'cli' }),
    });
    expect([...workspacePackages(npmRoot).keys()].sort()).toEqual(['@org/a', '@org/b', 'cli']);
    const yarnRoot = mkdtempSync(join(tmpdir(), 'dd-ws-yarn-'));
    mk(yarnRoot, {
      'package.json': JSON.stringify({ workspaces: { packages: ['libs/*'] } }),
      'libs/x/package.json': JSON.stringify({ name: 'x' }),
    });
    expect([...workspacePackages(yarnRoot).keys()]).toEqual(['x']);
    const pnpmRoot = mkdtempSync(join(tmpdir(), 'dd-ws-pnpm-'));
    mk(pnpmRoot, {
      'pnpm-workspace.yaml': 'packages:\n  - \'pkgs/*\'\n  - "!pkgs/ignored"\n',
      'pkgs/p/package.json': JSON.stringify({ name: 'p' }),
    });
    expect([...workspacePackages(pnpmRoot).keys()]).toEqual(['p']);
  });
});
