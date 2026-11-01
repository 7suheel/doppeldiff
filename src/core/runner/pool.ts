import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Outcome } from '../compare/observed.js';
import { nativeNetPermission } from './netguard.js';
import type { ChildMessage, LoadedMessage, ParentMessage } from './protocol.js';

export interface PoolOptions {
  /** Number of runner processes (default: max(1, floor(cpus / 2))). */
  size?: number;
  /** Directories the code under test may read (module bundles, node_modules, project root). */
  readPaths: string[];
  /** Per-call timeout in ms. */
  timeoutMs: number;
  /** V8 old-space limit per runner in MB (default 512). */
  memoryMb?: number;
  freeze: boolean;
  now: number;
  seed: number;
  showConsole?: boolean;
  /** Disable the Node permission model (debugging only). */
  noSandbox?: boolean;
  /** Label for diagnostics, e.g. "base" / "head". */
  label: string;
}

export interface LoadResult {
  ok: boolean;
  error?: LoadedMessage['error'];
  exports: string[];
}

/** Resolve (and if running from source, build) the runner child entry script. */
let childEntryCache: string | undefined;
export async function resolveChildEntry(): Promise<string> {
  if (childEntryCache) return childEntryCache;
  const here = dirname(fileURLToPath(import.meta.url));
  const built = [join(here, 'child.js'), join(here, 'runner-child.js')].find((p) => existsSync(p));
  if (built) return (childEntryCache = built);
  const source = join(here, 'child.ts');
  if (!existsSync(source)) throw new Error(`doppeldiff: runner entry not found next to ${here}`);
  // Running from TypeScript sources (development/tests): bundle the child once into a temp cache.
  const esbuild = await import('esbuild');
  const result = await esbuild.build({
    entryPoints: [source],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    write: false,
    logLevel: 'silent',
  });
  const code = result.outputFiles[0]!.text;
  const hash = createHash('sha256').update(code).digest('hex').slice(0, 16);
  const dir = join(tmpdir(), 'doppeldiff-runner');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `child-${hash}.mjs`);
  if (!existsSync(file) || readFileSync(file, 'utf8') !== code) writeFileSync(file, code);
  return (childEntryCache = file);
}

function realpaths(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    out.add(p);
    try {
      out.add(realpathSync(p));
    } catch {
      /* ignore */
    }
  }
  return [...out];
}

interface Job {
  moduleId: string;
  exportName: string;
  inputs: unknown[][];
}

/** One sandboxed runner process, respawned transparently after timeouts and crashes. */
class RunnerProcess {
  private child: ChildProcess | undefined;
  private reqCounter = 0;
  private stderrTail = '';
  private listeners = new Set<(msg: ChildMessage) => void>();
  private exitListeners = new Set<(reason: string) => void>();
  spawns = 0;

  constructor(
    private readonly entry: string,
    private readonly options: PoolOptions,
    private readonly loads: Map<string, string>,
    /** Functions that hung synchronously once; their calls run in vm-guarded mode from then on. */
    private readonly guarded: Set<string>,
  ) {}

  private execArgv(): string[] {
    const args = [`--max-old-space-size=${this.options.memoryMb ?? 512}`];
    if (!this.options.noSandbox) {
      args.push('--permission');
      for (const p of realpaths([dirname(this.entry), ...this.options.readPaths]))
        args.push(`--allow-fs-read=${p}`);
    }
    return args;
  }

