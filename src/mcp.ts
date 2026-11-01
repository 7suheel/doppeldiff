import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { matchClaims } from './core/claims/match.js';
import { selectProvider } from './core/claims/providers.js';
import { diffText, repoRoot } from './core/git/git.js';
import { buildReport } from './core/report/build.js';
import { renderMarkdown } from './core/report/markdown.js';
import type { Report } from './core/report/model.js';
import { run, toolVersion } from './core/run.js';

const common = {
  cwd: z
    .string()
    .optional()
    .describe('Repository directory. Defaults to the directory the server was started in.'),
  base: z
    .string()
    .optional()
    .describe('Base revision to compare against (default: HEAD, i.e. your uncommitted changes).'),
  head: z
    .string()
    .optional()
    .describe('Head revision (default: the working tree, including uncommitted changes).'),
  functions: z
    .array(z.string())
    .optional()
    .describe('Only verify these functions (export names or "path/file.ts#name").'),
  runs: z
    .number()
    .int()
    .min(10)
    .max(100_000)
    .optional()
    .describe('Max generated inputs per function (default 1000).'),
  time_budget_seconds: z
    .number()
    .int()
    .min(5)
    .max(600)
    .optional()
    .describe('Total time budget for exploration (default 60).'),
};

interface ToolArgs {
  cwd?: string;
  base?: string;
  head?: string;
  functions?: string[];
  runs?: number;
  time_budget_seconds?: number;
  claim?: string;
}

async function verify(args: ToolArgs, refactor: boolean): Promise<Report> {
  const cwd = resolve(args.cwd ?? process.cwd());
  const result = await run({
    cwd,
    ...(args.base ? { base: args.base } : {}),
    ...(args.head ? { head: args.head } : {}),
    ...(args.functions?.length ? { only: args.functions } : {}),
    runs: args.runs ?? 1000,
    timeBudgetMs: (args.time_budget_seconds ?? 60) * 1000,
  });
  let report = buildReport(result, {
    text: args.claim ?? null,
    source: args.claim ? 'flag' : 'none',
    ...(refactor ? { refactor: true } : {}),
  });
  const provider = refactor ? null : selectProvider();
  if (provider && args.claim && report.summary.behaviors > 0) {
    try {
      const files = [...new Set(report.functions.filter((f) => f.behaviors.length).map((f) => f.file))];
      const diff = diffText(repoRoot(cwd), result.base.sha, result.head.sha ?? undefined, files);
      report = (await matchClaims(report, { provider, diff })).report;
    } catch {
      /* claim matching is optional */
    }
  }
  return report;
}

function verdictLine(r: Report, refactor: boolean): string {
  const s = r.summary;
  const inputs = `${s.inputsRun.toLocaleString('en-US')} generated inputs`;
  const notVerified = s.skipped + s.nondeterministic;
  const caveat =
    notVerified > 0 ? ` ${notVerified} changed export(s) could not be verified (see "Not verified").` : '';
  if (s.functions === 0)
    return `NOTHING TO VERIFY: no changed exported functions with an earlier version were found.${caveat}`;
  if (refactor) {
    return s.behaviors === 0
      ? `PASS: no behavior change detected in ${s.functions} function(s) across ${inputs}. This is strong evidence, not a proof.${caveat}`
      : `FAIL: ${s.behaviors} behavior change(s) in ${s.changed} function(s). The refactor changes behavior; see the counterexamples below.${caveat}`;
  }
  if (s.behaviors === 0)
    return `NO BEHAVIOR CHANGE detected in ${s.functions} function(s) across ${inputs}.${caveat}`;
  return `${s.behaviors} BEHAVIOR CHANGE(S) in ${s.changed} function(s)${s.unclaimed ? `, ${s.unclaimed} not covered by the claim` : ''}. Check each counterexample is intended.${caveat}`;
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'doppeldiff', version: toolVersion() });

  server.registerTool(
    'verify_change',
    {
      title: 'Verify a code change by running old and new versions',
      description:
        'Runs the old and new version of every changed exported TypeScript/JavaScript function on generated inputs and reports concrete counterexamples where behavior differs. Call this after editing code and before saying the change is done; compare the reported differences with what you intended. Optionally pass `claim` (what the change is supposed to do).',
      inputSchema: {
        ...common,
        claim: z.string().optional().describe('What the change is supposed to do, e.g. the commit message.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const report = await verify(args as ToolArgs, false);
        return {
          content: [
            { type: 'text' as const, text: `${verdictLine(report, false)}\n\n${renderMarkdown(report)}` },
          ],
        };
      } catch (e) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `doppeldiff failed: ${(e as Error).message}` }],
        };
      }
    },
  );

  server.registerTool(
    'verify_refactor',
    {
      title: 'Check that a refactor does not change behavior',
      description:
        'Asserts that changed exported TypeScript/JavaScript functions behave exactly as before: runs old and new versions on generated inputs and returns PASS, or FAIL with minimal counterexamples. Use it after a refactor and before claiming "no behavior change".',
      inputSchema: common,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const report = await verify(args as ToolArgs, true);
        return {
          content: [
            { type: 'text' as const, text: `${verdictLine(report, true)}\n\n${renderMarkdown(report)}` },
          ],
          ...(report.summary.behaviors > 0 ? { isError: false } : {}),
        };
      } catch (e) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `doppeldiff failed: ${(e as Error).message}` }],
        };
      }
    },
  );
  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}
