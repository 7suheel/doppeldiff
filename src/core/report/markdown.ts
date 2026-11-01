import type { Behavior, BehaviorLabel, FunctionReport, Report } from './model.js';

export const STICKY_MARKER = '<!-- doppeldiff:sticky -->';
const GITHUB_LIMIT = 60_000;
const PROJECT_URL = 'https://github.com/7suheel/doppeldiff';

/** Escape untrusted text for Markdown prose: HTML, mentions, and Markdown control characters. */
export function escapeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@/g, '@​')
    .replace(/([\\`*_[\]#|~])/g, '\\$1')
    .replace(/\r?\n/g, ' ');
}

/** Inline code span that survives backticks and table pipes. */
export function code(s: string, max = 160): string {
  let v = s.replace(/\r?\n/g, '↵');
  if (v.length > max) v = `${v.slice(0, max - 1)}…`;
  v = v.replace(/\|/g, '\\|');
  const ticks = (v.match(/`+/g) ?? []).reduce((m, t) => Math.max(m, t.length), 0);
  const fence = '`'.repeat(ticks + 1);
  const pad = v.startsWith('`') || v.endsWith('`') || v.startsWith(' ') ? ' ' : '';
  return `${fence}${pad}${v}${pad}${fence}`;
}

const n = (x: number) => x.toLocaleString('en-US');

