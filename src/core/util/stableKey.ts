import { FN_TAG, isFnDescriptor, isProtoDescriptor, PROTO_TAG, viewBytes } from '../runner/tags.js';

/**
 * Deterministic string key for a generated JavaScript value. Distinguishes -0/0, NaN, undefined,
 * Dates, Maps, Sets and bigint; used for de-duplicating inputs and caching evaluations.
 */
export function stableKey(value: unknown): string {
  const seen = new Set<unknown>();
  const k = (v: unknown): string => {
    switch (typeof v) {
      case 'undefined':
        return 'u';
      case 'number':
        return Object.is(v, -0) ? '-0' : Number.isNaN(v) ? 'NaN' : `#${v}`;
      case 'bigint':
        return `${v}n`;
      case 'string':
        return JSON.stringify(v);
      case 'boolean':
        return v ? 'T' : 'F';
      case 'symbol':
        return `sym(${v.description ?? ''})`;
      case 'function':
        return `fn(${v.name})`;
    }
    if (v === null) return 'null';
    if (seen.has(v)) return '<cycle>';
    seen.add(v);
    try {
      if (isFnDescriptor(v)) return `fn->${k(v[FN_TAG].returns)}${v[FN_TAG].async ? 'a' : ''}`;
      if (Array.isArray(v)) return `[${v.map(k).join(',')}]`;
      if (v instanceof Date) return `D${v.getTime()}`;
      if (isProtoDescriptor(v)) return `P{${k(v[PROTO_TAG].proto)}|${k(v[PROTO_TAG].own)}}`;
      if (v instanceof ArrayBuffer) return `AB[${viewBytes(v).join(',')}]`;
      if (ArrayBuffer.isView(v))
        return `V:${v.constructor.name}:${v.byteOffset}:${v.byteLength}:[${viewBytes(new Uint8Array(v.buffer)).join(',')}]`;
      if (v instanceof Map) return `M{${[...v].map(([a, b]) => `${k(a)}=>${k(b)}`).join(',')}}`;
      if (v instanceof Set) return `S{${[...v].map(k).join(',')}}`;
      const proto = Object.getPrototypeOf(v) as unknown;
      const tag =
        proto === Object.prototype
          ? ''
          : proto === null
            ? 'N'
            : `C:${(proto as { constructor?: { name?: string } }).constructor?.name ?? '?'}`;
      return `${tag}{${Object.entries(v as Record<string, unknown>)
        .map(([a, b]) => `${JSON.stringify(a)}:${k(b)}`)
        .join(',')}}`;
    } finally {
      seen.delete(v);
    }
  };
  return k(value);
}

/** 32-bit FNV-1a hash of a string. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
