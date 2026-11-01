import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { LlmProvider } from '../../src/core/claims/providers.js';
import { Report } from '../../src/core/report/model.js';
import { run } from '../../src/core/run.js';
import { makeRepo } from '../helpers/repo.js';
import { gitScenario, REPO_ROOT } from '../helpers/scenarios.js';

const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((c) => c()));

/** Async spawn: the mock server lives in this process, so a blocking spawnSync would deadlock. */
function runAsync(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, opts);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

describe('LLM input suggestions', () => {
  it('finds a difference that random generation and literal mining miss', async () => {
    // The difference hides behind an arithmetic condition: no literal in the code is near 123457.
    const repo = makeRepo(
      { 'src/a.ts': 'export function f(x: number) { return x * 2; }' },
      {
        'src/a.ts': 'export function f(x: number) { return x * 7919 === 977655 * 1000 + 983 ? -1 : x * 2; }',
      },
    );
    cleanups.push(repo.cleanup);
    const without = await run({ cwd: repo.root, runs: 500 });
    expect(without.functions[0]!.status).toBe('unchanged');

    const provider: LlmProvider = {
      name: 'fake',
      model: 'fake-1',
      complete: async () => JSON.stringify({ inputs: [{ args: '[123457]' }, { args: '["not a number"]' }] }),
    };
    const withLlm = await run({ cwd: repo.root, runs: 500, suggestProvider: provider });
    const f = withLlm.functions[0]!;
    expect(f.llmInputs).toBe(1);
    expect(f.status).toBe('changed');
    expect(f.clusters[0]!.witnesses.some((w) => w.input[0] === 123457)).toBe(true);
  });
});

describe('CLI with an Anthropic-compatible endpoint (mock server)', () => {
  it('labels the honest fix as a claimed change', async () => {
    const s = gitScenario('honest-fix', 'branch');
    cleanups.push(s.cleanup);
    const requests: string[] = [];
    const server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        const body = JSON.parse(data) as { system: string; messages: { content: string }[] };
        requests.push(body.system.slice(0, 40));
        const user = body.messages[0]!.content;
        const text = body.system.includes('find inputs')
          ? JSON.stringify({ inputs: [{ args: '[1000.07, 0.5]' }] })
          : JSON.stringify({
              behaviors: [...user.matchAll(/<behavior id="([^"]+)">/g)].map((m) => ({
                id: m[1],
                label: 'claimed',
                explanation: 'Prices over $1000 are now rounded to the nearest cent instead of down.',
              })),
            });
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            id: 'msg',
            type: 'message',
            role: 'assistant',
            model: 'claude-opus-5-5',
            content: [{ type: 'text', text }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const r = await runAsync(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          join(REPO_ROOT, 'src', 'bin.ts'),
          '--base',
          'main',
          '--head',
          'pr',
          '--claim',
          s.claim,
          '--json',
          '-',
          '--runs',
          '300',
          '--llm',
          'anthropic',
        ],
        {
          cwd: s.repo,
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: 'test-key',
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
            HOME: join(s.repo, '.home'),
            NO_COLOR: '1',
          },
        },
      );
      expect(r.status, r.stderr).toBe(0);
      const report = Report.parse(JSON.parse(r.stdout));
      expect(report.claim.llm).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5' });
      const f = report.functions[0]!;
      expect(f.llmInputs).toBe(1);
      expect(f.behaviors.every((b) => b.label === 'claimed' && b.labelSource === 'llm')).toBe(true);
      expect(report.summary.verdict).toBe('changes');
      expect(requests.length).toBe(2); // one suggestion request + one claim-matching request
    } finally {
      server.close();
    }
  });
});
