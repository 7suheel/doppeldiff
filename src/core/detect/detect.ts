import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import picomatch from 'picomatch';
import { asFunctionLike } from '../analyze/locate.js';
import { changedFiles, git, type ChangedFile } from '../git/git.js';
import type { Side } from '../verify/session.js';
import type { FunctionTarget } from '../verify/verifyFunction.js';
import { changedTopLevel, indexModule, reach, type ModuleIndex } from './toplevel.js';
import type { SourceFile } from 'ts-morph';

export const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

export const DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/*.d.ts',
  '**/*.d.mts',
  '**/*.d.cts',
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  '**/__mocks__/**',
  '**/test/**',
  '**/tests/**',
  '**/test.{js,ts,mjs,cjs}',
  '**/tests.{js,ts,mjs,cjs}',
  '**/*.config.*',
  '**/.*/**',
];

export interface DetectOptions {
  /** Repository root of the head version (where git commands run). */
  repo: string;
  baseSha: string;
  /** Head revision, or undefined for the working tree. */
  headSha?: string;
  baseRoot: string;
  headRoot: string;
  include?: string[];
  exclude?: string[];
  /** Depth for following references inside a module (default 3). */
  transitiveDepth?: number;
  /** Follow imports one module deep (default true). */
  crossModule?: boolean;
  sourceFile: (side: Side, absFile: string) => SourceFile;
}

export interface ListedFunction {
  id: string;
  file: string;
  exportName: string;
  kind: string;
  reason?: string;
}

export interface Detection {
  /** Changed source files considered (after include/exclude). */
  files: ChangedFile[];
  targets: FunctionTarget[];
  /** Changed exports that cannot be tested in v1 (classes, values, generators, …). */
  skipped: ListedFunction[];
  added: ListedFunction[];
  removed: ListedFunction[];
  /** Exports whose code changed only in comments/formatting. */
  identical: ListedFunction[];
  /** Changed files that could not be analyzed. */
  errors: { file: string; message: string }[];
}

/** Canonical path key: real path with forward slashes (TypeScript reports resolved, posix-style paths). */
function pathKey(p: string): string {
  let r = p;
  try {
    r = realpathSync.native(p);
  } catch {
    /* keep as is */
  }
  return r.replace(/\\/g, '/');
}

function isSource(path: string): boolean {
  return SOURCE_EXTENSIONS.includes(extname(path));
}

function exportKind(
  index: ModuleIndex,
  topName: string,
): { testable: boolean; kind: string; reason?: string } {
  const top = index.decls.get(topName)!;
  if (top.kind === 'class')
    return { testable: false, kind: 'class', reason: 'class (class methods are out of scope in v1)' };
  if (top.kind === 'enum') return { testable: false, kind: 'enum', reason: 'enum (not a function)' };
  if (top.kind === 'import') return { testable: false, kind: 'import', reason: 're-exported import' };
  const loc = asFunctionLike(top.node);
  if (loc.ok) return { testable: true, kind: 'function' };
  return { testable: false, kind: top.kind === 'variable' ? 'value' : top.kind, reason: loc.reason };
}

/**
 * Determine which exported functions may have changed behavior between two versions:
 * - directly: their normalized declaration differs;
 * - transitively: they reference (within `transitiveDepth` hops) a changed module-level binding,
 *   or an imported binding whose declaration changed in another module (one module deep).
 */
