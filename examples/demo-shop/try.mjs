#!/usr/bin/env node
// Creates a git repository with the demo shop on `main` and a scenario on branch `pr`, and prints how to run
// doppeldiff on it. Usage: node examples/demo-shop/try.mjs [honest-fix|ai-refactor|pure-refactor]
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scenarios = {
  'honest-fix': '1-honest-fix',
  'ai-refactor': '2-ai-refactor',
  'pure-refactor': '3-pure-refactor',
};
const name = process.argv[2] ?? 'ai-refactor';
const patch = scenarios[name];
if (!patch) {
  console.error(`unknown scenario "${name}"; choose one of: ${Object.keys(scenarios).join(', ')}`);
  process.exit(1);
}
const repo = mkdtempSync(join(tmpdir(), `doppeldiff-${name}-`));
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
for (const entry of ['src', 'test', 'package.json', 'tsconfig.json'])
  cpSync(join(here, entry), join(repo, entry), { recursive: true });
git('init', '-q', '-b', 'main');
git('add', '-A');
git('-c', 'user.name=demo', '-c', 'user.email=demo@example.com', 'commit', '-qm', 'demo shop');
git('checkout', '-qb', 'pr');
git('apply', join(here, 'scenarios', `${patch}.patch`));
copyFileSync(join(here, 'scenarios', `${patch}.md`), join(repo, 'pr.md'));
git('add', '-A');
git('-c', 'user.name=demo', '-c', 'user.email=demo@example.com', 'commit', '-qm', `scenario: ${name}`);
console.log(`Created ${repo} (branch "pr" = scenario "${name}", PR description in pr.md)\n`);
console.log(`  cd ${repo}`);
console.log('  npx doppeldiff --base main --claim-file pr.md');
