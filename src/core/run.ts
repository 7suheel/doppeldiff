import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { CompareOptions } from './compare/compare.js';
import { detectChanges, type Detection, type ListedFunction } from './detect/detect.js';
import { prepareDependencies, type DepsResult } from './git/deps.js';
import { isWorkingTreeClean, mergeBase, repoRoot, resolveCommit, git } from './git/git.js';
import { addWorktree, type Worktree } from './git/worktree.js';
import { packageRootOf, relPath, VerifySession } from './verify/session.js';
import { verifyFunction, type FunctionResult, type FunctionTarget } from './verify/verifyFunction.js';

export interface RunOptions {
  /** Any directory inside the repository. */
  cwd: string;
  /** Base revision (default: HEAD). */
  base?: string;
  /** Head revision (default: the working tree, including uncommitted changes). */
  head?: string;
  /** Compare against merge-base(base, head) like a pull request does (default true). */
  mergeBase?: boolean;
  seed?: number;
  /** Max inputs per function (default 1000). */
  runs?: number;
  /** Per-call timeout in ms (default 250). */
  timeoutMs?: number;
  /** Total time budget for exploring all functions, in ms. Undefined: no budget. */
  timeBudgetMs?: number;
  /** Freeze the clock and seed randomness in the code under test (default true). */
  freeze?: boolean;
  include?: string[];
  exclude?: string[];
  /** Only verify these functions (ids or export names). */
  only?: string[];
  compare?: CompareOptions;
  keepWorktrees?: boolean;
  /** Allow installing dependencies in the base worktree when the lockfile changed (default true). */
  install?: boolean;
  /** Cache directory for dependency installs (default ~/.cache/doppeldiff/deps). */
  depsCacheDir?: string;
  poolSize?: number;
  noSandbox?: boolean;
  showConsole?: boolean;
  onEvent?: (event: RunEvent) => void;
}

export type RunEvent =
  | { type: 'phase'; phase: 'materialize' | 'dependencies' | 'detect' | 'verify'; detail?: string }
  | { type: 'detected'; detection: Detection }
  | { type: 'function-start'; target: FunctionTarget; index: number; total: number }
  | { type: 'function-progress'; target: FunctionTarget; inputsRun: number; clusters: number }
  | { type: 'function-done'; result: FunctionResult; index: number; total: number };

export interface RunResult {
  tool: { name: 'doppeldiff'; version: string };
  base: { ref: string; sha: string };
  head: { ref: string; sha: string | null };
  seed: number;
  settings: { runs: number; timeoutMs: number; timeBudgetMs: number | null; freeze: boolean };
  /** Results for every function whose behavior may have changed. */
  functions: FunctionResult[];
  skipped: ListedFunction[];
  added: ListedFunction[];
  removed: ListedFunction[];
  identical: ListedFunction[];
  errors: { file: string; message: string }[];
  changedFiles: number;
  dependencies: DepsResult['actions'];
  timing: {
    totalMs: number;
    materializeMs: number;
    dependenciesMs: number;
    detectMs: number;
    verifyMs: number;
  };
}

export const DEFAULT_SEED = 1;
export const DEFAULT_RUNS = 1000;
export const DEFAULT_TIMEOUT_MS = 250;

export function toolVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    for (const p of ['../package.json', '../../package.json']) {
      try {
        return (require(p) as { version: string }).version;
      } catch {
        /* try next */
      }
    }
  } catch {
    /* ignore */
  }
  return '0.0.0';
}