export function detectChanges(options: DetectOptions): Detection {
  const include = options.include?.length ? picomatch(options.include, { dot: true }) : () => true;
  const exclude = picomatch([...DEFAULT_EXCLUDE, ...(options.exclude ?? [])], { dot: true });
  const wanted = (p: string | undefined) => !!p && isSource(p) && include(p) && !exclude(p);
  const depth = options.transitiveDepth ?? 3;

  const all = changedFiles(options.repo, options.baseSha, options.headSha);
  const files = all.filter((f) => wanted(f.headPath) || wanted(f.basePath));
  const detection: Detection = {
    files,
    targets: [],
    skipped: [],
    added: [],
    removed: [],
    identical: [],
    errors: [],
  };

  /** Changed top-level names per head file (absolute path). */
  const changedByFile = new Map<string, Set<string>>();
  const targetIds = new Set<string>();

  const pushTarget = (t: FunctionTarget) => {
    if (targetIds.has(t.id)) return;
    targetIds.add(t.id);
    detection.targets.push(t);
  };

  // Add every file analysis will need to the projects *before* querying the type checker: each addition
  // invalidates the TypeScript program, and rebuilding it per file is quadratic on large repositories.
  const preload = (side: Side, abs: string) => {
    try {
      if (existsSync(abs)) options.sourceFile(side, abs);
    } catch {
      /* reported when analyzed */
    }
  };
  const changedStems = new Set<string>();
  for (const f of files) {
    if (f.headPath) {
      preload('head', join(options.headRoot, f.headPath));
      changedStems.add(basename(f.headPath).replace(/\.[^.]+$/, ''));
      const name = nearestPackageName(join(options.headRoot, f.headPath), options.headRoot);
      if (name) changedStems.add(name);
    }
    if (f.basePath) preload('base', join(options.baseRoot, f.basePath));
  }
  const changedHeadKeys = new Set(
    files.filter((f) => f.headPath).map((f) => pathKey(join(options.headRoot, f.headPath!))),
  );
  const crossCandidates =
    options.crossModule === false || files.length === 0
      ? []
      : listSourceFiles(options.repo, options.headSha)
          .filter((p) => wanted(p))
          .map((p) => ({ rel: p, abs: join(options.headRoot, p) }))
          .filter(({ abs }) => existsSync(abs) && !changedHeadKeys.has(pathKey(abs)))
          .filter(({ abs }) => {
            const text = readFileSync(abs, 'utf8');
            return [...changedStems].some((st) => text.includes(st));
          });
  for (const c of crossCandidates) preload('head', c.abs);

  for (const f of files) {
    const headFile = f.headPath ? join(options.headRoot, f.headPath) : undefined;
    const baseFile = f.basePath ? join(options.baseRoot, f.basePath) : undefined;
    let head: ModuleIndex | undefined;
    let base: ModuleIndex | undefined;
    try {
      if (headFile && existsSync(headFile)) head = indexModule(options.sourceFile('head', headFile));
      if (baseFile && existsSync(baseFile)) base = indexModule(options.sourceFile('base', baseFile));
    } catch (e) {
      detection.errors.push({ file: (f.headPath ?? f.basePath)!, message: (e as Error).message });
      continue;
    }
    const displayPath = (f.headPath ?? f.basePath)!;
    const changed = changedTopLevel(base, head);
    const sideEffectsChanged =
      JSON.stringify(base?.sideEffects ?? []) !== JSON.stringify(head?.sideEffects ?? []);
    if (headFile) changedByFile.set(pathKey(headFile), changed);

    // Removed exports.
    if (base) {
      for (const [exportName, topName] of base.exports) {
        if (head?.exports.has(exportName)) continue;
        detection.removed.push({
          id: `${f.basePath}#${exportName}`,
          file: f.basePath!,
          exportName,
          kind: exportKind(base, topName).kind,
        });
      }
    }
    if (!head) continue;

    // A changed module with runtime code but no recognizable exports (UMD/IIFE wrappers, globals) must not be
    // reported as "nothing changed": list it as not verified.
    if (head.exports.size === 0 && (changed.size > 0 || sideEffectsChanged)) {
      detection.skipped.push({
        id: `${displayPath}#*`,
        file: displayPath,
        exportName: '*',
        kind: 'module',
        reason:
          'changed, but no ESM/CommonJS exports were recognized (UMD/IIFE wrappers are not supported in v1)',
      });
      continue;
    }

    for (const [exportName, topName] of head.exports) {
      const id = `${displayPath}#${exportName}`;
      const kind = exportKind(head, topName);
      const baseTop = base?.exports.get(exportName);
      if (!base || baseTop === undefined) {
        detection.added.push({ id, file: displayPath, exportName, kind: kind.kind });
        continue;
      }
      const top = head.decls.get(topName)!;
      const baseDecl = base.decls.get(baseTop);
      const directlyChanged = !baseDecl || baseDecl.normalized !== top.normalized;
      let reason: string | undefined;
      if (directlyChanged) {
        reason = 'code changed';
      } else {
        const r = reach(head, top.node, depth);
        const hit = [...r.local].find(([name]) => changed.has(name));
        if (hit)
          reason = `uses changed \`${hit[0]}\`${hit[1].length > 1 ? ` (via ${hit[1].slice(0, -1).join(' → ')})` : ''}`;
        else if (sideEffectsChanged) reason = 'module-level code changed';
      }
      if (!reason) {
        if (baseDecl && baseDecl.raw !== top.raw) {
          detection.identical.push({
            id,
            file: displayPath,
            exportName,
            kind: kind.kind,
            reason: 'only comments or formatting changed',
          });
        }
        continue;
      }
      if (!kind.testable) {
        detection.skipped.push({
          id,
          file: displayPath,
          exportName,
          kind: kind.kind,
          reason: kind.reason ?? 'not testable',
        });
        continue;
      }
      pushTarget({
        id,
        exportName,
        baseFile: join(options.baseRoot, f.basePath!),
        headFile: headFile!,
        reason,
      });
    }
  }

  // Cross-module impact: exported functions anywhere in the head tree that import a changed binding.
  if (options.crossModule !== false && changedByFile.size > 0) {
    const changedFilesAbs = [...changedByFile.entries()].filter(([, set]) => set.size > 0);
    // Cheap pre-filter: a file can only import a changed module if it mentions its file stem or package name.
    const stems = new Set(changedFilesAbs.map(([p]) => basename(p).replace(/\.[^.]+$/, '')));
    for (const [p] of changedFilesAbs) {
      const name = nearestPackageName(p, options.headRoot);
      if (name) stems.add(name);
    }
    const candidates = crossCandidates.filter(({ abs }) => !changedByFile.has(pathKey(abs)));
    for (const { rel, abs } of candidates) {
      const text = readFileSync(abs, 'utf8');
      if (![...stems].some((s) => text.includes(s))) continue;
      const baseAbs = join(options.baseRoot, rel);
      if (!existsSync(baseAbs)) continue;
      let index: ModuleIndex;
      try {
        index = indexModule(options.sourceFile('head', abs));
      } catch {
        continue;
      }
      for (const [exportName, topName] of index.exports) {
        const id = `${rel}#${exportName}`;
        if (targetIds.has(id)) continue;
        const top = index.decls.get(topName)!;
        const r = reach(index, top.node, depth);
        let reason: string | undefined;
        for (const [, imp] of r.imported) {
          const key = pathKey(imp.file);
          if (changedByFile.get(key)?.has(imp.name)) {
            reason = `uses changed \`${imp.name}\` from ${relativeTo(pathKey(options.headRoot), key)}`;
            break;
          }
        }
        if (!reason) continue;
        const kind = exportKind(index, topName);
        if (!kind.testable) continue;
        pushTarget({ id, exportName, baseFile: baseAbs, headFile: abs, reason });
      }
    }
  }
  return detection;
}

function nearestPackageName(file: string, root: string): string | undefined {
  let dir = dirname(file);
  const stop = pathKey(root);
  for (let i = 0; i < 20; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const name = (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: unknown }).name;
        if (typeof name === 'string') return name;
      } catch {
        /* ignore */
      }
    }
    if (pathKey(dir) === stop) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function relativeTo(root: string, abs: string): string {
  return abs.startsWith(root + '/') ? abs.slice(root.length + 1) : abs;
}

/** Tracked (and, for the working tree, untracked non-ignored) files of the head version. */
function listSourceFiles(repo: string, headSha?: string): string[] {
  const out = headSha
    ? git(['ls-tree', '-r', '--name-only', '-z', headSha], repo)
    : git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], repo);
  return out.split('\0').filter((p) => p.length > 0 && isSource(p));
}
