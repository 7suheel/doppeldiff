import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEMO_SHOP = join(REPO_ROOT, 'examples', 'demo-shop');

export const SCENARIOS = {
  'honest-fix': { patch: '1-honest-fix', functions: ['src/pricing.ts#applyDiscount'] },
  'ai-refactor': {
    patch: '2-ai-refactor',
    functions: ['src/cart.ts#cartTotal', 'src/cart.ts#itemCount', 'src/slug.ts#slugify'],
  },
  'pure-refactor': {
    patch: '3-pure-refactor',
    functions: [
      'src/pricing.ts#applyTax',
      'src/pricing.ts#bulkPrice',
      'src/dates.ts#addBusinessDays',
      'src/dates.ts#formatDate',
    ],
  },
} as const;

export type ScenarioName = keyof typeof SCENARIOS;

export interface MaterializedScenario {
  baseRoot: string;
  headRoot: string;
  claim: string;
  functions: readonly string[];
  cleanup(): void;
}

function copyShop(dest: string): void {
  for (const entry of ['src', 'test', 'package.json', 'tsconfig.json']) {
    cpSync(join(DEMO_SHOP, entry), join(dest, entry), { recursive: true });
  }
}

/** Create two directories: the demo shop as-is (base) and with the scenario patch applied (head). */
export function materializeScenario(name: ScenarioName): MaterializedScenario {
  const s = SCENARIOS[name];
  const dir = mkdtempSync(join(tmpdir(), `doppeldiff-${name}-`));
  const baseRoot = join(dir, 'base');
  const headRoot = join(dir, 'head');
  copyShop(baseRoot);
  copyShop(headRoot);
  execFileSync('git', ['apply', join(DEMO_SHOP, 'scenarios', `${s.patch}.patch`)], { cwd: headRoot });
  const claim = readFileSync(join(DEMO_SHOP, 'scenarios', `${s.patch}.md`), 'utf8');
  return {
    baseRoot,
    headRoot,
    claim,
    functions: s.functions,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
