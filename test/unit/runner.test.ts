import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RunnerPool } from '../../src/core/runner/pool.js';
import { FN_TAG } from '../../src/core/runner/tags.js';

const dir = mkdtempSync(join(tmpdir(), 'doppeldiff-runner-test-'));
const mod = join(dir, 'mod.mjs');
writeFileSync(
  mod,
  `
import { writeFileSync } from 'node:fs';
export const add = (a, b) => a + b;
export const hang = (n) => { if (n < 0) { while (true) {} } return n; };
export const asyncHang = async (n) => { if (n < 0) await new Promise(() => {}); return n; };
export const exit = () => process.exit(3);
export const oom = () => { const a = []; while (true) a.push(new Array(1e6).fill(1)); };
export const write = () => writeFileSync(${JSON.stringify(join(dir, 'x.txt'))}, 'y');
export const spawn = async () => (await import('node:child_process')).execSync('echo hi');
export const net = async () => { await fetch('https://example.com'); return 1; };
export const now = () => [Date.now(), new Date().getTime(), Math.random(), crypto.randomUUID()];
export const mutate = (arr) => { arr.push(1); return arr.length; };
export const callTwice = (cb) => cb() + cb();
export const throwsLater = async () => { setTimeout(() => { throw new Error('late'); }, 1); await new Promise((r) => setTimeout(r, 20)); return 1; };
`,
);

let pool: RunnerPool;
beforeAll(async () => {
  pool = new RunnerPool({
    size: 2,
    readPaths: [dir],
    timeoutMs: 200,
    freeze: true,
    now: 1_700_000_000_000,
    seed: 1,
    label: 'test',
    memoryMb: 64,
  });
  const load = await pool.load('m', mod);
  expect(load.ok).toBe(true);
});
afterAll(() => pool.close());

describe('runner pool', () => {
  it('returns encoded outcomes in input order', async () => {
    const out = await pool.run(
      'm',
      'add',
      Array.from({ length: 100 }, (_, i) => [i, 1]),
    );
    expect(out.map((o) => (o.kind === 'return' && o.value.t === 'number' ? o.value.v : null))).toEqual(
      Array.from({ length: 100 }, (_, i) => i + 1),
    );
  });

  it('turns sync and async hangs into timeouts and keeps going', async () => {
    const out = await pool.run('m', 'hang', [[1], [-1], [2], [-2], [3]]);
    expect(out.map((o) => o.kind)).toEqual(['return', 'timeout', 'return', 'timeout', 'return']);
    const a = await pool.run('m', 'asyncHang', [[-1], [1]]);
    expect(a.map((o) => o.kind)).toEqual(['timeout', 'return']);
  });

  it('isolates process exits and out-of-memory crashes', async () => {
    const [e] = await pool.run('m', 'exit', [[]]);
    expect(e).toMatchObject({ kind: 'crash', reason: expect.stringContaining('code 3') });
    const [o] = await pool.run('m', 'oom', [[]]);
    expect(o).toMatchObject({ kind: 'crash' });
    const [after] = await pool.run('m', 'add', [[1, 1]]);
    expect(after).toMatchObject({ kind: 'return' });
  });

  it('denies file writes, child processes and network access', async () => {
    for (const fn of ['write', 'spawn', 'net']) {
      const [o] = await pool.run('m', fn, [[]]);
      expect(o, fn).toMatchObject({ kind: 'throw' });
      expect(JSON.stringify(o)).toMatch(/ERR_ACCESS_DENIED/);
    }
  });

  it('freezes the clock and seeds randomness identically for every call', async () => {
    const [a, b] = await pool.run('m', 'now', [[], []]);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toContain('1700000000000');
  });

  it('captures argument mutations and clones inputs per call', async () => {
    const shared = [1, 2];
    const out = await pool.run('m', 'mutate', [[shared], [shared]]);
    expect(out[0]).toEqual(out[1]);
    expect(out[0]).toMatchObject({ kind: 'return', value: { v: 3 } });
  });

  it('materializes callback descriptors', async () => {
    const [o] = await pool.run('m', 'callTwice', [[{ [FN_TAG]: { returns: 21, async: false } }]]);
    expect(o).toMatchObject({ kind: 'return', value: { t: 'number', v: 42 } });
  });

  it('attributes uncaught async errors to the running call', async () => {
    const [o] = await pool.run('m', 'throwsLater', [[]]);
    expect(o).toMatchObject({ kind: 'throw', error: { message: 'late' } });
  });

  it('reports missing exports', async () => {
    const [o] = await pool.run('m', 'nope', [[]]);
    expect(o).toMatchObject({ kind: 'crash', reason: expect.stringContaining('not a function') });
  });
});
