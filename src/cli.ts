import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { cac } from 'cac';
import pc from 'picocolors';
import { loadConfig, type DoppeldiffConfig } from './config.js';
import { buildReport, type ClaimInput } from './core/report/build.js';
import { renderMarkdown } from './core/report/markdown.js';
import type { Report } from './core/report/model.js';
import { progressPrinter, renderTerminal } from './core/report/terminal.js';
import { generateTests } from './core/report/testgen.js';
import { diffText, repoRoot } from './core/git/git.js';
import { matchClaims } from './core/claims/match.js';
import { selectProvider, type LlmProvider } from './core/claims/providers.js';
import { DEFAULT_RUNS, DEFAULT_SEED, DEFAULT_TIMEOUT_MS, run, toolVersion } from './core/run.js';

export type FailOn = 'unclaimed' | 'any' | 'never';

/** Exit code for a report: 0 ok, 1 findings matching --fail-on. (2 is reserved for tool errors.) */
export function exitCodeFor(report: Report, failOn: FailOn): 0 | 1 {
  if (failOn === 'never') return 0;
  if (failOn === 'any') return report.summary.behaviors > 0 ? 1 : 0;
  return report.summary.unclaimed > 0 ? 1 : 0;
}

const list = (v: unknown): string[] | undefined => {
  if (v === undefined) return undefined;
  const arr = Array.isArray(v) ? v : [v];
  return arr
    .flatMap((x) => String(x).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
};

/** `--json` / `--json -` (parsed as `true`) mean stdout; a string is a file path. */
const toStdout = (v: string | boolean | undefined) => v === true || v === '-' || v === '';

function writeOut(target: string | boolean, content: string): void {
  if (toStdout(target)) {
    process.stdout.write(content);
    return;
  }
  const file = String(target);
  mkdirSync(dirname(resolve(file)), { recursive: true });
  writeFileSync(file, content);
}

interface CliFlags {
  base?: string;
  head?: string;
  claim?: string;
  claimFile?: string;
  refactor?: boolean;
  seed?: number;
  runs?: number;
  timeout?: number;
  budget?: number;
  json?: string | boolean;
  markdown?: string | boolean;
  writeTests?: string | boolean;
  failOn?: FailOn;
  include?: string | string[];
  exclude?: string | string[];
  only?: string | string[];
  freeze?: boolean;
  install?: boolean;
  mergeBase?: boolean;
  keepWorktrees?: boolean;
  config?: string;
  cwd?: string;
  quiet?: boolean;
  showConsole?: boolean;
  sandbox?: boolean;
  llm?: 'auto' | 'anthropic' | 'openai' | 'off';
  llmModel?: string;
  llmInputs?: boolean;
}

export async function main(argv = process.argv): Promise<number> {
  const cli = cac('doppeldiff');
  cli
    .command(
      '[...args]',
      'Run old and new versions of changed functions on generated inputs and report behavior differences',
    )
    .option('--base <rev>', 'Base revision (default: HEAD; compared via merge-base)')
    .option('--head <rev>', 'Head revision (default: the working tree)')
    .option('--claim <text>', 'What the change claims to do (e.g. the PR title/description)')
    .option('--claim-file <path>', 'Read the claim from a file')
    .option('--refactor', 'Assert that the change does not alter behavior: every difference is unclaimed')
    .option('--seed <n>', `Random seed (default ${DEFAULT_SEED})`)
    .option('--runs <n>', `Max generated inputs per function (default ${DEFAULT_RUNS})`)
    .option('--timeout <ms>', `Per-call timeout (default ${DEFAULT_TIMEOUT_MS})`)
    .option('--budget <seconds>', 'Total time budget for exploration')
    .option('--json [file]', 'Write the JSON report (to a file, or stdout with "-")')
    .option('--markdown [file]', 'Write the Markdown report (PR comment)')
    .option(
      '--write-tests [dir]',
      'Write regression tests pinning the found examples (default tests/doppeldiff)',
    )
    .option('--fail-on <mode>', 'Exit with code 1 on: unclaimed (default) | any | never')
    .option('--include <glob>', 'Only analyze matching files (repeatable)')
    .option('--exclude <glob>', 'Skip matching files (repeatable)')
    .option('--only <name>', 'Only verify these functions (export name or file#export)')
    .option('--no-freeze', 'Do not freeze the clock / seed randomness in code under test')
    .option('--no-install', 'Never install dependencies for the base version (reuse the working copy)')
    .option('--no-merge-base', 'Compare against --base exactly, not the merge base')
    .option('--keep-worktrees', 'Keep temporary git worktrees for debugging')
    .option(
      '--llm <provider>',
      'Claim matching / input suggestions: auto (default, if an API key is set) | anthropic | openai | off',
    )
    .option('--llm-model <id>', 'Model for the LLM layer (default claude-opus-5-5 / gpt-5.5)')
    .option('--no-llm-inputs', 'Do not ask the LLM for edge-case inputs (claim matching only)')
    .option('--config <path>', 'Config file (default doppeldiff.config.{ts,mts,js,mjs})')
    .option('--cwd <dir>', 'Repository directory (default: current directory)')
    .option('--quiet', 'Only print the final report')
    .option('--show-console', 'Do not silence console output of code under test')
    .option('--no-sandbox', 'Disable the Node permission model for code under test (debugging only)')
    .action(async (_args: string[], flags: CliFlags) => {
      process.exitCode = await runCli(flags);
    });
  cli.help();
  cli.version(toolVersion());
  cli.parse(argv, { run: false });
  if (cli.options.help || cli.options.version) return 0;
  await cli.runMatchedCommand();
  return Number(process.exitCode ?? 0);
}

async function runCli(flags: CliFlags): Promise<number> {
  const cwd = resolve(flags.cwd ?? process.cwd());
  const err = (line: string) => process.stderr.write(`${line}\n`);
  let config: DoppeldiffConfig;
  try {
    config = (await loadConfig(cwd, flags.config)).config;
  } catch (e) {
    err(pc.red(`doppeldiff: could not load config: ${(e as Error).message}`));
    return 2;
  }
  const claimText = flags.claimFile ? readFileSync(flags.claimFile, 'utf8') : (flags.claim ?? null);
  const claim: ClaimInput = {
    text: claimText,
    source: claimText ? 'flag' : 'none',
    ...(flags.refactor ? { refactor: true } : {}),
  };
  const failOn: FailOn = flags.failOn ?? config.failOn ?? 'unclaimed';
  if (!['unclaimed', 'any', 'never'].includes(failOn)) {
    err(pc.red(`doppeldiff: invalid --fail-on "${failOn}"`));
    return 2;
  }
  const stdoutTaken = toStdout(flags.json) || toStdout(flags.markdown);
  if (toStdout(flags.json) && toStdout(flags.markdown)) {
    err(pc.red('doppeldiff: --json and --markdown cannot both write to stdout'));
    return 2;
  }
  const quiet = flags.quiet || stdoutTaken;
  if (!quiet) err(`${pc.bold('🔬 doppeldiff')} ${pc.dim(`v${toolVersion()}`)}`);

  let provider: LlmProvider | null;
  try {
    provider = selectProvider({
      ...(flags.llm ? { provider: flags.llm } : {}),
      ...(flags.llmModel ? { model: String(flags.llmModel) } : {}),
    });
  } catch (e) {
    err(pc.red(`doppeldiff: ${(e as Error).message}`));
    return 2;
  }
  if (provider && !quiet) err(pc.dim(`  LLM layer: ${provider.name} (${provider.model})`));
  const warn = (m: string) => err(pc.yellow(`  warning: ${m}`));

  try {
    const result = await run({
      ...(provider && flags.llmInputs !== false ? { suggestProvider: provider } : {}),
      onWarning: warn,
      cwd,
      ...(flags.base ? { base: String(flags.base) } : {}),
      ...(flags.head ? { head: String(flags.head) } : {}),
      seed: Number(flags.seed ?? config.seed ?? DEFAULT_SEED),
      runs: Number(flags.runs ?? config.runs ?? DEFAULT_RUNS),
      timeoutMs: Number(flags.timeout ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      ...(flags.budget !== undefined ? { timeBudgetMs: Number(flags.budget) * 1000 } : {}),
      freeze: flags.freeze !== false && config.freeze !== false,
      ...((list(flags.include) ?? config.include) ? { include: list(flags.include) ?? config.include } : {}),
      ...((list(flags.exclude) ?? config.exclude)
        ? { exclude: [...(list(flags.exclude) ?? []), ...(config.exclude ?? [])] }
        : {}),
      ...(list(flags.only) ? { only: list(flags.only) } : {}),
      ...(config.compare ? { compare: config.compare } : {}),
      ...(config.functions ? { functions: config.functions } : {}),
      mergeBase: flags.mergeBase !== false,
      install: flags.install !== false,
      keepWorktrees: !!flags.keepWorktrees,
      showConsole: !!flags.showConsole,
      noSandbox: flags.sandbox === false,
      ...(quiet ? {} : { onEvent: progressPrinter(err) }),
    });
    let report = buildReport(result, claim);
    if (provider && report.summary.behaviors > 0 && claim.text && !report.claim.refactor) {
      try {
        const root = repoRoot(cwd);
        const files = [...new Set(report.functions.filter((f) => f.behaviors.length).map((f) => f.file))];
        const diff = diffText(root, result.base.sha, result.head.sha ?? undefined, files);
        const m = await matchClaims(report, { provider, diff, onWarning: warn });
        report = m.report;
      } catch (e) {
        warn(
          `claim matching unavailable (${(e as Error).message}); behaviors are reported without claim labels`,
        );
      }
    }

    if (flags.writeTests) {
      const dir =
        typeof flags.writeTests === 'string' ? flags.writeTests : (config.testsDir ?? 'tests/doppeldiff');
      // Tests are written into the user's working copy (repo root), never into a temporary worktree.
      const gen = generateTests(report, { root: repoRoot(cwd), outDir: dir });
      report.regressionTests = {
        framework: gen.framework,
        files: gen.files.map((f) => f.path),
        cases: gen.files.reduce((s, f) => s + f.cases, 0),
      };
    }
    if (flags.json !== undefined && flags.json !== false)
      writeOut(flags.json, `${JSON.stringify(report, null, 2)}\n`);
    if (flags.markdown !== undefined && flags.markdown !== false)
      writeOut(flags.markdown, renderMarkdown(report));
    if (!stdoutTaken) process.stdout.write(renderTerminal(report));
    return exitCodeFor(report, failOn);
  } catch (e) {
    err(pc.red(`doppeldiff: ${(e as Error).message}`));
    if (process.env.DOPPELDIFF_DEBUG) err(String((e as Error).stack));
    return 2;
  }
}
