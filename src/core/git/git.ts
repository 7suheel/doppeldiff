import { execFileSync } from 'node:child_process';

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export function git(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    });
  } catch (e) {
    const err = e as { stderr?: string | Buffer; message: string };
    const stderr = String(err.stderr ?? '');
    throw new GitError(`git ${args.join(' ')} failed: ${stderr.trim() || err.message}`, stderr);
  }
}

export function repoRoot(cwd: string): string {
  return git(['rev-parse', '--show-toplevel'], cwd).trim();
}

/** Resolve a revision to a full commit SHA. */
export function resolveCommit(cwd: string, rev: string): string {
  return git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], cwd).trim();
}

export function mergeBase(cwd: string, a: string, b: string): string {
  return git(['merge-base', a, b], cwd).trim();
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ChangedFile {
  status: FileStatus;
  /** Path in the base revision (repo-relative, forward slashes); undefined for added files. */
  basePath?: string;
  /** Path in the head revision; undefined for deleted files. */
  headPath?: string;
}

/**
 * Files changed between `base` and `head`. `head === undefined` means the working tree
 * (staged + unstaged changes and untracked, non-ignored files).
 */
export function changedFiles(cwd: string, base: string, head?: string): ChangedFile[] {
  const args = ['diff', '--name-status', '-z', '-M', base];
  if (head) args.push(head);
  const out = git(args, cwd);
  const parts = out.split('\0').filter((p) => p.length > 0);
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length;) {
    const code = parts[i++]!;
    if (code.startsWith('R')) {
      files.push({ status: 'renamed', basePath: parts[i++]!, headPath: parts[i++]! });
    } else if (code.startsWith('C')) {
      i++; // copy source
      files.push({ status: 'added', headPath: parts[i++]! });
    } else if (code === 'A') {
      files.push({ status: 'added', headPath: parts[i++]! });
    } else if (code === 'D') {
      files.push({ status: 'deleted', basePath: parts[i++]! });
    } else {
      const p = parts[i++]!;
      files.push({ status: 'modified', basePath: p, headPath: p });
    }
  }
  if (!head) {
    const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], cwd)
      .split('\0')
      .filter((p) => p.length > 0);
    for (const p of untracked) files.push({ status: 'added', headPath: p });
  }
  return files;
}

/** Line ranges touched by a diff, per side. Lines are 1-based, ranges inclusive. */
export interface Hunk {
  baseStart: number;
  baseLines: number;
  headStart: number;
  headLines: number;
}

export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  for (const m of diff.matchAll(re)) {
    hunks.push({
      baseStart: Number(m[1]),
      baseLines: m[2] === undefined ? 1 : Number(m[2]),
      headStart: Number(m[3]),
      headLines: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  return hunks;
}

export function fileHunks(cwd: string, base: string, head: string | undefined, file: ChangedFile): Hunk[] {
  const args = ['diff', '-U0', '-M', '--no-color', '--no-ext-diff', base];
  if (head) args.push(head);
  args.push('--', ...new Set([file.basePath, file.headPath].filter((p): p is string => !!p)));
  return parseHunks(git(args, cwd));
}

/** Contents of a file at a revision. */
export function showFile(cwd: string, rev: string, path: string): string {
  return git(['show', `${rev}:${path}`], cwd);
}

export function isWorkingTreeClean(cwd: string): boolean {
  return git(['status', '--porcelain'], cwd).trim().length === 0;
}
