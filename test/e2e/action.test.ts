import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyze } from '../../src/action/analyze.js';
import { comment } from '../../src/action/comment.js';
import type { ActionIO, CommentInfo, PullsApi } from '../../src/action/types.js';
import { STICKY_MARKER } from '../../src/core/report/markdown.js';
import type { Report } from '../../src/core/report/model.js';
import { gitIn } from '../helpers/repo.js';
import { gitScenario, type GitScenario } from '../helpers/scenarios.js';

function fakeIO(inputs: Record<string, string> = {}) {
  const state = {
    outputs: {} as Record<string, string>,
    warnings: [] as string[],
    summary: '',
    uploaded: [] as string[],
    artifactDir: '',
  };
  const io: ActionIO = {
    getInput: (n) => inputs[n] ?? '',
    info: () => {},
    warning: (m) => state.warnings.push(m),
    setOutput: (n, v) => (state.outputs[n] = v),
    writeSummary: async (md) => {
      state.summary = md;
    },
    uploadArtifact: async (_name, files) => {
      state.uploaded = files;
    },
    downloadArtifact: async (_name, _id, dest) => {
      if (!state.artifactDir) return false;
      for (const f of ['report.json', 'meta.json']) copyFileSync(join(state.artifactDir, f), join(dest, f));
      return true;
    },
  };
  return { io, state };
}

function fakeApi(
  pr: { headSha: string; title?: string; body?: string; state?: string },
  comments: CommentInfo[] = [],
) {
  const posted: { kind: 'create' | 'update'; id?: number; body: string }[] = [];
  const api: PullsApi = {
    getPull: async (n) => ({
      number: n,
      state: pr.state ?? 'open',
      title: pr.title ?? 'Refactor cart',
      body: pr.body ?? 'No behavior change.',
      headSha: pr.headSha,
    }),
    getDiff: async () => '',
    listComments: async () => comments,
    createComment: async (_n, body) => {
      posted.push({ kind: 'create', body });
      comments.push({ id: 99, body, authorLogin: 'github-actions[bot]', authorType: 'Bot' });
    },
    updateComment: async (id, body) => {
      posted.push({ kind: 'update', id, body });
    },
  };
  return { api, posted };
}

let s: GitScenario;
let headSha: string;
let artifactDir: string;
let report: Report;

beforeAll(async () => {
  s = gitScenario('ai-refactor', 'branch');
  const baseSha = gitIn(s.repo, 'rev-parse', 'main').trim();
  headSha = gitIn(s.repo, 'rev-parse', 'pr').trim();
  artifactDir = mkdtempSync(join(tmpdir(), 'dd-artifact-'));
  const { io, state } = fakeIO({
    runs: '300',
    'time-budget': '30',
    install: 'false',
    'fail-on': 'unclaimed',
  });
  const r = await analyze({
    io,
    workspace: s.repo,
    pr: {
      number: 7,
      title: 'Refactor cart and slug utilities',
      body: 'Pure refactor, no behavior change.',
      base: { sha: baseSha },
      head: { sha: headSha },
    },
    tempDir: artifactDir,
  });
  report = r.report;
  expect(r.exitCode).toBe(1);
  expect(state.uploaded.map((f) => f.split(/[\\/]/).pop())).toEqual(['report.json', 'meta.json']);
  expect(state.summary).toContain('⚠️ Unclaimed behavior change');
  expect(state.outputs).toMatchObject({ verdict: 'unclaimed' });
});
afterAll(() => s.cleanup());

const run = () => ({ id: 1, event: 'pull_request', head_sha: headSha, conclusion: 'success' });