function duration(ms: number): string {
  return ms < 1000
    ? `${ms}ms`
    : ms < 60_000
      ? `${(ms / 1000).toFixed(1)}s`
      : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

const SECTIONS: { label: BehaviorLabel; heading: string }[] = [
  { label: 'unclaimed', heading: '⚠️ Unclaimed behavior change' },
  { label: 'suspicious', heading: '❓ Suspicious behavior change' },
  { label: 'claimed', heading: '✅ Claimed change verified' },
  { label: 'behavior-change', heading: '🔍 Behavior change' },
];

function behaviorBlock(f: FunctionReport, b: Behavior, maxExamples: number): string {
  const lines: string[] = [];
  const region = f.inputsRun > 0 ? ` · ${n(b.count)} of ${n(f.inputsRun)} inputs` : '';
  lines.push(`**${code(f.exportName, 80)}** in ${code(f.file, 120)}: ${escapeText(b.title)}${region}`);
  if (b.explanation) lines.push(`<br>${b.labelSource === 'llm' ? '🤖 ' : ''}${escapeText(b.explanation)}`);
  if (b.realism === 'unusual') {
    lines.push(
      `<br>ℹ️ Only on inputs unlike those in the project's tests and call sites: ${escapeText(b.realismNote ?? 'unusual values')}.`,
    );
  }
  lines.push('');
  const examples = b.examples.slice(0, maxExamples);
  const hasMutation = examples.some((e) => e.mutation);
  lines.push(hasMutation ? '| Call | Old | New | Argument after call (old → new) |' : '| Call | Old | New |');
  lines.push(hasMutation ? '| --- | --- | --- | --- |' : '| --- | --- | --- |');
  for (const e of examples) {
    const cells = [code(e.call), code(e.old.display, 100), code(e.new.display, 100)];
    if (hasMutation)
      cells.push(e.mutation ? `${code(e.mutation.old, 60)} → ${code(e.mutation.new, 60)}` : '');
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

function claimLine(r: Report): string | undefined {
  if (!r.claim.text) return undefined;
  const firstLine = r.claim.text
    .trim()
    .split(/\r?\n/)[0]!
    .replace(/^#+\s*/, '');
  return `**PR claims:** “${escapeText(firstLine.slice(0, 200))}”${r.claim.refactor ? ' (no behavior change)' : ''}`;
}

export interface MarkdownOptions {
  maxExamples?: number;
  /** Include the hidden sticky-comment marker (GitHub Action). */
  sticky?: boolean;
}

export function renderMarkdown(r: Report, options: MarkdownOptions = {}): string {
  const out = render(r, options.maxExamples ?? 3, options.sticky ?? false);
  if (out.length <= GITHUB_LIMIT) return out;
  const shorter = render(r, 1, options.sticky ?? false);
  if (shorter.length <= GITHUB_LIMIT) return shorter;
  const cut = shorter.slice(0, GITHUB_LIMIT - 400);
  return `${cut.slice(0, cut.lastIndexOf('\n'))}\n\n_Report truncated. The full report is in the JSON artifact._\n${options.sticky ? STICKY_MARKER : ''}`;
}

function render(r: Report, maxExamples: number, sticky: boolean): string {
  const lines: string[] = [];
  lines.push('## 🔬 doppeldiff: behavioral diff');
  const claim = claimLine(r);
  if (claim) lines.push('', claim);

  const s = r.summary;
  lines.push('');
  if (s.functions === 0) {
    lines.push(
      r.skipped.length + r.added.length + r.removed.length > 0
        ? '> No existing exported function with changed behavior to compare.'
        : '> No changed exported functions found.',
    );
  } else if (s.behaviors === 0 && s.edgeCaseBehaviors === 0) {
    lines.push(
      `> ✅ **No behavior change** detected in ${n(s.unchanged)} function${s.unchanged === 1 ? '' : 's'} across ${n(s.inputsRun)} generated inputs.`,
    );
  } else if (s.behaviors === 0) {
    lines.push(
      `> ✅ **No behavior change on realistic inputs** across ${n(s.inputsRun)} generated inputs; ${s.edgeCaseBehaviors} difference${s.edgeCaseBehaviors === 1 ? '' : 's'} only on edge-case inputs (below).`,
    );
  } else {
    const all = r.functions.flatMap((f) => f.behaviors).filter((b) => b.realism !== 'edge');
    const realistic = all.filter((b) => b.realism === 'seen' || b.realism === 'ordinary').length;
    const unusual = all.length - realistic;
    const plural = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`;
    const parts: string[] = [];
    if (realistic > 0) {
      parts.push(`**${plural(realistic, 'behavior change')}** on realistic inputs`);
      if (s.unclaimedRealistic > 0)
        parts.push(`**${s.unclaimedRealistic} not covered by the PR description**`);
      if (unusual > 0) parts.push(`${unusual} more only on unusual inputs`);
    } else {
      parts.push(
        `${plural(unusual, 'behavior change')} only on unusual inputs${s.unclaimed > 0 ? ` (${s.unclaimed} not covered by the PR description)` : ''}`,
      );
    }
    if (s.edgeCaseBehaviors > 0) parts.push(`${s.edgeCaseBehaviors} only on edge-case inputs`);
    const icon = s.unclaimedRealistic > 0 ? '⚠️' : realistic > 0 ? '🔍' : 'ℹ️';
    lines.push(`> ${icon} ${parts.join(', ')}.`);
  }

  const rank = { seen: 0, ordinary: 1, unusual: 2, edge: 3 } as const;
  for (const sec of SECTIONS) {
    const items = r.functions
      .flatMap((f) =>
        f.behaviors.filter((b) => b.label === sec.label && b.realism !== 'edge').map((b) => ({ f, b })),
      )
      .sort((x, y) => rank[x.b.realism] - rank[y.b.realism]);
    if (items.length === 0) continue;
    lines.push(
      '',
      `### ${sec.heading}`,
      '',
      items.map(({ f, b }) => behaviorBlock(f, b, maxExamples)).join('\n\n'),
    );
  }

  const edge = r.functions.flatMap((f) =>
    f.behaviors.filter((b) => b.realism === 'edge').map((b) => ({ f, b })),
  );
  if (edge.length > 0) {
    const reasons = [...new Set(edge.map(({ b }) => b.realismNote).filter(Boolean))].slice(0, 4).join(', ');
    const tag: Record<string, string> = {
      unclaimed: '⚠️ unclaimed: ',
      suspicious: '❓ suspicious: ',
      claimed: '✅ claimed: ',
      'behavior-change': '',
    };
    lines.push(
      '',
      `<details><summary>🧪 ${edge.length} behavior change${edge.length === 1 ? '' : 's'} only on edge-case inputs${reasons ? ` (${escapeText(reasons)})` : ''}</summary>`,
      '',
      edge.map(({ f, b }) => `${tag[b.label] ?? ''}${behaviorBlock(f, b, maxExamples)}`).join('\n\n'),
      '',
      '</details>',
    );
  }

  const unchanged = r.functions.filter((f) => f.status === 'unchanged');
  if (unchanged.length > 0) {
    lines.push('', '### ✅ No behavior change', '');
    lines.push(
      unchanged
        .map(
          (f) =>
            `${code(f.exportName, 80)} (${n(f.inputsRun)} inputs${f.stoppedBy === 'failures' ? ', stopped early after repeated timeouts' : ''})`,
        )
        .join(' · '),
    );
  }

  const notVerified = [
    ...r.functions
      .filter((f) => f.status === 'skipped' || f.status === 'nondeterministic')
      .map((f) => ({ name: f.exportName, file: f.file, reason: f.reason ?? f.status })),
    ...r.skipped.map((x) => ({ name: x.exportName, file: x.file, reason: x.reason ?? x.kind })),
  ];
  if (notVerified.length > 0) {
    lines.push('', '### ⏭️ Not verified', '');
    for (const x of notVerified)
      lines.push(`- ${code(x.name, 80)} in ${code(x.file, 120)}: ${escapeText(x.reason)}`);
  }

  const extras: string[] = [];
  if (r.added.length) extras.push(`**Added:** ${r.added.map((a) => code(a.exportName, 60)).join(', ')}`);
  if (r.removed.length)
    extras.push(`**Removed:** ${r.removed.map((a) => code(a.exportName, 60)).join(', ')}`);
  if (r.identical.length)
    extras.push(
      `**Only comments/formatting changed:** ${r.identical.map((a) => code(a.exportName, 60)).join(', ')}`,
    );
  if (r.errors.length)
    extras.push(
      `**Could not analyze:** ${r.errors.map((e) => `${code(e.file, 120)} (${escapeText(e.message.slice(0, 200))})`).join(', ')}`,
    );
  if (extras.length) {
    const counts = [
      r.added.length ? `${r.added.length} added` : '',
      r.removed.length ? `${r.removed.length} removed` : '',
      r.identical.length ? `${r.identical.length} formatting-only` : '',
      r.errors.length ? `${r.errors.length} not analyzable` : '',
    ].filter(Boolean);
    lines.push(
      '',
      `<details><summary>${counts.join(' · ')}</summary>`,
      '',
      extras.join('<br>\n'),
      '',
      '</details>',
    );
  }

  if (r.regressionTests && r.regressionTests.files.length > 0) {
    lines.push(
      '',
      `📎 Regression tests (${r.regressionTests.cases} cases): ${r.regressionTests.files.map((f) => code(f, 200)).join(', ')}`,
    );
  }

  const footer = [
    `${n(s.inputsRun)} inputs`,
    `${s.functions} function${s.functions === 1 ? '' : 's'}`,
    duration(Math.round(s.durationMs)),
    `seed ${r.settings.seed}`,
    `${r.base.sha.slice(0, 7)} → ${r.head.sha ? r.head.sha.slice(0, 7) : 'working tree'}`,
    `[doppeldiff](${PROJECT_URL}) v${r.tool.version}`,
  ];
  lines.push('', `<sub>${footer.join(' · ')}</sub>`);
  if (r.claim.llm && s.behaviors > 0) {
    lines.push(
      `<sub>🤖 Claimed/unclaimed labels and explanations by ${escapeText(r.claim.llm.model)}, checked against the observed examples. The examples themselves come from running the code.</sub>`,
    );
  } else if (s.behaviors > 0) {
    const labeled = r.functions.some((f) => f.behaviors.some((b) => b.labelSource === 'rules'));
    lines.push(
      labeled
        ? `<sub>Claimed/unclaimed labels come from the PR text via [deterministic rules](${PROJECT_URL}/blob/main/docs/CLAIMS.md) (no LLM, no API key).</sub>`
        : `<sub>Not matched against the PR description: name the functions you meant to change, or say "no behavior change" for a refactor ([rules](${PROJECT_URL}/blob/main/docs/CLAIMS.md)).</sub>`,
    );
  }
  if (sticky) lines.push(STICKY_MARKER);
  return lines.join('\n') + '\n';
}
