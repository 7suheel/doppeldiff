import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { matchClaims } from '../core/claims/match.js';
import { actionProvider } from './provider.js';
import { relabel } from '../core/report/build.js';
import { renderMarkdown, STICKY_MARKER } from '../core/report/markdown.js';
import { Report } from '../core/report/model.js';
import type { ActionIO, PullsApi } from './types.js';

export interface WorkflowRunEvent {
  id: number;
  event: string;
  head_sha: string;
  conclusion: string | null;
}

export interface CommentContext {
  io: ActionIO;
  api: PullsApi;
  run: WorkflowRunEvent;
  tempDir: string;
}

const Meta = z.object({
  schemaVersion: z.literal(1),
  pr: z.number().int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  baseSha: z.string(),
});
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

function readJson(path: string): unknown {
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  if (statSync(path).size > MAX_ARTIFACT_BYTES) throw new Error(`${path} is too large`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

export type CommentOutcome = 'posted' | 'updated' | 'skipped';

/**
 * Trusted job (`workflow_run`): never checks out or executes PR code. Downloads the report produced by the
 * untrusted job, treats it as untrusted data (schema validation, PR/SHA cross-check, labels re-derived from the
 * PR text fetched from the API), optionally runs LLM claim matching, and upserts one sticky comment.
 */
export async function comment(ctx: CommentContext): Promise<CommentOutcome> {
  const { io, api, run } = ctx;
  if (run.event !== 'pull_request') {
    io.info(`doppeldiff: triggering run was a "${run.event}" event, nothing to comment on`);
    return 'skipped';
  }
  const found = await io.downloadArtifact(
    io.getInput('artifact-name') || 'doppeldiff-report',
    run.id,
    ctx.tempDir,
  );
  if (!found) {
    io.warning('doppeldiff: no report artifact found for the triggering run (did the analyze job fail?)');
    return 'skipped';
  }

  let report: Report;
  let meta: z.infer<typeof Meta>;
  try {
    meta = Meta.parse(readJson(join(ctx.tempDir, 'meta.json')));
    report = Report.parse(readJson(join(ctx.tempDir, 'report.json')));
  } catch (e) {
    io.warning(
      `doppeldiff: the report artifact is invalid and was ignored (${(e as Error).message.slice(0, 300)})`,
    );
    return 'skipped';
  }

  // The artifact comes from untrusted code: it must describe the PR whose head commit triggered the run.
  const pr = await api.getPull(meta.pr);
  if (pr.headSha !== run.head_sha || meta.headSha !== run.head_sha) {
    io.warning(
      `doppeldiff: report does not match PR #${meta.pr} head ${run.head_sha.slice(0, 7)}; not commenting`,
    );
    return 'skipped';
  }
  if (pr.state !== 'open') {
    io.info(`doppeldiff: PR #${pr.number} is ${pr.state}; not commenting`);
    return 'skipped';
  }

  // Claim text comes from the API, never from the artifact; labels are re-derived.
  const claimText = [pr.title, pr.body ?? ''].join('\n\n').trim() || null;
  report = relabel(report, { text: claimText, source: claimText ? 'pr' : 'none' });

  if (report.summary.behaviors > 0 && claimText && !report.claim.refactor) {
    let provider = null;
    try {
      provider = actionProvider(io);
    } catch (e) {
      io.warning(`doppeldiff: LLM claim matching disabled: ${(e as Error).message}`);
    }
    if (provider) {
      try {
        const diff = await api.getDiff(pr.number);
        report = (
          await matchClaims(report, {
            provider,
            diff: diff.slice(0, 200_000),
            cacheDir: null,
            onWarning: (m) => io.warning(m),
          })
        ).report;
      } catch (e) {
        io.warning(
          `doppeldiff: claim matching failed (${(e as Error).message}); posting without claim labels`,
        );
      }
    }
  }

  const body = renderMarkdown(report, { sticky: true });
  const existing = (await api.listComments(pr.number)).find(
    (c) =>
      c.authorType === 'Bot' && c.authorLogin === 'github-actions[bot]' && c.body.includes(STICKY_MARKER),
  );
  io.setOutput('verdict', report.summary.verdict);
  io.setOutput('behaviors', String(report.summary.behaviors));
  io.setOutput('unclaimed', String(report.summary.unclaimed));
  if (existing) {
    await api.updateComment(existing.id, body);
    io.info(`doppeldiff: updated comment ${existing.id} on PR #${pr.number}`);
    return 'updated';
  }
  await api.createComment(pr.number, body);
  io.info(`doppeldiff: commented on PR #${pr.number}`);
  return 'posted';
}
