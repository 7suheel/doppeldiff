/**
 * Phase 1 driver: runs the core engine on the hardcoded function pairs of each demo scenario.
 * Usage: node --import tsx scripts/demo-phase1.ts [scenario] [--runs N] [--seed N]
 */
import { join } from 'node:path';
import { formatArgs, formatOutcome } from '../src/core/format/format.js';
import { VerifySession } from '../src/core/verify/session.js';
import { verifyFunction } from '../src/core/verify/verifyFunction.js';
import { materializeScenario, SCENARIOS, type ScenarioName } from '../test/helpers/scenarios.js';

const args = process.argv.slice(2);
const flag = (name: string, def: number) => {
  const i = args.indexOf(name);
  return i === -1 ? def : Number(args[i + 1]);
};
const runs = flag('--runs', 1000);
const seed = flag('--seed', 42);
const only = args.find((a) => !a.startsWith('--') && a in SCENARIOS) as ScenarioName | undefined;

for (const name of only ? [only] : (Object.keys(SCENARIOS) as ScenarioName[])) {
  const s = materializeScenario(name);
  const session = new VerifySession({
    baseRoot: s.baseRoot,
    headRoot: s.headRoot,
    timeoutMs: 250,
    freeze: true,
    seed,
  });
  const t0 = Date.now();
  console.log(`\n=== ${name}: ${s.claim.split('\n')[0]!.replace(/^# /, '')}`);
  try {
    for (const id of s.functions) {
      const [file, exportName] = id.split('#') as [string, string];
      const r = await verifyFunction(
        session,
        { id, exportName, baseFile: join(s.baseRoot, file), headFile: join(s.headRoot, file) },
        { seed, runs },
      );
      const head = `${r.status.toUpperCase().padEnd(10)} ${r.signature ?? id}  (${r.inputsRun} inputs, ${r.durationMs}ms${r.reason ? `, ${r.reason}` : ''})`;
      console.log(head);
      for (const c of r.clusters) {
        console.log(`    • ${c.transition}   [${c.features.join(' ')}]  ×${c.count}`);
        for (const w of c.witnesses) {
          console.log(
            `        ${exportName}(${formatArgs(w.input, 80)})   old: ${formatOutcome(w.base, 60)}   new: ${formatOutcome(w.head, 60)}${w.minimal ? '  (minimal)' : ''}`,
          );
        }
      }
    }
  } finally {
    session.close();
    s.cleanup();
  }
  console.log(`--- ${name} done in ${Date.now() - t0}ms`);
}
