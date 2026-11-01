import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@actions/core';
import { DefaultArtifactClient } from '@actions/artifact';
import * as github from '@actions/github';
import { analyze, type PullRequestEvent } from './analyze.js';
import { comment, type WorkflowRunEvent } from './comment.js';
import type { ActionIO, PullsApi } from './types.js';

function io(): ActionIO {
  const artifacts = new DefaultArtifactClient();
  const { owner, repo } = github.context.repo;
  return {
    getInput: (n) => core.getInput(n),
    info: (m) => core.info(m),
    warning: (m) => core.warning(m),
    setOutput: (n, v) => core.setOutput(n, v),
    writeSummary: async (md) => {
      await core.summary.addRaw(md).write();
    },
    uploadArtifact: async (name, files, rootDir) => {
      await artifacts.uploadArtifact(name, files, rootDir, { retentionDays: 7 });
    },
    downloadArtifact: async (name, runId, dest) => {
      const findBy = {
        token: core.getInput('github-token'),
        workflowRunId: runId,
        repositoryOwner: owner,
        repositoryName: repo,
      };
      try {
        const { artifact } = await artifacts.getArtifact(name, { findBy });
        await artifacts.downloadArtifact(artifact.id, { path: dest, findBy });
        return true;
      } catch (e) {
        core.info(`artifact lookup failed: ${(e as Error).message}`);
        return false;
      }
    },
  };
}

function pullsApi(): PullsApi {
  const octokit = github.getOctokit(core.getInput('github-token'));
  const { owner, repo } = github.context.repo;
  return {
    async getPull(n) {
      const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: n });
      return {
        number: data.number,
        state: data.state,
        title: data.title,
        body: data.body,
        headSha: data.head.sha,
      };
    },
    async getDiff(n) {
      const { data } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: n,
        mediaType: { format: 'diff' },
      });
      return data as unknown as string;
    },
    async listComments(n) {
      const all = await octokit.paginate(octokit.rest.issues.listComments, {
        owner,
        repo,
        issue_number: n,
        per_page: 100,
      });
      return all.map((c) => ({
        id: c.id,
        body: c.body ?? '',
        authorLogin: c.user?.login ?? '',
        authorType: c.user?.type ?? '',
      }));
    },
    async createComment(n, body) {
      await octokit.rest.issues.createComment({ owner, repo, issue_number: n, body });
    },
    async updateComment(id, body) {
      await octokit.rest.issues.updateComment({ owner, repo, comment_id: id, body });
    },
  };
}

async function main(): Promise<void> {
  const event = github.context.eventName;
  const requested = core.getInput('mode') || 'auto';
  const mode = requested === 'auto' ? (event === 'workflow_run' ? 'comment' : 'analyze') : requested;
  const tempDir = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'doppeldiff-'));

  if (event === 'pull_request_target' && mode === 'analyze') {
    throw new Error(
      'doppeldiff refuses to analyze on pull_request_target: that would run untrusted PR code with secrets and a write token. ' +
        'Use the documented workflow (pull_request + workflow_run).',
    );
  }
  if (mode === 'analyze') {
    const pr = github.context.payload.pull_request as PullRequestEvent | undefined;
    if (!pr) throw new Error(`analyze mode needs a pull_request event (got "${event}")`);
    const { exitCode } = await analyze({
      io: io(),
      workspace: process.env.GITHUB_WORKSPACE ?? process.cwd(),
      pr,
      tempDir,
    });
    if (exitCode !== 0) core.setFailed('doppeldiff found behavior changes matching fail-on');
    return;
  }
  if (mode === 'comment') {
    const run = github.context.payload.workflow_run as WorkflowRunEvent | undefined;
    if (!run) throw new Error(`comment mode needs a workflow_run event (got "${event}")`);
    await comment({ io: io(), api: pullsApi(), run, tempDir });
    return;
  }
  throw new Error(`unknown mode "${requested}" (expected auto, analyze or comment)`);
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e: unknown) => {
    core.setFailed((e as Error).message);
    process.exit(1);
  },
);
