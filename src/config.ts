import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type fcType from 'fast-check';
import type { Arbitrary } from 'fast-check';
import type { CompareOptions } from './core/compare/compare.js';

export interface FunctionConfig {
  /** Custom argument generator: return an arbitrary of the full argument list. */
  args?: (fc: typeof fcType) => Arbitrary<unknown[]>;
  /** Extra inputs to always try first. */
  examples?: unknown[][];
  /** Do not verify this function (true or a reason). */
  skip?: boolean | string;
  runs?: number;
}

export interface DoppeldiffConfig {
  include?: string[];
  exclude?: string[];
  runs?: number;
  timeoutMs?: number;
  seed?: number;
  freeze?: boolean;
  failOn?: 'unclaimed' | 'any' | 'never';
  compare?: CompareOptions;
  /** Per-function settings, keyed by `path/to/file.ts#exportName` or just `exportName`. */
  functions?: Record<string, FunctionConfig>;
  /** Regression test output directory (default tests/doppeldiff). */
  testsDir?: string;
}

/** Identity helper for typed config files. */
export function defineConfig(config: DoppeldiffConfig): DoppeldiffConfig {
  return config;
}

export const CONFIG_FILES = [
  'doppeldiff.config.ts',
  'doppeldiff.config.mts',
  'doppeldiff.config.js',
  'doppeldiff.config.mjs',
];

/**
 * Load `doppeldiff.config.*` from the repository root. The config runs in the main process (it builds
 * arbitraries), so it is treated like any other project build script: trusted code from the checkout.
 */
export async function loadConfig(
  root: string,
  explicit?: string,
): Promise<{ config: DoppeldiffConfig; path: string | null }> {
  const path = explicit
    ? join(root, explicit)
    : CONFIG_FILES.map((f) => join(root, f)).find((p) => existsSync(p));
  if (!path) return { config: {}, path: null };
  if (!existsSync(path)) throw new Error(`config file not found: ${path}`);
  const esbuild = await import('esbuild');
  const result = await esbuild.build({
    entryPoints: [path],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    write: false,
    logLevel: 'silent',
    banner: {
      js: "import { createRequire as __ddRequire } from 'node:module'; const require = __ddRequire(import.meta.url);",
    },
    // `import { defineConfig } from 'doppeldiff'` should work even when doppeldiff is not installed locally.
    plugins: [
      {
        name: 'doppeldiff-self',
        setup(build) {
          build.onResolve({ filter: /^doppeldiff$/ }, () => ({
            path: 'doppeldiff',
            namespace: 'doppeldiff-self',
          }));
          build.onLoad({ filter: /.*/, namespace: 'doppeldiff-self' }, () => ({
            contents: 'export const defineConfig = (c) => c;',
            loader: 'js',
          }));
        },
      },
    ],
  });
  const code = result.outputFiles[0]!.text;
  const hash = createHash('sha256').update(code).digest('hex').slice(0, 16);
  const dir = join(tmpdir(), 'doppeldiff-config');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `config-${hash}.mjs`);
  writeFileSync(file, code);
  const mod = (await import(pathToFileURL(file).href)) as { default?: DoppeldiffConfig };
  return { config: mod.default ?? {}, path };
}

/** Find the per-function config entry for a target. */
export function functionConfig(
  config: DoppeldiffConfig,
  id: string,
  exportName: string,
): FunctionConfig | undefined {
  return config.functions?.[id] ?? config.functions?.[exportName];
}
