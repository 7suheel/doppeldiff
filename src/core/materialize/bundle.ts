import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import * as esbuild from 'esbuild';

export interface BundleResult {
  /** Absolute path of the bundled ESM module. */
  path: string;
  /** Directory the runner must be allowed to read. */
  dir: string;
  /** Bare package imports left external. */
  externals: string[];
}

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

/** ESM output that still supports `require()` of external packages from bundled CommonJS code. */
const REQUIRE_SHIM =
  "import { createRequire as __ddCreateRequire } from 'node:module'; const require = __ddCreateRequire(import.meta.url);";

/**
 * Bundle one module of one version of the project with esbuild: TypeScript, JSX, ESM/CJS interop and
 * tsconfig `paths` are handled here. Packages stay external and resolve against the version's own
 * node_modules, so the bundle is written inside `<root>/node_modules/.cache/doppeldiff/` when the module
 * imports packages, and to the OS temp dir otherwise.
 */
export async function bundleModule(root: string, entry: string, label: string): Promise<BundleResult> {
  const tsconfig = existsSync(join(root, 'tsconfig.json')) ? join(root, 'tsconfig.json') : undefined;
  const result = await esbuild.build({
    entryPoints: [entry],
    absWorkingDir: root,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    write: false,
    metafile: true,
    logLevel: 'silent',
    banner: { js: REQUIRE_SHIM },
    ...(tsconfig ? { tsconfig } : {}),
  });
  const code = result.outputFiles[0]!.text;
  const externals = new Set<string>();
  for (const out of Object.values(result.metafile.outputs)) {
    for (const imp of out.imports) if (imp.external && !BUILTINS.has(imp.path)) externals.add(imp.path);
  }
  const hash = createHash('sha256').update(code).digest('hex').slice(0, 12);
  const name = `${label}-${relative(root, entry).replace(/[^\w.-]+/g, '_')}-${hash}.mjs`;
  const dir =
    externals.size > 0 && existsSync(join(root, 'node_modules'))
      ? join(root, 'node_modules', '.cache', 'doppeldiff')
      : join(tmpdir(), 'doppeldiff-bundles');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  if (!existsSync(path)) writeFileSync(path, code);
  return { path, dir, externals: [...externals] };
}
