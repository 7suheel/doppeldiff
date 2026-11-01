import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { actionProvider } from './provider.js';
import { buildReport } from '../core/report/build.js';
import { renderMarkdown } from '../core/report/markdown.js';
import type { Report } from '../core/report/model.js';
import { run } from '../core/run.js';
import { exitCodeFor, type FailOn } from '../cli.js';
import type { ActionIO } from './types.js';

export interface PullRequestEvent {
  number: number;
  title: string;
  body: string | null;
  base: { sha: string };
  head: { sha: string };
}

export interface AnalyzeContext {
  io: ActionIO;
  workspace: string;
  pr: PullRequestEvent;
  tempDir: string;
}

const list = (v: string) =>
  v
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

function installDependencies(io: ActionIO, cwd: string): void {
  if (!existsSync(join(cwd, 'package.json')) || existsSync(join(cwd, 'node_modules'))) return;
  const pm = existsSync(join(cwd, 'pnpm-lock.yaml'))
    ? ['corepack', ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts']]
    : existsSync(join(cwd, 'yarn.lock'))
      ? ['corepack', ['yarn', 'install', '--immutable', '--mode=skip-build']]
      : existsSync(join(cwd, 'package-lock.json'))
        ? ['npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']]
        : ['npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']];
  const [cmd, args] = pm as [string, string[]];
  io.info(`Installing dependencies: ${cmd} ${args.join(' ')} (lifecycle scripts disabled)`);
  try {
    execFileSync(cmd, args, { cwd, stdio: 'inherit' });
  } catch (e) {
    io.warning(`dependency install failed (${(e as Error).message}); continuing without it`);
  }
}

/** Make sure the base commit is available (shallow checkouts). */
function ensureCommit(io: ActionIO, cwd: string, sha: string): void {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd, stdio: 'ignore' });
    return;
  } catch {
    io.info(`Fetching base commit ${sha.slice(0, 7)}`);
  }
  execFileSync('git', ['fetch', '--no-tags', '--depth=200', 'origin', sha], { cwd, stdio: 'inherit' });
  try {
    execFileSync('git', ['merge-base', sha, 'HEAD'], { cwd, stdio: 'ignore' });
  } catch {
    execFileSync('git', ['fetch', '--no-tags', '--unshallow', 'origin'], { cwd, stdio: 'inherit' });
  }
}

/**
 * Untrusted job (`pull_request`): runs the deterministic engine on the PR's code without secrets, writes the
 * report to the job summary and uploads it as an artifact for the trusted comment job.
 */
export async function analyze(ctx: AnalyzeContext): Promise<{ report: Report; exitCode: number }> {
  const { io, workspace, pr } = ctx;
  if (io.getInput('install') !== 'false') installDependencies(io, workspace);
  ensureCommit(io, workspace, pr.base.sha);

  const claimText = [pr.title, pr.body ?? ''].join('\n\n').trim();
  // Optional: same-repo workflows may pass an API key for LLM input suggestions. Fork PRs never get secrets.
  let provider = null;
  try {
    provider = actionProvider(io);
  } catch (e) {
    io.warning(`LLM input suggestions disabled: ${(e as Error).message}`);
  }

  const budget = Number(io.getInput('time-budget') || '60');
  const result = await run({
    cwd: workspace,
    base: pr.base.sha,
    runs: Number(io.getInput('runs') || '10000'),
    timeoutMs: Number(io.getInput('timeout') || '250'),
    timeBudgetMs: budget * 1000,
    ...(list(io.getInput('include')).length ? { include: list(io.getInput('include')) } : {}),
    ...(list(io.getInput('exclude')).length ? { exclude: list(io.getInput('exclude')) } : {}),
    ...(provider ? { suggestProvider: provider } : {}),
    onWarning: (m) => io.warning(m),
    onEvent: (e) => {
      if (e.type === 'detected') io.info(`doppeldiff: ${e.detection.targets.length} function(s) to verify`);
      if (e.type === 'function-done') {
        io.info(
          `  ${e.result.status.padEnd(10)} ${e.result.id} (${e.result.inputsRun} inputs, ${e.result.durationMs}ms)`,
        );
      }
    },
  });
  const report = buildReport(result, { text: claimText || null, source: claimText ? 'pr' : 'none' });
  // The checkout is GitHub's merge commit for the PR (clean working tree): name it instead of "working tree".
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();
    report.head = { ref: `pull request #${pr.number}`, sha };
  } catch {
    /* keep the default */
  }

  mkdirSync(ctx.tempDir, { recursive: true });
  const reportPath = join(ctx.tempDir, 'report.json');
  const metaPath = join(ctx.tempDir, 'meta.json');
  writeFileSync(reportPath, JSON.stringify(report));
  writeFileSync(
    metaPath,
    JSON.stringify({ schemaVersion: 1, pr: pr.number, headSha: pr.head.sha, baseSha: pr.base.sha }),
  );
  await io.writeSummary(renderMarkdown(report));
  try {
    await io.uploadArtifact(
      io.getInput('artifact-name') || 'doppeldiff-report',
      [reportPath, metaPath],
      ctx.tempDir,
    );
  } catch (e) {
    io.warning(`could not upload the report artifact: ${(e as Error).message}`);
  }
  io.setOutput('verdict', report.summary.verdict);
  io.setOutput('behaviors', String(report.summary.behaviors));
  io.setOutput('unclaimed', String(report.summary.unclaimed));
  io.setOutput('report-path', reportPath);
  const failOn = (io.getInput('fail-on') || 'never') as FailOn;
  return { report, exitCode: exitCodeFor(report, failOn) };
}