  async start(): Promise<void> {
    this.spawns++;
    const child = fork(this.entry, [], {
      execArgv: this.execArgv(),
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { TZ: 'UTC', LANG: 'en_US.UTF-8', NODE_ENV: 'test', DOPPELDIFF_RUNNER: '1' },
    });
    this.child = child;
    child.stderr?.on('data', (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-2000);
    });
    child.on('message', (m) => {
      for (const l of [...this.listeners]) l(m as ChildMessage);
    });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      const reason = signal ? `killed by ${signal}` : `exited with code ${code}`;
      const oom = /heap out of memory|Allocation failed/i.test(this.stderrTail) ? ' (out of memory)' : '';
      for (const l of [...this.exitListeners]) l(reason + oom);
    });
    await this.request(
      {
        t: 'init',
        freeze: this.options.freeze,
        now: this.options.now,
        seed: this.options.seed,
        netGuard: !nativeNetPermission(),
        showConsole: this.options.showConsole ?? false,
      },
      (m) => m.t === 'ready',
    );
    for (const [moduleId, path] of this.loads) await this.loadModule(moduleId, path);
  }

  /** Send a message and wait for the first reply matching `done`. Rejects if the process exits. */
  private request<T extends ChildMessage>(
    msg: ParentMessage,
    done: (m: ChildMessage) => boolean,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onMsg = (m: ChildMessage) => {
        if (!done(m)) return;
        cleanup();
        resolve(m as T);
      };
      const onExit = (reason: string) => {
        cleanup();
        reject(new Error(`runner (${this.options.label}) ${reason}: ${this.stderrTail.trim().slice(-500)}`));
      };
      const cleanup = () => {
        this.listeners.delete(onMsg);
        this.exitListeners.delete(onExit);
      };
      this.listeners.add(onMsg);
      this.exitListeners.add(onExit);
      this.child!.send(msg);
    });
  }

  async loadModule(moduleId: string, path: string): Promise<LoadResult> {
    const m = await this.request<LoadedMessage>(
      { t: 'load', moduleId, path },
      (r) => r.t === 'loaded' && r.moduleId === moduleId,
    );
    return { ok: m.ok, exports: m.exports, ...(m.error ? { error: m.error } : {}) };
  }

  kill(): void {
    const c = this.child;
    this.child = undefined;
    c?.removeAllListeners('exit');
    c?.kill('SIGKILL');
  }

  /** Execute a job; timeouts and crashes become outcomes, and the process is respawned. */
  async run(job: Job): Promise<Outcome[]> {
    const { timeoutMs } = this.options;
    const watchdogMs = timeoutMs + Math.max(150, Math.round(timeoutMs * 0.3));
    const guardKey = `${job.moduleId}#${job.exportName}`;
    const outcomes: Outcome[] = new Array(job.inputs.length);
    let next = 0;
    while (next < job.inputs.length) {
      if (!this.child) await this.start();
      const reqId = ++this.reqCounter;
      const offset = next;
      const segment = job.inputs.slice(offset);
      const received = await new Promise<{ count: number; failure?: Outcome }>((resolve) => {
        let count = 0;
        let timer: NodeJS.Timeout;
        const arm = () => {
          clearTimeout(timer);
          timer = setTimeout(
            () => finish({ count, failure: { kind: 'timeout', ms: timeoutMs } }, true),
            watchdogMs,
          );
        };
        const onMsg = (m: ChildMessage) => {
          if (m.t === 'result' && m.reqId === reqId) {
            outcomes[offset + m.index] = m.outcome;
            count = m.index + 1;
            arm();
          } else if (m.t === 'done' && m.reqId === reqId) {
            finish({ count }, false);
          }
        };
        const onExit = (reason: string) => finish({ count, failure: { kind: 'crash', reason } }, false);
        const finish = (r: { count: number; failure?: Outcome }, kill: boolean) => {
          clearTimeout(timer);
          this.listeners.delete(onMsg);
          this.exitListeners.delete(onExit);
          if (kill) this.kill();
          resolve(r);
        };
        this.listeners.add(onMsg);
        this.exitListeners.add(onExit);
        arm();
        try {
          this.child!.send({
            t: 'run',
            reqId,
            moduleId: job.moduleId,
            exportName: job.exportName,
            inputs: segment,
            timeoutMs,
            guard: this.guarded.has(guardKey),
          });
        } catch (e) {
          // Non-serializable input: report every remaining input as a crash rather than hanging.
          for (let i = 0; i < segment.length; i++) {
            outcomes[offset + i] = {
              kind: 'crash',
              reason: `input not serializable: ${(e as Error).message}`,
            };
          }
          finish({ count: segment.length }, false);
        }
      });
      next = offset + received.count;
      if (received.failure && next < job.inputs.length) {
        if (received.failure.kind === 'timeout') this.guarded.add(guardKey);
        outcomes[next] = received.failure;
        next++;
        if (this.child) this.kill();
      }
    }
    return outcomes;
  }
}

/** A pool of runner processes for one version (base or head) of the code. */
export class RunnerPool {
  private procs: RunnerProcess[] = [];
  private readonly loads = new Map<string, string>();
  private readonly guarded = new Set<string>();
  private started = false;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: PoolOptions) {}

  get size(): number {
    return this.options.size ?? Math.max(1, Math.floor(availableParallelism() / 2));
  }

  /** Total number of process spawns so far (initial + respawns after timeouts/crashes). */
  get spawns(): number {
    return this.procs.reduce((s, p) => s + p.spawns, 0);
  }

  async start(): Promise<void> {
    if (this.started) return;
    const entry = await resolveChildEntry();
    this.procs = Array.from(
      { length: this.size },
      () => new RunnerProcess(entry, this.options, this.loads, this.guarded),
    );
    await Promise.all(this.procs.map((p) => p.start()));
    this.started = true;
  }

  async load(moduleId: string, path: string): Promise<LoadResult> {
    await this.start();
    this.loads.set(moduleId, path);
    const results = await Promise.all(this.procs.map((p) => p.loadModule(moduleId, path)));
    return results[0]!;
  }

  /** Run inputs, spreading them across processes. Outcomes are returned in input order. */
  run(moduleId: string, exportName: string, inputs: unknown[][]): Promise<Outcome[]> {
    const result = this.lock.then(() => this.runUnlocked(moduleId, exportName, inputs));
    this.lock = result.catch(() => undefined);
    return result;
  }

  private async runUnlocked(moduleId: string, exportName: string, inputs: unknown[][]): Promise<Outcome[]> {
    await this.start();
    const chunkSize = Math.max(16, Math.ceil(inputs.length / this.procs.length));
    const chunks: unknown[][][] = [];
    for (let i = 0; i < inputs.length; i += chunkSize) chunks.push(inputs.slice(i, i + chunkSize));
    const results = await Promise.all(
      chunks.map((c, i) => this.procs[i]!.run({ moduleId, exportName, inputs: c })),
    );
    return results.flat();
  }

  close(): void {
    for (const p of this.procs) p.kill();
    this.procs = [];
    this.started = false;
  }
}
