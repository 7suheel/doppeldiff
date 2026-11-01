import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { VerifySession } from '../../src/core/verify/session.js';
import { verifyFunction, type FunctionResult } from '../../src/core/verify/verifyFunction.js';
import { materializeScenario, type ScenarioName } from '../helpers/scenarios.js';

const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((c) => c()));

async function runScenario(name: ScenarioName, runs = 1000): Promise<Record<string, FunctionResult>> {
  const s = materializeScenario(name);
  const session = new VerifySession({
    baseRoot: s.baseRoot,
    headRoot: s.headRoot,
    timeoutMs: 250,
    freeze: true,
    seed: 42,
  });
  cleanups.push(() => {
    session.close();
    s.cleanup();
  });
  const out: Record<string, FunctionResult> = {};
  for (const id of s.functions) {
    const [file, exportName] = id.split('#') as [string, string];
    out[exportName] = await verifyFunction(
      session,
      { id, exportName, baseFile: join(s.baseRoot, file), headFile: join(s.headRoot, file) },
      { seed: 42, runs },
    );
  }
  return out;
}

describe('demo scenarios (core engine on hardcoded function pairs)', () => {
  it('1. honest fix: only prices over $1000 change', async () => {
    const r = await runScenario('honest-fix');
    const d = r.applyDiscount!;
    expect(d.status).toBe('changed');
    expect(d.inputsRun).toBe(1000);
    expect(d.clusters.length).toBeGreaterThan(0);
    for (const c of d.clusters) {
      expect(c.features[0]).toBe('>1000');
      for (const w of c.witnesses) expect((w.input[0] as number) > 1000).toBe(true);
    }
  });

  it('2. AI refactor: catches clamped negative totals, NaN totals and slug changes; itemCount unchanged', async () => {
    const r = await runScenario('ai-refactor');
    expect(r.cartTotal!.status).toBe('changed');
    const transitions = r.cartTotal!.clusters.map((c) => c.transition);
    expect(transitions).toContain('returns negative number → returns 0');
    expect(transitions.some((t) => t.endsWith('→ returns NaN'))).toBe(true);
    const neg = r.cartTotal!.clusters.find((c) => c.transition === 'returns negative number → returns 0')!;
    expect(neg.witnesses[0]!.minimal).toBe(true);
    expect(JSON.stringify(neg.witnesses[0]!.input)).toContain('"unitPrice":-1');
    expect(r.itemCount!.status).toBe('unchanged');
    expect(r.slugify!.status).toBe('changed');
    expect(r.slugify!.clusters.flatMap((c) => c.witnesses.map((w) => w.input[0]))).toContain('é');
  });

  it('3. pure refactor: no behavior change', async () => {
    const r = await runScenario('pure-refactor');
    for (const [name, f] of Object.entries(r)) {
      expect(f.status, name).toBe('unchanged');
      expect(f.inputsRun, name).toBeGreaterThan(100);
    }
  });
});
