import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Project, ts, type SourceFile } from 'ts-morph';
import { bundleModule } from '../materialize/bundle.js';
import { RunnerPool, type LoadResult } from '../runner/pool.js';

export type Side = 'base' | 'head';

export interface SessionOptions {
  /** Root directory of the base version (repo root or worktree). */
  baseRoot: string;
  /** Root directory of the head version. */
  headRoot: string;
  timeoutMs: number;
  freeze: boolean;
  /** Frozen clock value; default 2025-01-15T12:00:00Z. */
  now?: number;
  seed: number;
  poolSize?: number;
  memoryMb?: number;
  showConsole?: boolean;
  noSandbox?: boolean;
  /** Extra directories the runners may read (e.g. node_modules real paths). */
  extraReadPaths?: string[];
  /** The user's working copy (whose node_modules both versions share), for monorepo workspace mapping. */
  sourceRepo?: string;
}

export interface LoadedModule {
  moduleId: string;
  load: LoadResult;
}

export const DEFAULT_NOW = Date.UTC(2025, 0, 15, 12, 0, 0);

function readPathsFor(root: string, extra: string[]): string[] {
  const paths = [root, join(tmpdir(), 'doppeldiff-bundles'), ...extra];
  const nm = join(root, 'node_modules');
  if (existsSync(nm)) paths.push(realpathSync(nm));
  return paths;
}

/**
 * Nearest directory at or above `file` (but not above `root`) that contains a tsconfig.json or
 * package.json: the "package root" used for type analysis and bundling.
 */
export function packageRootOf(root: string, file: string): string {
  const absRoot = resolve(root);
  let dir = dirname(resolve(file));
  while (dir.startsWith(absRoot)) {
    if (existsSync(join(dir, 'tsconfig.json')) || existsSync(join(dir, 'package.json'))) return dir;
    if (dir === absRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return absRoot;
}

/** Repo-relative, forward-slash path. */
export function relPath(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

/**
 * Holds everything shared across functions of one run: the two runner pools (base/head), a ts-morph
 * project per package root and version, and the bundled modules.
 */
export class VerifySession {
  readonly pools: Record<Side, RunnerPool>;
  readonly roots: Record<Side, string>;
  private readonly projects = new Map<string, Project>();
  private readonly modules = new Map<string, Promise<LoadedModule>>();

  constructor(readonly options: SessionOptions) {
    this.roots = { base: options.baseRoot, head: options.headRoot };
    const common = {
      timeoutMs: options.timeoutMs,
      freeze: options.freeze,
      now: options.now ?? DEFAULT_NOW,
      seed: options.seed,
      ...(options.poolSize !== undefined ? { size: options.poolSize } : {}),
      ...(options.memoryMb !== undefined ? { memoryMb: options.memoryMb } : {}),
      ...(options.showConsole !== undefined ? { showConsole: options.showConsole } : {}),
      ...(options.noSandbox !== undefined ? { noSandbox: options.noSandbox } : {}),
    };
    const extra = options.extraReadPaths ?? [];
    this.pools = {
      base: new RunnerPool({ ...common, label: 'base', readPaths: readPathsFor(options.baseRoot, extra) }),
      head: new RunnerPool({ ...common, label: 'head', readPaths: readPathsFor(options.headRoot, extra) }),
    };
  }

  /** ts-morph project for the package containing `file` in the given version. */
  project(side: Side, file: string): Project {
    const pkg = packageRootOf(this.roots[side], file);
    const key = `${side}:${pkg}`;
    let p = this.projects.get(key);
    if (!p) {
      const tsconfig = join(pkg, 'tsconfig.json');
      p = existsSync(tsconfig)
        ? new Project({
            tsConfigFilePath: tsconfig,
            skipAddingFilesFromTsConfig: true,
            compilerOptions: { allowJs: true, noEmit: true },
          })
        : new Project({
            compilerOptions: {
              strict: true,
              allowJs: true,
              checkJs: false,
              target: ts.ScriptTarget.ES2022,
              module: ts.ModuleKind.ESNext,
              moduleResolution: ts.ModuleResolutionKind.Bundler,
            },
          });
      this.projects.set(key, p);
    }
    return p;
  }

  /** Parsed source file (with its imports resolved for the type checker). */
  sourceFile(side: Side, file: string): SourceFile {
    const project = this.project(side, file);
    const existing = project.getSourceFile(file);
    if (existing) return existing;
    const sf = project.addSourceFileAtPath(file);
    project.resolveSourceFileDependencies();
    return sf;
  }

  /** Bundle and load a module in the side's runner pool (memoized). */
  loadModule(side: Side, file: string): Promise<LoadedModule> {
    const key = `${side}:${file}`;
    let p = this.modules.get(key);
    if (!p) {
      p = (async () => {
        const ws = this.options.sourceRepo
          ? { workspace: { sourceRepo: this.options.sourceRepo, versionRepo: this.roots[side] } }
          : {};
        const bundle = await bundleModule(packageRootOf(this.roots[side], file), file, side, ws);
        const load = await this.pools[side].load(key, bundle.path);
        return { moduleId: key, load };
      })();
      this.modules.set(key, p);
    }
    return p;
  }

  close(): void {
    this.pools.base.close();
    this.pools.head.close();
  }
}
