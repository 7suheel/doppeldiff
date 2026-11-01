import pc from 'picocolors';
import { groupBehaviors } from './behaviors.js';
import type { RunEvent } from '../run.js';
import type { Behavior, FunctionReport, Report } from './model.js';

const n = (x: number) => x.toLocaleString('en-US');
const secs = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

const LABEL: Record<Behavior['label'], (s: string) => string> = {
  unclaimed: (s) => pc.yellow(`⚠ unclaimed  ${s}`),
  suspicious: (s) => pc.magenta(`? suspicious ${s}`),
  claimed: (s) => pc.green(`✓ claimed    ${s}`),
  'behavior-change': (s) => pc.cyan(`● changed    ${s}`),
};

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Live progress lines for a run (written to stderr by the CLI). */
export function progressPrinter(write: (line: string) => void): (e: RunEvent) => void {
  return (e) => {
    switch (e.type) {
      case 'phase':
        if (e.phase === 'detect') write(pc.dim('  detecting changed functions…'));
        break;
      case 'detected': {
        const d = e.detection;
        write(
          pc.dim(
            `  ${d.targets.length} function${d.targets.length === 1 ? '' : 's'} to verify in ${d.files.length} changed file${d.files.length === 1 ? '' : 's'}` +
              (d.skipped.length ? `, ${d.skipped.length} not verifiable` : ''),
          ),
        );
        break;
      }
      case 'function-done': {
        const r = e.result;
        const name = `${pc.bold(r.exportName)} ${pc.dim(r.file)}`;
        const meta = pc.dim(`${n(r.inputsRun)} inputs · ${secs(r.durationMs)}`);
        const nb = groupBehaviors(r.clusters).length;
        if (r.status === 'changed')
          write(`  ${pc.yellow('≠')} ${name}  ${nb} behavior change${nb === 1 ? '' : 's'}  ${meta}`);
        else if (r.status === 'unchanged') write(`  ${pc.green('=')} ${name}  no behavior change  ${meta}`);
        else if (r.status === 'nondeterministic')
          write(`  ${pc.magenta('~')} ${name}  nondeterministic  ${pc.dim(r.reason ?? '')}`);
        else write(`  ${pc.dim('-')} ${name}  ${pc.dim(`skipped: ${r.reason ?? ''}`)}`);
        break;
      }
      default:
        break;
    }
  };
}

function behaviorLines(f: FunctionReport, b: Behavior, width: number): string[] {
  const lines = [
    `    ${LABEL[b.label](pc.bold(b.title))} ${pc.dim(`(${n(b.count)} of ${n(f.inputsRun)} inputs)`)}`,
  ];
  if (b.explanation) lines.push(`      ${pc.dim(clip(b.explanation, width - 6))}`);
  if (b.realism === 'unusual')
    lines.push(`      ${pc.dim(clip(`only on unusual inputs: ${b.realismNote ?? ''}`, width - 6))}`);
  for (const ex of b.examples) {
    lines.push(`      ${clip(ex.call, width - 6)}`);
    lines.push(`        ${pc.dim('old:')} ${clip(ex.old.display, width - 14)}`);
    lines.push(`        ${pc.dim('new:')} ${clip(ex.new.display, width - 14)}`);
    if (ex.mutation)
      lines.push(
        `        ${pc.dim(`arg ${ex.mutation.argIndex + 1} after call:`)} ${clip(`${ex.mutation.old} → ${ex.mutation.new}`, width - 30)}`,
      );
  }
  return lines;
}

/** Final human-readable report. */
export function renderTerminal(r: Report, width = Math.min(process.stdout.columns ?? 100, 120)): string {
  const out: string[] = [''];
  if (r.claim.text)
    out.push(
      `${pc.dim('Claim:')} ${clip(
        r.claim.text
          .trim()
          .split('\n')[0]!
          .replace(/^#+\s*/, ''),
        width - 8,
      )}${r.claim.refactor ? pc.dim(' (no behavior change)') : ''}`,
      '',
    );

  for (const f of r.functions.filter((x) => x.behaviors.length > 0)) {
    out.push(
      `  ${pc.bold(f.exportName)} ${pc.dim(f.file)}${f.targetReason && f.targetReason !== 'code changed' ? pc.dim(`  (${f.targetReason})`) : ''}`,
    );
    for (const b of f.behaviors.filter((x) => x.realism !== 'edge')) out.push(...behaviorLines(f, b, width));
    const edge = f.behaviors.filter((x) => x.realism === 'edge');
    if (edge.length > 0) {
      out.push(
        `    ${pc.dim(
          `edge-case inputs only (${edge
            .map((b) => b.realismNote)
            .filter(Boolean)
            .join(', ')}):`,
        )}`,
      );
      for (const b of edge) out.push(...behaviorLines(f, b, width).map((l) => pc.dim(l)));
    }
    out.push('');
  }

  const unchanged = r.functions.filter((f) => f.status === 'unchanged');
  if (unchanged.length) {
    out.push(
      `  ${pc.green('✓ no behavior change:')} ${unchanged.map((f) => `${f.exportName} ${pc.dim(`(${n(f.inputsRun)})`)}`).join(', ')}`,
    );
  }
  const skipped = [
    ...r.functions
      .filter((f) => f.status === 'skipped' || f.status === 'nondeterministic')
      .map((f) => `${f.exportName}: ${f.reason ?? f.status}`),
    ...r.skipped.map((s) => `${s.exportName}: ${s.reason ?? s.kind}`),
  ];
  if (skipped.length) {
    out.push(`  ${pc.dim('– not verified:')}`);
    for (const s of skipped) out.push(`      ${pc.dim(clip(s, width - 6))}`);
  }
  if (r.added.length) out.push(`  ${pc.dim('+ added:')} ${r.added.map((a) => a.exportName).join(', ')}`);
  if (r.removed.length)
    out.push(`  ${pc.dim('- removed:')} ${r.removed.map((a) => a.exportName).join(', ')}`);
  if (r.identical.length)
    out.push(`  ${pc.dim('· formatting only:')} ${r.identical.map((a) => a.exportName).join(', ')}`);
  if (r.regressionTests?.files.length)
    out.push(`  ${pc.dim('📎 regression tests:')} ${r.regressionTests.files.join(', ')}`);

  const s = r.summary;
  const verdict =
    s.functions === 0
      ? pc.dim('no changed exported functions to compare')
      : s.verdict === 'no-change'
        ? pc.green(pc.bold('no behavior change'))
        : s.verdict === 'unclaimed'
          ? pc.yellow(
              pc.bold(
                `${s.behaviors} behavior change${s.behaviors === 1 ? '' : 's'}, ${s.unclaimed} unclaimed`,
              ),
            )
          : pc.cyan(pc.bold(`${s.behaviors} behavior change${s.behaviors === 1 ? '' : 's'}`));
  const edgeNote =
    s.edgeCaseBehaviors > 0 ? pc.dim(` (+${s.edgeCaseBehaviors} on edge-case inputs only)`) : '';
  out.push('');
  out.push(
    `  ${verdict}${edgeNote}  ${pc.dim(`${n(s.inputsRun)} inputs · ${s.functions} function${s.functions === 1 ? '' : 's'} · ${secs(s.durationMs)} · seed ${r.settings.seed}`)}`,
  );
  out.push('');
  return out.join('\n');
}
