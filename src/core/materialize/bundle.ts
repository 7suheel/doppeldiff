import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
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
export interface BundleOptions {
  /**
   * Monorepo support: the working copy whose node_modules are shared with this version, and this version's
   * repo root. Bare imports that resolve (through workspace symlinks) to source files inside the working
   * copy are redirected to the same path in this version's tree and bundled, so each version uses its own
   * workspace packages.
   */
  workspace?: { sourceRepo: string; versionRepo: string };
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function workspacePlugin(ws: NonNullable<BundleOptions['workspace']>): esbuild.Plugin {
  const sourceRepo = realpathSync(ws.sourceRepo);
  const versionRepo = realpathSync(ws.versionRepo);
  return {
    name: 'doppeldiff-workspaces',
    setup(build) {
      build.onResolve({ filter: /^[^./]|^\.[^./]|^\.\.[^/]/ }, async (args) => {
        if (args.pluginData === 'doppeldiff-skip' || BUILTINS.has(args.path) || args.kind === 'entry-point')
          return undefined;
        const r = await build.resolve(args.path, {
          resolveDir: args.resolveDir,
          kind: args.kind,
          pluginData: 'doppeldiff-skip',
        });
        if (r.errors.length > 0 || !r.path) return { path: args.path, external: true };
        let real: string;
        try {
          real = realpathSync(r.path);
        } catch {
          return { path: args.path, external: true };
        }
        if (real.split(sep).includes('node_modules')) return { path: args.path, external: true };
        // tsconfig `paths` aliases and similar: already inside this version's tree.
        if (isInside(real, versionRepo) || isInside(r.path, ws.versionRepo)) return { path: r.path };
        if (!isInside(real, sourceRepo)) return { path: args.path, external: true };
        // A workspace package symlinked from the shared node_modules: bundle this version's copy of it.
        const mapped = join(ws.versionRepo, relative(sourceRepo, real));
        return { path: existsSync(mapped) ? mapped : real };
      });
    },
  };
}

export async function bundleModule(
  root: string,
  entry: string,
  label: string,
  options: BundleOptions = {},
): Promise<BundleResult> {
  const tsconfig = existsSync(join(root, 'tsconfig.json')) ? join(root, 'tsconfig.json') : undefined;
  const build = (withTsconfig: boolean) =>
    esbuild.build({
      entryPoints: [entry],
      absWorkingDir: root,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      ...(options.workspace
        ? { plugins: [workspacePlugin(options.workspace)] }
        : { packages: 'external' as const }),
      write: false,
      metafile: true,
      logLevel: 'silent',
      banner: { js: REQUIRE_SHIM },
      ...(tsconfig && withTsconfig ? { tsconfig } : {}),
    });
  let result: Awaited<ReturnType<typeof build>>;
  try {
    result = await build(true);
  } catch (e) {
    // A tsconfig that cannot be loaded (e.g. `extends` from an uninstalled package): retry without it.
    if (!tsconfig) throw e;
    result = await build(false);
  }
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
