import type { Enc } from '../compare/observed.js';
import { FN_TAG, isFnDescriptor, isProtoDescriptor, PROTO_TAG, viewBytes } from '../runner/tags.js';

/**
 * JavaScript source for values, used in reports (copy-pasteable calls) and generated regression tests.
 * Returns undefined when a value cannot be expressed faithfully as a literal.
 */
const IDENT = /^[A-Za-z_$][\w$]*$/;
const key = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));

function num(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return 'Infinity';
  if (n === -Infinity) return '-Infinity';
  if (Object.is(n, -0)) return '-0';
  return String(n);
}

/** Code for a generated input value (plain data, Dates, Maps, Sets, callback descriptors). */
export function valueToCode(v: unknown): string | undefined {
  const seen = new Set<unknown>();
  const f = (x: unknown): string | undefined => {
    if (isFnDescriptor(x)) {
      const { returns, async } = x[FN_TAG];
      const r = f(returns);
      if (r === undefined) return undefined;
      const body = r.startsWith('{') ? `(${r})` : r;
      return `${async ? 'async ' : ''}() => ${body}`;
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
      case 'function':
        return undefined;
    }
    if (x === null) return 'null';
    if (seen.has(x)) return undefined;
    seen.add(x);
    try {
      if (Array.isArray(x)) {
        const items = x.map(f);
        return items.some((i) => i === undefined) ? undefined : `[${items.join(', ')}]`;
      }
      if (x instanceof Date)
        return Number.isNaN(x.getTime()) ? 'new Date(NaN)' : `new Date(${JSON.stringify(x.toISOString())})`;
      if (x instanceof Map) {
        const entries = [...x].map(([k, val]) => {
          const a = f(k);
          const b = f(val);
          return a === undefined || b === undefined ? undefined : `[${a}, ${b}]`;
        });
        return entries.some((e) => e === undefined) ? undefined : `new Map([${entries.join(', ')}])`;
      }
      if (x instanceof Set) {
        const items = [...x].map(f);
        return items.some((i) => i === undefined) ? undefined : `new Set([${items.join(', ')}])`;
      }
      if (x instanceof RegExp) return String(x);
      if (isProtoDescriptor(x)) {
        const { proto, own } = x[PROTO_TAG];
        const p = f(proto);
        const o = f(own);
        return p === undefined || o === undefined ? undefined : `Object.assign(Object.create(${p}), ${o})`;
      }
      if (x instanceof ArrayBuffer) return `new Uint8Array([${viewBytes(x).join(', ')}]).buffer`;
      if (x instanceof DataView) {
        return `new DataView(new Uint8Array([${viewBytes(new Uint8Array(x.buffer)).join(', ')}]).buffer, ${x.byteOffset}, ${x.byteLength})`;
      }
      if (ArrayBuffer.isView(x) && /^(?:Int|Uint|Float)\d+(?:Clamped)?Array$/.test(x.constructor.name)) {
        return `new ${x.constructor.name}([${Array.from(x as unknown as ArrayLike<number>).join(', ')}])`;
      }
      const proto = Object.getPrototypeOf(x) as unknown;
      if (proto !== Object.prototype && proto !== null) return undefined;
      const entries = Object.entries(x as Record<string, unknown>).map(([k, val]) => {
        const c = f(val);
        return c === undefined ? undefined : `${key(k)}: ${c}`;
      });
      if (entries.some((e) => e === undefined)) return undefined;
      return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
    } finally {
      seen.delete(x);
    }
  };
  return f(v);
}

export function argsToCode(args: unknown[]): string | undefined {
  const parts = args.map(valueToCode);
  return parts.some((p) => p === undefined) ? undefined : parts.join(', ');
}

/** Code for an observed (encoded) value; undefined for class instances, functions, cycles, symbols. */
export function encToCode(e: Enc): string | undefined {
  const f = (x: Enc): string | undefined => {
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
      case 'array': {
        const items = x.items.map(f);
        return items.some((i) => i === undefined) ? undefined : `[${items.join(', ')}]`;
      }
      case 'object': {
        if (x.ctor !== null) return undefined;
        const entries = x.entries.map(([k, v]) => {
          const c = f(v);
          return c === undefined ? undefined : `${key(k)}: ${c}`;
        });
        if (entries.some((en) => en === undefined)) return undefined;
        return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
      }
      case 'date':
        return Number.isNaN(x.v)
          ? 'new Date(NaN)'
          : `new Date(${JSON.stringify(new Date(x.v).toISOString())})`;
      case 'map': {
        const entries = x.entries.map(([k, v]) => {
          const a = f(k);
          const b = f(v);
          return a === undefined || b === undefined ? undefined : `[${a}, ${b}]`;
        });
        return entries.some((en) => en === undefined) ? undefined : `new Map([${entries.join(', ')}])`;
      }
      case 'set': {
        const items = x.items.map(f);
        return items.some((i) => i === undefined) ? undefined : `new Set([${items.join(', ')}])`;
      }
      case 'regexp':
        return `/${x.source}/${x.flags}`;
      case 'typed':
        return /^(?:Big)?(?:Int|Uint|Float)\d+(?:Clamped)?Array$/.test(x.ctor) && !x.ctor.startsWith('Big')
          ? `new ${x.ctor}([${x.items.map(num).join(', ')}])`
          : undefined;
      default:
        return undefined;
    }
  };
  return f(e);
}
