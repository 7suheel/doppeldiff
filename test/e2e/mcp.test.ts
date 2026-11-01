import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitScenario, REPO_ROOT, type GitScenario } from '../helpers/scenarios.js';

let client: Client;
const scenarios: GitScenario[] = [];

beforeAll(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', import.meta.resolve('tsx'), join(REPO_ROOT, 'src', 'bin.ts'), 'mcp'],
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NO_COLOR: '1' },
    stderr: 'pipe',
  });
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
  scenarios.forEach((s) => s.cleanup());
});

const text = (r: unknown) => (r as { content: { type: string; text: string }[] }).content[0]!.text;

describe('MCP server', () => {
  it('lists the two tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['verify_change', 'verify_refactor']);
    expect(tools.find((t) => t.name === 'verify_refactor')!.annotations?.readOnlyHint).toBe(true);
  });

  it('verify_refactor fails an AI refactor that changes behavior, with counterexamples', async () => {
    const s = gitScenario('ai-refactor', 'worktree');
    scenarios.push(s);
    const r = await client.callTool({ name: 'verify_refactor', arguments: { cwd: s.repo, runs: 300 } });
    expect(text(r)).toMatch(/^FAIL: \d+ behavior change\(s\) in 2 function\(s\)/);
    expect(text(r)).toContain('cartTotal([{ sku: "", unitPrice: -1, quantity: 1 }]');
  });

  it('verify_refactor passes a pure refactor', async () => {
    const s = gitScenario('pure-refactor', 'worktree');
    scenarios.push(s);
    const r = await client.callTool({ name: 'verify_refactor', arguments: { cwd: s.repo, runs: 200 } });
    expect(text(r)).toMatch(/^PASS: no behavior change detected in 4 function\(s\)/);
  });

  it('verify_change reports differences and errors cleanly', async () => {
    const s = gitScenario('honest-fix', 'worktree');
    scenarios.push(s);
    const r = await client.callTool({
      name: 'verify_change',
      arguments: { cwd: s.repo, runs: 300, claim: 'Fix rounding over $1000' },
    });
    expect(text(r)).toMatch(/^1 BEHAVIOR CHANGE\(S\) in 1 function\(s\)/);
    const bad = await client.callTool({ name: 'verify_change', arguments: { cwd: '/' } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/doppeldiff failed/);
  });
});
