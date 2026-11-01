/**
 * Runner process entry. Loads modules under test and executes calls on request.
 * Runs with the Node permission model; must only import node built-ins and dependency-free modules.
 */
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import type { Outcome } from '../compare/observed.js';
import { encode } from './encode.js';
import { installDeterminism, type Determinism } from './determinism.js';
import { installNetGuard } from './netguard.js';
import type { ChildMessage, ParentMessage, RunMessage } from './protocol.js';
import { FN_TAG, isFnDescriptor, isProtoDescriptor, isViewDescriptor, PROTO_TAG, VIEW_TAG } from './tags.js';

const modules = new Map<string, Record<string, unknown>>();
let determinism: Determinism | undefined;

interface PendingCall {
  fail: (error: unknown) => void;
}
let current: PendingCall | undefined;

const send = (msg: ChildMessage) => process.send!(msg);

process.on('uncaughtException', (err) => current?.fail(err));
process.on('unhandledRejection', (err) => current?.fail(err));
process.on('disconnect', () => process.exit(0));

function materialize(value: unknown, seen = new Set<unknown>()): unknown {
  if (isFnDescriptor(value)) {
    const { returns, async } = value[FN_TAG];
    return async
      ? async function stub() {
          return structuredClone(returns);
        }
      : function stub() {
          return structuredClone(returns);
        };
  }
  if (isProtoDescriptor(value)) {
    const { proto, own } = value[PROTO_TAG];
    return Object.assign(Object.create(materialize(proto, seen) as object) as object, materialize(own, seen));
  }
  if (isViewDescriptor(value)) {
    const { ctor, buffer, byteOffset, length } = value[VIEW_TAG];
    const Ctor = (
      globalThis as unknown as Record<string, new (b: ArrayBuffer, o: number, l: number) => unknown>
    )[ctor];
    return Ctor ? new Ctor(buffer, byteOffset, length) : value;
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = materialize(value[i], seen);
  } else if (value instanceof Map) {
    const entries = [...value].map(([k, v]) => [materialize(k, seen), materialize(v, seen)] as const);
    value.clear();
    for (const [k, v] of entries) value.set(k, v);
  } else if (value instanceof Set) {
    const items = [...value].map((v) => materialize(v, seen));
    value.clear();
    for (const v of items) value.add(v);
  } else if (Object.getPrototypeOf(value) === Object.prototype) {
    const rec = value as Record<string, unknown>;
    for (const k of Object.keys(rec)) rec[k] = materialize(rec[k], seen);
  }
  return value;
}

function resolveExport(mod: Record<string, unknown>, name: string): unknown {
  if (name in mod) return mod[name];
  const def = mod.default as Record<string, unknown> | undefined;
  if (def && (typeof def === 'object' || typeof def === 'function') && name in def) return def[name];
  return undefined;
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    (typeof v === 'object' || typeof v === 'function') &&
    v !== null &&
    typeof (v as { then?: unknown }).then === 'function'
  );
}

const guardContext = vm.createContext({});
const guardScript = new vm.Script('__dd_fn(...__dd_args)');

async function callOnce(
  fn: (...a: unknown[]) => unknown,
  input: unknown[],
  timeoutMs: number,
  guard: boolean,
): Promise<Outcome> {
  const args = materialize(structuredClone(input)) as unknown[];
  determinism?.reset();
  let result: unknown;
  try {
    if (guard) {
      const ctx = guardContext as { __dd_fn?: unknown; __dd_args?: unknown };
      ctx.__dd_fn = fn;
      ctx.__dd_args = args;
      try {
        result = guardScript.runInContext(guardContext, { timeout: timeoutMs });
      } finally {
        ctx.__dd_fn = undefined;
        ctx.__dd_args = undefined;
      }
    } else {
      result = fn(...args);
    }
  } catch (error) {
    if (guard && (error as { code?: string })?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      return { kind: 'timeout', ms: timeoutMs };
    }
    return { kind: 'throw', error: encode(error), async: false, args: args.map((a) => encode(a)) };
  }
  if (!isThenable(result)) {
    return { kind: 'return', value: encode(result), async: false, args: args.map((a) => encode(a)) };
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    const settled = await new Promise<{ ok: boolean; value: unknown } | 'timeout'>((resolve) => {
      current = { fail: (error) => resolve({ ok: false, value: error }) };
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      Promise.resolve(result).then(
        (value) => resolve({ ok: true, value }),
        (error) => resolve({ ok: false, value: error }),
      );
    });
    if (settled === 'timeout') return { kind: 'timeout', ms: timeoutMs };
    const encodedArgs = args.map((a) => encode(a));
    return settled.ok
      ? { kind: 'return', value: encode(settled.value), async: true, args: encodedArgs }
      : { kind: 'throw', error: encode(settled.value), async: true, args: encodedArgs };
  } finally {
    current = undefined;
    if (timer) clearTimeout(timer);
  }
}

async function run(msg: RunMessage): Promise<void> {
  const mod = modules.get(msg.moduleId);
  const fn = mod ? resolveExport(mod, msg.exportName) : undefined;
  for (let i = 0; i < msg.inputs.length; i++) {
    let outcome: Outcome;
    if (typeof fn !== 'function') {
      outcome = { kind: 'crash', reason: `export \`${msg.exportName}\` is not a function` };
    } else {
      outcome = await callOnce(fn as (...a: unknown[]) => unknown, msg.inputs[i]!, msg.timeoutMs, msg.guard);
    }
    send({ t: 'result', reqId: msg.reqId, index: i, outcome });
  }
  send({ t: 'done', reqId: msg.reqId });
}

let queue: Promise<void> = Promise.resolve();

process.on('message', (raw) => {
  const msg = raw as ParentMessage;
  queue = queue
    .then(async () => {
      switch (msg.t) {
        case 'init': {
          if (msg.netGuard) installNetGuard();
          if (msg.freeze) determinism = installDeterminism({ now: msg.now, seed: msg.seed });
          if (!msg.showConsole) {
            const noop = () => {};
            for (const k of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table'] as const) {
              (console as unknown as Record<string, unknown>)[k] = noop;
            }
          }
          send({ t: 'ready', node: process.version });
          break;
        }
        case 'load': {
          try {
            const mod = (await import(pathToFileURL(msg.path).href)) as Record<string, unknown>;
            modules.set(msg.moduleId, mod);
            const def = mod.default as Record<string, unknown> | undefined;
            const names = new Set(Object.keys(mod));
            if (def && typeof def === 'object') for (const k of Object.keys(def)) names.add(k);
            send({ t: 'loaded', moduleId: msg.moduleId, ok: true, exports: [...names] });
          } catch (e) {
            const err = e as Error & { code?: string };
            send({
              t: 'loaded',
              moduleId: msg.moduleId,
              ok: false,
              error: {
                name: err?.name ?? 'Error',
                message: String(err?.message ?? e),
                ...(err?.code ? { code: err.code } : {}),
              },
              exports: [],
            });
          }
          break;
        }
        case 'run':
          await run(msg);
          break;
      }
    })
    .catch((e: unknown) => {
      // Internal runner failure: exit loudly so the parent reports it instead of waiting forever.
      process.stderr.write(`doppeldiff runner internal error: ${(e as Error)?.stack ?? String(e)}\n`);
      process.exit(70);
    });
});