describe('action: comment mode (trusted job)', () => {
  it('posts one sticky comment, then updates it', async () => {
    const { io, state } = fakeIO();
    state.artifactDir = artifactDir;
    const comments: CommentInfo[] = [];
    const { api, posted } = fakeApi(
      { headSha, title: 'Refactor cart and slug utilities', body: 'Pure refactor, no behavior change.' },
      comments,
    );
    expect(await comment({ io, api, run: run(), tempDir: mkdtempSync(join(tmpdir(), 'dd-c-')) })).toBe(
      'posted',
    );
    expect(posted[0]!.body).toContain(STICKY_MARKER);
    expect(posted[0]!.body).toContain('cartTotal');
    expect(await comment({ io, api, run: run(), tempDir: mkdtempSync(join(tmpdir(), 'dd-c-')) })).toBe(
      'updated',
    );
    expect(posted[1]).toMatchObject({ kind: 'update', id: 99 });
  });

  it('does not touch a human comment that contains the marker', async () => {
    const { io, state } = fakeIO();
    state.artifactDir = artifactDir;
    const comments: CommentInfo[] = [
      { id: 5, body: `fake ${STICKY_MARKER}`, authorLogin: 'mallory', authorType: 'User' },
    ];
    const { api, posted } = fakeApi({ headSha }, comments);
    await comment({ io, api, run: run(), tempDir: mkdtempSync(join(tmpdir(), 'dd-c-')) });
    expect(posted.map((p) => p.kind)).toEqual(['create']);
  });

  it('refuses artifacts that do not match the PR head commit', async () => {
    const { io, state } = fakeIO();
    state.artifactDir = artifactDir;
    const { api, posted } = fakeApi({ headSha: 'f'.repeat(40) });
    expect(await comment({ io, api, run: run(), tempDir: mkdtempSync(join(tmpdir(), 'dd-c-')) })).toBe(
      'skipped',
    );
    expect(posted).toEqual([]);
    expect(state.warnings.join()).toMatch(/does not match/);
  });

  it('rejects invalid artifacts and ignores labels the artifact carries', async () => {
    // Tampered: invalid schema.
    const bad = mkdtempSync(join(tmpdir(), 'dd-bad-'));
    copyFileSync(join(artifactDir, 'meta.json'), join(bad, 'meta.json'));
    writeFileSync(join(bad, 'report.json'), JSON.stringify({ ...report, schemaVersion: 2 }));
    const a = fakeIO();
    a.state.artifactDir = bad;
    const api1 = fakeApi({ headSha });
    expect(
      await comment({ io: a.io, api: api1.api, run: run(), tempDir: mkdtempSync(join(tmpdir(), 'dd-c-')) }),
    ).toBe('skipped');
    expect(api1.posted).toEqual([]);

    // Tampered: schema-valid but claims everything is "claimed" with a fake explanation.
    const forged = mkdtempSync(join(tmpdir(), 'dd-forged-'));
    copyFileSync(join(artifactDir, 'meta.json'), join(forged, 'meta.json'));
    const f: Report = JSON.parse(readFileSync(join(artifactDir, 'report.json'), 'utf8'));
    for (const fn of f.functions)
      for (const b of fn.behaviors)
        Object.assign(b, { label: 'claimed', labelSource: 'llm', explanation: 'All good @everyone' });
    f.summary.unclaimed = 0;
    writeFileSync(join(forged, 'report.json'), JSON.stringify(f));
    const b = fakeIO();
    b.state.artifactDir = forged;
    const api2 = fakeApi({ headSha, title: 'Refactor cart', body: 'No behavior change.' });
    await comment({ io: b.io, api: api2.api, run: run(), tempDir: mkdtempSync(join(tmpdir(), 'dd-c-')) });
    const body = api2.posted[0]!.body;
    expect(body).toContain('⚠️ Unclaimed behavior change');
    expect(body).not.toContain('All good');
    expect(b.state.outputs.verdict).toBe('unclaimed');
  });

  it('skips runs that were not triggered by pull_request and missing artifacts', async () => {
    const { io } = fakeIO();
    const { api, posted } = fakeApi({ headSha });
    expect(await comment({ io, api, run: { ...run(), event: 'push' }, tempDir: tmpdir() })).toBe('skipped');
    expect(await comment({ io, api, run: run(), tempDir: tmpdir() })).toBe('skipped');
    expect(posted).toEqual([]);
  });
});

void mkdirSync;
