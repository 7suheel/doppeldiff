import type { Enc } from '../compare/observed.js';
import { viewBytes } from './tags.js';

/**
 * Encode an arbitrary runtime value into the canonical `Enc` representation.
 * Runs inside the runner process; must not depend on anything but the language.
 */
export interface EncodeLimits {
  maxNodes: number;
  maxDepth: number;
}

const DEFAULT_LIMITS: EncodeLimits = { maxNodes: 20_000, maxDepth: 24 };

const toStringTag = (v: object): string => Object.prototype.toString.call(v).slice(8, -1);

function ctorName(v: object): string | null {
  const proto = Object.getPrototypeOf(v) as object | null;
  if (proto === null) return 'null-prototype';
  if (proto === Object.prototype) return null;
  const ctor = (proto as { constructor?: unknown }).constructor;
  if (typeof ctor === 'function' && typeof ctor.name === 'string' && ctor.name) {
    // Objects from another realm whose prototype is that realm's Object.prototype.
    if (ctor.name === 'Object' && Object.getPrototypeOf(proto) === null) return null;
    return ctor.name;
  }
  return 'anonymous';
}

export function encode(value: unknown, limits: EncodeLimits = DEFAULT_LIMITS): Enc {
  let nodes = 0;
  const stack: object[] = [];

  const enc = (v: unknown, depth: number): Enc => {
    if (++nodes > limits.maxNodes) return { t: 'truncated', reason: 'too many nodes' };
    switch (typeof v) {
      case 'undefined':
        return { t: 'undefined' };
      case 'boolean':
        return { t: 'boolean', v };
      case 'number':
        return { t: 'number', v };
      case 'bigint':
        return { t: 'bigint', v: v.toString() };
      case 'string':
        return { t: 'string', v };
      case 'symbol':
        return { t: 'symbol', d: v.description ?? '' };
      case 'function':
        return { t: 'function', name: v.name, length: v.length };
    }
    if (v === null) return { t: 'null' };
    const obj = v as object;
    const cycleAt = stack.lastIndexOf(obj);
    if (cycleAt !== -1) return { t: 'cycle', up: stack.length - cycleAt };
    if (depth > limits.maxDepth) return { t: 'truncated', reason: 'too deep' };

    stack.push(obj);
    try {
      return encObject(obj, depth);
    } finally {
      stack.pop();
    }
  };

  const readProp = (obj: object, key: string, depth: number): Enc => {
    try {
      return enc((obj as Record<string, unknown>)[key], depth + 1);
    } catch (e) {
      return { t: 'truncated', reason: `getter threw: ${String((e as Error)?.message ?? e)}` };
    }
  };

  const encObject = (obj: object, depth: number): Enc => {
    const tag = toStringTag(obj);
    if (Array.isArray(obj)) {
      const items: Enc[] = [];
      // Huge sparse array (`a[4294967294] = x`): describe its populated entries instead of walking the holes.
      const populated = obj.length > limits.maxNodes ? Object.keys(obj) : undefined;
      if (populated && populated.length < limits.maxNodes) {
        const entries = populated.slice(0, 20).map((k) => `${k}: ${JSON.stringify(readProp(obj, k, depth))}`);
        return { t: 'truncated', reason: `sparse array of length ${obj.length} {${entries.join(', ')}}` };
      }
      for (let i = 0; i < obj.length; i++) {
        // A sparse array can be billions of elements long (`a[4294967294] = x`): stop at the node limit.
        if (nodes > limits.maxNodes) {
          items.push({ t: 'truncated', reason: `array of length ${obj.length}` });
          break;
        }
        items.push(readProp(obj, String(i), depth));
      }
      return { t: 'array', items };
    }
    if (tag === 'Date') return { t: 'date', v: Date.prototype.getTime.call(obj) };
    if (tag === 'RegExp') {
      const r = obj as RegExp;
      return { t: 'regexp', source: r.source, flags: r.flags };
    }
    if (tag === 'Map') {
      const entries: [Enc, Enc][] = [];
      for (const [k, val] of Map.prototype.entries.call(obj) as Iterable<[unknown, unknown]>) {
        entries.push([enc(k, depth + 1), enc(val, depth + 1)]);
      }
      return { t: 'map', entries };
    }
    if (tag === 'Set') {
      const items: Enc[] = [];
      for (const val of Set.prototype.values.call(obj) as Iterable<unknown>) items.push(enc(val, depth + 1));
      return { t: 'set', items };
    }
    if (tag === 'Promise') return { t: 'promise' };
    if (tag === 'DataView' || tag === 'ArrayBuffer' || tag === 'SharedArrayBuffer') {
      // Bytes of the visible window: a DataView over the wrong offset/length shows different bytes.
      return { t: 'typed', ctor: tag, items: viewBytes(obj as ArrayBuffer | DataView) };
    }
    if (ArrayBuffer.isView(obj)) {
      const arr = obj as unknown as ArrayLike<number | bigint>;
      return {
        t: 'typed',
        ctor: ctorName(obj) ?? tag,
        items: Array.from(arr, (x) => Number(x)),
      };
    }
    if (obj instanceof Error || tag === 'Error') {
      const e = obj as Error;
      const props: [string, Enc][] = [];
      for (const key of Object.keys(e)) {
        if (key === 'stack' || key === 'message') continue;
        props.push([key, readProp(e, key, depth)]);
      }
      // `cause` is non-enumerable but often carries the real reason (e.g. fetch → ERR_ACCESS_DENIED).
      if (Object.prototype.hasOwnProperty.call(e, 'cause') && !Object.keys(e).includes('cause')) {
        props.push(['cause', readProp(e, 'cause', depth)]);
      }
      let message: string;
      try {
        message = String(e.message);
      } catch {
        message = '<unreadable>';
      }
      return { t: 'error', ctor: ctorName(e) ?? 'Error', message, props };
    }
    const entries: [string, Enc][] = [];
    for (const key of Object.keys(obj)) entries.push([key, readProp(obj, key, depth)]);
    return { t: 'object', ctor: ctorName(obj), entries };
  };

  try {
    return enc(value, 0);
  } catch (e) {
    return { t: 'truncated', reason: `encoding failed: ${String((e as Error)?.message ?? e)}` };
  }
}
