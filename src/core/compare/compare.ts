import type { Enc, Outcome } from './observed.js';

export interface CompareOptions {
  /** Treat `{a: undefined}` and `{}` as different (default false: equal). */
  strictUndefined?: boolean;
  /** Compare thrown errors by class only (default false: class + message). */
  ignoreErrorMessages?: boolean;
  /** Absolute/relative tolerance for numbers (default 0: exact, but NaN equals NaN). */
  epsilon?: number;
  /** Compare argument mutations (default true). */
  compareMutations?: boolean;
}

export type DiffPath = (string | number)[];

/** Returns null if equal, otherwise the path to the first difference. */
export function diffEnc(a: Enc, b: Enc, opts: CompareOptions = {}, path: DiffPath = []): DiffPath | null {
  if (a.t !== b.t) return path;
  switch (a.t) {
    case 'undefined':
    case 'null':
    case 'promise':
      return null;
    case 'boolean':
    case 'bigint':
    case 'string':
      return a.v === (b as typeof a).v ? null : path;
    case 'number':
      return numbersEqual(a.v, (b as typeof a).v, opts.epsilon ?? 0) ? null : path;
    case 'date': {
      const bv = (b as typeof a).v;
      return Object.is(a.v, bv) || (Number.isNaN(a.v) && Number.isNaN(bv)) ? null : path;
    }
    case 'symbol':
      return a.d === (b as typeof a).d ? null : path;
    case 'regexp': {
      const bb = b as typeof a;
      return a.source === bb.source && a.flags === bb.flags ? null : path;
    }
    case 'function': {
      const bb = b as typeof a;
      return a.name === bb.name && a.length === bb.length ? null : path;
    }
    case 'cycle':
      return a.up === (b as typeof a).up ? null : path;
    case 'truncated':
      return a.reason === (b as typeof a).reason ? null : path;
    case 'typed': {
      const bb = b as typeof a;
      if (a.ctor !== bb.ctor || a.items.length !== bb.items.length) return path;
      for (let i = 0; i < a.items.length; i++) {
        if (!numbersEqual(a.items[i]!, bb.items[i]!, opts.epsilon ?? 0)) return [...path, i];
      }
      return null;
    }
    case 'array': {
      const bb = b as typeof a;
      const n = Math.max(a.items.length, bb.items.length);
      for (let i = 0; i < n; i++) {
        const x = a.items[i];
        const y = bb.items[i];
        if (!x || !y) return [...path, 'length'];
        const d = diffEnc(x, y, opts, [...path, i]);
        if (d) return d;
      }
      return null;
    }
    case 'object': {
      const bb = b as typeof a;
      if (a.ctor !== bb.ctor) return [...path, '[[prototype]]'];
      return diffEntries(a.entries, bb.entries, opts, path);
    }
    case 'error': {
      const bb = b as typeof a;
      if (a.ctor !== bb.ctor) return [...path, '[[class]]'];
      if (!opts.ignoreErrorMessages && a.message !== bb.message) return [...path, 'message'];
      return opts.ignoreErrorMessages ? null : diffEntries(a.props, bb.props, opts, path);
    }
    case 'map': {
      const bb = b as typeof a;
      if (a.entries.length !== bb.entries.length) return [...path, 'size'];
      // Order-insensitive: every key of a must exist in b with an equal value.
      for (const [k, v] of a.entries) {
        const match = bb.entries.find(([k2]) => diffEnc(k, k2, opts) === null);
        if (!match) return [...path, `key ${shortEnc(k)}`];
        const d = diffEnc(v, match[1], opts, [...path, `get(${shortEnc(k)})`]);
        if (d) return d;
      }
      return null;
    }
    case 'set': {
      const bb = b as typeof a;
      if (a.items.length !== bb.items.length) return [...path, 'size'];
      const used = new Set<number>();
      for (const x of a.items) {
        const j = bb.items.findIndex((y, idx) => !used.has(idx) && diffEnc(x, y, opts) === null);
        if (j === -1) return [...path, `has(${shortEnc(x)})`];
        used.add(j);
      }
      return null;
    }
  }
}

function diffEntries(
  a: [string, Enc][],
  b: [string, Enc][],
  opts: CompareOptions,
  path: DiffPath,
): DiffPath | null {
  const keep = (e: [string, Enc]) => opts.strictUndefined || e[1].t !== 'undefined';
  const am = new Map(a.filter(keep));
  const bm = new Map(b.filter(keep));
  for (const [k, v] of am) {
    const w = bm.get(k);
    if (!w) return [...path, k];
    const d = diffEnc(v, w, opts, [...path, k]);
    if (d) return d;
  }
  for (const k of bm.keys()) if (!am.has(k)) return [...path, k];
  return null;
}

function numbersEqual(x: number, y: number, epsilon: number): boolean {
  if (Number.isNaN(x) && Number.isNaN(y)) return true;
  if (Object.is(x, y)) return true;
  if (epsilon > 0 && Number.isFinite(x) && Number.isFinite(y)) {
    // With a tolerance, -0 and 0 are considered equal.
    return Math.abs(x - y) <= epsilon * Math.max(1, Math.abs(x), Math.abs(y));
  }
  return false;
}

function shortEnc(e: Enc): string {
  switch (e.t) {
    case 'string':
      return JSON.stringify(e.v);
    case 'number':
      return Object.is(e.v, -0) ? '-0' : String(e.v);
    case 'boolean':
    case 'bigint':
      return String(e.v);
    default:
      return e.t;
  }
}

export interface OutcomeDiff {
  /** Which aspect differs. */
  aspect: 'kind' | 'value' | 'error' | 'mutation' | 'async';
  /** Path inside the value (for value/error) or `[argIndex, ...]` for mutations. */
  path: DiffPath;
}

/** Compare two outcomes. Returns null if behavior is the same. */
export function diffOutcome(a: Outcome, b: Outcome, opts: CompareOptions = {}): OutcomeDiff | null {
  if (a.kind !== b.kind) return { aspect: 'kind', path: [] };
  switch (a.kind) {
    case 'timeout':
      return null;
    case 'crash':
      return null;
    case 'return': {
      const bb = b as typeof a;
      if (a.async !== bb.async) return { aspect: 'async', path: [] };
      const d = diffEnc(a.value, bb.value, opts);
      if (d) return { aspect: 'value', path: d };
      return diffArgs(a.args, bb.args, opts);
    }
    case 'throw': {
      const bb = b as typeof a;
      if (a.async !== bb.async) return { aspect: 'async', path: [] };
      const d = diffEnc(a.error, bb.error, opts);
      if (d) return { aspect: 'error', path: d };
      return diffArgs(a.args, bb.args, opts);
    }
  }
}

function diffArgs(a: Enc[], b: Enc[], opts: CompareOptions): OutcomeDiff | null {
  if (opts.compareMutations === false) return null;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y) return { aspect: 'mutation', path: [i] };
    const d = diffEnc(x, y, opts, [i]);
    if (d) return { aspect: 'mutation', path: d };
  }
  return null;
}
