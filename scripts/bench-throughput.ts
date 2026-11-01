/**
 * Measures raw runner throughput (calls/s through the sandboxed pool) for a trivial pure function,
 * and the per-call cost of the vm-guarded mode used after a function has hung once.
 * Usage: npm run bench
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunnerPool } from '../src/core/runner/pool.js';

const dir = mkdtempSync(join(tmpdir(), 'doppeldiff-bench-'));
writeFileSync(
  join(dir, 'm.mjs'),
  'export const add = (a, b) => a + b; export const hangOnce = (n) => { if (n === -1) while (true) {} return n; };',
);

const N = 20_000;
const inputs = Array.from({ length: N }, (_, i) => [i, i]);
console.log(`node ${process.version}, ${availableParallelism()} CPUs, ${N} calls per measurement`);
for (const size of [1, 2, Math.max(1, Math.floor(availableParallelism() / 2))]) {
  const pool = new RunnerPool({
    size,
    readPaths: [dir],
    timeoutMs: 250,
    freeze: true,
    now: 0,
    seed: 1,
    label: 'bench',
  });
  const t0 = performance.now();
  await pool.load('m', join(dir, 'm.mjs'));
  const startup = performance.now() - t0;
  await pool.run('m', 'add', inputs.slice(0, 1000)); // warm-up
  const t1 = performance.now();
  await pool.run('m', 'add', inputs);
  const dt = performance.now() - t1;
  console.log(
    `pool size ${size}: startup ${startup.toFixed(0)}ms, ${Math.round((N / dt) * 1000).toLocaleString()} calls/s`,
  );
  // Guarded mode: trigger one sync hang, then measure.
  await pool.run('m', 'hangOnce', [[-1]]);
  const t2 = performance.now();
  await pool.run(
    'm',
    'hangOnce',
    inputs.slice(0, 5000).map(([i]) => [i]),
  );
  const dg = performance.now() - t2;
  console.log(`  vm-guarded mode: ${Math.round((5000 / dg) * 1000).toLocaleString()} calls/s`);
  pool.close();
}
