import type { Enc, Outcome } from '../compare/observed.js';
import { FN_TAG, isFnDescriptor, isProtoDescriptor, PROTO_TAG, viewBytes } from '../runner/tags.js';

const MAX_LEN = 120;

function clip(s: string, max = MAX_LEN): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function num(n: number): string {
  if (Object.is(n, -0)) return '-0';
  return String(n);
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
const key = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));

/** Render a raw JavaScript value (a generated input) as a JS-like literal. */
export function formatValue(v: unknown, max = MAX_LEN): string {
  const seen = new Set<unknown>();
  const f = (x: unknown): string => {
    if (isFnDescriptor(x)) {
      const { returns, async } = x[FN_TAG];
      return `${async ? 'async ' : ''}() => ${f(returns)}`;
    }
    switch (typeof x) {
      case 'undefined':
        return 'undefined';
      case 'number':
        return num(x);
      case 'bigint':
        return `${x}n`;
      case 'string':
        return JSON.stringify(x);
      case 'boolean':
        return String(x);
      case 'symbol':
        return x.toString();
      case 'function':
        return `[Function ${x.name || 'anonymous'}]`;
    }
    if (x === null) return 'null';
    if (seen.has(x)) return '[Circular]';
    seen.add(x);
    try {
      if (Array.isArray(x)) return `[${x.map(f).join(', ')}]`;
      if (x instanceof Date)
        return Number.isNaN(x.getTime()) ? 'new Date(NaN)' : `new Date(${JSON.stringify(x.toISOString())})`;
      if (x instanceof Map)
        return `new Map([${[...x].map(([k, val]) => `[${f(k)}, ${f(val)}]`).join(', ')}])`;
      if (x instanceof Set) return `new Set([${[...x].map(f).join(', ')}])`;
      if (x instanceof RegExp) return String(x);
      if (isProtoDescriptor(x)) {
        const { proto, own } = x[PROTO_TAG];
        return `Object.assign(Object.create(${f(proto)}), ${f(own)})`;
      }
      if (x instanceof ArrayBuffer) return `new Uint8Array([${viewBytes(x).join(', ')}]).buffer`;
      if (x instanceof DataView) {
        return `new DataView(new Uint8Array([${viewBytes(new Uint8Array(x.buffer)).join(', ')}]).buffer, ${x.byteOffset}, ${x.byteLength})`;
      }
      if (ArrayBuffer.isView(x))
        return `new ${x.constructor.name}([${Array.from(x as unknown as ArrayLike<number>).join(', ')}])`;
      const entries = Object.entries(x as Record<string, unknown>);
      if (entries.length === 0) return '{}';
      return `{ ${entries.map(([k, val]) => `${key(k)}: ${f(val)}`).join(', ')} }`;
    } finally {
      seen.delete(x);
    }
  };
  return clip(f(v), max);
}

export function formatArgs(args: unknown[], max = MAX_LEN): string {
  return clip(args.map((a) => formatValue(a, max)).join(', '), max);
}

/** Render an encoded value as a JS-like literal. */
export function formatEnc(e: Enc, max = MAX_LEN): string {
  const f = (x: Enc): string => {
    switch (x.t) {
      case 'undefined':
        return 'undefined';
      case 'null':
        return 'null';
      case 'boolean':
        return String(x.v);
      case 'number':
        return num(x.v);
      case 'bigint':
        return `${x.v}n`;
      case 'string':
        return JSON.stringify(x.v);
      case 'symbol':
        return `Symbol(${x.d})`;
      case 'array':
        return `[${x.items.map(f).join(', ')}]`;
      case 'object': {
        const prefix = x.ctor && x.ctor !== 'null-prototype' ? `${x.ctor} ` : '';
        if (x.entries.length === 0) return `${prefix}{}`;
        return `${prefix}{ ${x.entries.map(([k, v]) => `${key(k)}: ${f(v)}`).join(', ')} }`;
      }
      case 'date':
        return Number.isNaN(x.v) ? 'Invalid Date' : new Date(x.v).toISOString();
      case 'map':
        return `Map(${x.entries.length}) { ${x.entries.map(([k, v]) => `${f(k)} => ${f(v)}`).join(', ')} }`;
      case 'set':
        return `Set(${x.items.length}) { ${x.items.map(f).join(', ')} }`;
      case 'regexp':
        return `/${x.source}/${x.flags}`;
      case 'function':
        return `[Function ${x.name || 'anonymous'}]`;
      case 'error':
        return `${x.ctor}: ${x.message}`;
      case 'typed':
        return `${x.ctor} [${x.items.join(', ')}]`;
      case 'promise':
        return 'Promise';
      case 'cycle':
        return '[Circular]';
      case 'truncated':
        return `<${x.reason}>`;
    }
  };
  return clip(f(e), max);
}

/** Short behavior summary, e.g. `1104.99`, `throws RangeError: bad price`, `timeout`. */
export function formatOutcome(o: Outcome, max = MAX_LEN): string {
  switch (o.kind) {
    case 'return':
      return o.async ? `resolves ${formatEnc(o.value, max)}` : formatEnc(o.value, max);
    case 'throw': {
      const e = o.error.t === 'error' ? `${o.error.ctor}: ${o.error.message}` : formatEnc(o.error, max);
      return clip(`${o.async ? 'rejects' : 'throws'} ${e}`, max);
    }
    case 'timeout':
      return `timeout (>${o.ms}ms)`;
    case 'crash':
      return `crash (${o.reason})`;
  }
}

/** Coarse category of a value, used to describe outcome transitions (e.g. "number → NaN"). */
export function encCategory(e: Enc): string {
  switch (e.t) {
    case 'number':
      if (Number.isNaN(e.v)) return 'NaN';
      if (!Number.isFinite(e.v)) return e.v > 0 ? 'Infinity' : '-Infinity';
      if (Object.is(e.v, -0)) return '-0';
      if (e.v === 0) return '0';
      return e.v < 0 ? 'negative number' : 'positive number';
    case 'object':
      return e.ctor && e.ctor !== 'null-prototype' ? e.ctor : 'object';
    case 'date':
      return Number.isNaN(e.v) ? 'Invalid Date' : 'Date';
    case 'string':
      return e.v.length === 0 ? 'empty string' : 'string';
    case 'array':
      return e.items.length === 0 ? 'empty array' : 'array';
    case 'error':
      return e.ctor;
    default:
      return e.t;
  }
}

/** Category of a whole outcome, e.g. `returns number`, `throws RangeError`, `timeout`. */
export function outcomeCategory(o: Outcome): string {
  switch (o.kind) {
    case 'return':
      return `${o.async ? 'resolves' : 'returns'} ${encCategory(o.value)}`;
    case 'throw':
      return `${o.async ? 'rejects' : 'throws'} ${encCategory(o.error)}`;
    case 'timeout':
      return 'timeout';
    case 'crash':
      return 'crash';
  }
}
