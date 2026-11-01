import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, posix } from 'node:path';
import { DEFAULT_NOW, packageRootOf } from '../verify/session.js';
import type { Behavior, Example, FunctionReport, Report } from './model.js';

export type Framework = 'vitest' | 'jest';

export interface TestgenOptions {
  /** Root of the head version (the working copy): files are written here. */
  root: string;
  /** Output directory relative to `root` (default `tests/doppeldiff`). */
  outDir?: string;
  framework?: Framework | 'auto';
  /** Write files (default true). When false, only returns them. */
  write?: boolean;
}

export interface GeneratedFile {
  path: string;
  content: string;
  cases: number;
}

const BUILTIN_ERRORS = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'EvalError',
  'URIError',
  'AggregateError',
]);
const PRIMITIVE_CODE = /^(?:-?\d|-?Infinity|undefined|null|true|false|"|-?\d+n$)/;

/** Pick the test framework from the nearest package.json (vitest wins if both are present). */
export function detectFramework(root: string, file: string): Framework {
  for (const dir of [packageRootOf(root, join(root, file)), root]) {
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<
        string,
        Record<string, string> | undefined
      >;
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.vitest) return 'vitest';
      if (deps.jest) return 'jest';
    } catch {
      /* ignore */
    }
  }
  return 'vitest';
}

function importPath(fromFile: string, sourceFile: string): string {
  let rel = posix.relative(posix.dirname(fromFile), sourceFile);
  if (!rel.startsWith('.')) rel = `./${rel}`;
  const ext = extname(rel);
  // TypeScript sources are imported without extension (resolved by the test runner); JS keeps its extension.
  if (['.ts', '.tsx', '.mts', '.cts'].includes(ext)) rel = rel.slice(0, -ext.length);
  return rel;
}