export async function run(options: RunOptions): Promise<RunResult> {
  const t0 = Date.now();
  const emit = options.onEvent ?? (() => {});
  const seed = options.seed ?? DEFAULT_SEED;
  const runs = options.runs ?? DEFAULT_RUNS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const freeze = options.freeze ?? true;

  // 1. Resolve revisions and materialize both versions.
  emit({ type: 'phase', phase: 'materialize' });
  const repo = repoRoot(options.cwd);
  const baseRef = options.base ?? 'HEAD';
  const headRef = options.head;
  const headSha = headRef ? resolveCommit(repo, headRef) : undefined;
  let baseSha = resolveCommit(repo, baseRef);
  if (options.mergeBase !== false) baseSha = mergeBase(repo, baseSha, headSha ?? 'HEAD');

  const worktrees: Worktree[] = [];
  let session: VerifySession | undefined;
  try {
    const baseWt = addWorktree(repo, baseSha, { keep: options.keepWorktrees ?? false });
    worktrees.push(baseWt);
    let headRoot = repo;
    const currentHead = git(['rev-parse', 'HEAD'], repo).trim();
    if (headSha && !(headSha === currentHead && isWorkingTreeClean(repo))) {
      const headWt = addWorktree(repo, headSha, { keep: options.keepWorktrees ?? false });
      worktrees.push(headWt);
      headRoot = headWt.path;
    }
    const materializeMs = Date.now() - t0;

    // 2. Detect changed functions (parsing only needs sources, not dependencies).
    emit({ type: 'phase', phase: 'detect' });
    const tDetect = Date.now();
    const parser = new VerifySession({ baseRoot: baseWt.path, headRoot, timeoutMs, freeze, seed });
    const detection = detectChanges({
      repo,
      baseSha,
      ...(headSha ? { headSha } : {}),
      baseRoot: baseWt.path,
      headRoot,
      ...(options.include ? { include: options.include } : {}),
      ...(options.exclude ? { exclude: options.exclude } : {}),
      sourceFile: (side, file) => parser.sourceFile(side, file),
    });
    const only = options.only;
    if (only?.length) {
      detection.targets = detection.targets.filter((t) => only.some((o) => o === t.id || o === t.exportName));
    }
    emit({ type: 'detected', detection });
    const detectMs = Date.now() - tDetect;

    // 3. Dependencies for the worktrees (only the package dirs that contain targets).
    emit({ type: 'phase', phase: 'dependencies' });
    const tDeps = Date.now();
    const packageDirs = [
      ...new Set(detection.targets.map((t) => relPath(headRoot, packageRootOf(headRoot, t.headFile)))),
    ];
    const deps: DepsResult = { readPaths: [], actions: [] };
    if (detection.targets.length > 0) {
      for (const wt of worktrees) {
        const r = prepareDependencies({
          targetRoot: wt.path,
          sourceRoot: repo,
          packageDirs,
          ...(options.install !== undefined ? { install: options.install } : {}),
          ...(options.depsCacheDir !== undefined ? { cacheDir: options.depsCacheDir } : {}),
        });
        deps.readPaths.push(...r.readPaths);
        deps.actions.push(...r.actions);
      }
      // Package-level node_modules of the working copy may be symlinks (pnpm, workspaces): allow their targets.
      for (const dir of packageDirs) {
        const nm = join(repo, dir, 'node_modules');
        if (existsSync(nm)) deps.readPaths.push(realpathSync(nm));
      }
    }
    const dependenciesMs = Date.now() - tDeps;

    // 4. Verify each target in the sandboxed runners.
    emit({ type: 'phase', phase: 'verify' });
    const tVerify = Date.now();
    session = new VerifySession({
      baseRoot: baseWt.path,
      headRoot,
      timeoutMs,
      freeze,
      seed,
      // Both runners may read the working copy (for symlinked workspace packages); writes stay denied.
      extraReadPaths: [repo, ...deps.readPaths],
      sourceRepo: repo,
      ...(options.poolSize !== undefined ? { poolSize: options.poolSize } : {}),
      ...(options.noSandbox !== undefined ? { noSandbox: options.noSandbox } : {}),
      ...(options.showConsole !== undefined ? { showConsole: options.showConsole } : {}),
    });
    const functions: FunctionResult[] = [];
    const total = detection.targets.length;
    for (const [index, target] of detection.targets.entries()) {
      emit({ type: 'function-start', target, index, total });
      let deadline: number | undefined;
      if (options.timeBudgetMs !== undefined) {
        const remaining = options.timeBudgetMs - (Date.now() - tVerify);
        deadline = Date.now() + Math.max(500, remaining / (total - index));
      }
      const result = await verifyFunction(session, target, {
        seed,
        runs,
        ...(deadline !== undefined ? { deadline } : {}),
        ...(options.compare ? { compare: options.compare } : {}),
        onProgress: (p) => emit({ type: 'function-progress', target, ...p }),
      });
      functions.push(result);
      emit({ type: 'function-done', result, index, total });
    }
    const verifyMs = Date.now() - tVerify;

    return {
      tool: { name: 'doppeldiff', version: toolVersion() },
      base: { ref: baseRef, sha: baseSha },
      head: { ref: headRef ?? 'working tree', sha: headSha ?? null },
      seed,
      settings: { runs, timeoutMs, timeBudgetMs: options.timeBudgetMs ?? null, freeze },
      functions,
      skipped: detection.skipped,
      added: detection.added,
      removed: detection.removed,
      identical: detection.identical,
      errors: detection.errors,
      changedFiles: detection.files.length,
      dependencies: deps.actions,
      timing: { totalMs: Date.now() - t0, materializeMs, dependenciesMs, detectMs, verifyMs },
    };
  } finally {
    session?.close();
    for (const wt of worktrees) wt.dispose();
  }
}
