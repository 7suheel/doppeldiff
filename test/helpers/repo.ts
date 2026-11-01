import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export type Files = Record<string, string | null>;

export function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function writeFiles(root: string, files: Files): void {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, path);
    if (content === null) {
      try {
        unlinkSync(abs);
      } catch {
        /* ignore */
      }
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

export interface TestRepo {
  root: string;
  cleanup(): void;
}

/**
 * Create a git repo with `base` committed on main. `head` changes (null deletes a file) are left in the
 * working tree, or committed on branch `pr` when `commit` is true.
 */
export function makeRepo(base: Files, head: Files, options: { commit?: boolean } = {}): TestRepo {
  const root = mkdtempSync(join(tmpdir(), 'doppeldiff-repo-'));
  gitIn(root, 'init', '-q', '-b', 'main');
  writeFiles(root, base);
  gitIn(root, 'add', '-A');
  gitIn(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  if (options.commit) gitIn(root, 'checkout', '-qb', 'pr');
  writeFiles(root, head);
  if (options.commit) {
    gitIn(root, 'add', '-A');
    gitIn(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'head');
  }
  return {
    root,
    cleanup: () => {
      try {
        gitIn(root, 'worktree', 'prune');
      } catch {
        /* ignore */
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
