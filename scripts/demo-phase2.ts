/** Phase 2 driver: full git integration on a scenario repository. Usage: tsx scripts/demo-phase2.ts [scenario] [branch] */
import { formatArgs, formatOutcome } from '../src/core/format/format.js';
import { run } from '../src/core/run.js';
import { gitScenario, SCENARIOS, type ScenarioName } from '../test/helpers/scenarios.js';

const name = (process.argv[2] ?? 'ai-refactor') as ScenarioName;
if (!(name in SCENARIOS)) throw new Error(`unknown scenario ${name}`);
const mode = process.argv[3] === 'branch' ? 'branch' : 'worktree';
const s = gitScenario(name, mode);
try {
  const r = await run({
    cwd: s.repo,
    ...(mode === 'branch' ? { base: 'main', head: 'pr' } : {}),
    onEvent: (e) => {
      if (e.type === 'detected')
        console.log(`detected ${e.detection.targets.length} targets in ${e.detection.files.length} files`);
    },
  });
  for (const f of r.functions) {
    console.log(
      `${f.status.padEnd(10)} ${f.id}  [${f.targetReason}] ${f.inputsRun} inputs ${f.reason ?? ''}`,
    );
    for (const c of f.clusters.slice(0, 4)) {
      const w = c.witnesses[0]!;
      console.log(
        `   ${c.transition}: ${f.exportName}(${formatArgs(w.input, 70)}) old ${formatOutcome(w.base, 40)} new ${formatOutcome(w.head, 40)}`,
      );
    }
  }
  for (const k of ['skipped', 'added', 'removed', 'identical'] as const) {
    if (r[k].length)
      console.log(`${k}: ${r[k].map((x) => `${x.id}${x.reason ? ` (${x.reason})` : ''}`).join(', ')}`);
  }
  console.log('timing', r.timing, 'deps', r.dependencies);
} finally {
  s.cleanup();
}
