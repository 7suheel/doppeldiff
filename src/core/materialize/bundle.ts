import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
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

/** Workspace globs from package.json `workspaces` (array or `{ packages }`) or pnpm-workspace.yaml. */
function workspaceGlobs(repo: string): string[] {
  const globs: string[] = [];
  try {
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { workspaces?: unknown };
    const w = pkg.workspaces;
    if (Array.isArray(w)) globs.push(...w.filter((x): x is string => typeof x === 'string'));
    else if (w && typeof w === 'object' && Array.isArray((w as { packages?: unknown }).packages)) {
      globs.push(
        ...(w as { packages: unknown[] }).packages.filter((x): x is string => typeof x === 'string'),
      );
    }
  } catch {
    /* no root package.json */
  }
  try {
    const yaml = readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8');
    for (const m of yaml.matchAll(/^\s*-\s*['"]?([^'"#\n]+?)['"]?\s*$/gm)) globs.push(m[1]!);
  } catch {
    /* not pnpm */
  }
  return globs.filter((g) => !g.startsWith('!'));
}

/** Workspace package name → directory, read from a version's own tree (supports `dir`, `dir/*`, `dir/**`). */
export function workspacePackages(repo: string): Map<string, string> {
  const out = new Map<string, string>();
  const add = (dir: string) => {
    try {
      const name = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }).name;
      if (typeof name === 'string') out.set(name, dir);
    } catch {
      /* not a package */
    }
  };
  for (const glob of workspaceGlobs(repo)) {
    const clean = glob.replace(/\/+$/, '');
    const star = clean.search(/\*/);
    if (star === -1) {
      add(join(repo, clean));
      continue;
    }
    const base = join(repo, clean.slice(0, star).replace(/\/+$/, ''));
    try {
      for (const e of readdirSync(base, { withFileTypes: true }))
        if (e.isDirectory()) add(join(base, e.name));
    } catch {
      /* missing dir */
    }
  }
  return out;
}

function packageNameOf(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

function workspacePlugin(ws: NonNullable<BundleOptions['workspace']>): esbuild.Plugin {
  const sourceRepo = realpathSync(ws.sourceRepo);
  const versionRepo = realpathSync(ws.versionRepo);
  // Workspace packages are resolved from this version's own tree, never through node_modules links
  // (which point at the working copy and are junction chains on Windows).
  const packages = workspacePackages(ws.versionRepo);
  return {
    name: 'doppeldiff-workspaces',
    setup(build) {
      build.onResolve({ filter: /^[^./]|^\.[^./]|^\.\.[^/]/ }, async (args) => {
        if (args.pluginData === 'doppeldiff-skip' || BUILTINS.has(args.path) || args.kind === 'entry-point')
          return undefined;
        const name = packageNameOf(args.path);
        const pkgDir = packages.get(name);
        if (pkgDir) {
          const sub = args.path.slice(name.length).replace(/^\//, '');
          const target = sub ? join(pkgDir, sub) : pkgDir;
          const w = await build.resolve(`./${relative(args.resolveDir, target).split(sep).join('/')}`, {
            resolveDir: args.resolveDir,
            kind: args.kind,
            pluginData: 'doppeldiff-skip',
          });
          if (w.errors.length === 0 && w.path) return { path: w.path };
        }
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
