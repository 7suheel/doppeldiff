import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project, ts, type SourceFile } from 'ts-morph';
import { bundleModule } from '../materialize/bundle.js';
import { RunnerPool, type LoadResult } from '../runner/pool.js';

export type Side = 'base' | 'head';

export interface SessionOptions {
  baseRoot: string;
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
}

export interface LoadedModule {
  moduleId: string;
  load: LoadResult;
}

export const DEFAULT_NOW = Date.UTC(2025, 0, 15, 12, 0, 0);

function readPathsFor(root: string): string[] {
  const paths = [root, join(tmpdir(), 'doppeldiff-bundles')];
  const nm = join(root, 'node_modules');
  if (existsSync(nm)) paths.push(realpathSync(nm));
  return paths;
}

/**
 * Holds everything shared across functions of one run: the two runner pools (base/head),
 * a ts-morph project per version and the bundled modules.
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
    this.pools = {
      base: new RunnerPool({ ...common, label: 'base', readPaths: readPathsFor(options.baseRoot) }),
      head: new RunnerPool({ ...common, label: 'head', readPaths: readPathsFor(options.headRoot) }),
    };
  }

  project(side: Side): Project {
    const root = this.roots[side];
    let p = this.projects.get(side);
    if (!p) {
      const tsconfig = join(root, 'tsconfig.json');
      p = existsSync(tsconfig)
        ? new Project({
            tsConfigFilePath: tsconfig,
            skipAddingFilesFromTsConfig: true,
            compilerOptions: { allowJs: true },
          })
        : new Project({
            compilerOptions: {
              strict: true,
              allowJs: true,
              target: ts.ScriptTarget.ES2022,
              module: ts.ModuleKind.ESNext,
              moduleResolution: ts.ModuleResolutionKind.Bundler,
            },
          });
      this.projects.set(side, p);
    }
    return p;
  }

  sourceFile(side: Side, file: string): SourceFile {
    const project = this.project(side);
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
        const bundle = await bundleModule(this.roots[side], file, side);
        const moduleId = key;
        const load = await this.pools[side].load(moduleId, bundle.path);
        return { moduleId, load };
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
