import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  type Dirent,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

const LOCKFILES: [string, PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

export interface DepsResult {
  /** node_modules directories (real paths) the runners must be allowed to read. */
  readPaths: string[];
  /** What happened, for the report's timing/diagnostics section. */
  actions: { dir: string; action: 'linked' | 'installed' | 'cached' | 'none'; reason: string; ms: number }[];
}

export interface DepsOptions {
  /** Repo root of the worktree that needs dependencies. */
  targetRoot: string;
  /** Repo root of the checkout whose node_modules are installed (the user's working copy). */
  sourceRoot: string;
  /** Package directories (repo-relative) that contain code under test. */
  packageDirs: string[];
  /** Allow running the package manager when the lockfile changed (default true). */
  install?: boolean;
  cacheDir?: string;
}

/** Content hash of a text file, insensitive to CRLF vs LF (Windows checkouts convert line endings). */
function hashFile(path: string): string {
  if (!existsSync(path)) return 'missing';
  return createHash('sha256').update(readFileSync(path, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
}

/** Dependency-relevant fields of a package.json. */
function manifestDeps(path: string): string {
  if (!existsSync(path)) return 'missing';
  try {
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return JSON.stringify([
      pkg.dependencies,
      pkg.devDependencies,
      pkg.optionalDependencies,
      pkg.peerDependencies,
      pkg.workspaces,
      pkg.overrides,
      pkg.resolutions,
      pkg.pnpm,
    ]);
  } catch {
    return 'invalid';
  }
}

function detectPackageManager(root: string): { pm: PackageManager; lockfile?: string } {
  for (const [file, pm] of LOCKFILES) if (existsSync(join(root, file))) return { pm, lockfile: file };
  return { pm: 'npm' };
}

/** Directory whose lockfile governs `packageDir`: the package itself if it has one, else the repo root. */
function lockRoot(root: string, packageDir: string): string {
  const own = join(root, packageDir);
  return LOCKFILES.some(([f]) => existsSync(join(own, f))) ? own : root;
}

/** Identity of the dependency tree for a package: lockfile content plus dependency fields of manifests. */
function lockKey(root: string, packageDir: string): string {
  const lr = lockRoot(root, packageDir);
  const { lockfile } = detectPackageManager(lr);
  const h = createHash('sha256');
  h.update(lockfile ? `${lockfile}:${hashFile(join(lr, lockfile))}` : 'no-lockfile');
  h.update(manifestDeps(join(root, 'package.json')));
  h.update(manifestDeps(join(root, packageDir, 'package.json')));
  return h.digest('hex');
}

function link(target: string, path: string): void {
  if (existsSync(path) || isSymlink(path)) rmSync(path, { recursive: true, force: true });
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function installCommand(pm: PackageManager, hasLock: boolean): [string, string[]] {
  switch (pm) {
    case 'pnpm':
      return [
        'pnpm',
        ['install', hasLock ? '--frozen-lockfile' : '--no-frozen-lockfile', '--ignore-scripts'],
      ];
    case 'yarn':
      return ['yarn', ['install', '--immutable', '--mode=skip-build']];
    case 'bun':
      return ['bun', ['install', '--frozen-lockfile', '--ignore-scripts']];
    default:
      return ['npm', [hasLock ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund']];
  }
}

/**
 * Make dependencies available to the base worktree:
 * - unchanged lockfile and manifests → symlink the head's node_modules (fast path, the common case);
 * - changed → install in the worktree with lifecycle scripts disabled, and cache the result by lock hash.
 */
export function prepareDependencies(options: DepsOptions): DepsResult {
  const result: DepsResult = { readPaths: [], actions: [] };
  const cacheDir = options.cacheDir ?? join(homedir(), '.cache', 'doppeldiff', 'deps');
  const dirs = [...new Set(['', ...options.packageDirs])];

  for (const dir of dirs) {
    const headNm = join(options.sourceRoot, dir, 'node_modules');
    const baseNm = join(options.targetRoot, dir, 'node_modules');
    const started = Date.now();
    if (!existsSync(headNm)) {
      if (dir === '' || existsSync(join(options.sourceRoot, dir, 'package.json'))) {
        result.actions.push({ dir, action: 'none', reason: 'no node_modules in the working copy', ms: 0 });
      }
      continue;
    }
    result.readPaths.push(realpathSync(headNm), ...symlinkedPackageTargets(headNm));
    if (samePath(options.targetRoot, options.sourceRoot)) continue;

    const baseKey = lockKey(options.targetRoot, dir);
    const headKey = lockKey(options.sourceRoot, dir);
    if (baseKey === headKey) {
      link(realpathSync(headNm), baseNm);
      result.actions.push({ dir, action: 'linked', reason: 'lockfile unchanged', ms: Date.now() - started });
      continue;
    }

    const cached = join(
      cacheDir,
      baseKey.slice(0, 24),
      dir.replace(/[\\/]/g, '__') || '_root',
      'node_modules',
    );
    if (existsSync(cached)) {
      link(cached, baseNm);
      result.readPaths.push(realpathSync(cached));
      result.actions.push({
        dir,
        action: 'cached',
        reason: 'lockfile changed; reused cached install',
        ms: Date.now() - started,
      });
      continue;
    }
    if (options.install === false) {
      link(realpathSync(headNm), baseNm);
      result.actions.push({
        dir,
        action: 'linked',
        reason: 'lockfile changed but installs are disabled; reusing the working copy dependencies',
        ms: Date.now() - started,
      });
      continue;
    }
    // Install where the governing lockfile lives (package dir or repo root for workspaces).
    const installRoot = lockRoot(options.targetRoot, dir);
    const { pm, lockfile } = detectPackageManager(installRoot);
    const [cmd, args] = installCommand(pm, lockfile !== undefined);
    try {
      execFileSync(cmd, args, {
        cwd: installRoot,
        stdio: 'pipe',
        env: { ...process.env, npm_config_ignore_scripts: 'true' },
        shell: process.platform === 'win32',
      });
    } catch (e) {
      const stderr = String((e as { stderr?: Buffer }).stderr ?? '').slice(-500);
      link(realpathSync(headNm), baseNm);
      result.actions.push({
        dir,
        action: 'linked',
        reason: `install failed (${cmd} ${args.join(' ')}): ${stderr.trim() || (e as Error).message}; reusing the working copy dependencies`,
        ms: Date.now() - started,
      });
      continue;
    }
    // Cache the install unless it contains relative links that would break when moved (file: deps, workspaces).
    if (existsSync(baseNm) && !isSymlink(baseNm) && symlinkedPackageTargets(baseNm).length > 0) {
      result.readPaths.push(realpathSync(baseNm), ...symlinkedPackageTargets(baseNm));
    } else if (existsSync(baseNm) && !isSymlink(baseNm)) {
      try {
        mkdirSync(dirname(cached), { recursive: true });
        renameSync(baseNm, cached);
        link(cached, baseNm);
        result.readPaths.push(realpathSync(cached));
      } catch {
        result.readPaths.push(realpathSync(baseNm));
      }
    }
    result.actions.push({
      dir,
      action: 'installed',
      reason: `lockfile changed; ran ${cmd} ${args[0]}`,
      ms: Date.now() - started,
    });
  }
  return result;
}

/**
 * Real paths of symlinked packages in a node_modules dir (npm `file:` deps, workspaces, `npm link`) that
 * live outside it: the runners need read access to them because Node resolves modules to real paths.
 */
export function symlinkedPackageTargets(nodeModules: string): string[] {
  const out = new Set<string>();
  const root = realpathSync(nodeModules);
  const visit = (dir: string, depth: number) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.name.startsWith('@') && e.isDirectory() && depth === 0) {
        visit(p, 1);
      } else if (e.isSymbolicLink()) {
        try {
          const target = realpathSync(p);
          if (!target.startsWith(root)) out.add(target);
        } catch {
          /* dangling link */
        }
      }
    }
  };
  visit(nodeModules, 0);
  return [...out];
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}