function comment(s: string): string {
  return s.replace(/\*\//g, '*\\/').replace(/\r?\n/g, ' ');
}

function title(s: string): string {
  return JSON.stringify(s.length > 120 ? `${s.slice(0, 119)}…` : s);
}

/** Assertion source for one example, or a reason it cannot be pinned. */
function assertion(local: string, ex: Example): { code: string } | { skip: string } {
  if (ex.argsCode === undefined) return { skip: 'arguments cannot be written as code' };
  const call = `${local}(${ex.argsCode})`;
  const out = ex.new;
  if (ex.mutation) {
    if (ex.mutation.newCode === undefined) return { skip: 'mutated argument cannot be written as code' };
    return {
      code: [
        `const args = [${ex.argsCode}] as const;`,
        out.kind === 'throw'
          ? `try { ${out.async ? 'await ' : ''}${local}(...(args as unknown as Parameters<typeof ${local}>)); } catch { /* expected to throw */ }`
          : `${out.async ? 'await ' : ''}${local}(...(args as unknown as Parameters<typeof ${local}>));`,
        `expect(args[${ex.mutation.argIndex}]).toEqual(${ex.mutation.newCode});`,
      ].join('\n    '),
    };
  }
  switch (out.kind) {
    case 'return': {
      if (out.code === undefined) return { skip: `return value cannot be written as code (${out.display})` };
      const matcher =
        out.code === 'NaN'
          ? 'toBeNaN()'
          : PRIMITIVE_CODE.test(out.code)
            ? `toBe(${out.code})`
            : `toEqual(${out.code})`;
      return {
        code: out.async ? `await expect(${call}).resolves.${matcher};` : `expect(${call}).${matcher};`,
      };
    }
    case 'throw': {
      const checks: string[] = [];
      if (out.errorClass && BUILTIN_ERRORS.has(out.errorClass)) checks.push(`toThrow(${out.errorClass})`);
      if (out.message !== undefined) checks.push(`toThrow(${JSON.stringify(out.message)})`);
      if (checks.length === 0) checks.push('toThrow()');
      return {
        code: checks
          .map((c) => (out.async ? `await expect(${call}).rejects.${c};` : `expect(() => ${call}).${c};`))
          .join('\n    '),
      };
    }
    default:
      return { skip: `new version ${out.display}` };
  }
}

function fileFor(f: FunctionReport, outDir: string, taken: Set<string>, ts: boolean): string {
  const ext = ts ? '.test.ts' : '.test.js';
  const safe = f.exportName === 'default' ? basename(f.file).replace(/\.[^.]+$/, '') : f.exportName;
  let p = posix.join(outDir, `${safe}${ext}`);
  if (taken.has(p)) p = posix.join(outDir, `${basename(f.file).replace(/\.[^.]+$/, '')}.${safe}${ext}`);
  taken.add(p);
  return p;
}

function renderFile(
  r: Report,
  f: FunctionReport,
  path: string,
  framework: Framework,
): { content: string; cases: number } {
  const ts = path.endsWith('.ts');
  const local = f.exportName === 'default' ? 'subject' : f.exportName;
  const imp = importPath(path, f.file);
  const lines: string[] = [];
  lines.push(
    `// Generated by doppeldiff v${r.tool.version}: pins the current behavior of \`${f.exportName}\` (${f.file}).`,
  );
  lines.push(
    `// Observed differences against ${r.base.sha.slice(0, 7)}; review before committing. Regenerate with \`npx doppeldiff --write-tests\`.`,
  );
  if (r.settings.freeze) {
    lines.push(
      `// Values were observed with the clock frozen at ${new Date(DEFAULT_NOW).toISOString()} and TZ=UTC.`,
    );
  }
  if (framework === 'vitest')
    lines.push(`import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';`);
  else lines.push(`import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';`);
  lines.push(
    f.exportName === 'default' ? `import ${local} from '${imp}';` : `import { ${local} } from '${imp}';`,
  );
  lines.push('');
  lines.push(`describe(${JSON.stringify(`${f.exportName} (doppeldiff)`)}, () => {`);
  if (r.settings.freeze) {
    if (framework === 'vitest') {
      lines.push(
        `  beforeAll(() => {`,
        `    vi.useFakeTimers({ now: ${DEFAULT_NOW}, toFake: ['Date'] });`,
        `  });`,
      );
      lines.push(`  afterAll(() => {`, `    vi.useRealTimers();`, `  });`);
    } else {
      lines.push(
        `  beforeAll(() => {`,
        `    jest.useFakeTimers({ now: ${DEFAULT_NOW}, doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });`,
        `  });`,
        `  afterAll(() => {`,
        `    jest.useRealTimers();`,
        `  });`,
      );
    }
  }
  let cases = 0;
  f.behaviors.forEach((b: Behavior) => {
    lines.push('');
    if (b.label === 'unclaimed' || b.label === 'suspicious') {
      lines.push(
        `  // ⚠️ ${b.label === 'unclaimed' ? 'Unclaimed' : 'Suspicious'} behavior change: ${comment(b.title)}.`,
      );
      lines.push(`  // These tests pin the NEW behavior. Delete them if the change is a bug.`);
    } else {
      lines.push(`  // ${comment(b.title)}`);
    }
    for (const ex of b.examples) {
      const a = assertion(local, ex);
      if ('skip' in a) {
        lines.push(`  // Not pinned: ${comment(ex.call)}: ${comment(a.skip)}`);
        continue;
      }
      const isAsync = a.code.includes('await ');
      lines.push(`  it(${title(ex.call)}, ${isAsync ? 'async ' : ''}() => {`);
      lines.push(`    // Before: ${comment(ex.old.display)}`);
      lines.push(
        `    ${ts ? a.code : a.code.replace(/ as const;/, ';').replace(/ as unknown as Parameters<typeof \w+>/, '')}`,
      );
      lines.push(`  });`);
      cases++;
    }
  });
  lines.push('});', '');
  return { content: lines.join('\n'), cases };
}

/** Generate one regression test file per function with behavior changes. */
export function generateTests(
  r: Report,
  options: TestgenOptions,
): { framework: Framework; files: GeneratedFile[] } {
  const outDir = (options.outDir ?? 'tests/doppeldiff').replace(/\\/g, '/').replace(/\/$/, '');
  const changed = r.functions.filter((f) => f.behaviors.length > 0);
  const framework: Framework =
    options.framework && options.framework !== 'auto'
      ? options.framework
      : detectFramework(options.root, changed[0]?.file ?? '.');
  const taken = new Set<string>();
  const files: GeneratedFile[] = [];
  for (const f of changed) {
    const ts = /\.(?:ts|tsx|mts|cts)$/.test(f.file);
    const path = fileFor(f, outDir, taken, ts);
    const { content, cases } = renderFile(r, f, path, framework);
    if (cases === 0) continue;
    files.push({ path, content, cases });
    if (options.write !== false) {
      const abs = join(options.root, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
  }
  return { framework, files };
}
