import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from './git.js';

export interface Worktree {
  path: string;
  sha: string;
  /** Remove the worktree (no-op for reused checkouts). */
  dispose(): void;
}

function worktreeBase(repo: string): string {
  const id = createHash('sha256').update(repo).digest('hex').slice(0, 10);
  return join(tmpdir(), 'doppeldiff-worktrees', id);
}

/**
 * Materialize `sha` of `repo` in a detached git worktree under the OS temp dir.
 * Reuses an existing worktree for the same commit (e.g. from a `--keep-worktrees` run).
 */
export function addWorktree(repo: string, sha: string, options: { keep?: boolean } = {}): Worktree {
  const dir = join(worktreeBase(repo), sha.slice(0, 12));
  const registered = git(['worktree', 'list', '--porcelain'], repo)
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length));
  const isRegistered = registered.some((p) => samePath(p, dir));
  if (isRegistered && existsSync(join(dir, '.git'))) {
    const head = git(['rev-parse', 'HEAD'], dir).trim();
    if (head === sha) return { path: dir, sha, dispose: () => options.keep || removeWorktree(repo, dir) };
  }
  if (isRegistered || existsSync(dir)) removeWorktree(repo, dir);
  mkdirSync(worktreeBase(repo), { recursive: true });
  git(['worktree', 'add', '--detach', '--force', dir, sha], repo);
  return { path: dir, sha, dispose: () => options.keep || removeWorktree(repo, dir) };
}

export function removeWorktree(repo: string, dir: string): void {
  try {
    git(['worktree', 'remove', '--force', dir], repo);
  } catch {
    rmSync(dir, { recursive: true, force: true });
    try {
      git(['worktree', 'prune'], repo);
    } catch {
      /* ignore */
    }
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}
